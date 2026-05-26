import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { family, theme } from "@/src/theme";
import type { AssistantTextBlock } from "@/src/types";

// Left-aligned light-gray bubble. Mirror of the user bubble's corner
// pattern — sharp bottom-left so the bubble points toward the agent's
// side of the thread. Streaming blocks carry the FULL accreted text on
// every wire delta (see ChatBlock contract), so the markdown component
// sees a continuously growing string and we don't have to splice
// deltas client-side.
//
// A blinking cursor renders only while `streaming` is true; the terminal
// upsert flips it to false and the cursor goes away.
export function BlockAssistantText({ block }: { block: AssistantTextBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Markdown style={markdownStyles}>{block.text}</Markdown>
        {block.streaming ? <StreamingCursor /> : null}
      </View>
    </View>
  );
}

function StreamingCursor() {
  // Opacity-pulsing block that sits at the end of the streaming text so
  // the user has a visible "still working" cue. Using the native driver
  // keeps the animation off the JS thread while the next delta lands.
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.2,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[styles.cursor, { opacity }]} />;
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    maxWidth: "80%"
  },
  bubble: {
    backgroundColor: theme.assistantBubble,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    borderBottomLeftRadius: 4
  },
  cursor: {
    marginTop: 2,
    width: 7,
    height: 14,
    backgroundColor: theme.assistantBubbleText,
    alignSelf: "flex-start"
  }
});

// react-native-markdown-display takes a style map keyed by element name.
// Override the colors to the light palette so the rendered tree sits
// on the gray bubble. Inline code and code fences use the chat's
// code-chip background.
const markdownStyles = StyleSheet.create({
  body: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    lineHeight: 22
  },
  paragraph: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    marginTop: 0,
    marginBottom: 6
  },
  heading1: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 20,
    marginTop: 6,
    marginBottom: 4
  },
  heading2: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 18,
    marginTop: 6,
    marginBottom: 4
  },
  heading3: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 16,
    marginTop: 6,
    marginBottom: 4
  },
  heading4: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15,
    marginTop: 6,
    marginBottom: 4
  },
  heading5: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14,
    marginTop: 6,
    marginBottom: 4
  },
  heading6: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13,
    marginTop: 6,
    marginBottom: 4
  },
  strong: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 700)
  },
  em: {
    color: theme.assistantBubbleText,
    fontStyle: "italic"
  },
  link: { color: theme.accent, textDecorationLine: "underline" },
  blockquote: {
    backgroundColor: theme.codeChipBg,
    borderLeftColor: theme.accent,
    borderLeftWidth: 3,
    paddingLeft: 8,
    paddingVertical: 4,
    marginVertical: 4
  },
  code_inline: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontFamily: family("JetBrainsMono"),
    fontSize: 14
  },
  code_block: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    padding: 8,
    borderRadius: 6,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13
  },
  fence: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    padding: 8,
    borderRadius: 6,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13,
    borderWidth: 0
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    marginVertical: 2
  },
  hr: {
    backgroundColor: theme.border,
    height: 1,
    marginVertical: 8
  },
  table: { borderColor: theme.border },
  thead: { borderColor: theme.border, backgroundColor: theme.codeChipBg },
  th: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 700),
    padding: 6
  },
  tbody: { borderColor: theme.border },
  td: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    padding: 6,
    borderColor: theme.border
  }
});
