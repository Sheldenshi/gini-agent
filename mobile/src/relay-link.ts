// Mapping incoming deep links to in-app routes. Used by `app/+native-intent.tsx`
// so a universal link to a relay subdomain opens the app straight into the
// pairing screen. Kept as a pure, dependency-free module so the parsing is
// unit-testable without expo-router or react-native.

// The relay registrable domain. A universal link to any `*.<RELAY_DOMAIN>` host
// is a "connect to this gateway" link. Mirrors the gateway's GINI_RELAY_DOMAIN
// default (src/lib/origin-trust.ts).
export const RELAY_DOMAIN = "gini-relay.lilaclabs.ai";

// True when `host` is the relay domain or one of its per-device subdomains. A
// trailing-label match (not a substring) so `gini-relay.lilaclabs.ai.evil.com`
// does NOT match. Strips an optional :port.
export function isRelayHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  return lower === RELAY_DOMAIN || lower.endsWith(`.${RELAY_DOMAIN}`);
}

// Map an incoming deep-link URL to an in-app route. An https link to a relay
// host becomes `/pair?relay=<https origin>` so the pair screen knows which
// gateway to pair with (the host identifies the gateway; the link's own path is
// irrelevant). Anything else returns null — the caller then leaves the original
// path untouched so the app's own `gini://` links and other routes still work.
// Pure and total: never throws (a malformed URL just returns null).
export function relayPairingRedirect(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only the HTTPS relay front. A `gini://...` custom-scheme link or any other
  // host falls through to expo-router's normal routing.
  if (parsed.protocol !== "https:") return null;
  if (!isRelayHost(parsed.host)) return null;
  return `/pair?relay=${encodeURIComponent(`https://${parsed.host}`)}`;
}
