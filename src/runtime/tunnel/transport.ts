// Tunnel transport classifier. Cloudflare quick tunnels (the rotating
// `*.trycloudflare.com` hostnames we mint via `cloudflared tunnel --url`)
// do NOT proxy Server-Sent Events — `text/event-stream` responses get
// dropped at Cloudflare's edge so the client never receives runtime
// events or chat-block deltas. Verified verbatim in Cloudflare's docs
// ("Quick Tunnels do not support Server-Sent Events (SSE)"). When the
// gateway's publicUrl is a quick-tunnel hostname, clients must fall
// back to long-polling for any wire path that would otherwise be SSE.
//
// Loopback, named Cloudflare tunnels, and direct LAN access (no
// publicUrl) all use SSE — Bun.serve streams natively and there's no
// SSE-stripping proxy in the way.
//
// IMPORTANT: this file is duplicated as web/src/lib/transport.ts so the
// Next.js client bundle can import the same classifier. Next.js can't
// bundle modules from outside its project root, mirroring the
// canonicalize duplication already in this repo. The unit-test table
// (tests/runtime/tunnel/transport.test.ts) is run against both copies
// so the implementations stay in sync.

export type TunnelTransport = "sse" | "poll";

const QUICK_TUNNEL_HOST_SUFFIX = ".trycloudflare.com";

/**
 * Returns "poll" when `publicUrl` is a quick-tunnel hostname
 * (`*.trycloudflare.com`, case-insensitive). Returns "sse" for every
 * other case: null/empty, named tunnels, loopback, malformed URLs.
 *
 * Fail-safe is "sse" — if we can't classify the URL, the existing SSE
 * path runs unchanged. A wrong "poll" classification would silently
 * disable streaming on a host that actually supports it; a wrong "sse"
 * classification surfaces as a broken stream the operator can recover
 * from by manually selecting the polling fallback. SSE is the default
 * because it's the cheaper transport when it works.
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
