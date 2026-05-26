// Plain relative paths. When the page is served through the cloudflared
// tunnel, the Next.js proxy sets a HttpOnly session cookie on the very
// first secret-bearing request; subsequent same-origin fetches travel
// authenticated by cookie, so JS never has to know about the secret
// prefix.

// Distinct subclass for HTTP-level failures (4xx/5xx). Callers can use
// `instanceof HttpError` to separate "the server replied with an error
// status" (a real failure with a meaningful body) from "fetch never
// got a response" (network failure / abort / TypeError) — which matter
// to the tunnel toggle whose disable path can self-sever the response
// channel. The default `Error` shape stays for non-HTTP failures so a
// dropped connection still surfaces as a plain Error to onError.
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  if (!response.ok) {
    // Read the body as text first because a Response stream can only
    // be consumed once. Try JSON.parse to extract {error: "..."} from
    // the gateway, but fall back to the raw text when the upstream
    // returned HTML/plain (e.g. a 502 from a reverse proxy). Without
    // this guard the original code called response.json() before
    // checking response.ok and threw SyntaxError on non-JSON error
    // bodies; callers that distinguish HttpError from network errors
    // (e.g. TunnelSettingsCard's self-severing race) then
    // mis-classify the real failure as success.
    let message = `HTTP ${response.status}`;
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (typeof parsed?.error === "string") {
          message = parsed.error;
        } else if (text.trim().length > 0) {
          message = text.trim();
        }
      } catch {
        if (text.trim().length > 0) message = text.trim();
      }
    }
    throw new HttpError(message, response.status);
  }
  return (await response.json()) as T;
}

export function streamUrl(path: string): string {
  return `/api/runtime${path}`;
}
