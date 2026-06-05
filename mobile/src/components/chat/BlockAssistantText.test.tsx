import { describe, expect, mock, test, beforeEach } from "bun:test";
import * as ReactActual from "react";

// ---------------------------------------------------------------------------
// These RN components can't mount under bun (react-native ships untranspiled
// Flow and there is no native runtime / test renderer in this project). So we
// stub the native modules and invoke the exported render rules + the
// SelectableBlockText forwardRef directly, inspecting the returned element
// tree. `Platform.OS` is a mutable field so a test can pick the iOS vs.
// non-iOS branch; reset it in beforeEach so mutations don't leak.
// ---------------------------------------------------------------------------

const openURL = mock((_url: string) => Promise.resolve());
const Platform = { OS: "ios" as "ios" | "android" | "web" };

// Identity-comparable stand-ins for the native primitives. We never render
// them, so the bodies are no-ops; tests assert on element.type === Text etc.
function Text() {
  return null;
}
function TextInput() {
  return null;
}
function View() {
  return null;
}
function AnimatedView() {
  return null;
}

const loopStop = mock(() => {});
const loopStart = mock(() => {});

mock.module("react-native", () => ({
  Platform,
  Text,
  TextInput,
  View,
  StyleSheet: { create: (styles: unknown) => styles },
  Linking: { openURL },
  Animated: {
    View: AnimatedView,
    Value: function Value(this: { v: number }, v: number) {
      this.v = v;
    },
    loop: () => ({ start: loopStart, stop: loopStop }),
    sequence: () => ({}),
    timing: () => ({})
  },
  Easing: { inOut: (e: unknown) => e, ease: () => ({}) }
}));

mock.module("react-native-markdown-display", () => ({
  __esModule: true,
  default: function Markdown() {
    return null;
  },
  MarkdownIt: (cfg: unknown) => cfg
}));

mock.module("@/src/theme", () => ({
  theme: {
    assistantBubble: "#E9E9EB",
    assistantBubbleText: "#1A1A1A",
    accent: "#007AFF",
    codeChipBg: "#E8E8ED",
    codeChipText: "#3A3A3C",
    border: "#ECECEC"
  },
  family: (name: string, weight = 400) => `${name}_${weight}`
}));

// StreamingCursor uses useRef/useEffect; bare invocation outside a renderer
// would throw "invalid hook call". Override just those two so the cursor's
// effect body runs (and its cleanup is captured) without a React renderer.
// Everything else (forwardRef, the JSX runtime) stays real.
const effectCleanups: Array<() => void> = [];
mock.module("react", () => ({
  __esModule: true,
  ...ReactActual,
  default: (ReactActual as { default?: unknown }).default ?? ReactActual,
  useRef: <T,>(v: T) => ({ current: v }),
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") effectCleanups.push(cleanup);
  }
}));

const { markdownRules, BlockAssistantText } = await import(
  "@/src/components/chat/BlockAssistantText"
);
const { SelectableBlockText } = await import(
  "@/src/components/chat/SelectableBlockText"
);

type Node = {
  key: string;
  content?: string;
  type?: string;
  attributes?: { href?: string };
  children?: Node[];
};

// markdownRules is strongly typed against the library's ASTNode and forwardRef
// hides `.render` from its public type. The tests poke both with hand-built
// partial nodes, so reach them through loose accessors.
const rule = (name: string): ((...a: unknown[]) => any) =>
  (markdownRules as Record<string, (...a: unknown[]) => any>)[name];
const renderSel = (props: unknown): any =>
  (
    SelectableBlockText as unknown as {
      render: (p: unknown, r: unknown) => any;
    }
  ).render(props, null);

// Minimal style map covering every key the inline rules read.
const styles = {
  text: {},
  textgroup: {},
  strong: {},
  em: {},
  s: {},
  inline: {},
  link: { color: "#007AFF" },
  code_block: {},
  fence: {}
} as Record<string, object>;

function linkNode(href?: string, label = "docs"): Node {
  return {
    key: "lnk",
    type: "link",
    content: "",
    attributes: href ? { href } : {},
    children: [{ key: "lt", type: "text", content: label, children: [] }]
  };
}

// Render a block-level rule (paragraph/heading) and resolve the iOS-vs-Text
// wrapper choice by invoking the SelectableBlockText forwardRef body.
function renderBlock(ruleName: string, node: Node, children: unknown[]) {
  const el = rule(ruleName)(node, children, [], styles);
  return renderSel(el.props);
}

beforeEach(() => {
  Platform.OS = "ios";
  openURL.mockClear();
});

describe("bug: markdown links inside iOS block text are not clickable", () => {
  // The defect: on iOS, paragraphs/headings wrap their inline children in a
  // <TextInput editable={false}> for the selection loupe. A nested
  // <Text onPress> link never receives taps inside a TextInput, so links
  // render styled but inert. A link-containing block must fall back to the
  // selectable <Text> path so the link's onPress is reachable.
  test("iOS paragraph containing a link renders as Text, not TextInput", () => {
    const para: Node = { key: "p", type: "paragraph", children: [linkNode("https://example.com")] };
    const inner = renderBlock("paragraph", para, [rule("link")(linkNode("https://example.com"), "docs", [], styles)]);
    expect(inner.type).toBe(Text);
    expect(inner.props.selectable).toBe(true);
  });

  test("iOS heading containing a link renders as Text, not TextInput", () => {
    const h: Node = { key: "h", type: "heading1", children: [linkNode("https://example.com")] };
    const inner = renderBlock("heading1", h, [rule("link")(linkNode("https://example.com"), "docs", [], styles)]);
    expect(inner.type).toBe(Text);
  });

  test("link nested deeper (inside emphasis) is still detected on iOS", () => {
    const nested: Node = {
      key: "p",
      type: "paragraph",
      children: [{ key: "em", type: "em", children: [linkNode("https://deep.example")] }]
    };
    const inner = renderBlock("paragraph", nested, ["x"]);
    expect(inner.type).toBe(Text);
  });

  test("the link rule wires onPress to Linking.openURL", () => {
    const el = rule("link")(linkNode("https://example.com"), "docs", [], styles);
    expect(typeof el.props.onPress).toBe("function");
    el.props.onPress();
    expect(openURL).toHaveBeenCalledWith("https://example.com");
  });
});

describe("non-regression: link-free blocks keep the iOS selection wrapper", () => {
  test("iOS paragraph without a link still renders as TextInput", () => {
    const para: Node = { key: "p", type: "paragraph", children: [{ key: "t", type: "text", content: "hello", children: [] }] };
    const inner = renderBlock("paragraph", para, ["hello"]);
    expect(inner.type).toBe(TextInput);
  });

  test("iOS paragraph with empty children still renders as TextInput", () => {
    const para: Node = { key: "p", type: "paragraph", children: [] };
    expect(renderBlock("paragraph", para, []).type).toBe(TextInput);
  });

  test("iOS paragraph with no children field still renders as TextInput", () => {
    const para: Node = { key: "p", type: "paragraph" };
    expect(renderBlock("paragraph", para, []).type).toBe(TextInput);
  });

  test("non-iOS always uses Text regardless of links", () => {
    Platform.OS = "android";
    const para: Node = { key: "p", type: "paragraph", children: [linkNode("https://x.example")] };
    expect(renderBlock("paragraph", para, ["x"]).type).toBe(Text);
  });

  test("iOS paragraph whose only link is a blocklink keeps TextInput", () => {
    // A blocklink (e.g. a linked image) is handled by the library's own
    // block-safe touchable plus the <Markdown onLinkPress> guard, not the
    // Text fallback — rendering block content under Text would break — so it
    // must NOT flip the block off the TextInput selection path.
    const blockLink: Node = {
      key: "bl",
      type: "blocklink",
      content: "",
      attributes: { href: "https://example.com" },
      children: [{ key: "img", type: "image", content: "", children: [] }]
    };
    const para: Node = { key: "p", type: "paragraph", children: [blockLink] };
    expect(renderBlock("paragraph", para, ["x"]).type).toBe(TextInput);
  });
});

describe("SelectableBlockText branches", () => {
  test("iOS + containsLink -> selectable Text", () => {
    const out = renderSel({ style: {}, children: "x", containsLink: true });
    expect(out.type).toBe(Text);
    expect(out.props.selectable).toBe(true);
  });

  test("iOS + no link -> TextInput", () => {
    const out = renderSel({ style: {}, children: "x", containsLink: false });
    expect(out.type).toBe(TextInput);
    expect(out.props.editable).toBe(false);
  });

  test("web -> Text", () => {
    Platform.OS = "web";
    const out = renderSel({ style: {}, children: "x" });
    expect(out.type).toBe(Text);
  });
});

describe("markdown rules coverage", () => {
  test("inline + emphasis rules return Text-based nodes", () => {
    for (const name of ["text", "textgroup", "strong", "em", "s", "inline"]) {
      const el = rule(name)({ key: name, content: name, children: [] }, ["c"], [], styles);
      expect(el.type).toBe(Text);
      expect(el.props.selectable).toBe(true);
    }
  });

  test("all heading levels render", () => {
    for (const h of ["heading2", "heading3", "heading4", "heading5", "heading6"]) {
      const node: Node = { key: h, type: h, children: [{ key: "t", type: "text", content: "x", children: [] }] };
      expect(renderBlock(h, node, ["x"]).type).toBe(TextInput);
    }
  });

  test("link without href has no onPress", () => {
    const el = rule("link")(linkNode(undefined), "docs", [], styles);
    expect(el.props.onPress).toBeUndefined();
  });

  test("link onPress opens http(s) only; other schemes inert", () => {
    // A leading-whitespace href is rejected too (no trim, default-deny).
    for (const ok of ["http://a.example", "https://b.example/x"]) {
      openURL.mockClear();
      const el = rule("link")(linkNode(ok), "x", [], styles);
      expect(typeof el.props.onPress).toBe("function");
      el.props.onPress();
      expect(openURL).toHaveBeenCalledWith(ok);
    }
    for (const bad of [
      "tel:18005551234",
      "mailto:a@b.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gini://deep/link",
      "/relative/path",
      "//proto.relative",
      " https://leading.space"
    ]) {
      const el = rule("link")(linkNode(bad), "x", [], styles);
      expect(el.props.onPress).toBeUndefined();
    }
  });

  test("code_block trims a single trailing newline; fence handles missing content", () => {
    const cb = rule("code_block")({ key: "c", content: "a\n", children: [] }, [], [], styles);
    expect(renderSel(cb.props).props.children).toBe("a");
    const cb2 = rule("code_block")({ key: "c2", content: "b", children: [] }, [], [], styles);
    expect(renderSel(cb2.props).props.children).toBe("b");
    const f = rule("fence")({ key: "f", children: [] }, [], [], styles);
    expect(renderSel(f.props).props.children).toBe("");
    const f2 = rule("fence")({ key: "f2", content: "c\n", children: [] }, [], [], styles);
    expect(renderSel(f2.props).props.children).toBe("c");
  });
});

describe("BlockAssistantText component + StreamingCursor", () => {
  test("renders without a cursor when not streaming", () => {
    const el = BlockAssistantText({ block: { text: "hi", streaming: false } as never }) as any;
    expect(el.type).toBe(View);
  });

  test("passes a web-scheme onLinkPress guard to Markdown", () => {
    // The library's default link/blocklink openers go through onLinkPress;
    // it must allow http(s) and reject other schemes.
    const el = BlockAssistantText({ block: { text: "hi", streaming: false } as never }) as any;
    const markdownEl = el.props.children.props.children[0];
    const onLinkPress = markdownEl.props.onLinkPress;
    expect(onLinkPress("https://ok.example")).toBe(true);
    expect(onLinkPress("http://ok.example")).toBe(true);
    expect(onLinkPress("tel:123")).toBe(false);
    expect(onLinkPress("gini://x")).toBe(false);
  });

  test("renders a cursor when streaming and the cursor effect loops", () => {
    const el = BlockAssistantText({ block: { text: "hi", streaming: true } as never }) as any;
    expect(el.type).toBe(View);
    // Outer row View wraps the bubble View, whose children are [Markdown,
    // cursor]. The streaming branch mounts <StreamingCursor/>; invoke it to
    // run its animation effect (and the captured cleanup) under the hook stubs.
    const cursorEl = el.props.children.props.children[1];
    const Cursor = cursorEl.type as () => unknown;
    Cursor();
    expect(loopStart).toHaveBeenCalled();
    for (const c of effectCleanups.splice(0)) c();
    expect(loopStop).toHaveBeenCalled();
  });
});
