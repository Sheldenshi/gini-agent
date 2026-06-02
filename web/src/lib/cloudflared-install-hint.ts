// Client-side mirror of the tunnel error-code union and cloudflared install
// hint. Kept in sync with src/runtime/tunnel/types.ts — importing the runtime
// type here would couple the BFF bundle to the runtime tree at build time, so
// the shapes are duplicated. The duplication is pinned by
// cloudflared-install-hint.parity.test.ts, which imports both copies and fails
// CI if the web `TunnelErrorCode` members or the `CloudflaredInstallHint`
// shape drift from the runtime `TunnelTransitionErrorCode` /
// `CloudflaredInstallHint` — the same duplicate-plus-parity-test pattern used
// for canonicalize.parity.test.ts and transport.parity.test.ts.

/** Web mirror of the runtime `TunnelTransitionErrorCode`
 *  (src/runtime/tunnel/types.ts). Named `TunnelErrorCode` on the web side
 *  because that is the only error union the BFF surfaces; the members are
 *  asserted equal to the runtime union by the parity test. */
export type TunnelErrorCode = "web_port_unhealthy" | "cloudflared_unavailable";

/** Web mirror of the runtime `CloudflaredInstallHint`
 *  (src/runtime/tunnel/types.ts). Shape parity is asserted by the parity
 *  test. */
export interface CloudflaredInstallHint {
  platform: "macos" | "linux" | "windows" | "other";
  command: string;
  url: string;
}

/** Message to show when an enable failed because cloudflared could not be
 *  provisioned, else null. The actionable command + releases link are NOT
 *  returned here — consumers render them from the snapshot's
 *  `cloudflaredInstall` hint via `<CloudflaredInstallHelp>`; this selector
 *  only decides whether to swap the raw "Last error" line for that block and
 *  supplies the lead-in sentence.
 *
 *  The runtime auto-installs cloudflared on enable, so this only fires when
 *  that download itself failed (typically the host is offline) — the copy is
 *  "retry / install manually", never "you must install it first". */
export function cloudflaredGuidance(
  code: TunnelErrorCode | null | undefined,
  hint: CloudflaredInstallHint | null | undefined
): string | null {
  if (code !== "cloudflared_unavailable" || !hint) return null;
  return "Couldn't download cloudflared automatically. Check this machine's internet connection and click Enable again, or install it manually:";
}
