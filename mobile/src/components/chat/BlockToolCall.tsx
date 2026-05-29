import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { api } from "@/src/api";
import { family, theme } from "@/src/theme";
import type { ToolCallBlock, ToolResultBlock } from "@/src/types";
import { iconForTool } from "./tool-icons";

// Single horizontal row per the Pencil design:
//   [icon + Hanken-Grotesk-600 label]  [monospace code chip filling rest]
// Tapping the row toggles an inline preview of the matching tool_result
// (the chat detail screen builds the callId → result map and passes the
// right result in via prop). The icon serves as the leading affordance,
// so no chevron / status dot — the new style relies on the icon to
// indicate what kind of tool ran.
//
// Three render variants:
//   - Default: the row above; failed (error/denied) calls add a red error string.
//   - Inline spinner (status === "running" && !result, no runningHint):
//     a small ActivityIndicator sits at the end of the row. Right for
//     short-lived tools.
//   - Amber waiting-card (status === "running" && !result && runningHint):
//     wraps the row in an amber-bordered card, folds the runningHint
//     into the card body, and adds a Cancel button — for tools that
//     park awaiting an external event (e.g. wait_for_messaging_pair
//     waiting on an inbound DM, up to 600s). The Composer's global Stop
//     button still works as an escape hatch.

const AMBER_BG = "rgba(251, 191, 36, 0.05)";
const AMBER_BORDER = "rgba(251, 191, 36, 0.3)";
const AMBER_BORDER_STRONG = "rgba(251, 191, 36, 0.4)";
const AMBER_TEXT = "#fbbf24";
const AMBER_TEXT_DIM = "rgba(251, 191, 36, 0.8)";

export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const failed = block.status === "error" || block.status === "denied";
  const running = block.status === "running" && !result;
  const waitingCard = running && Boolean(block.runningHint);
  const inlineSpinner = running && !waitingCard;
  const canExpand = Boolean(result);
  const icon = iconForTool(block.toolName);

  const handleCancel = async () => {
    if (!block.taskId || cancelling) return;
    setCancelling(true);
    try {
      await api(`/tasks/${block.taskId}/cancel`, { method: "POST" });
    } catch (err) {
      Alert.alert("Cancel failed", err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const rowBody = (
    <TouchableOpacity
      activeOpacity={canExpand ? 0.7 : 1}
      disabled={!canExpand}
      onPress={() => canExpand && setExpanded((v) => !v)}
      style={styles.body}
    >
      <View style={styles.labelGroup}>
        <Feather name={icon.name} size={15} color={theme.toolIcon} />
        <Text style={styles.label} numberOfLines={1}>
          {block.displayLabel}
        </Text>
      </View>
      {block.argsPreview ? (
        <View style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {block.argsPreview}
          </Text>
        </View>
      ) : null}
      {inlineSpinner ? (
        <ActivityIndicator
          size="small"
          color={theme.toolIcon}
          accessibilityLabel="Running"
          style={styles.spinner}
        />
      ) : null}
    </TouchableOpacity>
  );

  if (waitingCard) {
    return (
      <View style={styles.amberCard}>
        <View style={styles.amberRow}>
          {rowBody}
          <ActivityIndicator size="small" color={AMBER_TEXT} accessibilityLabel="Waiting" />
        </View>
        {block.runningHint ? (
          <Text style={styles.amberHint}>{block.runningHint}</Text>
        ) : null}
        <View style={styles.amberFooter}>
          <Text style={styles.amberSubtle}>WAITING ON EXTERNAL EVENT</Text>
          <Pressable
            onPress={handleCancel}
            disabled={!block.taskId || cancelling}
            style={({ pressed }) => [
              styles.cancelButton,
              (pressed || cancelling) && { opacity: 0.7 }
            ]}
          >
            <Text style={styles.cancelText}>{cancelling ? "Cancelling…" : "Cancel"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {rowBody}
      {failed && block.errorMessage ? (
        <Text style={styles.errorMessage} numberOfLines={3}>
          {block.errorMessage}
        </Text>
      ) : null}
      {expanded && result ? (
        <View style={styles.resultBox}>
          <Text style={styles.resultText} numberOfLines={20}>
            {result.preview}
            {result.truncated ? "\n\n[truncated]" : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    gap: 6
  },
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1
  },
  labelGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0
  },
  label: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  chip: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.codeChipBg,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 8
  },
  chipText: {
    color: theme.codeChipText,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12
  },
  spinner: {
    flexShrink: 0
  },
  errorMessage: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13,
    paddingLeft: 21
  },
  resultBox: {
    marginLeft: 21,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.codeChipBg,
    maxHeight: 200
  },
  resultText: {
    color: theme.codeChipText,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12,
    lineHeight: 16
  },
  amberCard: {
    alignSelf: "stretch",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AMBER_BORDER,
    backgroundColor: AMBER_BG
  },
  amberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  amberHint: {
    color: "#cfcfcf",
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13,
    lineHeight: 18
  },
  amberFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  amberSubtle: {
    color: AMBER_TEXT_DIM,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 11,
    letterSpacing: 0.5
  },
  cancelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: AMBER_BORDER_STRONG,
    backgroundColor: "rgba(251, 191, 36, 0.1)",
    paddingHorizontal: 14,
    paddingVertical: 6
  },
  cancelText: {
    color: "#fcd34d",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  }
});
