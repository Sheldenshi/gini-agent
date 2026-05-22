import { describe, expect, test } from "bun:test";
import { proxyRequest } from "../web/src/lib/runtime";

const RUNTIME_URL = "http://127.0.0.1:9999";
const TOKEN = "secret-token";

function mockFetcher(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

describe("runtime proxy", () => {
  test("injects bearer token and forwards GET to /api/<path>", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher = mockFetcher((url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const request = new Request("http://localhost/api/runtime/status?foo=bar", { method: "GET" });
    const response = await proxyRequest(request, ["status"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(value).toEqual({ ok: true });
    expect(captured!.url).toBe(`${RUNTIME_URL}/api/status?foo=bar`);
    expect((captured!.init.headers as Headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(captured!.init.method).toBe("GET");
  });

  test("forwards POST body and content-type to upstream", async () => {
    let received: { method?: string; body?: string; auth?: string; contentType?: string } = {};
    const fetcher = mockFetcher(async (url, init) => {
      received.method = init.method;
      received.auth = (init.headers as Headers).get("authorization") ?? undefined;
      received.contentType = (init.headers as Headers).get("content-type") ?? undefined;
      received.body = init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined;
      return new Response(JSON.stringify({ created: true, url }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const request = new Request("http://localhost/api/runtime/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" })
    });
    const response = await proxyRequest(request, ["tasks"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(201);
    expect(received.method).toBe("POST");
    expect(received.auth).toBe(`Bearer ${TOKEN}`);
    expect(received.contentType).toContain("application/json");
    expect(received.body).toBe(JSON.stringify({ input: "hello" }));
  });

  test("blocks cross-origin runtime update posts before bearer-token forwarding", async () => {
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://localhost/api/runtime/update", {
      method: "POST",
      headers: { origin: "https://example.test" }
    });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    const value = await response.json() as { error: string };

    expect(response.status).toBe(403);
    expect(value.error).toBe("Forbidden");
  });

  test("allows same-origin runtime update posts through the BFF", async () => {
    const captured: { auth: string | null } = { auth: null };
    const fetcher = mockFetcher((_url, init) => {
      captured.auth = (init.headers as Headers).get("authorization");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const request = new Request("http://localhost/api/runtime/update", {
      method: "POST",
      headers: { origin: "http://localhost" }
    });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(200);
    expect(captured.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("supports PATCH and DELETE methods", async () => {
    const seen: string[] = [];
    const fetcher = mockFetcher(async (_url, init) => {
      seen.push(String(init.method));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const patchRequest = new Request("http://localhost/api/runtime/skills/s_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" })
    });
    const deleteRequest = new Request("http://localhost/api/runtime/skills/s_1", { method: "DELETE" });
    await proxyRequest(patchRequest, ["skills", "s_1"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    await proxyRequest(deleteRequest, ["skills", "s_1"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(seen).toEqual(["PATCH", "DELETE"]);
  });

  test("passes upstream non-2xx error bodies through to the caller", async () => {
    const fetcher = mockFetcher(() => new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    const request = new Request("http://localhost/api/runtime/tasks/missing", { method: "GET" });
    const response = await proxyRequest(request, ["tasks", "missing"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    const value = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(value.error).toBe("Not found");
  });

  test("propagates the caller AbortSignal to upstream fetch (so client disconnect closes the stream)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetcher = mockFetcher((_url, init) => {
      receivedSignal = init.signal as AbortSignal | undefined;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const controller = new AbortController();
    const request = new Request("http://localhost/api/runtime/events/stream", { method: "GET" });
    await proxyRequest(request, ["events", "stream"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher, signal: controller.signal });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBe(controller.signal);
  });

  test("returns SSE bodies without buffering (preserves named events)", async () => {
    // The proxy must hand back upstream.body unchanged; if it materializes the
    // body via .text(), the browser EventSource sees ERR_INCOMPLETE_CHUNKED_ENCODING
    // and named events (event: <kind>) become unobservable.
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: task\ndata: {}\n\n"));
        controller.close();
      }
    });
    const upstream = new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    const fetcher = mockFetcher(() => upstream);
    const request = new Request("http://localhost/api/runtime/events/stream", { method: "GET" });
    const response = await proxyRequest(request, ["events", "stream"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.body).toBe(upstream.body);
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  test("preserves SSE stream bodies and headers", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: test\ndata: {\"id\":\"e_1\"}\n\n"));
        controller.close();
      }
    });
    const fetcher = mockFetcher(() => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    }));
    const request = new Request("http://localhost/api/runtime/events/stream", { method: "GET" });
    const response = await proxyRequest(request, ["events", "stream"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("data:");
    expect(text).toContain("e_1");
  });
});
