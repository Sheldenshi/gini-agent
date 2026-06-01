import { ActivityIndicator, View } from "react-native";
import { theme } from "@/src/theme";

// Visual placeholder while the deep-link handler in app/_layout.tsx
// (DeepLinkAuthBridge → useDeepLinkAuth) parses
// `gini://connect?api=...&token=...`, persists the credentials, and
// routes to /agents. Without this file Expo Router would render
// "Unmatched Route" for the tick between the deep link arriving and
// the redirect firing.
export default function ConnectRoute() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.bg
      }}
    >
      <ActivityIndicator size="large" color={theme.text} />
    </View>
  );
}
