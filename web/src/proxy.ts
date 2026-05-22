// Next.js Proxy (renamed from middleware). Runs before each request and
// gates everything except /setup and the API surface on the provider
// being configured. If the gateway reports providerConfigured:false the
// user is bounced to /setup so they can pick a provider before doing
// anything else.
//
// We hit the runtime directly through the BFF helpers (env override
// falls back to ~/.gini/instances/<inst>/runtime.port + config.json),
// the same source of truth the rest of the BFF reads from. Failures
// (gateway down, network glitch) let the request through — we'd rather
// show a degraded UI than a redirect loop when the runtime is the
// problem.
//
// No cache on the status answer. A previous version cached the result
// for 2s, but that caused a race: when /setup POSTs a successful
// provider, the page calls router.replace('/') *immediately* —
// within the cache window. The proxy on `/` would then read stale
// `providerConfigured:false` and bounce the user back to /setup. The
// cost of always hitting the gateway is one sub-millisecond local
// HTTP call per gated request — cheap, because the runtime is on the
// same machine and the call hits a tiny in-memory check
// (providerHealth + config). The matcher already excludes
// /_next/static and /_next/image so static asset loading is unaffected.

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeTunnelState, runtimeUrl } from "@/lib/runtime";

// Upper bound on the round-trip to the local gateway's /api/setup/status.
// The gateway is on 127.0.0.1 and the call hits a tiny in-memory check, so
// the typical latency is sub-ms. We're guarding against a hung gateway —
// don't make the user wait long when the runtime is genuinely down.
const PROXY_STATUS_TIMEOUT_MS = 1500;

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(PROXY_STATUS_TIMEOUT_MS)
    });
    if (!response.ok) {
      // 401 / 5xx — let the request through so the page can surface
      // the real error rather than redirecting in a loop.
      return null;
    }
    const data = await response.json() as { providerConfigured?: unknown };
    return data.providerConfigured === true;
  } catch {
    // Network error / gateway down — same logic as 5xx: don't redirect.
    return null;
  }
}

// Cookie name + lifetime for the post-bootstrap tunnel session. The
// secret in the URL is a bootstrap credential: the first request must
// carry `/<secret>/` so the proxy can verify ownership, after which it
// mints an HttpOnly cookie that authorizes subsequent same-origin
// requests (page navigations, API calls, asset fetches). Without this,
// every JS-issued `fetch("/api/runtime/...")` from a tunneled page
// would need to know the secret and prepend it manually, which the dev
// bundle keeps fumbling because hot-module updates don't survive
// cloudflared (the HMR websocket is gated alongside everything else).
const SESSION_COOKIE = "gini_tunnel_session";
// One day — secrets rotate every gateway restart anyway, so a stale
// cookie just stops working at next reboot.
const SESSION_TTL_SECONDS = 60 * 60 * 24;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get("host") ?? "";
  const isLocalHost = isLocalHostName(host);
  const { pathname } = request.nextUrl;

  if (!isLocalHost) {
    // External host (cloudflared): one of two auth paths must be present
    // before we'll forward anything to the BFF — which auto-injects the
    // operator's bearer token, so passing through unauthenticated would
    // hand authenticated /api/* access to anyone who learned the
    // trycloudflare hostname.
    //
    //   1. URL contains `/<secret>/...` — initial bootstrap. We strip
    //      the prefix and set a HttpOnly session cookie before
    //      rewriting.
    //   2. The session cookie matches the secret — subsequent requests
    //      no longer need the prefix in the URL, so the page's relative
    //      `fetch("/api/runtime/...")` calls just work.
    //
    // The secret + enabled flag come from config.json on every request
    // (mtime-cached for 2s). Reading lazily avoids the env-injection race
    // that bit first-boot autostart: the runtime mints the secret in
    // src/server.ts AFTER `gini start` has already spawned the web with
    // an empty GINI_TUNNEL_SECRET, and the autostart web plist did not
    // propagate the env var at all. Now both layers consult the same
    // disk record the gateway treats as the source of truth, so a
    // freshly-enabled tunnel starts authorizing requests on the next
    // request without restarting the web.
    const { enabled, secret } = runtimeTunnelState();
    if (!enabled || !secret) return new NextResponse("Not Found", { status: 404 });
    const prefix = `/${secret}`;
    // Accept BOTH `/<secret>/...` (canonical) and bare `/<secret>` (the
    // form Next 16 produces after its automatic trailing-slash 308).
    // Without the bare match, a QR-scanned URL ending in `/<secret>/`
    // gets normalized to `/<secret>` before the proxy runs and would
    // then 404. Direct rewrite — no redirect — so we never reintroduce
    // the trailing-slash loop.
    const hasPrefix = pathname === prefix || pathname.startsWith(`${prefix}/`);
    const cookieAuth = request.cookies.get(SESSION_COOKIE)?.value === secret;
    if (!hasPrefix && !cookieAuth) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const stripped = hasPrefix
      ? (pathname === prefix ? "/" : pathname.slice(prefix.length) || "/")
      : pathname;

    // Apply the same setup gate localhost requests get, but only on
    // page navigations (not API or _next/* asset fetches that the page
    // makes on the way in).
    if (!stripped.startsWith("/api/") && !stripped.startsWith("/setup")) {
      const configured = await isProviderConfigured();
      if (configured === false) {
        const setupUrl = new URL("/setup", request.url);
        const setupRedirect = NextResponse.redirect(setupUrl);
        if (hasPrefix) attachSession(setupRedirect, secret);
        return setupRedirect;
      }
    }

    const rewritten = request.nextUrl.clone();
    rewritten.pathname = stripped;
    const response = NextResponse.rewrite(rewritten);
    if (hasPrefix) attachSession(response, secret);
    return response;
  }

  // Localhost: existing setup gate.
  if (pathname.startsWith("/setup") || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
  const configured = await isProviderConfigured();
  if (configured === false) {
    const setupUrl = new URL("/setup", request.url);
    return NextResponse.redirect(setupUrl);
  }
  return NextResponse.next();
}

function attachSession(response: NextResponse, secret: string): void {
  response.cookies.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

// Detect a localhost-shaped Host header. Previously matched with naive
// `startsWith` which accepted `localhost.attacker.example` and similar
// suffix-shadow hostnames. Anchor the host portion (port stripped) to a
// known-good set instead so a hostile Host header can't masquerade as
// localhost to skip the tunnel-secret gate.
function isLocalHostName(host: string): boolean {
  const lower = host.toLowerCase();
  const bare = lower.includes(":") ? lower.slice(0, lower.lastIndexOf(":")) : lower;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]";
}

export const config = {
  // Match everything except Next.js static assets and the favicon. API
  // routes are NOT excluded — they need to go through the secret-path
  // gate when arriving via the cloudflared tunnel, otherwise the BFF's
  // bearer-token-injecting proxy hands authenticated access to anyone
  // who knows the trycloudflare hostname.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)"
  ]
};
