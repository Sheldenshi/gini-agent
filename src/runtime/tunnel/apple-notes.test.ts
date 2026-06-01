import { describe, expect, test } from "bun:test";
import { buildWriteNoteScript } from "./apple-notes";

describe("buildWriteNoteScript", () => {
  test("embeds the noteName as the first <div> of the body so Notes' auto-derived title stays stable across update", () => {
    const script = buildWriteNoteScript({
      folder: "gini",
      noteName: "gini-tunnel-feat+ios-deeplink-fallback",
      body: "https://tion-garmin-tba-physiology.trycloudflare.com/JTRpm4ZXV6IhYZKwbwWJDanuwmjAoGso"
    });
    // The body literal (the part passed to `set body of note`) must begin
    // with `<div>${noteName}</div>` — that's the line Notes uses to derive
    // the title. Without it, a `set body of note "X" to "Y"` whose Y is
    // just the URL would make Notes auto-rename the note to the URL,
    // breaking the next title-based lookup.
    expect(script).toContain(
      'set body of note "gini-tunnel-feat+ios-deeplink-fallback" to "<div>gini-tunnel-feat+ios-deeplink-fallback</div><div>https://tion-garmin-tba-physiology.trycloudflare.com/JTRpm4ZXV6IhYZKwbwWJDanuwmjAoGso</div>"'
    );
    // The create path must share the exact same body shape so the title
    // derived from the body on first render matches the title used by
    // subsequent `if exists note "X"` lookups.
    expect(script).toContain(
      'make new note with properties {name:"gini-tunnel-feat+ios-deeplink-fallback", body:"<div>gini-tunnel-feat+ios-deeplink-fallback</div><div>https://tion-garmin-tba-physiology.trycloudflare.com/JTRpm4ZXV6IhYZKwbwWJDanuwmjAoGso</div>"}'
    );
  });

  test("escapes AppleScript double-quotes and backslashes in folder + noteName + body", () => {
    const script = buildWriteNoteScript({
      folder: 'gini"quote',
      noteName: 'note\\back',
      body: 'body"with"quotes\\and\\backslashes'
    });
    // Double-quotes embedded in any operand must be escaped as `\"` so the
    // surrounding AppleScript string literal stays well-formed; backslashes
    // must escape to `\\` for the same reason.
    expect(script).toContain('exists folder "gini\\"quote"');
    expect(script).toContain('exists note "note\\\\back"');
    // The body operand combines HTML-escape on the operand value (`"` →
    // `&quot;`, `\` stays as `\`) with AppleScript-escape on the wrapped
    // literal (`\` → `\\`), so an inner `"` from the body shows up as
    // `&quot;` (not `\"`) and an inner `\` from the body shows up as `\\`.
    expect(script).toContain("body&quot;with&quot;quotes\\\\and\\\\backslashes");
  });

  test("HTML-escapes < > & ' \" in the body content to keep the rendered Notes body literal-safe", () => {
    const script = buildWriteNoteScript({
      folder: "gini",
      noteName: "n",
      body: '<script>alert("&\'")</script>'
    });
    // Raw HTML metacharacters in the body must be HTML-escaped before the
    // AppleScript wrapper so Notes renders them as literal text rather
    // than executing them via its HTML parser.
    expect(script).toContain("&lt;script&gt;");
    expect(script).toContain("&amp;");
    expect(script).toContain("&#39;");
    expect(script).toContain("&quot;");
    expect(script).not.toContain("<script>alert");
  });
});
