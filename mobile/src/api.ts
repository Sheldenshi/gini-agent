import { readCachedCredentials, type AuthCredentials } from "./auth";

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
