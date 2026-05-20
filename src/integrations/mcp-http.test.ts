import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { httpMcpCallTool, httpMcpInitialize, httpMcpListTools, resolveHeaderValue } from "./mcp-http";

const originalFetch = globalThis.fetch;

function sse(body: object): string {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}

// Echo the request id back so the client's id matcher accepts the response
// regardless of how many tests have run in the same process.
async function readRequestId(init: RequestInit | undefined): Promise<number | undefined> {
  if (!init?.body) return undefined;
  try {
    const parsed = JSON.parse(String(init.body));
    return typeof parsed.id === "number" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function jsonResp(body: object, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init
  });
}

function sseResp(body: object, init?: ResponseInit): Response {
  return new Response(sse(body), {
    headers: { "content-type": "text/event-stream" },
    ...init
  });
}

beforeEach(() => {
  // Reset to baseline between tests so a stub from a prior case can't bleed.
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveHeaderValue", () => {
  test("substitutes ${VAR} placeholders", () => {
    expect(resolveHeaderValue("Bearer ${LINEAR_API_KEY}", { LINEAR_API_KEY: "lin_api_FAKE_FOR_TESTS" })).toBe("Bearer lin_api_FAKE_FOR_TESTS");
  });

  test("returns undefined when a placeholder is missing", () => {
    expect(resolveHeaderValue("Bearer ${MISSING}", {})).toBeUndefined();
  });

  test("returns the original value when no placeholders are present", () => {
    expect(resolveHeaderValue("application/json", {})).toBe("application/json");
  });

  test("does not interpret lowercase placeholder names", () => {
    // Only [A-Z0-9_] is treated as an env reference; mixed case is left alone
    // so connector secret names stay distinct from user-provided literals.
    expect(resolveHeaderValue("${not_a_var}", { not_a_var: "x" })).toBe("${not_a_var}");
  });
});

// Build a fetch stub that echoes the request id back into the SSE/JSON
// response envelope so the client's id matcher accepts the response
// regardless of how many test runs share the counter.
function stubFetch(buildBody: (id: number) => object, mode: "sse" | "json" = "sse"): typeof fetch {
  return (async (_url: unknown, init: RequestInit | undefined) => {
    const id = (await readRequestId(init)) ?? 0;
    const body = { jsonrpc: "2.0", id, ...buildBody(id) };
    return mode === "sse" ? sseResp(body) : jsonResp(body);
  }) as unknown as typeof fetch;
}

describe("httpMcpInitialize", () => {
  test("parses SSE response", async () => {
    globalThis.fetch = stubFetch(() => ({ result: { serverInfo: { name: "linear-mcp", version: "1.0" }, capabilities: { tools: {} } } }));
    const result = await httpMcpInitialize("https://example.test/mcp", { authorization: "Bearer t" });
    expect(result.ok).toBe(true);
    expect(result.serverInfo?.name).toBe("linear-mcp");
  });

  test("parses plain JSON response", async () => {
    globalThis.fetch = stubFetch(() => ({ result: { serverInfo: { name: "json-mcp" } } }), "json");
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(true);
    expect(result.serverInfo?.name).toBe("json-mcp");
  });

  test("surfaces 401 as a typed error", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  test("surfaces 5xx as a typed error", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");
  });

  test("rejects malformed payloads", async () => {
    globalThis.fetch = (async () => new Response("not json {{{", {
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not JSON");
  });

  test("surfaces JSON-RPC error envelopes", async () => {
    globalThis.fetch = stubFetch(() => ({ error: { code: -32600, message: "Invalid Request" } }), "json");
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid Request");
  });

  test("surfaces aborted requests as a timeout error", async () => {
    // Simulate AbortController firing by throwing an AbortError synchronously.
    globalThis.fetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("httpMcpListTools", () => {
  test("returns tools with name and description", async () => {
    globalThis.fetch = stubFetch(() => ({ result: { tools: [{ name: "list_issues", description: "List Linear issues" }, { name: "save_issue" }] } }));
    const result = await httpMcpListTools("https://example.test/mcp", {});
    expect(result.ok).toBe(true);
    expect(result.tools?.length).toBe(2);
    expect(result.tools?.[0]?.name).toBe("list_issues");
  });

  test("errors when tools array is missing", async () => {
    globalThis.fetch = stubFetch(() => ({ result: {} }), "json");
    const result = await httpMcpListTools("https://example.test/mcp", {});
    expect(result.ok).toBe(false);
  });
});

describe("httpMcpCallTool", () => {
  test("flattens text content parts", async () => {
    globalThis.fetch = stubFetch(() => ({ result: { content: [{ type: "text", text: "[{\"id\":\"LIN-1\"}]" }] } }));
    const result = await httpMcpCallTool("https://example.test/mcp", {}, "list_issues", {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("LIN-1");
  });

  test("propagates isError flag", async () => {
    globalThis.fetch = stubFetch(() => ({ result: { content: [{ type: "text", text: "bad input" }], isError: true } }));
    const result = await httpMcpCallTool("https://example.test/mcp", {}, "save_issue", {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad input");
  });

  test("posts to the supplied url with merged headers", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      captured = { url: String(url), init };
      const id = (await readRequestId(init)) ?? 0;
      return sseResp({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
    }) as unknown as typeof fetch;
    await httpMcpCallTool("https://example.test/mcp", { authorization: "Bearer lin_api_FAKE_FOR_TESTS" }, "x", {});
    expect(captured?.url).toBe("https://example.test/mcp");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer lin_api_FAKE_FOR_TESTS");
    expect(headers["accept"]).toContain("text/event-stream");
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
  });
});
