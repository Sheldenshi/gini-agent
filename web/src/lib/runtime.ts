import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Headers we forward verbatim from the browser to the runtime. Last-Event-ID
// is critical for SSE reconnect dedup (see src/http.ts:eventStream) — without
// it, every reconnect re-replays the entire event log.
const FORWARD_HEADERS = new Set(["content-type", "accept", "cache-control", "last-event-id"]);
// Routes the BFF must gate behind origin + sec-fetch-site checks.
// The default forwarding path injects the gateway bearer token
// server-side, so a cross-origin POST from a victim's browser
// reaches the gateway authenticated. Without this guard, an
// attacker page can trigger any non-listed POST as the operator.
// `embedding/reembed` is destructive enough to belong here even
// though it doesn't lose data — `allBanks: true` runs an expensive
// embedding pass against every bank in the instance, a DoS vector
// for any operator who's paying per-token for embeddings.
// `messaging/<bridge>/<verb>` covers the operator-only bot allowlist
// surface (allow / deny / reject-pending / disable / remove /
// health / send / receive) — any of those forwarded cross-origin
// would let an attacker page mutate the bot's allowlist or fire
// outbound messages as the operator. The bare `messaging` POST
// creates a brand-new bridge (with a bot token) under the operator's
// identity, so it has to land in the same guard or a cross-origin
// page can plant attacker-supplied ingress.
const PRIVILEGED_POST_ROUTES: ReadonlyArray<RegExp> = [
  /^update$/,
  /^update\/check$/,
  /^embedding\/reembed$/,
  /^messaging$/,
  /^messaging\/[^/]+\/(allow|deny|reject-pending|disable|remove|health|send|receive)$/
];

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

  const guard = guardPrivilegedRequest(request, canonical);
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
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
  });
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

function guardPrivilegedRequest(request: Request, pathSegments: string[]): Response | null {
  if (request.method !== "POST") return null;
  const route = pathSegments.join("/");
  if (!PRIVILEGED_POST_ROUTES.some((pattern) => pattern.test(route))) return null;

  // Compare the browser-supplied Origin against the Host header the
  // browser actually used. Next.js dev (and most reverse-proxy /
  // tunnel setups) carry a stale internal hostname in `request.url`
  // — typically `localhost:<port>` — regardless of the public URL,
  // so the old strict `Origin === new URL(request.url).origin`
  // comparison rejected every legitimate non-localhost client.
  // Matching against Host preserves the CSRF defense (a cross-origin
  // attacker page has a different Origin host than the BFF's own
  // Host header) while letting tailnet / tunnel / hostname access
  // through. When the Host header is absent (synthetic Request
  // objects in tests, non-browser HTTP/2 clients that send :authority
  // instead) we fall back to request.url's host so the legacy
  // localhost-equality check still applies. Sec-Fetch-Site below
  // remains the primary signal — the browser sets it and JS can't
  // spoof it.
  const origin = request.headers.get("origin");
  if (origin) {
    const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (originHost !== expectedHost) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
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
