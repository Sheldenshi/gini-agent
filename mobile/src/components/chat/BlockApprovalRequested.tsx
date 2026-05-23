import { StyleSheet, Text, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { ApprovalRequestedBlock } from "@/src/types";

// Approval bubble. Mobile in this round doesn't have the approve/deny
// mutations wired (web carries the AddConnectorDialog + the
// /approvals/:id/{approve,deny,connect} POSTs), so we render a quiet
// white card with the summary and a hint to open the chat on the web.
// Future rounds can layer the actions onto this same component.
//
// The bubble stays in the chat log forever — the runtime never deletes
// approval rows, and the visual treatment lets the user see the
// historical gate decision without losing the chat narrative.
export function BlockApprovalRequested({
  block
}: {
  block: ApprovalRequestedBlock;
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

// Color the risk pill so the user gets a quick glanceable severity cue.
// We keep the warning amber for medium and reserve red only for high.
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
