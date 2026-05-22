import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { httpMcpCallTool, httpMcpInitialize, httpMcpListTools, redactSecretsInText, resolveHeaderValue } from "./mcp-http";

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

describe("redactSecretsInText", () => {
  test("strips Authorization header values", () => {
    const input = "HTTP/1.1 401 Unauthorized\nAuthorization: Bearer lin_api_SECRET_VALUE";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("lin_api_SECRET_VALUE");
    expect(out).toContain("[REDACTED]");
  });

  test("strips bare 'Bearer <token>' in JSON-ish bodies", () => {
    const input = `{"echo":{"authorization":"Bearer sk-LEAKED_TOKEN"}}`;
    const out = redactSecretsInText(input);
    expect(out).not.toContain("sk-LEAKED_TOKEN");
    expect(out).toContain("[REDACTED]");
  });

  test("strips X-Api-Key and Cookie", () => {
    const input = "X-Api-Key: AAAA-BBBB\nCookie: session=abc123";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("AAAA-BBBB");
    expect(out).not.toContain("abc123");
  });

  test("redacts arbitrary *-Token / *-Key header values", () => {
    const input = "X-Service-Token: secret-token-value\nX-Some-Key: another-secret";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("secret-token-value");
    expect(out).not.toContain("another-secret");
  });

  test("leaves non-secret bodies untouched", () => {
    expect(redactSecretsInText("rate limited; retry-after: 30s")).toBe("rate limited; retry-after: 30s");
  });

  test("redacts URL query token (?token=)", () => {
    const input = "GET https://api.example.com/v1?token=SUPERSECRET HTTP/1.1";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts URL query access_token (&access_token=)", () => {
    const input = "redirect_uri=foo&access_token=SUPERSECRET&state=xyz";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts form-encoded api_key=", () => {
    const input = "grant_type=client_credentials&api_key=SUPERSECRET";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts JSON-quoted {"x-api-key":"..."}', () => {
    const input = '{"headers":{"x-api-key":"SUPERSECRET"}}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts JSON-quoted {"x-auth-token":"..."}', () => {
    const input = '{"x-auth-token":"SUPERSECRET"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts JSON-quoted {"cookie":"session=..."}', () => {
    const input = '{"cookie":"session=SUPERSECRET"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts JSON-quoted authorization with lowercase bearer', () => {
    const input = '{"authorization":"bearer SUPERSECRET"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts entire Cookie header value (multi-cookie)", () => {
    const input = "Cookie: theme=light; session=SUPERSECRET; foo=bar";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).not.toContain("foo=bar");
  });

  test("redacts inline Cookie: in prose (not at line start)", () => {
    const input = "upstream echoed Cookie: theme=light; session=SUPERSECRET; foo=bar";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).not.toContain("foo=bar");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts inline Set-Cookie: in prose (not at line start)", () => {
    const input = "server replied Set-Cookie: session=SUPERSECRET; HttpOnly; foo=bar";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).not.toContain("foo=bar");
  });

  test("catches mixed-case bare bearer tokens", () => {
    const input = "auth: bEaReR SUPERSECRET";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test("catches uppercase BEARER bare tokens", () => {
    const input = "got: BEARER SUPERSECRET trailing";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test("does not over-redact prose after a single 'bearer' word", () => {
    // The bare-bearer match should consume only the token immediately
    // following the keyword, not everything to end-of-string.
    const input = "Bearer ABC123 followed by harmless prose and more text";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("ABC123");
    expect(out).toContain("followed by harmless prose and more text");
  });

  test('redacts escaped-JSON x-api-key (backslash-quoted)', () => {
    const input = '{"error":"{\\"x-api-key\\":\\"SUPERSECRET\\"}"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts escaped-JSON cookie (backslash-quoted)', () => {
    const input = '{"error":"{\\"cookie\\":\\"session=SUPERSECRET\\"}"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts escaped-JSON authorization (backslash-quoted)', () => {
    const input = '{"error":"{\\"authorization\\":\\"Bearer SUPERSECRET\\"}"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });

  test('redacts escaped-JSON arbitrary *-token / *-key', () => {
    const input = '{"err":"got \\"x-service-token\\":\\"SUPERSECRET\\" back"}';
    const out = redactSecretsInText(input);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("[REDACTED]");
  });
});

describe("postRpc error body redaction (regression)", () => {
  test("sanitizes echoed Authorization in upstream 401 body", async () => {
    const leakedToken = "lin_api_LEAKED_FOR_TEST";
    const upstreamBody = `unauthorized; received Authorization: Bearer ${leakedToken}`;
    globalThis.fetch = (async () => new Response(upstreamBody, { status: 401 })) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", { authorization: `Bearer ${leakedToken}` });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(leakedToken);
    expect(result.error).toContain("401");
  });

  test("sanitizes secrets echoed inside a JSON-RPC 200 error message", async () => {
    const leakedToken = "lin_api_RPC200_LEAKED";
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const id = (await readRequestId(init)) ?? 0;
      const body = {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `Bad auth: Authorization: Bearer ${leakedToken}` }
      };
      return jsonResp(body);
    }) as unknown as typeof fetch;
    const result = await httpMcpInitialize("https://example.test/mcp", { authorization: `Bearer ${leakedToken}` });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(leakedToken);
    expect(result.error).toContain("[REDACTED]");
  });
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
