import { describe, expect, test } from "bun:test";
import { probeExa } from "./exa";

describe("probeExa", () => {
  test("returns ok=false when the API returns a non-2xx response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    try {
      const result = await probeExa("bad-key");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("HTTP 403");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("posts the API key as x-api-key and ok=true on 200", async () => {
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | undefined;
    let receivedBody: string | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers ?? {});
      receivedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await probeExa("good-key");
      expect(result.ok).toBe(true);
      expect(receivedHeaders?.get("x-api-key")).toBe("good-key");
      expect(receivedBody).toContain('"query":"ping"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
