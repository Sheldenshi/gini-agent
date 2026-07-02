import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2Literal, formatTelegramMarkdownV2 } from "./telegram-format";

describe("escapeMarkdownV2Literal", () => {
  test("escapes every MarkdownV2 special character", () => {
    expect(escapeMarkdownV2Literal("a.b-c!")).toBe("a\\.b\\-c\\!");
    expect(escapeMarkdownV2Literal("(x) [y]")).toBe("\\(x\\) \\[y\\]");
  });

  test("escapes backslashes themselves", () => {
    expect(escapeMarkdownV2Literal("path\\file")).toBe("path\\\\file");
  });
});

describe("formatTelegramMarkdownV2", () => {
  test("empty input round-trips", () => {
    expect(formatTelegramMarkdownV2("")).toBe("");
  });

  test("converts **bold** to single-asterisk bold and escapes the rest", () => {
    expect(formatTelegramMarkdownV2("Hello **world**!")).toBe("Hello *world*\\!");
  });

  test("escapes prose with no formatting", () => {
    expect(formatTelegramMarkdownV2("ver. 1.2.3 (rc-4)")).toBe("ver\\. 1\\.2\\.3 \\(rc\\-4\\)");
  });

  test("preserves inline code spans verbatim, escaping ` and \\ inside", () => {
    const out = formatTelegramMarkdownV2("Run `gini status` then go.");
    expect(out).toBe("Run `gini status` then go\\.");
  });

  test("preserves fenced code blocks (no MDV2 special escaping inside)", () => {
    const input = "Try:\n```ts\nconst x = 1;\n```\nDone.";
    const out = formatTelegramMarkdownV2(input);
    // Inside a code block MDV2 only requires escaping ` and \. Other
    // specials (=, ., parens) stay verbatim.
    expect(out).toBe("Try:\n```ts\nconst x = 1;\n```\nDone\\.");
  });

  test("escapes backslashes inside inline code", () => {
    // Input: `path\file` — backslash inside the inline span must be
    // doubled so MDV2 reads it as a literal.
    expect(formatTelegramMarkdownV2("Use `path\\file` now.")).toBe("Use `path\\\\file` now\\.");
  });

  test("a stray asterisk in prose becomes a literal, not a stray bold marker", () => {
    expect(formatTelegramMarkdownV2("price * 2 = total")).toBe("price \\* 2 \\= total");
  });

  test("multiple bold runs in one line", () => {
    expect(formatTelegramMarkdownV2("**a** and **b**")).toBe("*a* and *b*");
  });

  test("bold inside text with specials around it", () => {
    expect(formatTelegramMarkdownV2("see **README.md**!")).toBe("see *README\\.md*\\!");
  });

  test("bold wrapping an inline code span renders as code only (no literal ** leak)", () => {
    // Real-world agent output: **`git rebase`** highlights a command.
    // Telegram MDV2 doesn't reliably support code nested in bold, so we
    // drop the bold markers and keep the code span. Crucially the
    // output must contain NO literal `**` characters — that was the
    // exact regression that prompted this case.
    const out = formatTelegramMarkdownV2("Run **`git rebase`** to replay commits.");
    expect(out).toBe("Run `git rebase` to replay commits\\.");
    expect(out.includes("**")).toBe(false);
  });

  test("bold runs survive across the code-span pre-pass", () => {
    // Two bold phrases with a code span between them — both bold runs
    // must render, and the code stays intact.
    const out = formatTelegramMarkdownV2("**rebase** rewrites history; use `git log` then **squash** carefully.");
    expect(out).toBe("*rebase* rewrites history; use `git log` then *squash* carefully\\.");
  });

  test("bold containing prose and a code span keeps the bold and the code together", () => {
    // The agent emits a mixed bold span — we render it as `*…*` and
    // re-inject the code placeholder inside. Telegram may or may not
    // render the inner code, but the message is valid MDV2 and the
    // text reads cleanly either way.
    const out = formatTelegramMarkdownV2("**Use `npm install` now**.");
    expect(out).toBe("*Use `npm install` now*\\.");
  });

  test("control-byte sentinels in user input do not leak into the output as bold", () => {
    // If a (hypothetical) attacker put our internal placeholder bytes
    // directly into the input, they must be escaped or stripped — never
    // interpreted as a bold marker. We test by feeding the literal bytes
    // and confirming no unescaped `*` appears.
    const malicious = "0 plus **real**";
    const out = formatTelegramMarkdownV2(malicious);
    expect(out).toContain("*real*");
    // The injected sentinel bytes survive as literal characters in the
    // output (Telegram renders them as control-byte glyphs / nothing);
    // crucially they are NOT followed by an unescaped `*` that would
    // confuse Telegram's parser.
    expect(out.includes("**")).toBe(false);
  });
});
