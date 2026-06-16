import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProcessStep } from "@/src/group-exchanges";
import { family, theme } from "@/src/theme";
import type { ToolCallBlock, ToolResultBlock } from "@/src/types";
import { BlockToolCall } from "./BlockToolCall";
import { iconForTool } from "./tool-icons";

// Collapsed summary of every tool_call the assistant made during one
// exchange (user_text → final assistant_text). The trailing icon strip
// shows one glyph per *unique* tool category invoked, so a user can
// glance at the row and know whether the assistant touched files, ran
// shell commands, hit the browser, etc., without expanding. Expanding
// replays the turn's process — tool calls and the model's pre-tool
// narration — in chronological order.

export function BlockToolCallsCollapsed({
  calls,
  steps,
  resultsByCallId
}: {
  calls: ToolCallBlock[];
  steps: ProcessStep[];
  resultsByCallId: Map<string, ToolResultBlock>;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentCount = calls.filter((c) => c.toolName === "spawn_subagent").length;
  const toolCount = calls.length;

  const uniqueIcons: { key: string; name: ReturnType<typeof iconForTool>["name"] }[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const icon = iconForTool(call.toolName);
    if (seen.has(icon.name)) continue;
    seen.add(icon.name);
    uniqueIcons.push({ key: icon.name, name: icon.name });
  }

  const summary =
    agentCount > 0
      ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}, ${agentCount} agent${agentCount === 1 ? "" : "s"}`
      : `${toolCount} tool call${toolCount === 1 ? "" : "s"}`;

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.header}
        hitSlop={{ top: 8, bottom: 8 }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={summary}
      >
        <View style={[styles.chevron, expanded && styles.chevronRotated]}>
          <Feather name="chevron-right" size={16} color={theme.mutedIcon} />
        </View>
        <Text style={styles.summary}>{summary}</Text>
        {uniqueIcons.length > 0 ? (
          <View style={styles.iconStrip}>
            {uniqueIcons.map((icon) => (
              <Feather
                key={icon.key}
                name={icon.name}
                size={16}
                color={theme.mutedIcon}
              />
            ))}
          </View>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.expandedList}>
          {steps.map((step) =>
            step.kind === "tool_call" ? (
              <BlockToolCall
                key={step.block.id}
                block={step.block}
                result={resultsByCallId.get(step.block.callId)}
              />
            ) : (
              <Text key={step.block.id} style={styles.narration}>
                {step.block.text}
              </Text>
            )
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8
  },
  // Chevron + summary + icon strip all sit on one row, vertically
  // centered. The 13px gap mirrors the web version's gap-[13px].
  header: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    flexWrap: "wrap",
    gap: 13,
    rowGap: 13,
    paddingVertical: 2
  },
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center"
  },
  // RN doesn't ship a CSS transition for transforms; the rotation is
  // immediate on tap, matching the visual outcome of the web version
  // without the easing.
  chevronRotated: {
    transform: [{ rotate: "90deg" }]
  },
  summary: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14
  },
  iconStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9
  },
  // 27px left indent mirrors the web pl-[27px] so the expanded rows
  // sit under (not under-and-left of) the summary text.
  expandedList: {
    paddingLeft: 27,
    gap: 6
  },
  // Pre-tool narration rendered muted so it reads as process, not a
  // standalone reply. Narration is always settled (the streaming path
  // never collapses), so no cursor.
  narration: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 20
  }
});
