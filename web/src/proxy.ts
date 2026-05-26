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
import { runtimeToken, runtimeTunnelState, runtimeUrl, trustedOrigins } from "@/lib/runtime";

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
// One day — long enough that the operator's session survives a
// gateway restart, short enough that an exfiltrated cookie has a
// bounded shelf life. Cookies are keyed by the persisted secret
// (stable across restarts unless the operator runs `gini tunnel
// rotate-secret`), so a deliberate rotation invalidates every
// outstanding session.
const SESSION_TTL_SECONDS = 60 * 60 * 24;

// Internal authorization marker the proxy stamps onto requests that
// passed the tunnel-secret or session-cookie gate above. The BFF's
// per-route guard (web/src/lib/runtime.ts:guardCsrf) checks for this
// header as an equivalent to "loopback Host" because tunneled
// requests legitimately carry a non-loopback Host
// (<random>.trycloudflare.com) and there is no static origin to put
// in GINI_TRUSTED_ORIGINS — cloudflared mints a fresh hostname on
// every restart. The proxy ALWAYS strips any inbound value before
// re-setting it, so a remote caller cannot forge the marker; only
// requests that just passed the secret/cookie check carry it
// downstream.
const TUNNEL_VETTED_HEADER = "x-gini-tunnel-vetted";
const TUNNEL_VETTED_VALUE = "1";

// Strip + re-set the marker on the headers we forward upstream. The
// strip is the security-critical half: a remote attacker who knows
// the trycloudflare hostname but NOT the secret could try to attach
// `x-gini-tunnel-vetted: 1` themselves; without the strip the BFF
// guard would treat the spoofed value as proof the proxy already
// vetted them. Use a fresh Headers clone so the original NextRequest
// stays untouched (Next.js holds onto request headers internally).
function vettedHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  headers.delete(TUNNEL_VETTED_HEADER);
  headers.set(TUNNEL_VETTED_HEADER, TUNNEL_VETTED_VALUE);
  return headers;
}

// Strip the marker but DO NOT set it. Used on the localhost path so a
// co-tenant process on 127.0.0.1 cannot forge the header to influence
// the BFF guard's decision. The localhost path's own request still
// satisfies the guard via loopback-Host equality, so the marker simply
// isn't needed there.
function strippedHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  headers.delete(TUNNEL_VETTED_HEADER);
  return headers;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get("host") ?? "";
  const isLocalHost = isLocalHostName(host);
  const { pathname } = request.nextUrl;

  if (!isLocalHost) {
    // Non-loopback Host. Three deployment shapes feed this branch and
    // each has a distinct authorization model:
    //
    //   A. Tunnel enabled (cloudflared): require the URL secret prefix
    //      `/<secret>/...` or a matching session cookie before we'll
    //      forward anything to the BFF — which auto-injects the
    //      operator's bearer token, so passing through unauthenticated
    //      would hand authenticated /api/* access to anyone who learned
    //      the trycloudflare hostname.
    //        1. URL contains `/<secret>/...` — initial bootstrap. We
    //           strip the prefix and set a HttpOnly session cookie before
    //           rewriting.
    //        2. The session cookie matches the secret — subsequent
    //           requests no longer need the prefix in the URL, so the
    //           page's relative `fetch("/api/runtime/...")` calls just
    //           work.
    //      Requests that pass either check get `x-gini-tunnel-vetted: 1`
    //      stamped on the upstream headers; the BFF guard treats that
    //      marker as equivalent to a loopback Host because cloudflared
    //      mints a fresh hostname on every restart and can't be put in
    //      GINI_TRUSTED_ORIGINS.
    //
    //   B. Tunnel disabled + GINI_TRUSTED_ORIGINS set (tailnet / public
    //      DNS deployment per ADR bff-trust-boundary.md): pass through
    //      to the BFF without stamping the vetted marker. The BFF's
    //      guardCsrf enforces the allowlist by exact Origin match, which
    //      is the production-shape DNS-rebinding defense. The proxy
    //      cannot enforce the allowlist here because allowlists key on
    //      Origin (not Host), and a same-origin GET can legitimately
    //      omit Origin — only guardCsrf has the full picture.
    //
    //   C. Tunnel disabled + GINI_TRUSTED_ORIGINS unset: 404. No tunnel
    //      authorizer and no operator-blessed allowlist means this
    //      Host should not be reachable at all; failing closed at the
    //      proxy keeps DNS-rebinding pages from probing the BFF before
    //      guardCsrf gets a chance to refuse them.
    //
    // The secret + enabled flag come from config.json on every request
    // (uncached — see readFileFreshTrim). Reading lazily avoids the
    // env-injection race that bit first-boot autostart: the runtime
    // mints the secret in src/server.ts AFTER `gini start` has already
    // spawned the web with an empty GINI_TUNNEL_SECRET, and the
    // autostart web plist did not propagate the env var at all. Now
    // both layers consult the same disk record the gateway treats as
    // the source of truth, so a freshly-enabled tunnel starts
    // authorizing requests on the next request without restarting the
    // web.
    const { enabled, secret } = runtimeTunnelState();
    if (!enabled || !secret) {
      // Shape B vs C: pass through to the BFF only when the operator
      // has explicitly configured a trusted-origin allowlist. An empty
      // allowlist (env var set but every entry malformed) is treated
      // the same as "set" — guardCsrf will fail-closed on the
      // forwarded request, which is the right answer for an operator
      // who clearly meant to lock down the surface. Unset means no
      // external deployment is configured; 404 keeps the un-deployed
      // surface invisible.
      const allowlist = trustedOrigins();
      if (allowlist === null) return new NextResponse("Not Found", { status: 404 });
      // Strip any inbound vetted marker so a remote caller cannot
      // forge it before reaching the BFF guard. guardCsrf will then
      // enforce Origin/Host using the allowlist.
      return NextResponse.next({ request: { headers: strippedHeaders(request) } });
    }
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
    // Credential-minting routes MUST NOT be reachable via the tunnel,
    // including through the BFF's auto-injected bearer. POST
    // /api/runtime/pairing creates a code that the public
    // /api/pairing/claim trades for a durable device token; chaining
    // them on a tunnel-secret-authorized session yields a permanent
    // credential that outlives the next secret rotation.
    //
    // Compare against a canonicalized form because the BFF catch-all
    // (web/src/lib/runtime.ts:canonicalizeSegments) recursively
    // `decodeURIComponent`s before forwarding, so a literal-string
    // check would miss percent-encoded variants like
    // `/api/runtime/%70airing` (decodes to "pairing"). Recursive
    // decode + traversal-marker rejection here matches the BFF's
    // semantics so any encoding that reaches the runtime as
    // `pairing` is blocked at the proxy first.
    const canonicalStripped = canonicalizeForGate(stripped);
    if (
      request.method === "POST"
      && canonicalStripped !== null
      && (canonicalStripped === "/api/runtime/pairing" || canonicalStripped === "/api/runtime/pairing/")
    ) {
      return new NextResponse(
        JSON.stringify({ error: "Pairing creation is not available through the tunnel. Pair from localhost or an already-paired device." }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }

    // Build redirect Locations off the tunnel-facing Host (the
    // trycloudflare hostname cloudflared forwarded) rather than
    // request.url. Next is bound to 127.0.0.1 with `-H` (see
    // src/cli/process.ts), so `request.url` resolves to
    // `http://127.0.0.1:<port>/...` regardless of what cloudflared
    // received — handing that to NextResponse.redirect would tell the
    // scanning phone's browser to follow Location: http://127.0.0.1...
    // which is unreachable from a phone on the mobile network. The
    // external branch has already verified Host is non-loopback and
    // either the secret-prefix or the session cookie authorized this
    // request, so the Host header is the right public origin to use.
    const externalOrigin = `https://${host}`;

    // Apply the same setup gate localhost requests get, but only on
    // page navigations (not API or _next/* asset fetches that the page
    // makes on the way in).
    if (!stripped.startsWith("/api/") && !stripped.startsWith("/setup")) {
      const configured = await isProviderConfigured();
      if (configured === false) {
        const setupUrl = new URL("/setup", externalOrigin);
        const setupRedirect = NextResponse.redirect(setupUrl);
        if (hasPrefix) attachSession(setupRedirect, secret);
        return setupRedirect;
      }
    }

    // Root-bootstrap (`/<secret>` with no further path): redirect to "/"
    // so the URL bar collapses and the secret stops showing up in browser
    // history, screen-share, and screenshots after first visit. The
    // Set-Cookie on the redirect response authorizes the follow-up GET
    // for "/". Other prefixed paths like `/<secret>/settings` keep
    // rewriting because a redirect there would drop the user's intended
    // deep-link destination.
    if (hasPrefix && stripped === "/") {
      const homeRedirect = NextResponse.redirect(new URL("/", externalOrigin));
      attachSession(homeRedirect, secret);
      return homeRedirect;
    }
    const rewritten = request.nextUrl.clone();
    rewritten.pathname = stripped;
    // Propagate the tunnel-vetted marker upstream to the BFF guard. The
    // request reaches `/api/runtime/[...path]` (or any other rewritten
    // target) with `x-gini-tunnel-vetted: 1` attached and any inbound
    // value stripped — see vettedHeaders() above for the strip-then-set
    // rationale. NextResponse.rewrite forwards modified request headers
    // upstream when passed via `{ request: { headers } }`; without this
    // option Next would deliver the original request headers and the
    // marker would never reach the route handler.
    const response = NextResponse.rewrite(rewritten, { request: { headers: vettedHeaders(request) } });
    if (hasPrefix) attachSession(response, secret);
    return response;
  }

  // Localhost: existing setup gate. Strip any inbound tunnel-vetted
  // marker so a co-tenant process on 127.0.0.1 cannot forge the header
  // to influence the BFF guard — the localhost path's own loopback-Host
  // equality already satisfies guardCsrf, so the marker is unwanted
  // here, and stripping it shrinks the surface a hostile local process
  // could probe.
  const strippedReqHeaders = strippedHeaders(request);
  if (pathname.startsWith("/setup") || pathname.startsWith("/api/")) {
    return NextResponse.next({ request: { headers: strippedReqHeaders } });
  }
  const configured = await isProviderConfigured();
  if (configured === false) {
    const setupUrl = new URL("/setup", request.url);
    return NextResponse.redirect(setupUrl);
  }
  return NextResponse.next({ request: { headers: strippedReqHeaders } });
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

// Recursive `decodeURIComponent` of every path segment, rejecting any
// segment that contains a path separator, `..`, or non-printable bytes
// after decoding. Mirrors the canonicalization the BFF's proxyRequest
// applies before forwarding to the runtime, so a deny-list check at
// the proxy sees the same shape the runtime will eventually receive.
// Returns null when the path can't be canonicalized safely (e.g.,
// embeds traversal markers); callers should treat null as "do not
// proceed" but the current call site only consults the gate for the
// pairing deny, so a null result falls through to normal handling.
const MAX_DECODE_DEPTH = 5;
function canonicalizeForGate(pathname: string): string | null {
  const parts = pathname.split("/");
  const out: string[] = [];
  for (const part of parts) {
    let current = part;
    let stabilized = false;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
      let next: string;
      try { next = decodeURIComponent(current); } catch { return null; }
      if (next === current) { stabilized = true; break; }
      current = next;
    }
    if (!stabilized) return null;
    if (current.includes("/") || current === ".." || current === ".") return null;
    out.push(current);
  }
  return out.join("/");
}

// Detect a localhost-shaped Host header. Previously matched with naive
// `startsWith` which accepted `localhost.attacker.example` and similar
// suffix-shadow hostnames. Anchor the host portion (port stripped) to a
// known-good set instead so a hostile Host header can't masquerade as
// localhost to skip the tunnel-secret gate.
function isLocalHostName(host: string): boolean {
  const lower = host.toLowerCase();
  let bare = lower;
  let portPart: string | null = null;
  // IPv6 literals are bracketed: `[::1]` bare, `[::1]:3072` with port.
  // Strip the brackets and split off the port (if any) only when the
  // port parses as a positive integer. Without that guard,
  // `localhost:evil` would canonicalize to `localhost` and slip
  // through the loopback check. Next is pinned to 127.0.0.1 so only
  // a co-tenant can forge Host headers, but a malformed value should
  // still fail closed.
  if (lower.startsWith("[")) {
    const close = lower.indexOf("]");
    if (close === -1) return false;
    bare = lower.slice(0, close + 1);
    const rest = lower.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return false;
      portPart = rest.slice(1);
    }
  } else {
    const colon = lower.lastIndexOf(":");
    if (colon > -1) {
      bare = lower.slice(0, colon);
      portPart = lower.slice(colon + 1);
    }
  }
  if (portPart !== null && !/^\d+$/.test(portPart)) return false;
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
