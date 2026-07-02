import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { clearPendingPair, isPendingPairLive, readCachedPendingPair } from "@/src/pending-pair";
import { theme } from "@/src/theme";

// Auth gate. The root layout has already primed the AsyncStorage caches
// by the time this component renders, so the redirect is synchronous
// from the user's perspective.
export default function Index() {
  const { status, credentials } = useAuth();
  if (status === "loading") {
    // Solid white surface during the (effectively zero-length) loading
    // window keeps the cold-start visual consistent with the rest of
    // the app while primeCredentials() resolves and the redirect fires.
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }
  if (!credentials) {
    // No credentials, but a still-live pairing was in progress when iOS killed
    // the suspended app — resume /pair instead of dropping the user at /setup. A
    // live "request" re-polls the same handshake; an "input" breadcrumb just
    // returns to the paste screen. A stale record is swept and we fall through.
    const pending = readCachedPendingPair();
    if (pending && isPendingPairLive(pending, Date.now())) {
      return pending.kind === "request" ? (
        <Redirect href={`/pair?relay=${encodeURIComponent(pending.relayOrigin)}&resume=1`} />
      ) : (
        <Redirect href="/pair" />
      );
    }
    if (pending) void clearPendingPair();
    return <Redirect href="/setup" />;
  }
  return <Redirect href="/channels" />;
}
