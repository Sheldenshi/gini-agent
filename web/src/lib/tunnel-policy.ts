// Tunnel policy helpers shared by the Next.js proxy (web/src/proxy.ts) and
// the BFF guard (web/src/lib/runtime.ts). Pure functions over the canonical
// pathname: deny / rewrite / cookie / secret-prefix decisions. The proxy
// also handles Host classification and the session-cookie mint; this file
// holds the path-and-method logic both layers share.
//
// This module must stay browser-safe — it is imported (transitively) by
// `"use client"` components via `web/src/lib/queries.ts` and
// `web/src/lib/useRuntimeStream.ts`. Anything that touches `node:fs` /
// `node:os` / `node:path` lives in `tunnel-policy.server.ts` instead, so
// Turbopack never tries to bundle a Node built-in for the browser.
//
// See docs/adr/tunnel-and-mobile-access.md "Architecture (summary)" and
// "Trust radius" + docs/adr/bff-trust-boundary.md.

export const TUNNEL_MARKER_HEADER = "x-gini-tunnel-vetted";
export const TUNNEL_MARKER_VALUE = "1";
export const TUNNEL_COOKIE_NAME = "gini_tunnel_session";

/** Strip a trailing slash for equivalence matching. Returns "/" unchanged. */
export function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const PAIRING_PREFIX = "/api/runtime/pairing";
const TUNNEL_PREFIX = "/api/runtime/tunnel";

/** True when the request must be denied through the tunnel. Operates on the
 *  BFF-visible canonical form (`/api/runtime/<rest>`) and the request method.
 *
 *  Policy (the operator explicitly opted into surfacing the
 *  tunnel-control UI on the
 *  tunneled view, gated by the click-to-reveal blur on the QR, the bold
 *  "live credential" warnings, and confirm dialogs on Disable / Rotate):
 *
 *  - Pairing subtree (`/api/runtime/pairing` + sub-paths, all methods):
 *    DENY. Minting device bearers from a tunneled session is a real
 *    privilege escalation — a leaked URL holder must not be able to
 *    walk it forward into a permanent device token.
 *  - APNs device registration (`/api/runtime/push/devices`): ALLOW. Rows
 *    inserted through the tunnel are tagged `origin = 'tunnel'` on the
 *    runtime side and wiped whenever the operator rotates the secret or
 *    disables the tunnel. The tunneled lane is the legitimate path for a
 *    QR-onboarded iPhone to register for approval_requested pushes; the
 *    purge on rotate/disable is what bounds a leaked URL holder's
 *    subscription window.
 *  - Tunnel root (`/api/runtime/tunnel`, all methods): ALLOW. GET returns
 *    the privileged snapshot; PATCH lets the tunneled view enable /
 *    disable / rotate-secret / toggle Apple Notes through the confirm
 *    dialogs.
 *  - QR endpoints (`/api/runtime/tunnel/qr.svg`, `/qr.txt`): ALLOW. The
 *    pixels do encode the bootstrap URL, but the operator surfaces them
 *    behind a click-to-reveal blur + an explicit privacy warning.
 *  - Notes refresh (`/api/runtime/tunnel/refresh-notes`): ALLOW. The
 *    tunneled view exposes the same Apple Notes mirror toggle that the
 *    loopback settings card does, and a tunneled operator needs to be
 *    able to drive a one-off re-sync after enabling the mirror or
 *    after a recycle. The osascript itself runs on the operator's Mac
 *    — the tunneled caller only triggers it; it cannot exfiltrate
 *    Notes content.
 *  - Any future `/api/runtime/tunnel/<sub>` route: DENY by default.
 *    Adding a new endpoint should be a deliberate ALLOW, not a silent
 *    unlock.
 */
export function isTunnelDenied(canonicalPath: string, method: string): boolean {
  const upper = method.toUpperCase();
  const trimmed = withoutTrailingSlash(canonicalPath);
  // Pairing — minting permanent device bearers — is denied on every method.
  if (trimmed === PAIRING_PREFIX) return true;
  if (canonicalPath.startsWith(`${PAIRING_PREFIX}/`)) return true;
  // Bare tunnel root: only the methods the live API supports (GET for
  // the snapshot, PATCH for enable / disable / rotate / Apple Notes
  // toggle). A future POST / PUT / DELETE / etc. would otherwise pass
  // the deny list before the runtime even sees it; default-deny here
  // forces an explicit allow when a new method gets wired up.
  if (trimmed === TUNNEL_PREFIX) return !(upper === "GET" || upper === "PATCH");
  // QR endpoints — GET-only by design (the bytes themselves carry the
  // bootstrap URL; the runtime emits them with `cache-control: no-store`).
  if (trimmed === `${TUNNEL_PREFIX}/qr.svg`) return upper !== "GET";
  if (trimmed === `${TUNNEL_PREFIX}/qr.txt`) return upper !== "GET";
  // Notes refresh — POST-only side effect (it triggers the runtime to
  // write the bootstrap URL to the Apple Notes mirror, GET shouldn't
  // mutate iCloud).
  if (trimmed === `${TUNNEL_PREFIX}/refresh-notes`) return upper !== "POST";
  // Any other `/api/runtime/tunnel/<sub>` path is default-deny — adding
  // a new endpoint must be a deliberate allow, not a silent unlock.
  if (canonicalPath.startsWith(`${TUNNEL_PREFIX}/`)) return true;
  return false;
}

/** Match a candidate secret prefix in the canonical path. Returns the secret
 *  string when the path is exactly `/<secret>` or starts with `/<secret>/`,
 *  along with the suffix to redirect to. */
export function matchSecretPrefix(canonicalPath: string, secret: string): { match: true; suffix: string } | null {
  if (!secret) return null;
  // Bare /<secret>
  if (canonicalPath === `/${secret}`) return { match: true, suffix: "/" };
  if (canonicalPath === `/${secret}/`) return { match: true, suffix: "/" };
  // /<secret>/<rest>
  if (canonicalPath.startsWith(`/${secret}/`)) {
    return { match: true, suffix: canonicalPath.slice(`/${secret}`.length) };
  }
  return null;
}

/** Constant-time byte equality. Avoids early-exit on length mismatch. */
export function tunnelSecretEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aLen = a.length;
  const bLen = b.length;
  const len = Math.max(aLen, bLen);
  let diff = aLen ^ bLen;
  for (let i = 0; i < len; i += 1) {
    const ac = i < aLen ? a.charCodeAt(i) : 0;
    const bc = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}

export const TUNNEL_COOKIE_MAX_AGE_SECONDS = 86_400;

/** Build the Set-Cookie header value for a session cookie carrying the secret.
 *  Domain is omitted intentionally — the cookie is host-only and tied to the
 *  rotating trycloudflare hostname; a new hostname after restart implicitly
 *  invalidates the cookie. */
export function buildTunnelCookie(secret: string): string {
  return [
    `${TUNNEL_COOKIE_NAME}=${secret}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${TUNNEL_COOKIE_MAX_AGE_SECONDS}`
  ].join("; ");
}

/** Read the tunnel session cookie from a request's Cookie header. */
export function readTunnelCookie(headers: Headers): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  // Cookie header is name=value pairs separated by `; `. We need to handle
  // each candidate independently — a malformed pair shouldn't drop the rest.
  for (const piece of raw.split(";")) {
    const trimmed = piece.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (name !== TUNNEL_COOKIE_NAME) continue;
    return trimmed.slice(eq + 1);
  }
  return null;
}

/** Length sanity check for the secret-prefix candidate. The base64url-encoded
 *  192-bit secret is 32 characters, but we accept any length up to a small
 *  cap to keep the policy flexible for the future-larger-secret case. */
export function looksLikeSecretSegment(value: string): boolean {
  if (!value) return false;
  if (value.length < 8 || value.length > 128) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** True when the origin is a Cloudflare quick-tunnel hostname. Centralized
 *  so adding more transport types later happens in one place. Uses URL
 *  parsing rather than naive endsWith so suffix-confusion strings like
 *  `https://example.trycloudflare.com.evil.com` don't slip through.
 *  Returns false for non-URL inputs (parse failure) and for any non-
 *  trycloudflare hostname. */
export function isQuickTunnelOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.toLowerCase().endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}
