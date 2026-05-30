import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
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
// On error / denied the row gets an error string below — red by default,
// muted gray when errorSeverity is "info" (a calm needs-setup notice).

export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = block.status === "error" || block.status === "denied";
  const canExpand = Boolean(result);
  const icon = iconForTool(block.toolName);
  return (
    <View style={styles.row}>
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
      </TouchableOpacity>
      {failed && block.errorMessage ? (
        <Text
          style={block.errorSeverity === "info" ? styles.infoMessage : styles.errorMessage}
          numberOfLines={3}
        >
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
  // Single horizontal row: icon+label group on the left, code chip
  // filling the remaining width on the right. flexShrink 0 on the label
  // group + flex 1 on the chip mirrors the Pencil `fill_container` chip
  // sitting next to a `fit_content` label.
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
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
  errorMessage: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13,
    paddingLeft: 21
  },
  // Muted variant for errorSeverity "info" (e.g. web_search with no
  // provider): a calm needs-setup notice rather than a red failure.
  infoMessage: {
    color: theme.muted,
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
  }
});
