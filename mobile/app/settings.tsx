import { Stack, router } from "expo-router";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

export default function SettingsScreen() {
  const { credentials, clear } = useAuth();

  const onClear = () => {
    Alert.alert(
      "Sign out?",
      "Stored URL and token will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            await clear();
            router.replace("/setup");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: "Settings",
          headerStyle: { backgroundColor: theme.bg },
          headerTitleStyle: { color: theme.text },
          headerTintColor: theme.accent
        }}
      />

      <View style={styles.body}>
        <View style={styles.section}>
          <Text style={styles.label}>Base URL</Text>
          <Text style={styles.value}>{credentials?.baseUrl ?? "—"}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Token</Text>
          <Text style={styles.value} numberOfLines={1}>
            {credentials?.token ? maskToken(credentials.token) : "—"}
          </Text>
        </View>

        <TouchableOpacity onPress={onClear} style={styles.button}>
          <Text style={styles.buttonText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// First/last 4 chars only so the value is recognizable to a user that
// pasted it but doesn't fully expose the secret on a casual glance.
function maskToken(t: string): string {
  if (t.length <= 12) return "•".repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1, padding: 20 },
  section: { marginBottom: 20 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
    color: theme.subtle
  },
  value: { fontSize: 16, color: theme.text },
  button: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.danger
  },
  buttonText: { fontSize: 16, fontWeight: "600", color: "#FFFFFF" }
});
