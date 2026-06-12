import { describe, expect, test } from "bun:test";
import { probeBland } from "./bland";

describe("probeBland", () => {
  test("returns ok=false when the API returns a non-2xx response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    try {
      const result = await probeBland("bad-key");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("HTTP 401");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends the raw key as authorization (no Bearer) and ok=true on 200", async () => {
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | undefined;
    let receivedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers ?? {});
      receivedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ count: 0, calls: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await probeBland("good-key");
      expect(result.ok).toBe(true);
      expect(receivedHeaders?.get("authorization")).toBe("good-key");
      expect(receivedUrl).toContain("limit=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
