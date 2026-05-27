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
    throw new Error(value.error ?? value.message ?? `HTTP ${response.status}`);
  }
  return value as T;
}

export function streamUrl(path: string): string {
  return `/api/runtime${path}`;
}
