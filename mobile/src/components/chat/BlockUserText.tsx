import { StyleSheet, Text, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { UserTextBlock } from "@/src/types";

// Right-aligned dark bubble. The asymmetric corner geometry has a
// sharper bottom-left so the bubble visually "points" toward the
// user-bubble corner of the conversation (which is the closest edge to
// the input bar). No author/time header — the design uses alignment
// and color alone as the role signal.
export function BlockUserText({ block }: { block: UserTextBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Text style={styles.text} selectable>
          {block.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "80%"
  },
  bubble: {
    backgroundColor: theme.userBubble,
    paddingVertical: 12,
    paddingHorizontal: 16,
    // RN takes the four corner radii individually — top-left, top-right,
    // bottom-right, bottom-left. The bottom-right corner is the sharp
    // one for the user bubble (mirrors the Pencil design).
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  text: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    lineHeight: 22
  }
});
