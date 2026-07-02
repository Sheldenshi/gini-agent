import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import MarkdownItReal from "markdown-it";
import {
  Platform,
  TextInput,
  View
} from "./chatMockSetup";

// This test drives the REAL react-native-markdown-display parser + AstRenderer
// with the app's REAL `markdownRules`, so the AST nesting is genuine (an
// image-only line parses to `paragraph -> image`). chatMockSetup mocks the
// library's package root (its component renders null) and the react-native it
// pulls in, so importing AstRenderer/parser from the root would hit the mock —
// and loading the real root cascades through renderRules -> styles ->
// Platform.select / react-native-fit-image, none of which the lean RN mock
// provides. We import `parser.js` + `AstRenderer.js` from `/src/lib/*` instead:
// they're pure JS needing only the already-mocked StyleSheet, so they bypass
// the component mock and run against the real rule tree the device would build.
// The library's `MarkdownIt` re-export is mocked too, so we parse with the real
// `markdown-it` package — exactly what the library wraps. Walking the produced
// tree proves whether an agent image lands inside the iOS TextInput selection
// wrapper (where a View can't render).
const AstRenderer = (
  await import("react-native-markdown-display/src/lib/AstRenderer.js")
).default;
const parser = (
  await import("react-native-markdown-display/src/lib/parser.js")
).default;
const { markdownRules } = await import(
  "@/src/components/chat/BlockAssistantText"
);
const { SelectableBlockText } = await import(
  "@/src/components/chat/SelectableBlockText"
);

// BlockAssistantText configures markdown-it with typographer + linkify.
const markdownIt = MarkdownItReal({ typographer: true, linkify: true });

// The app overrides a subset of rules; the library normally merges them over
// its defaults. The image-only / short-prose ASTs we parse here only reach
// `body` beyond what the app rules already cover, so a passthrough body is the
// one structural default we add. Every other node (paragraph, textgroup, text,
// image) comes from the app's real rules.
const rules = {
  body: (node: { key: string }, children: unknown) =>
    createElement(View as never, { key: node.key }, children as never),
  ...(markdownRules as Record<string, unknown>)
};

// Render markdown source to the app's rule tree. We supply a minimal style map
// (every key resolves to {}), the library's default image handlers, and the
// linkify-enabled markdown-it.
function renderTree(src: string): unknown {
  const styleProxy = new Proxy({}, { get: () => ({}) }) as Record<
    string,
    object
  >;
  const renderer = new AstRenderer(
    rules,
    styleProxy,
    () => false,
    null,
    null,
    ["data:image/png;base64", "https://", "http://"],
    "https://",
    false
  );
  return parser(src, renderer.render, markdownIt);
}

type El = {
  type: unknown;
  props?: { children?: unknown; containsLink?: boolean; style?: unknown };
};

function isEl(x: unknown): x is El {
  return !!x && typeof x === "object" && "type" in (x as object);
}

function childrenOf(el: El): unknown[] {
  const c = el.props?.children;
  if (c === undefined || c === null) return [];
  return Array.isArray(c) ? c.flat(Infinity) : [c];
}

// Depth-first search for the first element whose type matches a predicate,
// returning the chain of ancestors (root-first) ending at the match.
function findPath(
  node: unknown,
  match: (el: El) => boolean,
  trail: El[] = []
): El[] | null {
  if (!isEl(node)) return null;
  const here = [...trail, node];
  if (match(node)) return here;
  for (const child of childrenOf(node)) {
    const found = findPath(child, match, here);
    if (found) return found;
  }
  return null;
}

// SelectableBlockText is a forwardRef, so its element `.type` is the forwardRef
// object (identity-comparable), not a named function. Match by identity.
function isSelectableBlock(el: El): boolean {
  return el.type === SelectableBlockText;
}

// Resolve a SelectableBlockText element (a forwardRef) to the concrete host it
// renders on the current Platform, by invoking its render body.
function resolveSelectable(el: El): El {
  const render = (
    SelectableBlockText as unknown as {
      render: (p: unknown, r: unknown) => El;
    }
  ).render;
  return render(el.props, null);
}

// MarkdownUploadImage is the component the image rule renders for a
// gini-upload ref. Identify it by name (it's a named function component).
function isUploadImage(el: El): boolean {
  return (
    typeof el.type === "function" &&
    (el.type as { name?: string }).name === "MarkdownUploadImage"
  );
}

// MarkdownForeignImage is the inert chip the image rule renders for a foreign
// http(s) src (loads only on tap; never auto-fetched).
function isForeignImage(el: El): boolean {
  return (
    typeof el.type === "function" &&
    (el.type as { name?: string }).name === "MarkdownForeignImage"
  );
}

beforeEach(() => {
  Platform.OS = "ios";
});

// The bug this pins: a standalone agent image (`![alt](gini-upload://id)`)
// parses to `paragraph -> image`. The paragraph rule used to wrap ALL children
// in SelectableBlockText, which on iOS is a <TextInput editable={false}>. The
// image rule renders MarkdownUploadImage — a Pressable (a View subtree) — and
// RN does not mount a View inside a TextInput on iOS, so the image collapsed to
// nothing: the empty gray bubble in the bug report. The block only escaped the
// TextInput path when hasLinkDescendant found a LINK node; it never checked for
// IMAGE nodes. The fix: a block carrying a renderable upload image renders as a
// plain View (which hosts the image's View subtree), mirroring the library's
// own default paragraph rule.
describe("an agent upload image renders outside the iOS text-selection wrapper", () => {
  test("the gini-upload image element is present in the rendered tree (rule fired)", () => {
    const tree = renderTree("![Cat pic](gini-upload://8df722d4)");
    const path = findPath(tree, isUploadImage);
    expect(path).not.toBeNull();
    expect(isUploadImage(path![path!.length - 1])).toBe(true);
  });

  test("a standalone image's block ancestor is a View, never the TextInput wrapper", () => {
    const tree = renderTree("![Cat pic](gini-upload://8df722d4)");
    const path = findPath(tree, isUploadImage)!;
    // No SelectableBlockText (and so no iOS TextInput) sits above the image.
    expect(path.some(isSelectableBlock)).toBe(false);
    // The image's nearest block ancestor renders as a View, which CAN host the
    // image's View/Pressable subtree on iOS.
    const blockAncestor = path[path.length - 2];
    expect(blockAncestor.type).toBe(View);
  });

  test("an image mid-sentence also escapes the text wrapper (prose + image under a View)", () => {
    const tree = renderTree(
      "Here is ![Cat pic](gini-upload://8df722d4) a cat mid sentence"
    );
    const path = findPath(tree, isUploadImage)!;
    expect(path.some(isSelectableBlock)).toBe(false);
    // The image's nearest block ancestor (the paragraph holding both the prose
    // and the image) renders as a View. Anchored from the leaf, like the
    // standalone case above, so a change in wrapping depth can't misindex it.
    const blockAncestor = path[path.length - 2];
    expect(blockAncestor.type).toBe(View);
    // It carries the library's row/wrap paragraph layout so prose and the image
    // flow inline and wrap, rather than stacking under RN's default column
    // direction. The style is an array [layout, margins]; flatten and assert.
    const flat = Object.assign(
      {},
      ...[blockAncestor.props?.style].flat(Infinity).filter(Boolean)
    ) as { flexDirection?: string; flexWrap?: string };
    expect(flat.flexDirection).toBe("row");
    expect(flat.flexWrap).toBe("wrap");
  });

  test("a paragraph of plain prose still uses the iOS TextInput selection wrapper", () => {
    const tree = renderTree("just some words");
    const path = findPath(tree, isSelectableBlock)!;
    expect(path).not.toBeNull();
    const host = resolveSelectable(path[path.length - 1]);
    expect(host.type).toBe(TextInput);
  });

  test("a foreign http(s) image renders the inert chip and escapes the TextInput wrapper", () => {
    // The screenshot's literal `https://cataas.com/cat` is NOT a gini-upload ref,
    // so it's not auto-fetched — but rather than vanish, it renders the inert
    // MarkdownForeignImage chip (a View/Pressable). Like the upload image, that
    // View subtree can't live inside the iOS TextInput, so its block ancestor
    // must be a plain View, not SelectableBlockText.
    const tree = renderTree("![Cat pic](https://cataas.com/cat)");
    const path = findPath(tree, isForeignImage);
    expect(path).not.toBeNull();
    expect(path!.some(isSelectableBlock)).toBe(false);
    expect(path![path!.length - 2].type).toBe(View);
  });

  test("a non-http(s) image src is dropped — no chip, stays on the text path", () => {
    // A data:/javascript: src renders nothing (not even a chip), so the block has
    // no image View to host and keeps the normal text-selection wrapper.
    const tree = renderTree("![x](data:image/png;base64,AAAA)");
    expect(findPath(tree, isForeignImage)).toBeNull();
    expect(findPath(tree, isUploadImage)).toBeNull();
    expect(findPath(tree, isSelectableBlock)).not.toBeNull();
  });
});
