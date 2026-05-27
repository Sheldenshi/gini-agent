// Tunnel state contract — types shared between manager, runtime endpoints,
// and BFF callers. The privileged shape carries the secret + publicUrl; the
// redacted shape nulls those fields and is what tunneled browser callers see.
// See PLAN.md "Public surface" + "Trust radius".

export interface AppleNotesState {
  enabled: boolean;
  notesAvailable: boolean | null;
  lastError: string | null;
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
  /** 16-char hex prefix of SHA-256(secret). Safe to expose in URLs / log
   *  lines — non-reversible to the secret. Used as a cache-buster on the
   *  QR `<img>` src so a rotate-secret invalidates the browser's painted
   *  image without putting the secret itself in the URL. */
  secretRevision: string | null;
  lastError: string | null;
  appleNotes: AppleNotesState;
}

export interface RedactedTunnelSnapshot {
  enabled: boolean;
  secret: null;
  publicUrl: null;
  /** Same non-reversible secret-revision marker as the privileged shape. */
  secretRevision: string | null;
  lastError: string | null;
  appleNotes: {
    enabled: boolean;
    notesAvailable: boolean | null;
    lastError: string | null;
  };
}

// Manager status reasons that bubble into `lastError` strings.
export type TunnelTransitionResult =
  | { ok: true; snapshot: TunnelSnapshot }
  | { ok: false; error: string };
