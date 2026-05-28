import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrustedOriginUrls } from "./trusted-origins";

// Headers we forward verbatim from the browser to the runtime. Last-Event-ID
// is critical for SSE reconnect dedup (see src/http.ts:eventStream) — without
// it, every reconnect re-replays the entire event log. X-Device-Token is
// required for /api/badge + /api/chat/:id/read; the mobile app sends it on
// every authenticated call so the gateway can attribute the device.
const FORWARD_HEADERS = new Set([
  "content-type",
  "accept",
  "cache-control",
  "last-event-id",
  "x-device-token"
]);

// Cache the file-read values across requests but invalidate on mtime change,
// so a gateway respawn that picks a different port doesn't strand the BFF
// pointing at the old port. We cache for 2s minimum to avoid stat'ing on
// every single request when a SSE stream is open.
interface FileCache {
  // The mtimeMs we read at; null when the file was missing.
  mtime: number | null;
  value: string;
  readAt: number;
}
const fileCacheTtlMs = 2000;
const fileCache: Map<string, FileCache> = new Map();

function readFileWithMtimeCache(path: string): string | null {
  const now = Date.now();
  const cached = fileCache.get(path);
  if (cached && now - cached.readAt < fileCacheTtlMs) return cached.value || null;

  if (!existsSync(path)) {
    fileCache.set(path, { mtime: null, value: "", readAt: now });
    return null;
  }
  let mtime: number | null = null;
  try { mtime = statSync(path).mtimeMs; } catch { /* ignore */ }
  if (cached && cached.mtime !== null && mtime === cached.mtime) {
    cached.readAt = now;
    return cached.value || null;
  }
  try {
    const value = readFileSync(path, "utf8").trim();
    fileCache.set(path, { mtime, value, readAt: now });
    return value || null;
  } catch {
    fileCache.set(path, { mtime, value: "", readAt: now });
    return null;
  }
}

function stateRoot(): string {
  return process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(process.env.HOME ?? homedir(), ".gini");
}

export function runtimeInstance(): string {
  return process.env.GINI_INSTANCE ?? "default";
}

// Resolve the gateway URL with this precedence:
//   1. GINI_RUNTIME_URL (explicit override — `gini start` injects this).
//   2. ~/.gini/instances/<inst>/runtime.port (written by src/server.ts on
//      boot). This lets the BFF survive a gateway restart that picks a
//      different port without the user restarting the web process.
//   3. Hardcoded http://127.0.0.1:7778 fallback (production `default` instance).
export function runtimeUrl(): string {
  if (process.env.GINI_RUNTIME_URL) return process.env.GINI_RUNTIME_URL;
  const portFile = join(stateRoot(), "instances", runtimeInstance(), "runtime.port");
  const port = readFileWithMtimeCache(portFile);
  if (port) return `http://127.0.0.1:${port}`;
  return "http://127.0.0.1:7778";
}

// Resolve the gateway bearer token with this precedence:
//   1. GINI_TOKEN (explicit override — `gini start` injects this).
//   2. ~/.gini/instances/<inst>/config.json (.token field). The token is
//      persisted in config and stable across restarts, but the bearer at
//      web-start time can become stale if the user runs `gini reset` or
//      reinstalls the instance — reading from disk picks up the new value.
//   3. Empty string (will produce 401s, surfaced to the user instead of
//      hanging requests).
export function runtimeToken(): string {
  if (process.env.GINI_TOKEN) return process.env.GINI_TOKEN;
  const configPath = join(stateRoot(), "instances", runtimeInstance(), "config.json");
  const raw = readFileWithMtimeCache(configPath);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

export interface ProxyOptions {
  runtimeUrl: string;
  token: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export async function proxyRequest(
  request: Request,
  pathSegments: string[],
  options: ProxyOptions
): Promise<Response> {
  // Canonicalize before guard + forward. Without this, a request to
  // /api/runtime/x/%252e%252e/messaging/<bridge>/allow reaches the BFF as
  // pathSegments ["x", "%2e%2e", "messaging", "<bridge>", "allow"] — the
  // guard regex misses (path doesn't start with "messaging"), the BFF
  // forwards via fetch(), which collapses the dot-segment in flight, and
  // the gateway happily executes allowChat under the operator's bearer.
  // Recursively decoding each segment and rejecting traversal/slash
  // markers closes the bypass before either the regex check or the
  // outbound URL construction.
  const canonical = canonicalizeSegments(pathSegments);
  if (!canonical) return Response.json({ error: "Invalid path" }, { status: 400 });

  const guard = guardCsrf(request, canonical);
  if (guard) return guard;

  const upstreamUrl = new URL(request.url);
  // Re-encode each canonicalized segment so URL-special characters that
  // survived canonicalization (`?`, `#`, `;`, raw `%`, etc.) cannot
  // re-acquire structural meaning when Bun's fetch parses the target. The
  // BFF's view of the path now matches the upstream's byte-for-byte: if
  // the guard didn't see "messaging/<bridge>/allow", the gateway won't
  // either.
  const encodedPath = canonical.map((segment) => encodeURIComponent(segment)).join("/");
  const target = `${options.runtimeUrl}/api/${encodedPath}${upstreamUrl.search}`;
  const headers = pickForwardHeaders(request.headers);
  headers.set("authorization", `Bearer ${options.token}`);
  const init: RequestInit = { method: request.method, headers };
  const signal = options.signal ?? request.signal;
  if (signal) init.signal = signal;
  if (!["GET", "HEAD"].includes(request.method)) {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }
  const fetcher = options.fetcher ?? fetch;
  const upstream = await fetcher(target, init);
  const isStream = upstream.headers.get("content-type")?.includes("text/event-stream");
  if (isStream) {
    // Return the upstream body directly without materializing — preserves chunking
    // and back-pressure. Client disconnect closes the upstream via request.signal.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }
  const text = await upstream.text();
  const outHeaders: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/json"
  };
  // Forward a small allowlist of response headers from the upstream runtime.
  // The QR endpoints (and any future bearer-gated response that needs
  // browser-caching control) set `Cache-Control: no-store`; without this
  // passthrough the BFF would silently allow a browser to cache the QR
  // pixels — which encode the bootstrap URL. Other entries are headers a
  // BFF typically wants to forward (content-disposition for downloads,
  // etag/last-modified for revalidation, vary for cache key correctness).
  const PASSTHROUGH_RESPONSE_HEADERS = [
    "cache-control",
    "etag",
    "last-modified",
    "vary",
    "content-disposition",
    "content-language",
    "content-encoding"
  ];
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) outHeaders[name] = v;
  }
  return new Response(text, { status: upstream.status, headers: outHeaders });
}

// Decode each segment until stable and reject anything that would let the
// upstream see a different path than the BFF guard does — empty segments,
// `.` / `..`, embedded `/`, or any non-printable byte. Returns null when the
// request must be refused outright. Used by proxyRequest to keep the regex
// match honest about what the gateway will execute.
const MAX_DECODE_DEPTH = 5;
function canonicalizeSegments(segments: string[]): string[] | null {
  const out: string[] = [];
  for (let segment of segments) {
    let stabilized = false;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (next === segment) {
        stabilized = true;
        break;
      }
      segment = next;
    }
    // A segment that is still decoding after MAX_DECODE_DEPTH iterations is
    // adversarially encoded and we refuse to guess the canonical form.
    if (!stabilized) return null;
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
    if (/[\x00-\x1f\x7f]/.test(segment)) return null;
    out.push(segment);
  }
  return out;
}

// Parse GINI_TRUSTED_ORIGINS into a Set of normalized origin strings
// (scheme://host[:port], no trailing slash, no path). Each entry must be a
// complete origin; bare hostnames are rejected. See ADR bff-trust-boundary.md
// for the trust-boundary decision and DNS-rebinding threat model.
//
// Tri-state return:
//   null  → env var is unset; loopback-only Host-equality fallback applies.
//   Set   → at least one valid origin parsed; the Set is the allowlist.
//   empty → operator set the env var but every entry was malformed; the guard
//           fails closed (refuses every privileged POST). This is the
//           defense-in-depth posture for a typo in a control that exists
//           specifically to lock down the trust boundary.
function parseTrustedOrigins(raw: string | undefined): ReadonlySet<string> | null {
  const urls = parseTrustedOriginUrls(raw);
  if (urls === null) return null;
  const out = new Set<string>();
  for (const parsed of urls) {
    out.add(`${parsed.protocol}//${parsed.host}`);
  }
  return out;
}

// Read process.env each call rather than caching at module import. The
// allowlist is short and the parse is trivial — re-running it per
// privileged POST costs a few microseconds, the requests aren't a hot
// path, and tests can now drive the guard's behavior by setting or
// deleting GINI_TRUSTED_ORIGINS in the test process without restarting
// the module loader. Without this, integration tests that exercise the
// BFF guard via proxyRequest would behave differently depending on
// whether the operator's dev shell had the env var exported — a real
// test-environment dependency, not just a theoretical one.
function trustedOrigins(): ReadonlySet<string> | null {
  return parseTrustedOrigins(process.env.GINI_TRUSTED_ORIGINS);
}

// Loopback hostnames the guard's local-dev fallback accepts when no
// allowlist is configured. Anything else is DNS-rebindable from a public
// origin and must be locked down with GINI_TRUSTED_ORIGINS.
function isLoopbackHost(host: string): boolean {
  // Strip the optional :port suffix. IPv6 literals are wrapped in brackets,
  // so look at everything up to the last ":" only when no closing bracket
  // follows. URL.host normalizes IPv6 to "[::1]:port" form.
  const closeBracket = host.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? host.slice(0, closeBracket + 1)
    : host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  return hostnameOnly === "localhost" || hostnameOnly === "127.0.0.1" || hostnameOnly === "[::1]";
}

// Tier the guard by method:
// - Unsafe methods (POST/PUT/PATCH/DELETE): require Origin. Modern browsers
//   always send it; absence indicates a non-browser client (curl/scripts/
//   misconfigured proxies) and those should talk to the gateway directly
//   with their own token, not the BFF's bearer-injection surface.
// - Safe methods (GET/HEAD): allow missing Origin. Non-browser clients
//   doing read-only inspection via the BFF (legacy callers) keep working.
//   When Origin IS present (browser fetch), it's still checked — a DNS-
//   rebinding page sends Origin honestly to the attacker-controlled host,
//   so the allowlist/loopback check still catches it.
//
// The guard runs on every request, not just the prior PRIVILEGED_POST_ROUTES
// list — readable surfaces like /state and the bare /pairing/claim POST
// that mints device tokens were previously un-guarded and DNS-rebindable.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function guardCsrf(request: Request, _pathSegments: string[]): Response | null {
  const origin = request.headers.get("origin");
  const isUnsafe = UNSAFE_METHODS.has(request.method);
  // The proxy stamps `x-gini-tunnel-vetted: 1` only after passing its own
  // Host classifier (live tunnel hostname or a GINI_TRUSTED_ORIGINS entry).
  // When vetted=1 is set on the inbound request, the Host classifier already
  // ran upstream; relaxing the Host check here is what lets a tunneled phone
  // reach the BFF without setting GINI_TRUSTED_ORIGINS. Origin equality
  // (when Origin is present) and the Sec-Fetch-Site gate below still fire
  // independently — see PLAN.md "CSRF policy".
  const vetted = request.headers.get("x-gini-tunnel-vetted") === "1";
  if (!origin) {
    // Mobile React Native fetch never sends Origin. When the proxy has
    // already vetted the inbound request (Host classifier + cookie/Bearer
    // secret compare) and stamped the marker, an unsafe-method POST without
    // Origin is legitimate — accept it before the Origin-required gate
    // rejects every tunneled POST. The Sec-Fetch-Site check below still
    // fires for vetted requests that happen to carry the header.
    if (isUnsafe && !vetted) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    // Safe method (GET/HEAD) without Origin. Browsers may omit Origin on
    // same-origin safe requests, which is the exact shape a DNS-rebound
    // page produces (the browser thinks it's same-origin to attacker.
    // example post-rebind). Validate the Host here so a non-loopback
    // exposure still requires GINI_TRUSTED_ORIGINS to be set — Origin-
    // less GETs from a rebound page hitting a tailnet/tunnel BFF will
    // 403 because Host is non-loopback. Non-browser callers on
    // loopback (curl, scripts) keep working.
    if (!vetted) {
      const allowlist = trustedOrigins();
      if (allowlist) {
        // Operator opted into the strict allowlist. There's no Origin to
        // compare, so we can't tell whether this is a legitimate same-
        // origin GET or a rebound page that omitted Origin. Fail closed:
        // any non-browser caller can hit the gateway directly with its
        // own token, and a browser would have sent Origin.
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
      if (!isLoopbackHost(expectedHost)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  } else {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    // GINI_TRUSTED_ORIGINS is the production-shape defense against DNS
    // rebinding. When set, only requests whose Origin exactly matches one
    // of the listed scheme+host[+port] entries pass. A rebinding attack
    // sets Origin honestly to the attacker-controlled hostname (the
    // browser sets Origin to the URL the operator visited), so an
    // explicit allowlist breaks the bypass that a Host-equality check
    // alone cannot — the browser legitimately sends Host equal to
    // attacker.example after a rebind, and the Host comparison accepts
    // it. The allowlist takes that codepath off the table for any
    // operator who configures it. If the operator set the env var but
    // every entry was malformed (empty Set), we fail closed — refuse
    // every request — rather than silently downgrading to the rebindable
    // fallback.
    const allowlist = trustedOrigins();
    if (allowlist) {
      const normalized = `${originUrl.protocol}//${originUrl.host}`;
      // A tunneled browser session sends Origin equal to the rotating
      // cloudflared hostname, which an operator using a stable hostname
      // (and a separate GINI_TRUSTED_ORIGINS allowlist) won't have on the
      // allowlist. The vetted marker is upstream-verified proof that the
      // proxy's own Host classifier accepted the inbound Host, AND the
      // browser's same-origin policy means Origin must already equal Host
      // for the marker to have been stamped — see PLAN.md "CSRF policy"
      // and the proxy's Host classifier at web/src/proxy.ts. Accept the
      // vetted request when Origin == Host even without an allowlist
      // entry; the allowlist still authoritatively rejects non-vetted
      // cross-origin callers.
      const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
      const originMatchesHost = originUrl.host === expectedHost;
      if (!allowlist.has(normalized) && !(vetted && originMatchesHost)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      // Local-dev fallback when GINI_TRUSTED_ORIGINS is unset. Compare the
      // browser-supplied Origin host against the Host header the browser
      // actually used. Restrict the fallback to loopback Host values
      // (localhost, 127.0.0.1, [::1]) so a BFF exposed on tailnet /
      // tunnel / public-DNS hostname cannot be approached by a DNS-
      // rebinding page that legitimately sets both Origin and Host to
      // an attacker-controlled name. Operators running on a non-
      // loopback hostname MUST set GINI_TRUSTED_ORIGINS — without it,
      // the guard refuses every request so the rebindable path is
      // fully closed. The vetted=1 marker bypasses the loopback-Host
      // restriction because the proxy's Host classifier already
      // verified the inbound Host against the live tunnel hostname or
      // an allowlist entry — see PLAN.md "CSRF policy".
      const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
      if (!vetted && !isLoopbackHost(expectedHost)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (originUrl.host !== expectedHost) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}

export async function runtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${runtimeToken()}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  return fetch(`${runtimeUrl()}${path}`, { ...init, headers });
}

export async function runtimeJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await runtimeFetch(path, init);
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function pickForwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (FORWARD_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
