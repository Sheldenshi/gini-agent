/// <reference lib="dom" />

// MarkdownContent renders chat markdown with three custom behaviors: links
// open in a new tab, ```email-draft fences render as an inline draft card,
// and every other fence stays a (highlighted) <pre>. These tests exercise the
// hast helpers (text reconstruction + fence-language detection) through real
// fenced blocks, plus the streaming-cursor affordance.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { fenceLang, hastText, MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  test("renders markdown links with target=_blank and rel", () => {
    render(<MarkdownContent text="see [the docs](https://example.com/docs)" />);
    const link = screen.getByText("the docs").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
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
});
