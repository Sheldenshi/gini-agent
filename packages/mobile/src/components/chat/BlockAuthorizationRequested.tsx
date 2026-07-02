import { StyleSheet, Text, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { AuthorizationRequestedBlock } from "@/src/types";

// Authorization bubble: agent-actor gate. Read-only on mobile — the
// approve/deny actions are driven from the web client. See
// docs/adr/authorization-vs-setup-request.md.
export function BlockAuthorizationRequested({
  block
}: {
  block: AuthorizationRequestedBlock;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.action}>{block.action}</Text>
        <Text style={[styles.risk, riskStyle(block.risk)]}>{block.risk}</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      <Text style={styles.hint}>Approve or deny this on the web client.</Text>
    </View>
  );
}

function riskStyle(risk: string) {
  if (risk === "high")
    return { backgroundColor: "rgba(255, 59, 48, 0.12)", color: theme.danger };
  if (risk === "medium")
    return { backgroundColor: "rgba(255, 149, 0, 0.14)", color: "#B26200" };
  return { backgroundColor: "rgba(52, 199, 89, 0.14)", color: "#0E7A2A" };
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    backgroundColor: theme.bg,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    gap: 6
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  action: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12,
    flexShrink: 1
  },
  risk: {
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 10,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden"
  },
  summary: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  },
  hint: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    fontStyle: "italic"
  }
});
