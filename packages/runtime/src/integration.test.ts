import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { proxyRequest } from "../../web/src/lib/runtime";

const RUNTIME_URL = "http://127.0.0.1:9999";
const TOKEN = "secret-token";

function mockFetcher(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

describe("runtime proxy", () => {
  // The BFF guard's behavior branches on GINI_TRUSTED_ORIGINS — when set,
  // only listed origins pass; when unset, the loopback-fallback path
  // matches Origin against Host. Pin the env to "unset" before each test
  // so dev shells / CI environments that export the var don't change the
  // guard's branch under tests that assume the fallback.
  const savedTrustedOrigins = process.env.GINI_TRUSTED_ORIGINS;
  beforeEach(() => {
    delete process.env.GINI_TRUSTED_ORIGINS;
  });
  afterEach(() => {
    if (savedTrustedOrigins === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
    else process.env.GINI_TRUSTED_ORIGINS = savedTrustedOrigins;
  });

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
      headers: { "content-type": "application/json", origin: "http://localhost" },
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

  test("rejects non-loopback Host in the fallback path even when Origin matches", async () => {
    // The fallback (no GINI_TRUSTED_ORIGINS) accepts only loopback Host
    // values so a BFF on tailnet / tunnel can't be approached by a DNS-
    // rebinding page that sets Origin and Host to the same attacker-
    // controlled name. Without the loopback restriction, the equality
    // check at the bottom of the fallback would pass and the bearer
    // would be forwarded.
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://gini-server.tailnet.example/api/runtime/update", {
      method: "POST",
      headers: { origin: "http://gini-server.tailnet.example", host: "gini-server.tailnet.example" }
    });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(403);
  });

  test("allowlist branch accepts origins in GINI_TRUSTED_ORIGINS and rejects the rest", async () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://gini-server.tailnet.example,http://localhost:3000";

    const passed: { auth: string | null } = { auth: null };
    const passingFetcher = mockFetcher((_url, init) => {
      passed.auth = (init.headers as Headers).get("authorization");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const passingRequest = new Request("https://gini-server.tailnet.example/api/runtime/update", {
      method: "POST",
      headers: { origin: "https://gini-server.tailnet.example", host: "gini-server.tailnet.example" }
    });
    const passingResponse = await proxyRequest(passingRequest, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher: passingFetcher });
    expect(passingResponse.status).toBe(200);
    expect(passed.auth).toBe(`Bearer ${TOKEN}`);

    const rejectingFetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const rejectedRequest = new Request("https://gini-server.tailnet.example/api/runtime/update", {
      method: "POST",
      headers: { origin: "https://attacker.example", host: "gini-server.tailnet.example" }
    });
    const rejectedResponse = await proxyRequest(rejectedRequest, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher: rejectingFetcher });
    expect(rejectedResponse.status).toBe(403);
  });

  test("allowlist branch fails closed when every entry in GINI_TRUSTED_ORIGINS is malformed", async () => {
    // A typo in the env var that leaves zero parseable origins refuses every
    // privileged POST from a non-loopback origin rather than silently
    // downgrading to the rebindable Host-equality fallback. (Loopback is trusted
    // unconditionally — the gateway is the single front and a rebinding page
    // cannot forge a loopback Host — so the failure must be exercised from a
    // non-loopback origin.)
    process.env.GINI_TRUSTED_ORIGINS = "not-a-url, also-not-a-url, :::garbage";

    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("https://gini-server.tailnet.example/api/runtime/update", {
      method: "POST",
      headers: { origin: "https://gini-server.tailnet.example", host: "gini-server.tailnet.example" }
    });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(403);
  });

  test("privileged POST with no Origin header fails closed", async () => {
    // Modern browsers always send Origin on POST. A request without it
    // is either a non-browser client (curl, scripts) that should hit the
    // gateway directly with its own token, or a misconfigured proxy
    // stripping the header — neither should drive the operator's
    // bearer-injected privileged path.
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://localhost/api/runtime/update", { method: "POST" });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(403);
  });

  test("rejects Origin-less GETs on non-loopback hosts (browser may omit Origin on same-origin safe requests)", async () => {
    // Some browsers omit Origin on same-origin GET. A DNS-rebound page
    // that thinks it's same-origin to attacker.example produces exactly
    // this shape: no Origin, Host = attacker.example. The fallback's
    // host validation must run even without Origin so a non-loopback
    // host without an allowlist 403s.
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://gini-server.tail.ts.net/api/runtime/state", {
      method: "GET",
      headers: { host: "gini-server.tail.ts.net" }
    });
    const response = await proxyRequest(request, ["state"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    expect(response.status).toBe(403);
  });

  test("loopback Origin-less GET passes even with GINI_TRUSTED_ORIGINS set (gateway is the single front)", async () => {
    // The BFF is internal now: in production the gateway validates the real
    // Host/Origin and rewrites both to loopback before proxying here, and a
    // top-level navigation carries no Origin. A loopback Host is therefore
    // trusted unconditionally — a rebinding page cannot forge a loopback Host —
    // so this no-Origin loopback GET reaches the upstream even with an allowlist
    // configured for the gateway's external origin. (Origin-less GETs on
    // non-loopback hosts still 403; see the test above.)
    process.env.GINI_TRUSTED_ORIGINS = "http://localhost:3000";
    let called = false;
    const fetcher = mockFetcher(() => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const request = new Request("http://localhost:3000/api/runtime/state", {
      method: "GET",
      headers: { host: "localhost:3000" }
    });
    const response = await proxyRequest(request, ["state"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    expect(called).toBe(true);
    expect(response.status).toBe(200);
  });

  test("rejects GETs whose Origin doesn't match Host on non-loopback hosts (DNS-rebinding for read-only state)", async () => {
    // Before the wider guard, GETs bypassed the CSRF check entirely.
    // A DNS-rebound page on attacker.example fetching /api/runtime/state
    // would have Origin=Host=attacker.example, the BFF would inject the
    // bearer, and the response would be readable same-origin under the
    // attacker's page. The guard now runs on every request and rejects
    // a non-loopback Host without an explicit allowlist.
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://gini-server.tail.ts.net/api/runtime/state", {
      method: "GET",
      headers: { origin: "http://gini-server.tail.ts.net", host: "gini-server.tail.ts.net" }
    });
    const response = await proxyRequest(request, ["state"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    expect(response.status).toBe(403);
  });

  test("rejects non-listed POSTs (pairing/claim) that previously bypassed the guard", async () => {
    // /pairing and /pairing/claim used to live outside PRIVILEGED_POST_ROUTES,
    // so a rebound page could drive token-minting under the operator's
    // bearer. The guard now runs on every POST regardless of route.
    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("http://gini-server.tail.ts.net/api/runtime/pairing", {
      method: "POST",
      headers: { origin: "http://gini-server.tail.ts.net", host: "gini-server.tail.ts.net", "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const response = await proxyRequest(request, ["pairing"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });
    expect(response.status).toBe(403);
  });

  test("allowlist entries with a path or query are rejected so the operator's intent isn't silently broadened", async () => {
    // An operator who pastes a full URL — say https://host/some-path —
    // would otherwise silently get an allowlist for the entire host
    // (the URL parser drops the path on .host). Refuse those entries
    // so a copy-paste mistake either produces an empty (fail-closed)
    // allowlist or a deliberately narrow one.
    process.env.GINI_TRUSTED_ORIGINS = "https://gini-server.tail.ts.net/some-path?token=secret";

    const fetcher = mockFetcher(() => {
      throw new Error("upstream should not be called");
    });
    const request = new Request("https://gini-server.tail.ts.net/api/runtime/update", {
      method: "POST",
      headers: { origin: "https://gini-server.tail.ts.net", host: "gini-server.tail.ts.net" }
    });
    const response = await proxyRequest(request, ["update"], { runtimeUrl: RUNTIME_URL, token: TOKEN, fetcher });

    expect(response.status).toBe(403);
  });

  test("supports PATCH and DELETE methods", async () => {
    const seen: string[] = [];
    const fetcher = mockFetcher(async (_url, init) => {
      seen.push(String(init.method));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const patchRequest = new Request("http://localhost/api/runtime/skills/s_1", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "x" })
    });
    const deleteRequest = new Request("http://localhost/api/runtime/skills/s_1", {
      method: "DELETE",
      headers: { origin: "http://localhost" }
    });
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
