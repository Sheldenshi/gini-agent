/// <reference lib="dom" />

// MarkdownContent renders chat markdown with three custom behaviors: links
// open in a new tab, ```email-draft fences render as an inline draft card,
// and every other fence stays a (highlighted) <pre>. These tests exercise the
// hast helpers (text reconstruction + fence-language detection) through real
// fenced blocks, plus the streaming-cursor affordance.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { fenceLang, hastText, MarkdownContent, resolveDocHref } from "./MarkdownContent";

describe("MarkdownContent", () => {
  test("renders markdown links with target=_blank and rel", () => {
    render(<MarkdownContent text="see [the docs](https://example.com/docs)" />);
    const link = screen.getByText("the docs").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("without linkBaseUrl, a doc-relative link is left as authored", () => {
    render(<MarkdownContent text="see [Codex](codex.md)" />);
    expect(screen.getByText("Codex").closest("a")?.getAttribute("href")).toBe("codex.md");
  });

  test("with linkBaseUrl, doc-relative links resolve absolute against the hosted doc URL", () => {
    const base = "https://gini.lilaclabs.ai/docs/providers/openai";
    render(<MarkdownContent text="see [Codex](codex.md) and [ADR](../adr/x.md)" linkBaseUrl={base} />);
    expect(screen.getByText("Codex").closest("a")?.getAttribute("href"))
      .toBe("https://gini.lilaclabs.ai/docs/providers/codex.md");
    expect(screen.getByText("ADR").closest("a")?.getAttribute("href"))
      .toBe("https://gini.lilaclabs.ai/docs/adr/x.md");
  });

  test("with linkBaseUrl, an absolute link is left untouched", () => {
    render(<MarkdownContent text="see [site](https://example.com/x)" linkBaseUrl="https://gini.lilaclabs.ai/docs/providers/openai" />);
    expect(screen.getByText("site").closest("a")?.getAttribute("href")).toBe("https://example.com/x");
  });

  test("resolveDocHref folds: no href, no base, absolute, protocol-relative, relative, unparseable", () => {
    const base = "https://gini.lilaclabs.ai/docs/providers/openai";
    expect(resolveDocHref(undefined, base)).toBeUndefined();
    expect(resolveDocHref("codex.md", undefined)).toBe("codex.md");
    expect(resolveDocHref("https://example.com/x", base)).toBe("https://example.com/x");
    expect(resolveDocHref("mailto:a@b.c", base)).toBe("mailto:a@b.c");
    expect(resolveDocHref("//cdn.example.com/x", base)).toBe("//cdn.example.com/x");
    expect(resolveDocHref("#anchor", base)).toBe("https://gini.lilaclabs.ai/docs/providers/openai#anchor");
    // An unparseable base makes new URL throw → href falls through unchanged.
    expect(resolveDocHref("codex.md", "not a url")).toBe("codex.md");
  });

  test("a language fence renders as a highlighted <pre>, not a draft card", () => {
    const { container } = render(<MarkdownContent text={"```ts\nconst x = 1;\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain("hljs");
    expect(container.textContent).toContain("const x = 1;");
  });

  test("a fence without a language stays a plain <pre>", () => {
    const { container } = render(<MarkdownContent text={"```\nplain text fence\n```"} />);
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.textContent).toContain("plain text fence");
  });

  test("an email-draft fence renders the inline draft card", () => {
    const text = "```email-draft\nTo: a@b.c\nSubject: Hi\n\nbody line\n```";
    render(<MarkdownContent text={text} />);
    expect(screen.queryByText("Draft")).not.toBeNull();
    expect(screen.queryByText("Hi")).not.toBeNull();
    expect(screen.queryByText("body line")).not.toBeNull();
  });

  test("hastText folds: null, text, children, and childless non-text nodes", () => {
    expect(hastText(null)).toBe("");
    expect(hastText({ type: "text", value: "x" })).toBe("x");
    expect(hastText({ type: "text" })).toBe("");
    expect(hastText({ type: "element", children: [{ type: "text", value: "a" }, { type: "text", value: "b" }] })).toBe("ab");
    // A node that is neither text nor carries a children array (e.g. a hast
    // comment) contributes nothing.
    expect(hastText({ type: "comment", value: "ignored" })).toBe("");
  });

  test("fenceLang folds: missing class list, no language class, language class", () => {
    expect(fenceLang(null)).toBeUndefined();
    expect(fenceLang({ properties: { className: "not-an-array" } })).toBeUndefined();
    expect(fenceLang({ properties: { className: ["hljs"] } })).toBeUndefined();
    expect(fenceLang({ properties: { className: ["language-email-draft"] } })).toBe("email-draft");
  });

  test("streaming renders the cursor; static does not", () => {
    const { container, rerender } = render(<MarkdownContent text="hi" streaming />);
    expect(container.querySelector(".streaming-cursor")).not.toBeNull();
    rerender(<MarkdownContent text="hi" />);
    expect(container.querySelector(".streaming-cursor")).toBeNull();
  });

  test("an inline gini-upload image ref renders an <img> served from the BFF upload URL", () => {
    const { container } = render(
      <MarkdownContent text="Here's the shot: ![screenshot](gini-upload://up_abc123)" />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/runtime/uploads/up_abc123");
  });

  test("a foreign image URL is DROPPED, not rendered (SSRF / tracking-pixel guard)", () => {
    const { container } = render(
      <MarkdownContent text="![x](https://evil.example/pixel.gif)" />
    );
    expect(container.querySelector("img")).toBeNull();
  });

  test("a gini-upload link ref renders a download chip pointing at the BFF upload URL", () => {
    render(<MarkdownContent text="[report.pdf](gini-upload://up_pdf99)" />);
    const link = screen.getByText("report.pdf").closest("a");
    expect(link?.getAttribute("href")).toBe("/api/runtime/uploads/up_pdf99");
  });

  test("a normal external link still renders untouched", () => {
    render(<MarkdownContent text="see [the docs](https://example.com/docs)" />);
    const link = screen.getByText("the docs").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
  });
});
