import { Feather } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { relativeTime } from "@/src/format";
import { family } from "@/src/theme";

// Two inline thread affordances rendered under a main-chat assistant
// bubble:
//   - ReplyInThreadPill ("Reply in thread", POvIw): a quiet link the
//     user taps to start a thread off this message.
//   - ThreadRepliesChip ("N replies · last reply …", GmqLz): shown when
//     the message already hosts a thread; tapping opens the Thread View.
// Both use the same light-blue family (#EEF2FF) from the design's light
// palette so they read as one affordance with two states.

export function ReplyInThreadPill({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.replyPill}
      accessibilityRole="button"
      accessibilityLabel="Reply in thread"
    >
      <Feather name="message-square" size={13} color="#3554D1" />
      <Text style={styles.replyPillLabel}>Reply in thread</Text>
    </TouchableOpacity>
  );
}

export function ThreadRepliesChip({
  replyCount,
  lastReplyAt,
  onPress
}: {
  replyCount: number;
  lastReplyAt?: string;
  onPress: () => void;
}) {
  const last = lastReplyAt ? relativeTime(lastReplyAt) : null;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.chip}
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
  replyPillLabel: {
    color: "#3554D1",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "flex-start",
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
