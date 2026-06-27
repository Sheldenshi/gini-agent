/// <reference lib="dom" />

// MarkdownContent renders chat markdown with three custom behaviors: links
// open in a new tab, ```email-draft fences render as an inline draft card,
// and every other fence stays a (highlighted) <pre>. These tests exercise the
// hast helpers (text reconstruction + fence-language detection) through real
// fenced blocks, plus the streaming-cursor affordance.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { fenceLang, hastText, MarkdownContent, resolveDocHref, webHost } from "./MarkdownContent";

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

  test("with dropForeignImages, a foreign image URL is NOT auto-fetched — it renders an inert chip, not an <img>", () => {
    const { container } = render(
      <MarkdownContent text="![a cat](https://evil.example/pixel.gif)" dropForeignImages />
    );
    // No <img>: nothing fetches the bytes at render time (the SSRF /
    // tracking-pixel guard for model-authored text holds).
    expect(container.querySelector("img")).toBeNull();
    // A chip names the image + host. It's a role=link SPAN (not an <a>) so it
    // can't form an invalid nested anchor inside a linked image; it carries the
    // URL in its title and opens only on explicit click.
    const chip = screen.getByText("a cat").closest("[role='link']");
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.getAttribute("title")).toBe("https://evil.example/pixel.gif");
    expect(chip?.textContent).toContain("evil.example");
    // No anchor was emitted for the image.
    expect(container.querySelector("a")).toBeNull();
  });

  test("a foreign image clicks open in a new tab with noopener (only on explicit click)", () => {
    const calls: Array<[string, string, string]> = [];
    const orig = window.open;
    // @ts-expect-error test stub
    window.open = (u: string, t: string, f: string) => { calls.push([u, t, f]); return null; };
    try {
      render(<MarkdownContent text="![a cat](https://evil.example/pixel.gif)" dropForeignImages />);
      const chip = screen.getByText("a cat").closest("[role='link']")!;
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(calls).toEqual([["https://evil.example/pixel.gif", "_blank", "noopener,noreferrer"]]);
    } finally {
      window.open = orig;
    }
  });

  test("a foreign image chip activates on Enter/Space but ignores other keys", () => {
    const calls: string[] = [];
    const orig = window.open;
    // @ts-expect-error test stub
    window.open = (u: string) => { calls.push(u); return null; };
    try {
      render(<MarkdownContent text="![a cat](https://evil.example/pixel.gif)" dropForeignImages />);
      const chip = screen.getByText("a cat").closest("[role='link']")!;
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(calls).toEqual([]); // a non-activating key does nothing
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(calls).toEqual([
        "https://evil.example/pixel.gif",
        "https://evil.example/pixel.gif"
      ]);
    } finally {
      window.open = orig;
    }
  });

  // The outer link uses a same-page `#target` fragment, not an absolute URL: a
  // dispatched click that reached the anchor would otherwise make happy-dom
  // attempt a real navigation fetch (noisy ECONNREFUSED on stderr). A fragment
  // exercises the identical nesting + cancel behavior with no network side
  // effect — the point is the chip OWNS the click, which `defaultPrevented`
  // proves regardless of the href's shape.
  test("a linked foreign image does NOT produce a nested anchor (chip is a span)", () => {
    const { container } = render(
      <MarkdownContent text="[![a cat](https://evil.example/p.gif)](#target)" dropForeignImages />
    );
    // Exactly one anchor (the outer link); the image chip is a span inside it,
    // never a second <a> — invalid nested anchors are avoided.
    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    expect(anchors[0]?.getAttribute("href")).toBe("#target");
    expect(anchors[0]?.querySelector("[role='link']")?.tagName).toBe("SPAN");
  });

  test("clicking the chip inside a linked image opens ONLY the image URL and cancels the outer link's navigation", () => {
    const opened: string[] = [];
    const origOpen = window.open;
    // @ts-expect-error test stub
    window.open = (u: string) => { opened.push(u); return null; };
    try {
      const { container } = render(
        <MarkdownContent text="[![a cat](https://evil.example/p.gif)](#target)" dropForeignImages />
      );
      // Sanity: the chip is nested inside the outer anchor.
      const anchor = container.querySelector("a")!;
      const chip = screen.getByText("a cat").closest("[role='link']")!;
      expect(anchor.contains(chip)).toBe(true);
      const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
      chip.dispatchEvent(evt);
      // Only the image URL opened (window.open), and the chip called
      // preventDefault — so the anchor's default navigation is cancelled.
      // One click → one model-authored destination, not two.
      expect(opened).toEqual(["https://evil.example/p.gif"]);
      expect(evt.defaultPrevented).toBe(true);
    } finally {
      window.open = origOpen;
    }
  });

  test("with dropForeignImages, an alt-less foreign image chip falls back to the 'Image' label", () => {
    const { container } = render(
      <MarkdownContent text="![](https://evil.example/pixel.gif)" dropForeignImages />
    );
    expect(container.querySelector("img")).toBeNull();
    const chip = screen.getByText("Image").closest("[role='link']");
    expect(chip?.getAttribute("title")).toBe("https://evil.example/pixel.gif");
  });

  test("with dropForeignImages, a non-http(s) image src is dropped entirely (no chip, no img)", () => {
    const { container } = render(
      <MarkdownContent text="![x](data:image/png;base64,AAAA)" dropForeignImages />
    );
    // react-markdown's sanitizer already neutralizes data:/javascript: srcs;
    // webHost also returns null for them, so no chip is rendered either.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[role='link']")).toBeNull();
  });

  test("webHost folds: http, https, non-http(s) protocol, unparseable", () => {
    expect(webHost("https://cataas.com/cat?foo=1")).toBe("cataas.com");
    expect(webHost("http://10.0.0.5:8080/x")).toBe("10.0.0.5:8080");
    expect(webHost("data:image/png;base64,AAAA")).toBeNull();
    expect(webHost("javascript:alert(1)")).toBeNull();
    expect(webHost("not a url")).toBeNull();
  });

  test("by default (trusted doc/file/skill markdown), an ordinary image renders", () => {
    const { container } = render(
      <MarkdownContent text="![diagram](https://example.com/diagram.png)" />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/diagram.png");
  });

  test("even by default, a gini-upload image ref is rewritten to the BFF URL (not the raw scheme)", () => {
    const { container } = render(
      <MarkdownContent text="![shot](gini-upload://up_xyz)" />
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/runtime/uploads/up_xyz");
  });

  test("dropForeignImages still rewrites a gini-upload image ref (the allowlist only drops FOREIGN srcs)", () => {
    const { container } = render(
      <MarkdownContent text="![shot](gini-upload://up_kept)" dropForeignImages />
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/runtime/uploads/up_kept");
  });

  test("a gini-upload link ref renders a chip that opens the inline preview URL", () => {
    render(<MarkdownContent text="[report.pdf](gini-upload://up_pdf99)" />);
    const link = screen.getByText("report.pdf").closest("a");
    // The chip opens the upload as an inline preview (?inline=1) in a new tab,
    // not a forced download.
    expect(link?.getAttribute("href")).toBe("/api/runtime/uploads/up_pdf99?inline=1");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  test("a normal external link still renders untouched", () => {
    render(<MarkdownContent text="see [the docs](https://example.com/docs)" />);
    const link = screen.getByText("the docs").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
  });
});
