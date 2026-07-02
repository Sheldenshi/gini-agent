import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import { family, theme } from "@/src/theme";

// A forwarded copy of a Topic's final answer lands in the parent Chat tagged
// with the Topic's id + title (ADR chat-topics-tasks-subagents.md). This chip
// renders below that answer — a subtle sky-accented pill matching the web
// TopicForwardChip and the "from <job name>" badge — and deep-links into the
// Topic's own conversation (its chat detail) on tap.
export function TopicForwardChip({
  topicId,
  topicTitle
}: {
  topicId: string;
  topicTitle?: string;
}) {
  const title = topicTitle?.trim() || "topic";
  return (
    <Pressable
      onPress={() => router.push(`/chat/${topicId}`)}
      style={styles.chip}
      accessibilityRole="button"
      accessibilityLabel={`Open topic ${title}`}
    >
      <Feather name="message-square" size={13} color={theme.accent} />
      <Text style={styles.label}>
        from <Text style={styles.title}>#{title}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(47,107,255,0.3)",
    backgroundColor: "#EAF3FF"
  },
  label: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  title: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700)
  }
});
