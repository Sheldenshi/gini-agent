// Tunnel state contract — types shared between manager, runtime endpoints,
// and BFF callers. The privileged shape (`TunnelSnapshot`) carries the
// secret + publicUrl. The redacted shape (`RedactedTunnelSnapshot`)
// nulls those fields and is exposed at `/api/tunnel/redacted` for any
// caller that wants the safe shape explicitly. Per the broadened policy
// in `docs/adr/tunnel-and-mobile-access.md`, tunneled browser callers
// now receive the privileged shape directly so the tunneled settings
// card can render the QR + URL with the same click-to-reveal pattern
// as the loopback view; the redacted shape stayed in the API for
// completeness but is no longer the default for tunneled requests.

export interface AppleNotesState {
  enabled: boolean;
  notesAvailable: boolean | null;
  lastError: string | null;
}

/** Manual-install guidance for `cloudflared` on the gateway's platform.
 *  Non-secret and constant for the life of the process. Exposed on every
 *  snapshot so the UI can render a copy-pasteable command + releases link
 *  when an enable fails with `lastErrorCode: "cloudflared_unavailable"`,
 *  without the browser needing to know the gateway's OS / arch. The runtime
 *  auto-installs cloudflared on enable, so this is a fallback for the offline
 *  case, not the primary path. Defined here (the shared contract) and
 *  consumed by `cloudflared-install.ts`. */
export interface CloudflaredInstallHint {
  platform: "macos" | "linux" | "windows" | "other";
  command: string;
  url: string;
}

export interface TunnelPersistedConfig {
  enabled: boolean;
  // 192-bit base64url-encoded secret. Generated eagerly on first gateway boot
  // (regardless of enabled state) so a later enable doesn't have to mint and
  // config.json's mtime never leaks enable history.
  secret: string;
  appleNotes: {
    enabled: boolean;
  };
}

export interface TunnelSnapshot {
  enabled: boolean;
  secret: string | null;
  publicUrl: string | null;
  /** 16-char hex prefix of SHA-256(`${secret}|${publicUrl ?? ""}`). Safe
   *  to expose in URLs / log lines — non-reversible to the secret. Used
   *  as a cache-buster on the QR `<img>` src so any of the three
   *  state transitions that change the QR pixels (rotate-secret,
   *  cloudflared hostname rotation on disable→enable, fresh boot)
   *  invalidates the browser's painted image without putting the
   *  secret itself in the URL. */
  secretRevision: string | null;
  /** "sse" when the live public URL is reachable via Server-Sent Events
   *  (loopback, named tunnels, off). "poll" when the public URL is a
   *  Cloudflare quick tunnel (`*.trycloudflare.com`) — quick tunnels
   *  drop `text/event-stream` at the edge, so clients hitting that
   *  hostname must fall back to long-polling for runtime events and
   *  chat-block streaming. Derived from `publicUrl` via
   *  `inferTunnelTransport` whenever the URL changes; nullable cases
   *  (no live tunnel) classify as "sse" because loopback callers don't
   *  go through Cloudflare. */
  tunnelTransport: "sse" | "poll";
  lastError: string | null;
  /** Typed counterpart to `lastError`. The HTTP layer already keys its
   *  409-vs-500 status mapping off `TunnelTransitionResult.code`;
   *  exposing the same code through the snapshot lets mobile and the
   *  settings card branch on the typed value instead of substring-
   *  matching the human-readable prose. Reset to `null` whenever
   *  `lastError` clears. */
  lastErrorCode: TunnelTransitionErrorCode | null;
  /** Constant manual-install guidance for cloudflared on this host (see
   *  CloudflaredInstallHint). Non-secret; the UI reads it only when
   *  `lastErrorCode === "cloudflared_unavailable"`. */
  cloudflaredInstall: CloudflaredInstallHint;
  appleNotes: AppleNotesState;
}

export interface RedactedTunnelSnapshot {
  enabled: boolean;
  secret: null;
  publicUrl: null;
  /** Same non-reversible secret-revision marker as the privileged shape. */
  secretRevision: string | null;
  /** Same transport hint as the privileged shape — exposing it on the
   *  redacted endpoint is safe because the value carries no secret
   *  material; it's a transport indicator the client uses to pick
   *  between SSE and long-polling. */
  tunnelTransport: "sse" | "poll";
  lastError: string | null;
  /** Same typed error code as the privileged shape. Non-secret — it's
   *  an enum the client uses to branch on the failure mode without
   *  substring-matching `lastError`. */
  lastErrorCode: TunnelTransitionErrorCode | null;
  /** Same constant install-hint as the privileged shape. Non-secret. */
  cloudflaredInstall: CloudflaredInstallHint;
  appleNotes: {
    enabled: boolean;
    notesAvailable: boolean | null;
    lastError: string | null;
  };
}

/** Discrete failure code for transition results. The HTTP layer keys
 *  status mapping on this enum instead of substring-matching the
 *  human-readable `error` prose, so a future rewording of the error
 *  message can't silently flip a 409 (operator-actionable: bring the
 *  web child back) into a 500 (gateway-internal). The prose is kept
 *  for client display; the code is the load-bearing contract. */
export type TunnelTransitionErrorCode = "web_port_unhealthy" | "cloudflared_unavailable";

/** Filename for the sibling file the runtime writes inside
 *  `~/.gini/instances/<inst>/` when the tunnel is up. The Next.js proxy
 *  reads it on every request to compare the inbound Host against the
 *  live trycloudflare hostname (no permissive suffix match). Centralized
 *  here so both the runtime (which writes it) and the BFF (which reads
 *  it) reference the same literal; renaming the file in one place would
 *  otherwise silently desynchronize the two trust layers. */
export const TUNNEL_PUBLIC_URL_FILENAME = "tunnel.publicUrl";

// Manager status reasons that bubble into `lastError` strings.
export type TunnelTransitionResult =
  | { ok: true; snapshot: TunnelSnapshot }
  | { ok: false; error: string; code?: TunnelTransitionErrorCode };
