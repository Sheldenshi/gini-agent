import { readCachedCredentials, type AuthCredentials } from "./auth";
import { inferTunnelTransport } from "./transport";

// Mirrors web/src/lib/api.ts in shape (`api<T>(path, init)`), but talks
// to the runtime gateway directly with a bearer token instead of routing
// through the Next.js BFF.
//
// The path argument is the runtime-relative path WITHOUT the `/api`
// prefix — e.g. `/chat`, `/agents/abc/use` — matching how the web client
// calls api("/chat"). Keeping the call-site shape identical means
// queries.ts looks familiar and is easy to keep in sync with the web's
// queries.ts when fields are added.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// Treat any 4xx/5xx as unauthenticated if it's a 401 from the gateway —
// the auth gate uses this to bounce the user back to setup.
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

interface ApiOptions extends Omit<RequestInit, "headers" | "credentials"> {
  headers?: Record<string, string>;
  // Override the cached gateway credentials (used by the setup screen to
  // validate a NEW baseUrl + token before persisting them). Named `auth`
  // rather than `credentials` to avoid colliding with the standard
  // RequestInit.credentials cookie/CORS field.
  auth?: AuthCredentials;
}

export async function api<T = unknown>(path: string, init: ApiOptions = {}): Promise<T> {
  const creds = init.auth ?? readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured");

  const { auth: _auth, ...rest } = init;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${creds.token}`,
    // Attach the cached APNs device token automatically when present.
    // Routes that key per-device (e.g. /chat/:id/read, /badge) need
    // it; routes that don't simply ignore the header. Resolved
    // lazily via require() so api.ts doesn't create an import cycle
    // with push.ts (which imports api).
    ...resolveDeviceTokenHeader(),
    ...(init.headers ?? {})
  };

  // Defensively re-derive the origin so a malformed value in storage
  // (e.g. one written by an older build that didn't normalize) can't
  // leak query strings into the request URL.
  let origin: string;
  try {
    origin = new URL(creds.baseUrl).origin;
  } catch {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  const url = `${origin}/api${path}`;
  const response = await fetch(url, { ...rest, headers });

  // 204 No Content (or any empty body) — return null cast as T so callers
  // that don't care about the body don't choke on JSON.parse.
  const text = await response.text();
  const value = text ? safeParse(text) : null;
  if (!response.ok) {
    const message =
      (value && typeof value === "object" && "error" in value && typeof value.error === "string")
        ? value.error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return value as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Resolve the absolute gateway URL + auth headers for an SSE subscription.
// react-native-sse opens its own XHR, so we can't reuse the `api()` fetcher;
// this helper centralizes origin normalization and bearer injection so the
// streaming hook doesn't reimplement either. Throws ApiError(401) when no
// credentials are configured — the caller surfaces that the same way the
// /blocks fetch does so the chat detail screen's redirect-to-setup effect
// still fires.
export function resolveStreamEndpoint(path: string): {
  url: string;
  headers: Record<string, string>;
} {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured");
  let origin: string;
  try {
    origin = new URL(creds.baseUrl).origin;
  } catch {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  return {
    url: `${origin}/api${path}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      // SSE endpoint resolver also injects X-Device-Token so the
      // gateway's per-device watch registry can credit this device's
      // open stream and suppress redundant silent pushes to it.
      ...resolveDeviceTokenHeader()
    }
  };
}

/** True when the cached gateway base URL points at a Cloudflare quick
 *  tunnel hostname (`*.trycloudflare.com`, case-insensitive). Quick
 *  tunnels drop `text/event-stream` at the edge, so chat streaming has
 *  to fall back to long-polling — `react-native-sse` would otherwise
 *  open an XHR that never receives frames. Returns false on missing /
 *  malformed credentials so the SSE path (which handles its own 401)
 *  stays the default.
 *
 *  Delegates host classification to the shared `inferTunnelTransport`
 *  helper so the mobile, web, and runtime copies stay in lockstep —
 *  parity is pinned in src/runtime/tunnel/transport.parity.test.ts. */
export function gatewayUsesQuickTunnel(): boolean {
  const creds = readCachedCredentials();
  return inferTunnelTransport(creds?.baseUrl ?? null) === "poll";
}

// Pull the cached APNs token from push.ts on every call. We avoid a
// static import because push.ts depends on this module (transitively
// through ApiError), and bundlers handle the cycle inconsistently
// when require()'d lazily. Returns an empty object when no token is
// cached so the header simply isn't sent.
function resolveDeviceTokenHeader(): Record<string, string> {
  try {
    const pushModule = require("./push") as { getCachedDeviceToken?: () => string | null };
    const token = pushModule.getCachedDeviceToken?.();
    if (token) return { "X-Device-Token": token };
  } catch {
    // Test envs without RN: push.ts side effects fail to load; that's
    // fine — the header is best-effort.
  }
  return {};
}
