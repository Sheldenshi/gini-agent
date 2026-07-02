import { GATEWAY_RESTARTING_MESSAGE, GATEWAY_UNREACHABLE_CODE } from "./gateway-codes";

// Error thrown by api(). `status` is the HTTP status when the BFF/gateway
// produced a response; `unreachable` marks the transient gateway-down shape
// (the BFF's 503 gateway_unreachable envelope) so callers can render a
// "reconnecting" treatment instead of a hard failure.
export type ApiError = Error & { status?: number; unreachable?: boolean };

function apiError(message: string, status: number, unreachable: boolean): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  if (unreachable) error.unreachable = true;
  return error;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  // Parse from text, not response.json(): a gateway restart used to surface
  // here as response.json() throwing a raw SyntaxError ("Unexpected end of
  // JSON input") on an empty 500 body. Reading text first keeps
  // every non-JSON body (empty, truncated, HTML error page) on the tagged
  // ApiError path instead.
  const text = await response.text();
  type ErrorEnvelope = { error?: string; message?: string; ok?: boolean; code?: string };
  let value: ErrorEnvelope | null = null;
  try {
    value = text ? (JSON.parse(text) as ErrorEnvelope) : null;
  } catch {
    value = null;
  }
  if (!response.ok) {
    // Two error-body shapes flow through the gateway:
    //   - Generic 4xx/5xx: { error: "..." } (set by json(..., status) calls).
    //   - Fill-secret / connector routes: { ok: false, message: "..." }
    //     (the runtime emits a runtime-action result envelope).
    // Read both so non-2xx fill_secret responses surface the
    // actionable message instead of falling back to "HTTP 400".
    // The BFF answers for a down gateway with 503 + code "gateway_unreachable";
    // an unparseable 5xx body is treated the same (a proxy hop dropped the
    // connection mid-response) so the UI never hard-errors on a restart blip.
    const unreachable = value?.code === GATEWAY_UNREACHABLE_CODE || (value === null && response.status >= 500);
    const fallback = unreachable ? GATEWAY_RESTARTING_MESSAGE : `HTTP ${response.status}`;
    throw apiError(value?.error ?? value?.message ?? fallback, response.status, unreachable);
  }
  if (value === null && text.trim().length > 0) {
    // A 2xx body that isn't JSON means the response was corrupted in flight
    // (truncated stream, proxy interference). Surface a tagged transport
    // error rather than the old raw SyntaxError.
    throw apiError("Gini returned an unreadable response — retrying may help.", response.status, false);
  }
  return value as T;
}

export function streamUrl(path: string): string {
  return `/api/runtime${path}`;
}

// Uploaded image ref returned by POST /api/uploads. The bytes live on the
// gateway side; the client only ever carries this small descriptor.
export interface UploadRef {
  id: string;
  mimeType: string;
  size: number;
}

// Multipart upload to the gateway via the BFF proxy. We can't use the
// `api()` helper above because it pins content-type: application/json,
// which would strip the multipart boundary FormData needs.
export async function uploadImage(file: File): Promise<UploadRef> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/runtime/uploads", {
    method: "POST",
    body: form
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const value = (await response.json()) as { error?: string };
      if (value.error) message = value.error;
    } catch {
      // ignore — fall through to the HTTP status message
    }
    throw new Error(message);
  }
  return (await response.json()) as UploadRef;
}

export function uploadUrl(id: string): string {
  return `/api/runtime/uploads/${encodeURIComponent(id)}`;
}

// BFF URL for PREVIEWING an upload inline (a file/PDF chip opens this in a new
// tab). The gateway's `?inline=1` mode serves a safe allowlist (PDFs + raster
// images with their real type; .md/.csv/.json/.txt coerced to text/plain) with
// content-disposition: inline, so the browser renders it rather than
// downloading. Unsafe/unknown mimes ignore the flag and still download. The
// BFF injects the bearer, so this is usable as a bare anchor/iframe src.
export function uploadInlineUrl(id: string): string {
  return `/api/runtime/uploads/${encodeURIComponent(id)}?inline=1`;
}

// A workspace file read via GET /api/files. `content` is the utf8 text (null
// for binary files); `truncated` is set when the file exceeds the gateway's
// read cap.
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

// Direct BFF URL for downloading a workspace file. The gateway's raw mode
// streams the bytes back as an attachment, so this is safe to use as an
// <a download href={...}> target.
export function fileRawUrl(path: string): string {
  return `/api/runtime/files?path=${encodeURIComponent(path)}&raw=1`;
}

// Direct BFF URL for embedding a workspace file inline. The gateway's inline
// mode serves an allowlist of safe types (PDFs + raster images) with their real
// content-type + content-disposition: inline, so this is suitable as an
// <img>/<iframe> src in the preview drawer.
export function fileInlineUrl(path: string): string {
  return `/api/runtime/files?path=${encodeURIComponent(path)}&raw=1&inline=1`;
}
