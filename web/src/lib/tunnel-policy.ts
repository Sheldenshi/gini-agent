// Tunnel policy helpers shared by the Next.js proxy (web/src/proxy.ts) and
// the BFF guard (web/src/lib/runtime.ts). Pure functions over the canonical
// pathname: deny / rewrite / cookie / secret-prefix decisions. The proxy
// also handles Host classification and the session-cookie mint; this file
// holds the path-and-method logic both layers share.
//
// See PLAN.md "Deny list through the tunnel" + "Path canonicalization".

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SECRET_LENGTH_DEFAULT = 32; // base64url-encoded 192-bit secret

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
 *  Policy (revised from PLAN.md's original conservative deny list — the
 *  operator explicitly opted into surfacing the tunnel-control UI on the
 *  tunneled view, gated by the click-to-reveal blur on the QR, the bold
 *  "live credential" warnings, and confirm dialogs on Disable / Rotate):
 *
 *  - Pairing subtree (`/api/runtime/pairing` + sub-paths, all methods):
 *    DENY. Minting device bearers from a tunneled session is a real
 *    privilege escalation — a leaked URL holder must not be able to
 *    walk it forward into a permanent device token.
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
  void method;
  const trimmed = withoutTrailingSlash(canonicalPath);
  if (trimmed === PAIRING_PREFIX) return true;
  if (canonicalPath.startsWith(`${PAIRING_PREFIX}/`)) return true;
  if (trimmed === TUNNEL_PREFIX) return false;
  if (trimmed === `${TUNNEL_PREFIX}/qr.svg`) return false;
  if (trimmed === `${TUNNEL_PREFIX}/qr.txt`) return false;
  if (trimmed === `${TUNNEL_PREFIX}/refresh-notes`) return false;
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

function instanceStateDir(): string {
  const instance = process.env.GINI_INSTANCE ?? "default";
  const stateRoot = process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(process.env.HOME ?? homedir(), ".gini");
  return join(stateRoot, "instances", instance);
}

/** Read the live tunnel config from disk on every call. The PLAN.md
 *  invariant ("proxy reads tunnel.secret + tunnel.enabled on every request,
 *  uncached") means rotate-secret / disable cycles invalidate cookies on
 *  the very next hit without coordination. */
export function readTunnelConfigFromDisk(): { enabled: boolean; secret: string } {
  const configFile = join(instanceStateDir(), "config.json");
  if (!existsSync(configFile)) return { enabled: false, secret: "" };
  try {
    const raw = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as { tunnel?: { enabled?: unknown; secret?: unknown } };
    return {
      enabled: parsed.tunnel?.enabled === true,
      secret: typeof parsed.tunnel?.secret === "string" ? parsed.tunnel.secret : ""
    };
  } catch {
    return { enabled: false, secret: "" };
  }
}

/** Read the live tunnel public URL host from the sibling file the runtime
 *  publishes (`~/.gini/instances/<inst>/tunnel.publicUrl`). The proxy uses
 *  this for an EQUALITY host match per PLAN.md "Architecture" step 3,
 *  rather than a permissive `.trycloudflare.com` suffix check. Returns the
 *  empty string when the file is missing (no live tunnel) — the proxy
 *  treats that as "no tunnel branch matches" and rejects at the Host
 *  classifier. */
export function readLiveTunnelHost(): string {
  const p = join(instanceStateDir(), "tunnel.publicUrl");
  if (!existsSync(p)) return "";
  try {
    const url = readFileSync(p, "utf8").trim();
    if (!url) return "";
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
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

void SECRET_LENGTH_DEFAULT;
