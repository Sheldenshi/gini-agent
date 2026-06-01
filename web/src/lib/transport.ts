// Tunnel transport classifier — web copy. Cloudflare quick tunnels (the
// rotating `*.trycloudflare.com` hostnames we mint via `cloudflared
// tunnel --url`) do NOT proxy Server-Sent Events — `text/event-stream`
// responses get dropped at Cloudflare's edge so the client never
// receives runtime events or chat-block deltas. When the gateway's
// publicUrl is a quick-tunnel hostname, clients fall back to
// long-polling for any wire path that would otherwise be SSE.
//
// IMPORTANT: this file is duplicated from src/runtime/tunnel/transport.ts.
// Next.js can't bundle modules outside its project root, mirroring the
// canonicalize duplication already in this repo. Tests at
// web/src/lib/transport.test.ts pin the same input table as the runtime
// copy so the implementations stay in sync.

export type TunnelTransport = "sse" | "poll";

const QUICK_TUNNEL_HOST_SUFFIX = ".trycloudflare.com";

/**
 * Returns "poll" when `publicUrl` is a quick-tunnel hostname
 * (`*.trycloudflare.com`, case-insensitive). Returns "sse" for every
 * other case: null/empty, named tunnels, loopback, malformed URLs.
 *
 * Fail-safe is "sse" — if we can't classify the URL, the existing SSE
 * path runs unchanged.
 */
export function inferTunnelTransport(publicUrl: string | null): TunnelTransport {
  if (!publicUrl) return "sse";
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return "sse";
  }
  if (parsed.hostname.toLowerCase().endsWith(QUICK_TUNNEL_HOST_SUFFIX)) {
    return "poll";
  }
  return "sse";
}
