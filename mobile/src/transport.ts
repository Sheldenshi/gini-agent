// Tunnel transport classifier — mobile copy. Cloudflare quick tunnels
// (the rotating `*.trycloudflare.com` hostnames we mint via `cloudflared
// tunnel --url`) do NOT proxy Server-Sent Events — `text/event-stream`
// responses get dropped at Cloudflare's edge so the client never
// receives runtime events or chat-block deltas. When the gateway's
// publicUrl (i.e. the mobile-stored baseUrl) is a quick-tunnel hostname,
// the mobile client falls back to long-polling.
//
// IMPORTANT: this file is duplicated from src/runtime/tunnel/transport.ts
// and web/src/lib/transport.ts. React Native (Metro/Hermes) can't import
// modules from outside the mobile workspace any more than Next.js can,
// mirroring the canonicalize triplication already in this repo. Parity
// is pinned in src/runtime/tunnel/transport.parity.test.ts which runs
// the same input table against all three copies.

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
