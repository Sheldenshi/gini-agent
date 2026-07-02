import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { AssistantTextBlock } from "@/src/types";

// A single per-iteration narration step, rendered to read exactly like a
// BlockToolCall row: [icon + bold "Thinking" label] [brief content chip], tap
// to expand the full text in a content box — the same brief-then-more
// affordance a tool call uses for its args preview + result. The chip and the
// expanded box reuse BlockToolCall's chip / result-box styling so a Thinking
// step is a visual peer of the tool calls in the collapsed group. Feather has
// no brain glyph, so "cpu" stands in (the Lucide→Feather closest-glyph
// convention from tool-icons.ts). Narration is always settled, so no cursor.

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
        {preview ? (
          <View style={styles.chip}>
            <Text style={styles.chipText} numberOfLines={1}>
              {preview}
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.resultBox}>
          <Text style={styles.resultText} numberOfLines={20}>
            {text}
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
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  resultBox: {
    marginLeft: 21,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.codeChipBg
  },
  resultText: {
    color: theme.codeChipText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    lineHeight: 16
  }
});
