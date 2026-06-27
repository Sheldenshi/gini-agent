import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode
} from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { family, theme } from "@/src/theme";
import type { AssistantTextBlock } from "@/src/types";
import { authHeader, uploadUrl } from "@/src/api";
import { uploadIdFromRef } from "@/src/upload-ref";
import { AuthedImage } from "./AuthedImage";
import { useImagePreview } from "@/src/components/ImagePreview";
import { openUploadInBrowser } from "./uploadAttachment";
import {
  handleMarkdownLinkPress,
  isWebUrl,
  linkHostname,
  openLink,
  presentLinkMenu
} from "./linkContextMenu";
import { SelectableBlockText } from "./SelectableBlockText";

type MarkdownNode = {
  key: string;
  type?: string;
  content: string;
  attributes?: { href?: string; src?: string; alt?: string };
  children?: MarkdownNode[];
};
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
// they render as tappable anchors alongside `[label](url)` links. Taps and
// long-presses are handled by the custom link rule + `onLinkPress` below,
// which route through an in-app browser instead of the system default.
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
          onLinkPress={handleMarkdownLinkPress}
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
// Collect the visible text of a markdown node's subtree. Used to recover the
// chip label (the filename in `[report.pdf](gini-upload://id)`) from a link
// node so the downloaded attachment gets a sensible filename for the OS
// preview/share sheet.
function nodeText(node: MarkdownNode): string {
  if (node.content) return node.content;
  return (node.children ?? []).map(nodeText).join("");
}

// Walk an AST node's subtree for an inline, *interactive* `link`. markdown-it
// (with `linkify`) collapses `link_open`/`link_close` into a node of type
// `link`, covering both `[label](url)` and bare autolinked URLs. A link is
// interactive — and so must flip the block off the iOS TextInput selection path,
// whose wrapper would otherwise swallow the link's taps — when it's either an
// http(s) link OR a `gini-upload://` attachment chip (the link rule gives both
// an onPress). A plain non-web, non-upload link is inert and should keep normal
// text selection. A block-level `blocklink` (e.g. a linked image) keeps the
// library's own touchable wrapper and is excluded here.
function hasLinkDescendant(node: MarkdownNode): boolean {
  const href = node.attributes?.href;
  if (
    node.type === "link" &&
    href !== undefined &&
    (isWebUrl(href) || uploadIdFromRef(href) !== null)
  )
    return true;
  return node.children?.some(hasLinkDescendant) ?? false;
}

// Walk an AST node's subtree for an `image` node that the image rule will
// actually render — i.e. one whose `src` is a `gini-upload://` ref (a foreign
// src is dropped to null, so it contributes no View to host). Such an image
// renders as MarkdownUploadImage, a Pressable (a View subtree), which RN cannot
// mount inside the iOS `<TextInput>` selection wrapper a text block resolves to.
// A block carrying one must therefore render as a plain View instead, so the
// image's View subtree has a valid host. The default markdown paragraph rule is
// itself a View for exactly this reason; the app's text-wrapper override (for
// clean URL wrapping + selection) is what would otherwise strand the image.
function hasUploadImageDescendant(node: MarkdownNode): boolean {
  if (node.type === "image" && uploadIdFromRef(node.attributes?.src) !== null)
    return true;
  return node.children?.some(hasUploadImageDescendant) ?? false;
}

// Block-level renderers wrap inline children in a single selectable
// block. On iOS that's a `TextInput multiline editable={false}` (the
// only RN primitive that exposes the loupe + drag handles for partial
// selection); on web/Android it falls back to `<Text selectable>` since
// their native Text already supports range selection. Either way, the
// outer wrapper coalesces the library's per-token inline children into
// one text run so RN's text engine can wrap URLs and long lines
// cleanly (see comment above).
//
// A block that contains an interactive (http/https) link is flagged so
// SelectableBlockText renders it as a plain, non-selectable Text on every
// platform: the iOS TextInput wrapper would swallow the link's taps, and a
// selectable wrapper would let iOS hijack the long-press for text selection
// instead of showing the link menu.
//
// A block that contains a renderable upload image takes a different escape: the
// image renders as a View subtree (MarkdownUploadImage), which can't mount
// inside the iOS TextInput a text wrapper resolves to, so the block renders as
// a plain View (the library's own default paragraph rule is a View for the same
// reason). It mirrors that default rule's row/wrap layout (imageBlock below) so
// a mid-sentence image keeps inline, wrapping paragraph flow — prose, image,
// prose flow left-to-right and wrap, rather than stacking vertically under RN's
// default column direction — and carries over the text style's vertical margins.
const renderAsText =
  (style: { marginTop?: number; marginBottom?: number }): RenderRule =>
  (node, children) => {
    if (hasUploadImageDescendant(node)) {
      return (
        <View
          key={node.key}
          style={[
            imageBlockStyles.block,
            { marginTop: style.marginTop, marginBottom: style.marginBottom }
          ]}
        >
          {children}
        </View>
      );
    }
    return (
      <SelectableBlockText
        key={node.key}
        style={style}
        containsLink={hasLinkDescendant(node)}
      >
        {children}
      </SelectableBlockText>
    );
  };

// Mirror of react-native-markdown-display's `_VIEW_SAFE_paragraph` layout
// (flexWrap row, top-aligned, full width) so an image-bearing paragraph lays
// its inline children out the same way the library's default paragraph View
// would — see the View escape in renderAsText.
const imageBlockStyles = StyleSheet.create({
  block: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    width: "100%"
  }
});
// A markdown link is interactive (tap opens, long-press shows the menu), so
// its label must not be selectable — otherwise iOS fires its own text
// selection "Copy" callout on long-press alongside the link menu. The inline
// children arrive pre-rendered as selectable <Text> from the text rules, so
// recursively clone them with selection disabled.
function nonSelectable(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const el = child as ReactElement<{ children?: ReactNode }>;
    return cloneElement(
      el as ReactElement<{ selectable?: boolean; children?: ReactNode }>,
      { selectable: false },
      nonSelectable(el.props.children)
    );
  });
}

// An inline agent image rendered from a `gini-upload://<id>` markdown ref.
// Tapping opens the full-screen preview. Split into its own component so it can
// use the useImagePreview hook (the markdown rules are a module-level constant,
// not a component, so the hook can't live there directly).
function MarkdownUploadImage({ uploadId }: { uploadId: string }) {
  const { open } = useImagePreview();
  const uri = uploadUrl(uploadId);
  const headers = authHeader();
  return (
    <Pressable
      style={uploadImageStyles.wrapper}
      onPress={() => open({ uri, headers })}
      accessibilityRole="button"
      accessibilityLabel="Open image"
    >
      <AuthedImage uploadId={uploadId} style={uploadImageStyles.image} resizeMode="cover" />
    </Pressable>
  );
}

const uploadImageStyles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.border,
    alignSelf: "flex-start"
  },
  image: {
    width: 240,
    height: 170
  }
});

// A foreign (non-upload) image `![alt](https://…)` an agent may emit instead of
// the canonical `gini-upload://` ref. The bytes are NOT fetched — auto-loading a
// model-authored URL at render time is the SSRF / tracking-pixel surface the
// image rule guards against. Rather than drop it silently (a blank gap the
// reader can't explain), render an inert chip naming the image and its host;
// the URL is only fetched on an explicit tap (in-app browser), and a long-press
// raises the same link menu as a text link. This mirrors how a foreign text
// link already behaves — nothing about an image should make it vanish.
function MarkdownForeignImage({ alt, href }: { alt: string; href: string }) {
  return (
    <Pressable
      style={foreignImageStyles.chip}
      onPress={() => openLink(href)}
      onLongPress={(e) =>
        presentLinkMenu(href, e.nativeEvent.pageX, e.nativeEvent.pageY)
      }
      accessibilityRole="button"
      accessibilityLabel={`Open image: ${alt || linkHostname(href)}`}
    >
      <Feather name="image" size={15} color={theme.muted} />
      <Text style={foreignImageStyles.label} numberOfLines={1}>
        {alt || "Image"}
      </Text>
      <Text style={foreignImageStyles.host} numberOfLines={1}>
        {linkHostname(href)}
      </Text>
    </Pressable>
  );
}

const foreignImageStyles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.codeChipBg,
    alignSelf: "flex-start",
    maxWidth: "100%"
  },
  label: {
    color: theme.assistantBubbleText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14,
    flexShrink: 1
  },
  host: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    flexShrink: 1
  }
});

// Inline rules (text/textgroup/link/strong/em/s/inline) need their own
// `selectable` because react-native-markdown-display emits <Text>
// wrappers per rule and the defaults omit the prop — without these
// overrides a long-press in the middle of a paragraph hits an inner
// non-selectable Text and the gesture finds nothing to copy.
export const markdownRules: Record<string, RenderRule> = {
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
    // A `gini-upload://<id>` link is a non-image attachment. Tapping it mints a
    // short-lived SIGNED url server-side and opens it in the in-app browser
    // (SFSafariViewController / Custom Tabs) — the signed url carries its own
    // auth in the query string, so the header-less browser can load it. If
    // minting fails it falls back to downloading the bytes with the bearer and
    // handing them to the OS share/Quick Look sheet. Stays an inline <Text> so
    // it can sit mid-prose; the filename label is recovered from the node text.
    const uploadId = uploadIdFromRef(href);
    if (uploadId) {
      const filename = nodeText(node).trim() || "attachment";
      return (
        <Text
          key={node.key}
          style={styles.link}
          onPress={() => {
            void openUploadInBrowser(uploadId, filename);
          }}
        >
          {nonSelectable(children)}
        </Text>
      );
    }
    // Only http(s) links are interactive. Tap opens the in-app browser;
    // long-press raises the link context menu at the touch point. The link
    // is intentionally not `selectable` so a long-press shows the menu
    // instead of starting a text selection.
    return (
      <Text
        key={node.key}
        style={styles.link}
        onPress={href && isWebUrl(href) ? () => openLink(href) : undefined}
        onLongPress={
          href && isWebUrl(href)
            ? (e) =>
                presentLinkMenu(href, e.nativeEvent.pageX, e.nativeEvent.pageY)
            : undefined
        }
      >
        {nonSelectable(children)}
      </Text>
    );
  },
  // An agent-produced image is authored as a `gini-upload://<id>` markdown
  // image ref. Override the default image rule (which renders a header-less
  // FitImage that 401s against the gateway) to render AuthedImage instead —
  // it carries the bearer on native and fetches a blob on web. A foreign
  // http(s) src is NOT auto-fetched (that's the SSRF / tracking-pixel surface);
  // it renders an inert chip that only loads on tap. Any other src (data:,
  // javascript:, …) is dropped entirely. The image rule has a special signature
  // (extra allowedImageHandlers / defaultImageHandler args), so it's cast.
  image: ((node: MarkdownNode) => {
    const src = node.attributes?.src;
    const id = uploadIdFromRef(src);
    if (id) return <MarkdownUploadImage key={node.key} uploadId={id} />;
    if (src && isWebUrl(src)) {
      return (
        <MarkdownForeignImage
          key={node.key}
          alt={node.attributes?.alt ?? ""}
          href={src}
        />
      );
    }
    return null;
  }) as RenderRule,
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
