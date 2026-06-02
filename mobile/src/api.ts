import * as FileSystem from "expo-file-system/legacy";
import {
  isLocalGatewayHost,
  PUBLIC_HTTP_REJECTION,
  readCachedCredentials,
  type AuthCredentials
} from "./auth";

// Defense-in-depth runtime gate against credentials persisted by an
// older build that didn't enforce the local-only http allowlist (or
// a future regression). Throws so the bearer never leaves the device
// in cleartext via a public http:// URL.
function assertTransportAllowed(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  if (parsed.protocol === "http:" && !isLocalGatewayHost(parsed.hostname)) {
    throw new ApiError(0, PUBLIC_HTTP_REJECTION);
  }
  return parsed;
}

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

  // Defensively re-derive the origin so a malformed value in storage
  // (e.g. one written by an older build that didn't normalize) can't
  // leak query strings into the request URL. Also blocks public-http
  // base URLs before the Authorization header is attached.
  const parsed = assertTransportAllowed(creds.baseUrl);

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

  const url = `${parsed.origin}/api${path}`;
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

// Uploaded image ref returned by POST /api/uploads. Matches the runtime's
// ImageAttachment shape — the client only carries this descriptor and
// attaches it to the next /messages call's `images` array.
export interface UploadRef {
  id: string;
  mimeType: string;
  size: number;
}

// Multipart upload to the gateway. We can't reuse api() because it pins
// content-type: application/json, which would strip the multipart
// boundary. We also can't use fetch() with FormData here: Expo SDK 56
// installs a winter-fetch polyfill whose convertFormDataAsync rejects
// React Native's classic `{uri, name, type}` part shape (see
// node_modules/expo/src/winter/fetch/convertFormData.ts — "Unsupported
// FormDataPart implementation"). FileSystem.uploadAsync streams the
// file from disk through native URLSession, sidestepping the polyfill
// and avoiding loading the bytes into JS memory at all.
async function uploadFile(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured");
  // Same transport guard as api(): block public-http origins before the
  // bearer ever leaves the device, even on the multipart upload path.
  const parsed = assertTransportAllowed(creds.baseUrl);
  const response = await FileSystem.uploadAsync(`${parsed.origin}/api/uploads`, file.uri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "file",
    mimeType: file.mimeType,
    // expo-file-system's multipart has no part-filename option, so the
    // original name reaches the server as an explicit `filename` form field
    // (the upload handler prefers it over the streamed part's cache basename).
    parameters: { filename: file.name },
    headers: { Authorization: `Bearer ${creds.token}` }
  });
  const value = response.body ? safeParse(response.body) : null;
  if (response.status < 200 || response.status >= 300) {
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return value as UploadRef;
}

export function uploadImage(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  return uploadFile(file);
}

// Voice-message upload. The gateway's /api/uploads gate accepts audio/*
// alongside image/*; the recorder hands us a 16 kHz mono WAV with an
// explicit `audio/wav` mimeType so it passes the prefix check.
export function uploadAudio(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  return uploadFile(file);
}

// Absolute URL for a stored upload. The gateway serves the bytes with
// long-lived immutable cache headers; the request still needs the bearer
// token, so callers must pass it via an Image source's `headers` prop.
export function uploadUrl(id: string): string {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured");
  const parsed = assertTransportAllowed(creds.baseUrl);
  return `${parsed.origin}/api/uploads/${encodeURIComponent(id)}`;
}

export function authHeader(): Record<string, string> {
  const creds = readCachedCredentials();
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}` };
}

// A workspace file read via GET /api/files. `content` is the utf8 text (null
// for binary files); `truncated` is set when the file exceeds the gateway's
// read cap. Mirrors web/src/lib/api.ts's WorkspaceFile.
export interface WorkspaceFile {
  path: string;
  absolutePath: string;
  name: string;
  bytes: number;
  content: string | null;
  truncated: boolean;
  binary: boolean;
}

export function fetchWorkspaceFile(path: string): Promise<WorkspaceFile> {
  return api<WorkspaceFile>(`/files?path=${encodeURIComponent(path)}`);
}

// Absolute gateway URL + bearer/device-token headers for a workspace file's
// raw bytes. `inline=1` makes the gateway serve the real content-type (so
// <Image source> can decode it); plain raw streams an octet-stream attachment
// suitable for FileSystem.downloadAsync. Reuses the same transport guard and
// credential resolution as api()/uploadUrl so a public-http base URL can't
// leak the bearer.
export function fileRawSource(
  path: string,
  opts: { inline?: boolean } = {}
): { uri: string; headers: Record<string, string> } {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured");
  const parsed = assertTransportAllowed(creds.baseUrl);
  const inline = opts.inline ? "&inline=1" : "";
  return {
    uri: `${parsed.origin}/api/files?path=${encodeURIComponent(path)}&raw=1${inline}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...resolveDeviceTokenHeader()
    }
  };
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
  // Same transport guard as api(): if a stored URL is public-http,
  // refuse to open the stream rather than leak the bearer.
  const parsed = assertTransportAllowed(creds.baseUrl);
  return {
    url: `${parsed.origin}/api${path}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      // SSE endpoint resolver also injects X-Device-Token so the
      // gateway's per-device watch registry can credit this device's
      // open stream and suppress redundant silent pushes to it.
      ...resolveDeviceTokenHeader()
    }
  };
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
