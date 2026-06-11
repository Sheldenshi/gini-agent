import { Feather } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { relativeTime } from "@/src/format";
import { family } from "@/src/theme";

// Inline "N replies · last reply …" chip (design GmqLz, light palette)
// rendered under a main-chat assistant bubble when that message hosts a
// thread. Tapping opens the Slack-style Thread View. Messages that don't
// yet host a thread show the ReplyInThreadPill instead, so the user can
// branch a brand-new thread off any agent reply (Slack-style).

export function ThreadRepliesChip({
  replyCount,
  lastReplyAt,
  align = "start",
  onPress
}: {
  replyCount: number;
  lastReplyAt?: string;
  // Which edge the chip hugs: "start" under a left-aligned assistant
  // reply, "end" under a right-aligned user message.
  align?: "start" | "end";
  onPress: () => void;
}) {
  const last = lastReplyAt ? relativeTime(lastReplyAt) : null;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.chip, { alignSelf: align === "end" ? "flex-end" : "flex-start" }]}
      accessibilityRole="button"
      accessibilityLabel={`${replyCount} ${replyCount === 1 ? "reply" : "replies"} in thread`}
    >
      <View style={styles.chipText}>
        <Text style={styles.chipReplies}>
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </Text>
        {last ? (
          <>
            <Text style={styles.chipSep}>·</Text>
            <Text style={styles.chipLast}>last reply {last}</Text>
          </>
        ) : null}
      </View>
      <Feather name="chevron-right" size={18} color="#8A93B8" />
    </TouchableOpacity>
  );
}

// "Reply in thread" pill (design POvIw, light palette) under a main-chat
// assistant bubble that doesn't host a thread yet. Tapping mints a new
// thread rooted at that message and opens the Thread View.
export function ReplyInThreadPill({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.replyPill}
      accessibilityRole="button"
      accessibilityLabel="Reply in thread"
    >
      <Feather name="message-square" size={14} color="#3554D1" />
      <Text style={styles.replyPillText}>Reply in thread</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  replyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    alignSelf: "flex-start",
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#D7DEFA",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10
  },
  replyPillText: {
    color: "#3554D1",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#DCE3FB",
    borderRadius: 13,
    paddingVertical: 7,
    paddingLeft: 9,
    paddingRight: 11
  },
  chipText: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipReplies: {
    color: "#2F6BFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 13
  },
  chipSep: {
    color: "#AEBBE8",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  chipLast: {
    color: "#7A86A8",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  }
});
