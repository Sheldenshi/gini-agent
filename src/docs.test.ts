import { describe, expect, test } from "bun:test";
import { readDocSection, slugifyHeading } from "./docs";

describe("slugifyHeading", () => {
  test("matches GitHub-style anchors", () => {
    expect(slugifyHeading("Re-authentication")).toBe("re-authentication");
    expect(slugifyHeading("If you authenticate with `OPENAI_API_KEY` instead")).toBe(
      "if-you-authenticate-with-openai_api_key-instead"
    );
    expect(slugifyHeading("Get an   API key")).toBe("get-an-api-key");
  });
});

describe("readDocSection", () => {
  test("extracts the requested section including nested sub-headings", () => {
    const result = readDocSection("providers/codex", "re-authentication");
    expect(result.title).toBe("Codex");
    expect(result.anchor).toBe("re-authentication");
    // Starts with the section heading itself (the panel header shows the H1).
    expect(result.markdown.startsWith("## Re-authentication")).toBe(true);
    // Includes the numbered steps.
    expect(result.markdown).toContain("Type `/logout` and press Enter");
    // Includes the nested ### sub-section.
    expect(result.markdown).toContain("### If you authenticate with `OPENAI_API_KEY` instead");
    // Excludes the intro paragraph above the section.
    expect(result.markdown).not.toContain("Codex is an OAuth/CLI provider");
  });

  test("returns the full body with the leading H1 stripped when no section is given", () => {
    const result = readDocSection("search/brave");
    expect(result.title).toBe("Brave Search");
    expect(result.anchor).toBeUndefined();
    expect(result.markdown).not.toContain("# Brave Search");
    expect(result.markdown).toContain("Web search via Brave");
  });

  test("falls back to the full doc when the requested section is missing", () => {
    const result = readDocSection("search/brave", "no-such-section");
    expect(result.title).toBe("Brave Search");
    expect(result.anchor).toBeUndefined();
    expect(result.markdown).toContain("Web search via Brave");
  });

  test("rejects traversal paths", () => {
    expect(() => readDocSection("../package")).toThrow();
    expect(() => readDocSection("../../etc/passwd")).toThrow();
  });

  test("propagates ENOENT for a missing doc", () => {
    expect(() => readDocSection("providers/does-not-exist")).toThrow();
  });
});
