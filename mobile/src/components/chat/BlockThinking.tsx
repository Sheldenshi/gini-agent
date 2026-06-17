import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { AssistantTextBlock } from "@/src/types";

// A single pre-tool narration step, rendered as a row that mirrors
// BlockToolCall's layout: [icon + bold "Thinking"] with a one-line preview.
// Tapping the row reveals the full settled message below, indented to align
// with the label (marginLeft 21, matching BlockToolCall's detail). Feather
// has no brain/sparkle glyph, so "cpu" stands in as the closest
// "thinking/processing" icon — the same Lucide→Feather closest-glyph
// convention used in tool-icons.ts. Narration is always settled (the
// streaming path never collapses), so there is no cursor.

export function BlockThinking({ block }: { block: AssistantTextBlock }) {
  const [expanded, setExpanded] = useState(false);
  const text = block.text.trim();
  const preview = text.split("\n")[0] ?? "";
  return (
    <View style={styles.row}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded((v) => !v)}
        style={styles.body}
      >
        <View style={styles.labelGroup}>
          <Feather name="cpu" size={15} color={theme.toolIcon} />
          <Text style={styles.label}>Thinking</Text>
        </View>
        {!expanded && preview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        ) : null}
      </TouchableOpacity>
      {expanded ? <Text style={styles.detail}>{text}</Text> : null}
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
  preview: {
    flex: 1,
    minWidth: 0,
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  },
  detail: {
    marginLeft: 21,
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13,
    lineHeight: 18
  }
});
