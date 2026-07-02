import { describe, expect, test } from "bun:test";
import { parseDocsUrl } from "./docs";

describe("parseDocsUrl", () => {
  test("derives path and anchor from a hosted docs URL", () => {
    expect(parseDocsUrl("https://gini.lilaclabs.ai/docs/providers/codex#re-authentication")).toEqual({
      path: "providers/codex",
      anchor: "re-authentication"
    });
  });

  test("omits the anchor when there is no hash", () => {
    expect(parseDocsUrl("https://gini.lilaclabs.ai/docs/search/brave")).toEqual({
      path: "search/brave"
    });
  });

  test("returns null for a non-/docs/ URL", () => {
    expect(parseDocsUrl("https://gini.lilaclabs.ai/settings")).toBeNull();
  });

  test("returns null for an unparseable URL", () => {
    expect(parseDocsUrl("not a url")).toBeNull();
  });

  test("returns null when nothing follows /docs/", () => {
    expect(parseDocsUrl("https://gini.lilaclabs.ai/docs/")).toBeNull();
  });
});
