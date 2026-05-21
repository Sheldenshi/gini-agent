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
const PRIVILEGED_POST_ROUTES = new Set([
  "update",
  "update/check",
  "embedding/reembed"
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
  const guard = guardPrivilegedRequest(request, pathSegments);
  if (guard) return guard;

  const upstreamUrl = new URL(request.url);
  const target = `${options.runtimeUrl}/api/${pathSegments.join("/")}${upstreamUrl.search}`;
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

function guardPrivilegedRequest(request: Request, pathSegments: string[]): Response | null {
  const route = pathSegments.join("/");
  if (request.method !== "POST" || !PRIVILEGED_POST_ROUTES.has(route)) return null;

  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
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
