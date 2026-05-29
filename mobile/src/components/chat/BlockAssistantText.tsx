import { useEffect, useRef } from "react";
import { Animated, Easing, Linking, StyleSheet, Text, View } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { family, theme } from "@/src/theme";
import type { AssistantTextBlock } from "@/src/types";
import { SelectableBlockText } from "./SelectableBlockText";

type MarkdownNode = { key: string; content: string; attributes?: { href?: string } };
type MarkdownStylesMap = Record<string, object>;
type RuleArgs = [
  node: MarkdownNode,
  children: React.ReactNode,
  parent: unknown,
  styles: MarkdownStylesMap,
  inheritedStyles?: object
];
type RenderRule = (...args: RuleArgs) => React.ReactNode;

// `linkify: true` autolinks bare URLs (e.g. `https://example.com`) that
// arrive in assistant text without explicit `[label](url)` markdown, so
// they render as tappable anchors. The library's default press handler
// hands the URL to `Linking.openURL`, which on iOS 14+ and Android
// respects the user's configured default browser (Chrome if set).
const markdownIt = MarkdownIt({ typographer: true, linkify: true });

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
        <Markdown
          style={markdownStyles}
          markdownit={markdownIt}
          rules={markdownRules}
        >
          {block.text}
        </Markdown>
        {block.streaming ? <StreamingCursor /> : null}
      </View>
    </View>
  );
}

// react-native-markdown-display's default paragraph/heading renderers
// are Views with `flexDirection: "row"` + `flexWrap: "wrap"`, and each
// inline token (text run, link, strong, em) becomes its own sibling
// <Text>. RN's text layout doesn't span across sibling Text nodes, so a
// paragraph mixing short prose with a long URL wraps per-token instead
// of as one continuous text block — the bubble shrinks to fit the
// widest stand-alone token and URLs end up broken every few characters.
// Rendering these block-level nodes as a single Text lets all inline
// children flow as true inline runs, which is what RN's text engine
// actually wraps cleanly. We use the markdown body's font props so the
// outer Text reserves the right line height before nested inline Texts
// supply their own font styles via the lib's inherited-style cascade.
const blockTextBase = {
  color: theme.assistantBubbleText,
  fontFamily: family("HankenGrotesk", 500),
  fontSize: 16,
  lineHeight: 22
} as const;
const blockTextStyles = StyleSheet.create({
  paragraph: { ...blockTextBase, marginTop: 0, marginBottom: 6 },
  heading1: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 20,
    lineHeight: 26,
    marginTop: 6,
    marginBottom: 4
  },
  heading2: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 18,
    lineHeight: 24,
    marginTop: 6,
    marginBottom: 4
  },
  heading3: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 700),
    marginTop: 6,
    marginBottom: 4
  },
  heading4: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
    marginBottom: 4
  },
  heading5: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 4
  },
  heading6: {
    ...blockTextBase,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    marginBottom: 4
  }
});
// Block-level renderers wrap inline children in a single selectable
// block. On iOS that's a `TextInput multiline editable={false}` (the
// only RN primitive that exposes the loupe + drag handles for partial
// selection); on web/Android it falls back to `<Text selectable>` since
// their native Text already supports range selection. Either way, the
// outer wrapper coalesces the library's per-token inline children into
// one text run so RN's text engine can wrap URLs and long lines
// cleanly (see comment above).
const renderAsText =
  (style: object): RenderRule =>
  (node, children) => (
    <SelectableBlockText key={node.key} style={style}>
      {children}
    </SelectableBlockText>
  );
// Inline rules (text/textgroup/link/strong/em/s/inline) need their own
// `selectable` because react-native-markdown-display emits <Text>
// wrappers per rule and the defaults omit the prop — without these
// overrides a long-press in the middle of a paragraph hits an inner
// non-selectable Text and the gesture finds nothing to copy.
const markdownRules: Record<string, RenderRule> = {
  paragraph: renderAsText(blockTextStyles.paragraph),
  heading1: renderAsText(blockTextStyles.heading1),
  heading2: renderAsText(blockTextStyles.heading2),
  heading3: renderAsText(blockTextStyles.heading3),
  heading4: renderAsText(blockTextStyles.heading4),
  heading5: renderAsText(blockTextStyles.heading5),
  heading6: renderAsText(blockTextStyles.heading6),
  text: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <Text key={node.key} style={[inheritedStyles, styles.text]} selectable>
      {node.content}
    </Text>
  ),
  textgroup: (node, children, _parent, styles) => (
    <Text key={node.key} style={styles.textgroup} selectable>
      {children}
    </Text>
  ),
  strong: (node, children, _parent, styles) => (
    <Text key={node.key} style={styles.strong} selectable>
      {children}
    </Text>
  ),
  em: (node, children, _parent, styles) => (
    <Text key={node.key} style={styles.em} selectable>
      {children}
    </Text>
  ),
  s: (node, children, _parent, styles) => (
    <Text key={node.key} style={styles.s} selectable>
      {children}
    </Text>
  ),
  inline: (node, children, _parent, styles) => (
    <Text key={node.key} style={styles.inline} selectable>
      {children}
    </Text>
  ),
  link: (node, children, _parent, styles) => {
    const href = node.attributes?.href;
    return (
      <Text
        key={node.key}
        style={styles.link}
        selectable
        onPress={href ? () => void Linking.openURL(href) : undefined}
      >
        {children}
      </Text>
    );
  },
  // Code blocks render as `SelectableBlockText` so iOS gets the loupe
  // and drag handles on multi-line snippets. The library's defaults
  // emit a single `<Text>` here, which on iOS would otherwise collapse
  // to a Copy-all menu. The trailing-newline trim mirrors the library's
  // behavior — the parser appends an extra `\n` at the end of fenced /
  // indented blocks that visually shows as an empty trailing line.
  code_block: (node, _children, _parent, styles, inheritedStyles = {}) => {
    const raw = node.content ?? "";
    const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return (
      <SelectableBlockText
        key={node.key}
        style={[inheritedStyles, styles.code_block]}
      >
        {content}
      </SelectableBlockText>
    );
  },
  fence: (node, _children, _parent, styles, inheritedStyles = {}) => {
    const raw = node.content ?? "";
    const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return (
      <SelectableBlockText
        key={node.key}
        style={[inheritedStyles, styles.fence]}
      >
        {content}
      </SelectableBlockText>
    );
  }
};

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
    // Pin to a definite 92% width rather than `maxWidth`. The library's
    // list rendering uses `flex: 1` on `bullet_list_content`, which
    // contributes zero intrinsic width to the bubble's measurement —
    // without a fixed parent frame the bubble sizes only to its widest
    // non-list paragraph and list rows underneath wrap at a tiny width,
    // visibly narrower than every other assistant message. A definite
    // 92% gives the inner `flex: 1` columns a frame to resolve against.
    width: "92%"
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
