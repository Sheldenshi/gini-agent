import { relayPairingRedirect } from "@/src/relay-link";

// Expo Router native-intent hook. iOS hands us the full incoming URL (universal
// link or custom scheme); we rewrite a relay link into the in-app pairing route
// so a tap on https://<sub>.gini-relay.lilaclabs.ai opens the app straight into
// the handshake. Everything else passes through unchanged. Apple's docs warn
// that throwing here can crash the launch, so the parse is total (relayPairingRedirect
// never throws) and we still guard defensively.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return relayPairingRedirect(path) ?? path;
  } catch {
    return path;
  }
}
