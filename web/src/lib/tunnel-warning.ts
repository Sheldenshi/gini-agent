/** Predicate for the "quick tunnel URLs are ephemeral" warning band shown in
 *  the settings TunnelCard. Cloudflare quick tunnels rotate their hostname on
 *  every cloudflared restart and Cloudflare can revoke them without notice,
 *  so any saved QR or deep link becomes invalid. The Apple Notes mirror writes
 *  the live bootstrap URL into iCloud so the phone can recover the new URL
 *  automatically — when the operator has the mirror ON, the rotation case is
 *  already handled and the band is unnecessary. The band is also irrelevant
 *  when the tunnel is OFF (no URL to lose). */
export function shouldShowEphemeralWarning(opts: {
  tunnelEnabled: boolean;
  notesEnabled: boolean;
}): boolean {
  return opts.tunnelEnabled && !opts.notesEnabled;
}
