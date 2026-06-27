import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
// Importing the shared setup installs the (process-global) module mocks before
// the components under test are imported. The same mocks are used by
// linkContextMenu.test so the two files can run in one process.
import {
  alert,
  downloadAsync,
  effectCleanups,
  loopStart,
  loopStop,
  openBrowserAsync,
  Platform,
  share,
  Text,
  TextInput,
  View
} from "./chatMockSetup";

const { markdownRules, BlockAssistantText } = await import(
  "@/src/components/chat/BlockAssistantText"
);
const { openUploadAttachment } = await import(
  "@/src/components/chat/uploadAttachment"
);
const { SelectableBlockText } = await import(
  "@/src/components/chat/SelectableBlockText"
);
// The real link module (its native deps are mocked by chatMockSetup), so the
// link rule's wiring is verified through observable behavior.
const { subscribeLinkMenu } = await import(
  "@/src/components/chat/linkContextMenu"
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
  openBrowserAsync.mockClear();
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
    // Link blocks render as a plain (non-selectable) Text so the link's
    // gestures win over iOS text selection.
    expect(inner.props.selectable).toBeFalsy();
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

  test("iOS paragraph whose only link is a gini-upload chip renders as Text, not TextInput", () => {
    // A `gini-upload://` chip has a live onPress (mint signed url + open the
    // in-app browser), so it's interactive and must flip the block off the
    // TextInput selection path — otherwise the wrapper swallows the chip's tap
    // and the file chip is inert on iOS. Mirrors the http(s) case above.
    const para: Node = {
      key: "p",
      type: "paragraph",
      children: [linkNode("gini-upload://up_pdf01", "report.pdf")]
    };
    const inner = renderBlock("paragraph", para, [
      rule("link")(linkNode("gini-upload://up_pdf01", "report.pdf"), "report.pdf", [], styles)
    ]);
    expect(inner.type).toBe(Text);
    expect(inner.props.selectable).toBeFalsy();
  });
});

describe("link tap and long-press wiring", () => {
  test("a web link taps to the in-app browser and long-presses to the menu", () => {
    const el = rule("link")(linkNode("https://example.com"), "docs", [], styles);
    expect(typeof el.props.onPress).toBe("function");
    el.props.onPress();
    expect(openBrowserAsync).toHaveBeenCalledWith("https://example.com");

    const seen: Array<{ href: string; x: number; y: number }> = [];
    const unsub = subscribeLinkMenu((r) => seen.push(r));
    expect(typeof el.props.onLongPress).toBe("function");
    el.props.onLongPress({ nativeEvent: { pageX: 12, pageY: 34 } });
    unsub();
    expect(seen).toEqual([{ href: "https://example.com", x: 12, y: 34 }]);
  });

  test("the link is not selectable so long-press shows the menu, not selection", () => {
    const el = rule("link")(linkNode("https://example.com"), "docs", [], styles);
    expect(el.props.selectable).toBeFalsy();
  });

  test("the link's label children are forced non-selectable (no native Copy callout)", () => {
    // A selectable child Text would trigger iOS's own selection menu on
    // long-press; the link renderer clones its children with selectable off.
    const child = createElement(Text as never, { selectable: true }, "docs");
    const el = rule("link")(linkNode("https://example.com"), [child], [], styles);
    const kids = (Array.isArray(el.props.children) ? el.props.children : [el.props.children]) as any[];
    expect(kids[0].props.selectable).toBe(false);
    // The label text is preserved (Children.map normalizes it into an array).
    expect([kids[0].props.children].flat()).toEqual(["docs"]);
  });

  test("non-web and missing-href links are inert (no onPress / onLongPress)", () => {
    for (const bad of [
      "tel:18005551234",
      "mailto:a@b.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gini://deep/link",
      "/relative/path",
      "//proto.relative",
      " https://leading.space",
      undefined
    ]) {
      const el = rule("link")(linkNode(bad), "x", [], styles);
      expect(el.props.onPress).toBeUndefined();
      expect(el.props.onLongPress).toBeUndefined();
    }
  });
});

describe("non-image attachment chip (gini-upload:// link)", () => {
  function uploadLink(label: string): Node {
    return {
      key: "ul",
      type: "link",
      content: "",
      attributes: { href: "gini-upload://up_pdf01" },
      children: [{ key: "t", type: "text", content: label, children: [] }]
    };
  }

  test("tapping the chip mints a signed url and opens it in the in-app browser", async () => {
    Platform.OS = "ios";
    openBrowserAsync.mockClear();
    const el = rule("link")(uploadLink("report.pdf"), "report.pdf", [], styles);
    expect(typeof el.props.onPress).toBe("function");
    // The chip stays a plain Text node so it can sit mid-prose.
    expect(el.type).toBe(Text);
    el.props.onPress();
    // onPress fire-and-forgets the async mint+open; await a couple ticks so the
    // sign promise resolves and openLink fires before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // signUploadUrl (mocked in chatMockSetup) returns a signed url; openLink
    // opens it via the in-app browser (openBrowserAsync), NOT a download.
    expect(openBrowserAsync).toHaveBeenCalledWith(
      "http://gw.local/api/uploads/up_pdf01?inline=1&exp=9999999999&sig=deadbeef"
    );
  });

  test("openUploadAttachment (the fallback) downloads with the bearer then shares (iOS)", async () => {
    Platform.OS = "ios";
    downloadAsync.mockClear();
    share.mockClear();
    await openUploadAttachment("up_pdf01", "report.pdf");
    // The cache dest is namespaced by upload id so two same-named uploads
    // can't collide / overwrite each other's bytes.
    expect(downloadAsync).toHaveBeenCalledWith(
      "http://gw.local/api/uploads/up_pdf01",
      "/cache/up_pdf01-report.pdf",
      { headers: { authorization: "Bearer t" } }
    );
    expect(share).toHaveBeenCalledWith({ url: "/cache/up_pdf01-report.pdf" });
  });

  test("a label-less upload chip still opens (filename falls back to 'attachment')", async () => {
    Platform.OS = "ios";
    openBrowserAsync.mockClear();
    const node: Node = {
      key: "ul2",
      type: "link",
      content: "",
      attributes: { href: "gini-upload://up_x" },
      children: []
    };
    const el = rule("link")(node, [], [], styles);
    el.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(openBrowserAsync).toHaveBeenCalledWith(
      "http://gw.local/api/uploads/up_x?inline=1&exp=9999999999&sig=deadbeef"
    );
  });

  test("openUploadAttachment surfaces a download failure via Alert", async () => {
    alert.mockClear();
    downloadAsync.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await openUploadAttachment("up_err", "report.pdf");
    expect(alert).toHaveBeenCalledWith("Couldn't open attachment", "offline");
  });
});

describe("inline image rule (gini-upload:// image ref)", () => {
  test("a gini-upload image ref renders the AuthedImage preview component", () => {
    const node: Node = { key: "img", type: "image", content: "", attributes: { src: "gini-upload://up_img1" } as never, children: [] };
    const el = rule("image")(node, [], [], styles);
    expect(el).not.toBeNull();
    // The element is the MarkdownUploadImage function component; invoking it
    // exercises the hook + AuthedImage wiring and its tap handler.
    const Comp = el.type as (p: { uploadId: string }) => any;
    const rendered = Comp({ uploadId: "up_img1" });
    expect(typeof rendered.props.onPress).toBe("function");
    // Tapping opens the full-screen preview (mocked useImagePreview.open).
    rendered.props.onPress();
  });

  test("a foreign http(s) image src renders an inert chip, NOT an auto-fetched image", () => {
    // The chip names the image + host and only loads on tap — it never fetches
    // the bytes at render time (the SSRF / tracking-pixel guard holds), mirroring
    // how a foreign text link behaves.
    const node: Node = {
      key: "img2",
      type: "image",
      content: "",
      attributes: { src: "https://evil.example/p.gif", alt: "a cat" } as never,
      children: []
    };
    const el = rule("image")(node, [], [], styles);
    expect(el).not.toBeNull();
    // It's the MarkdownForeignImage component, not the AuthedImage preview.
    const Comp = el.type as (p: { alt: string; href: string }) => any;
    const rendered = Comp({ alt: "a cat", href: "https://evil.example/p.gif" });
    // Tap opens the in-app browser; long-press raises the link menu.
    expect(typeof rendered.props.onPress).toBe("function");
    expect(typeof rendered.props.onLongPress).toBe("function");
    openBrowserAsync.mockClear();
    rendered.props.onPress();
    expect(openBrowserAsync).toHaveBeenCalledWith("https://evil.example/p.gif");
    // Long-press raises the link menu at the touch point (same as a text link).
    const seen: Array<{ href: string; x: number; y: number }> = [];
    const unsub = subscribeLinkMenu((r) => seen.push(r));
    rendered.props.onLongPress({ nativeEvent: { pageX: 5, pageY: 9 } });
    unsub();
    expect(seen).toEqual([{ href: "https://evil.example/p.gif", x: 5, y: 9 }]);
  });

  test("an alt-less foreign image chip falls back to a host-derived label", () => {
    const node: Node = {
      key: "imgna",
      type: "image",
      content: "",
      attributes: { src: "https://cataas.com/cat" } as never,
      children: []
    };
    const el = rule("image")(node, [], [], styles);
    expect(el).not.toBeNull();
    const Comp = el.type as (p: { alt: string; href: string }) => any;
    // alt is "" → the accessibility label falls back to the host; invoking the
    // component exercises that fallback branch and the label/host Text nodes.
    const rendered = Comp({ alt: "", href: "https://cataas.com/cat" });
    expect(rendered.props.accessibilityLabel).toBe("Open image: cataas.com");
  });

  test("a non-web image src (data:/no src) is DROPPED (returns null) — never even a chip", () => {
    const dataUri: Node = { key: "imgd", type: "image", content: "", attributes: { src: "data:image/png;base64,AAAA" } as never, children: [] };
    expect(rule("image")(dataUri, [], [], styles)).toBeNull();
    const noSrc: Node = { key: "img3", type: "image", content: "", attributes: {} as never, children: [] };
    expect(rule("image")(noSrc, [], [], styles)).toBeNull();
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

  test("iOS paragraph whose only link is non-web keeps TextInput", () => {
    // A non-web link is inert (no handlers), so it must not strip the block's
    // selection by flipping it onto the link path.
    const para: Node = { key: "p", type: "paragraph", children: [linkNode("tel:18005551234")] };
    expect(renderBlock("paragraph", para, ["x"]).type).toBe(TextInput);
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
  test("containsLink -> plain non-selectable Text (link gestures win)", () => {
    const out = renderSel({ style: {}, children: "x", containsLink: true });
    expect(out.type).toBe(Text);
    expect(out.props.selectable).toBeFalsy();
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

  test("routes Markdown's default openers through the in-app browser", () => {
    // The library's default link/blocklink openers go through onLinkPress;
    // it forwards to the in-app browser and returns false so the library
    // doesn't also hand the URL to the system browser.
    const el = BlockAssistantText({ block: { text: "hi", streaming: false } as never }) as any;
    const markdownEl = el.props.children.props.children[0];
    const onLinkPress = markdownEl.props.onLinkPress;
    expect(onLinkPress("https://ok.example")).toBe(false);
    expect(openBrowserAsync).toHaveBeenCalledWith("https://ok.example");
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
