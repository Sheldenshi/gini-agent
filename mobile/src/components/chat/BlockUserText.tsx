import { Image, StyleSheet, Text, View } from "react-native";
import { authHeader, uploadUrl } from "@/src/api";
import { family, theme } from "@/src/theme";
import type { UserTextBlock } from "@/src/types";

// Right-aligned dark bubble. The asymmetric corner geometry has a
// sharper bottom-left so the bubble visually "points" toward the
// user-bubble corner of the conversation (which is the closest edge to
// the input bar). No author/time header — the design uses alignment
// and color alone as the role signal.
//
// Attached images render as a wrapped grid of thumbnails above the
// bubble. The bubble itself is omitted when the user only sent images
// (no text), so an image-only message doesn't show an empty pill.
export function BlockUserText({ block }: { block: UserTextBlock }) {
  const images = block.images ?? [];
  const hasText = block.text.length > 0;
  // Gateway uploads require the same bearer token the SSE / REST paths
  // use; <Image> on RN supports a headers prop on its source object.
  const headers = authHeader();
  return (
    <View style={styles.row}>
      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((image) => (
            <View key={image.id} style={styles.imageWrapper}>
              <Image
                source={{ uri: uploadUrl(image.id), headers }}
                style={styles.image}
                resizeMode="cover"
                accessibilityLabel="Attached image"
              />
            </View>
          ))}
        </View>
      ) : null}
      {hasText ? (
        <View style={styles.bubble}>
          <Text style={styles.text} selectable>
            {block.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    alignItems: "flex-end",
    gap: 6
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
  },
  imageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6
  },
  imageWrapper: {
    width: 160,
    height: 160,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.codeChipBg
  },
  image: {
    width: "100%",
    height: "100%"
  }
});
