import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

// Auth gate. The root layout has already primed the AsyncStorage cache
// by the time this component renders, so the redirect is synchronous
// from the user's perspective.
export default function Index() {
  const { status, credentials } = useAuth();
  if (status === "loading") {
    // Solid dark surface during the (effectively zero-length) loading
    // window keeps us from flashing white between primeCredentials()
    // resolving and the redirect firing.
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }
  if (!credentials) return <Redirect href="/setup" />;
  return <Redirect href="/agents" />;
}
