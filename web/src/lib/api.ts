export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  // Two error-body shapes flow through the gateway:
  //   - Generic 4xx/5xx: { error: "..." } (set by json(..., status) calls).
  //   - Fill-secret / connector routes: { ok: false, message: "..." }
  //     (the runtime emits a runtime-action result envelope).
  // Read both so non-2xx fill_secret responses surface the
  // actionable message instead of falling back to "HTTP 400".
  const value = (await response.json()) as { error?: string; message?: string; ok?: boolean };
  if (!response.ok) {
    // Tag the gateway's HTTP status so callers can distinguish a structured
    // error response (the gateway replied non-2xx) from a transport failure
    // (fetch rejecting, or response.json() throwing on a truncated body when
    // the gateway drops the connection — neither of which reaches here).
    const error = new Error(value.error ?? value.message ?? `HTTP ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
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
