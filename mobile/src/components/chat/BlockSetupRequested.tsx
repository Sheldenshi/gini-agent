import { StyleSheet, Text, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { SetupRequestedBlock } from "@/src/types";

// SetupRequest bubble: user-actor gate. Read-only on mobile — the
// Connect / credential entry / Submit actions are driven from the web
// client. No risk pill: the rule is structural per
// docs/adr/authorization-vs-setup-request.md.
export function BlockSetupRequested({
  block
}: {
  block: SetupRequestedBlock;
}) {
  const title =
    block.action === "browser.connect"
      ? "Browser sign-in needed"
      : block.action === "connector.request"
        ? "Connection setup needed"
        : block.action === "browser.fill_secret"
          ? "Credentials needed"
          : block.action;
  const hint =
    block.action === "connector.request"
      ? "Finish this setup in Gini on your Mac. This chat is paused until the connection is completed or the turn is stopped."
      : block.action === "browser.connect"
        ? "Finish signing in from Gini on your Mac. This chat is paused until setup is completed or the turn is stopped."
        : block.action === "browser.fill_secret"
          ? "Enter the requested value from Gini on your Mac. This chat is paused until the value is submitted or the turn is stopped."
          : "Open Gini on your Mac to continue, or stop this turn from the composer.";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.action}>{title}</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
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
