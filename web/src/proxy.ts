// Next.js Proxy. Runs at the network boundary for every request not excluded
// by the matcher below. Two responsibilities, in order:
//
// 1. Tunnel proxy. Classify Host, gate on the secret-path bootstrap or the
//    session cookie, stamp the `x-gini-tunnel-vetted: 1` marker on tunnel-
//    branch forwards, and 404 anything else. Loopback callers (operator's
//    own Mac) pass through without the marker. See PLAN.md "Architecture"
//    + "Tunnel session cookie".
//
// 2. Setup gate. If no provider is configured the operator is bounced to
//    /setup so the rest of the app doesn't render in a broken state.
//
// The proxy reads `tunnel.secret`, `tunnel.enabled`, and the live tunnel
// public-URL host from disk on every request (uncached) — a `rotate-secret`
// causes every outstanding cookie to mismatch on the very next request, a
// `disable` 404s the next request even with a valid cookie, and a hostname
// rotation after restart invalidates the host-only session cookie.

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalizePath } from "@/lib/canonicalize";
import { parseTrustedOriginUrls } from "@/lib/trusted-origins";
import {
  TUNNEL_MARKER_HEADER,
  TUNNEL_MARKER_VALUE,
  buildTunnelCookie,
  isTunnelDenied,
  matchSecretPrefix,
  readLiveTunnelHost,
  readTunnelConfigFromDisk,
  readTunnelCookie,
  tunnelSecretEquals
} from "@/lib/tunnel-policy";

const PROXY_STATUS_TIMEOUT_MS = 1500;

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(PROXY_STATUS_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { providerConfigured?: unknown };
    return data.providerConfigured === true;
  } catch {
    return null;
  }
}

/** Per-request Host classifier. Three live lanes:
 *
 *  - `loopback`: the operator's own machine (`localhost` / `127.0.0.1` /
 *    `[::1]`). Pass through with the setup gate; the marker is stripped.
 *  - `tunnel`: the live trycloudflare hostname the runtime writes to the
 *    `tunnel.publicUrl` sibling file on enable. Gated on the secret-prefix
 *    bootstrap or the session cookie; the marker is stamped on forwards.
 *  - `trusted`: a stable hostname the operator listed in
 *    `GINI_TRUSTED_ORIGINS` (Tailscale, reverse proxy, whatever stable
 *    front they own). The BFF's CSRF guard handles origin equality on
 *    this lane; the proxy does NOT apply the tunnel's enabled / secret /
 *    cookie checks here. Conflating the two would 404 every trusted
 *    request whenever the tunnel was disabled — a real deployment hazard
 *    for operators who don't use the cloudflare lane at all.
 *
 *  Anything else returns `unknown` and 404s before any secret/cookie
 *  check — defends against DNS-rebinding to an attacker-controlled
 *  hostname per PLAN.md "Architecture" step 3. */
function classifyHost(hostHeader: string | null): "loopback" | "tunnel" | "trusted" | "unknown" {
  if (!hostHeader) return "unknown";
  const lower = hostHeader.toLowerCase();
  const hostOnly = lower.includes("]")
    ? lower.slice(0, lower.lastIndexOf("]") + 1)
    : lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
  if (hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "[::1]") {
    return "loopback";
  }
  // Equality match against the live tunnel hostname (NOT a suffix check on
  // .trycloudflare.com — that would accept any cloudflare-issued host the
  // attacker could mint). The runtime writes tunnel.publicUrl to a sibling
  // file on enable; the proxy reads it per-request so a recycle or disable
  // is visible on the very next hit.
  const liveHost = readLiveTunnelHost();
  if (liveHost) {
    if (hostMatches(lower, liveHost)) return "tunnel";
  }
  // Share the env-var parse + validation with the BFF CSRF guard so the
  // two lanes can't drift apart on what counts as a valid entry (entries
  // with paths/queries/userinfo are rejected here as well as there, per
  // the same fail-loud-on-typo posture). The proxy matches the Host
  // header against `.host` (with default-port equivalence); the BFF
  // matches the Origin header against `${protocol}//${host}` — same
  // validated input, different match field.
  const allowlist = parseTrustedOriginUrls(process.env.GINI_TRUSTED_ORIGINS);
  if (allowlist) {
    for (const url of allowlist) {
      const entryHost = url.host.toLowerCase();
      if (hostMatches(lower, entryHost)) return "trusted";
    }
  }
  return "unknown";
}

/** Compare two Host header values applying the default-port equivalence rule
 *  PLAN.md describes in "CSRF policy": `host` and `host:443` (HTTPS) or
 *  `host:80` (HTTP) are equivalent when one side omits the port. */
function hostMatches(inbound: string, candidate: string): boolean {
  if (inbound === candidate) return true;
  const splitPort = (h: string): { name: string; port: string | null } => {
    if (h.startsWith("[")) {
      const close = h.lastIndexOf("]");
      const name = h.slice(0, close + 1);
      const rest = h.slice(close + 1);
      return { name, port: rest.startsWith(":") ? rest.slice(1) : null };
    }
    const idx = h.indexOf(":");
    return idx < 0 ? { name: h, port: null } : { name: h.slice(0, idx), port: h.slice(idx + 1) };
  };
  const a = splitPort(inbound);
  const b = splitPort(candidate);
  if (a.name !== b.name) return false;
  const isDefault = (port: string | null) => port === null || port === "443" || port === "80";
  return isDefault(a.port) && isDefault(b.port);
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404 });
}

function stampVettedHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete(TUNNEL_MARKER_HEADER);
  cloned.set(TUNNEL_MARKER_HEADER, TUNNEL_MARKER_VALUE);
  return cloned;
}

function stripVettedHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete(TUNNEL_MARKER_HEADER);
  return cloned;
}

function applyResponsePolicy(res: NextResponse): NextResponse {
  // Outbound clicks send only the origin, never the path with the secret.
  res.headers.set("referrer-policy", "strict-origin");
  return res;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl.clone();
  const hostHeader = request.headers.get("host");
  const classification = classifyHost(hostHeader);
  const tunnel = readTunnelConfigFromDisk();
  const canon = canonicalizePath(url.pathname);

  // -------- LOOPBACK + TRUSTED BRANCHES --------
  // Both lanes strip the marker (no upstream classifier proved anything; the
  // BFF guard makes its own decision via loopback-Host or origin-allowlist).
  // The tunnel-specific gates (enabled / secret / cookie) only belong on the
  // tunnel lane — applying them to a trusted-host caller would 404 every
  // request whenever the tunnel was disabled.
  if (classification === "loopback" || classification === "trusted") {
    const headers = stripVettedHeaders(request.headers);
    const next = NextResponse.next({ request: { headers } });
    // Setup gate runs ONLY on loopback. A tunneled phone or a Tailscale-front
    // caller hitting / should not be redirected to /setup since /setup is a
    // localhost-only experience.
    if (classification === "loopback") {
      const { pathname } = url;
      if (!pathname.startsWith("/setup") && !pathname.startsWith("/api/") && !pathname.startsWith("/connect")) {
        const configured = await isProviderConfigured();
        if (configured === false) {
          const setupUrl = new URL("/setup", request.url);
          return applyResponsePolicy(NextResponse.redirect(setupUrl));
        }
      }
    }
    return applyResponsePolicy(next);
  }

  if (classification === "unknown") {
    return notFound();
  }

  // -------- TUNNEL BRANCH --------
  // canon errors land here as a 4xx before any secret/cookie check.
  if (!canon.ok) {
    return new NextResponse("Bad request", { status: 400 });
  }
  if (!tunnel.enabled) return notFound();

  // Try secret-path bootstrap: /<secret>/<rest>. Use the shared matcher so
  // the proxy and the policy module stay byte-equivalent.
  const prefixMatch = matchSecretPrefix(canon.path, tunnel.secret);
  if (prefixMatch) {
    const postPrefix = prefixMatch.suffix;
    if (isTunnelDenied(postPrefix, request.method)) {
      return notFound();
    }
    // Redirect through /connect rather than straight to `/` so the operator's
    // phone has a chance to hand off to the installed gini-mobile app via the
    // `gini://connect?...` URL scheme. The /connect interstitial attempts the
    // scheme handoff and falls back to the mobile web app on a
    // visibilitychange timeout when the app isn't installed. We still mint
    // the session cookie here so the web-app fallback is already authed —
    // the user never has to re-enter the bootstrap URL after the scheme
    // attempt fails. The mobile app, when it does take the handoff, uses
    // the Bearer-token path on the proxy (see Bearer branch below) rather
    // than the cookie.
    const tunnelOrigin = `${url.protocol}//${url.host}`;
    const target = new URL(request.url);
    target.pathname = "/connect";
    target.search =
      `?api=${encodeURIComponent(tunnelOrigin)}` +
      `&web=${encodeURIComponent(tunnelOrigin)}` +
      `&token=${encodeURIComponent(tunnel.secret)}`;
    const redirect = NextResponse.redirect(target, 302);
    redirect.headers.set("set-cookie", buildTunnelCookie(tunnel.secret));
    // The 302 itself carries no-referrer so the brief /<secret>/ URL cannot
    // leak via Referer on subresource fetches the destination page issues.
    // See PLAN.md "URL cleanup after bootstrap".
    redirect.headers.set("referrer-policy", "no-referrer");
    redirect.headers.set("cache-control", "no-store");
    return redirect;
  }

  // Cookie-bearing follow-up requests.
  const cookieValue = readTunnelCookie(request.headers);
  if (cookieValue && tunnelSecretEquals(cookieValue, tunnel.secret)) {
    if (isTunnelDenied(canon.path, request.method)) {
      return notFound();
    }
    const headers = stampVettedHeaders(request.headers);
    const next = NextResponse.next({ request: { headers } });
    return applyResponsePolicy(next);
  }

  // Bearer-token follow-up requests. The installed gini-mobile app receives
  // the secret via the `gini://connect` deep link and sends it on every API
  // call as `Authorization: Bearer <secret>` rather than as a cookie — the
  // mobile RN runtime has no cookie jar that survives across app launches
  // the way Safari does, so the Bearer path is the durable auth surface for
  // the installed app. The compare uses the SAME constant-time helper as
  // the cookie path so neither branch leaks the secret via timing.
  const bearer = readTunnelBearer(request.headers);
  if (bearer && tunnelSecretEquals(bearer, tunnel.secret)) {
    if (isTunnelDenied(canon.path, request.method)) {
      return notFound();
    }
    const headers = stampVettedHeaders(request.headers);
    const next = NextResponse.next({ request: { headers } });
    return applyResponsePolicy(next);
  }

  // No bootstrap, no cookie, no Bearer — 404 (do NOT reveal the existence of
  // the gateway via a richer error).
  return notFound();
}

/** Extract the Bearer token from an `Authorization: Bearer <value>` header.
 *  Returns null when the header is missing, malformed, or uses a different
 *  scheme. The Authorization header itself is case-insensitive per HTTP
 *  (handled by Headers.get); the scheme prefix is matched case-sensitively
 *  with exactly one space because Bearer is the only shape gini-mobile
 *  emits and we want a tight surface rather than a permissive parser. */
function readTunnelBearer(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const match = /^Bearer (.+)$/.exec(raw);
  if (!match) return null;
  return match[1];
}

export const config = {
  // Exclude Next.js static assets and the dev-mode HMR endpoint — the proxy
  // runs at request time and re-running for every /_next/static asset would
  // be wasteful. `_next/webpack-hmr` is the dev server's WebSocket upgrade
  // path; intercepting it as an HTTP request breaks the upgrade handshake,
  // and the browser logs a steady stream of WS connection failures (one per
  // reconnect attempt). Excluding it here lets Next.js's HMR WS upgrade run
  // through to the dev server directly. The path doesn't exist in
  // production builds. The match intentionally covers `/api/*` so the
  // tunnel proxy gates BFF calls too.
  // `icon.png` is the Next.js 16 metadata-route filename for the site
  // favicon — public logo bytes, no sensitive payload. If the proxy gates
  // it, a speculative favicon fetch from the bootstrap-redirect window
  // (no cookie yet) 404s, and the browser caches that 404 across the
  // session so even after auth lands the favicon stays missing.
  matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico|icon.png).*)"]
};
