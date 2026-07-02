import { describe, expect, test } from "bun:test";
import { braveWebSearch, exaWebSearch, formatWebSearchResults } from "./web-search";

describe("braveWebSearch", () => {
  test("maps Brave's web.results payload into normalized rows and strips HTML", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "<strong>Brave</strong> — Search", url: "https://brave.com", description: "Privacy-first <em>search</em>." },
              { title: "Docs", url: "https://docs.brave.com", description: "Reference." }
            ]
          }
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const results = await braveWebSearch("k", "brave", 5);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: "Brave — Search",
        url: "https://brave.com",
        snippet: "Privacy-first search."
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on non-2xx Brave responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    try {
      await expect(braveWebSearch("k", "q", 3)).rejects.toThrow(/HTTP 429/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("exaWebSearch", () => {
  test("maps Exa's results and prefers highlights over text for the snippet", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "A", url: "https://a.example", highlights: ["highlight one", "highlight two"], text: "full text body" },
            { title: "B", url: "https://b.example", text: "fallback body" }
          ]
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const results = await exaWebSearch("k", "q", 5);
      expect(results[0]?.snippet).toBe("highlight one … highlight two");
      expect(results[1]?.snippet).toBe("fallback body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("formatWebSearchResults", () => {
  test("renders an indexed list with provider + query header", () => {
    const out = formatWebSearchResults("brave-search", "claude code", [
      { title: "Claude Code", url: "https://example.com", snippet: "An agent that codes." }
    ]);
    expect(out).toContain('Results from brave-search for "claude code"');
    expect(out).toContain("[1] Claude Code — https://example.com");
    expect(out).toContain("An agent that codes.");
  });

  test("returns a friendly empty-state line when there are no results", () => {
    const out = formatWebSearchResults("exa", "nothing", []);
    expect(out).toBe('No results from exa for "nothing".');
  });
});
