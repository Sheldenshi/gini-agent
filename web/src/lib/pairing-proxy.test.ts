// Tests for the /api/pairing BFF passthrough. It bridges the Next origin to the
// gateway's native pairing surface, forwarding cookies (NOT a bearer) and a
// loopback Origin, behind the same CSRF guard as the runtime lane.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gatewayIsThisInstance, proxyPairingRequest } from "./pairing-proxy";
import { runtimeInstance } from "./runtime";

const GATEWAY = "http://127.0.0.1:7778";
const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
});
afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
});

// The proxy probes ${runtimeUrl}/api/runtime/__healthz to confirm the gateway is
// this instance before forwarding. This fetcher answers that probe (matching
// instance by default) and records only the actual forward calls in `calls`.
function captureFetcher(response: Response, opts: { healthzInstance?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith("/api/runtime/__healthz")) {
      return Response.json({ ok: true, service: "gini-web", instance: opts.healthzInstance ?? runtimeInstance() });
    }
    calls.push({ url: u, init });
    return response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("proxyPairingRequest", () => {
  test("GET list: forwards to the gateway pairing path with no bearer, cookies + loopback Origin", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ requests: [] }));
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests", {
      method: "GET",
      headers: { host: "127.0.0.1:7777", cookie: "gini_session=abc" }
    });
    const res = await proxyPairingRequest(req, ["requests"], { runtimeUrl: GATEWAY, fetcher });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${GATEWAY}/api/pairing/requests`);
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("cookie")).toBe("gini_session=abc");
    expect(sent.get("origin")).toBe(GATEWAY);
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("preserves the query string when forwarding", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ status: "pending" }));
    const req = new Request("http://127.0.0.1:7777/api/pairing/request/preq_1?foo=bar", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    await proxyPairingRequest(req, ["request", "preq_1"], { runtimeUrl: GATEWAY, fetcher });
    expect(calls[0]!.url).toBe(`${GATEWAY}/api/pairing/request/preq_1?foo=bar`);
  });

  test("forwards the browser User-Agent (device-name fallback on the create path)", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ id: "preq_1", code: "770-600" }, 201));
    const req = new Request("http://127.0.0.1:7777/api/pairing/request", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", "user-agent": "Mozilla/5.0 (iPhone)" },
      body: "{}"
    });
    await proxyPairingRequest(req, ["request"], { runtimeUrl: GATEWAY, fetcher });
    expect(new Headers(calls[0]!.init.headers).get("user-agent")).toBe("Mozilla/5.0 (iPhone)");
  });

  test("POST approve: forwards method + body to the gateway", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ request: { id: "preq_1", status: "approved" } }));
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests/preq_1/approve", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", "content-type": "application/json" },
      body: "{}"
    });
    const res = await proxyPairingRequest(req, ["requests", "preq_1", "approve"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(200);
    expect(calls[0]!.init.method).toBe("POST");
    expect(await new Response(calls[0]!.init.body as BodyInit).text()).toBe("{}");
  });

  test("passes Set-Cookie from the gateway back to the browser (device handshake)", async () => {
    const upstream = jsonResponse({ id: "preq_1", code: "770-600" }, 201, {
      "set-cookie": "gini_pair=secret; Path=/api/pairing; HttpOnly; Secure"
    });
    const { fetcher } = captureFetcher(upstream);
    const req = new Request("http://127.0.0.1:7777/api/pairing/request", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" },
      body: "{}"
    });
    const res = await proxyPairingRequest(req, ["request"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toContain("gini_pair=secret; Path=/api/pairing; HttpOnly; Secure");
  });

  test("POST with no body forwards without a body init", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ ok: true }));
    const req = new Request("http://127.0.0.1:7777/api/pairing/request/preq_1/cancel", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }
    });
    const res = await proxyPairingRequest(req, ["request", "preq_1", "cancel"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(200);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  test("rejects a traversal path with 400 and never forwards", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({}));
    const req = new Request("http://127.0.0.1:7777/api/pairing/x", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyPairingRequest(req, ["..", "requests"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("refuses with 502 when the gateway at runtimeUrl is a DIFFERENT instance (stale/reused port)", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({ requests: [] }), { healthzInstance: `${runtimeInstance()}-mismatch` });
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyPairingRequest(req, ["requests"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(502);
    expect(calls.length).toBe(0);
  });

  test("rejects an encoded slash inside a segment with 400 (no path-confusion collapse)", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({}));
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" },
      body: "{}"
    });
    // "preq_1%2Fapprove" must NOT collapse into requests/preq_1/approve.
    const res = await proxyPairingRequest(req, ["requests", "preq_1%2Fapprove"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("refuses a non-loopback Host with 404 and never forwards (stays gateway-native for remote fronts)", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({}));
    // A same-origin GET on a trusted non-loopback front passes guardCsrf but must
    // not be bridged: pairing remains gateway-native + session-gated off loopback.
    process.env.GINI_TRUSTED_ORIGINS = "https://box.example";
    const req = new Request("https://box.example/api/pairing/requests", {
      method: "GET",
      headers: { host: "box.example", origin: "https://box.example", "sec-fetch-site": "same-origin" }
    });
    const res = await proxyPairingRequest(req, ["requests"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  test("rejects a cross-site POST via the CSRF guard with 403 and never forwards", async () => {
    const { fetcher, calls } = captureFetcher(jsonResponse({}));
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests/preq_1/approve", {
      method: "POST",
      headers: { host: "127.0.0.1:7777", origin: "https://evil.example" }
    });
    const res = await proxyPairingRequest(req, ["requests", "preq_1", "approve"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  test("forwards the upstream status verbatim (e.g. a gateway 403)", async () => {
    const { fetcher } = captureFetcher(jsonResponse({ error: "Forbidden" }, 403));
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyPairingRequest(req, ["requests"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  test("defaults content-type to application/json when upstream omits it", async () => {
    const upstream = new Response("{}", { status: 200 });
    const { fetcher } = captureFetcher(upstream);
    const req = new Request("http://127.0.0.1:7777/api/pairing/requests", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyPairingRequest(req, ["requests"], { runtimeUrl: GATEWAY, fetcher });
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("gatewayIsThisInstance", () => {
  test("true when __healthz reports this service + instance", async () => {
    const fetcher = (async () => Response.json({ service: "gini-web", instance: runtimeInstance() })) as unknown as typeof fetch;
    expect(await gatewayIsThisInstance("http://127.0.0.1:7790", fetcher)).toBe(true);
  });

  test("false when the service marker is wrong even if the instance matches", async () => {
    const fetcher = (async () => Response.json({ service: "not-gini", instance: runtimeInstance() })) as unknown as typeof fetch;
    expect(await gatewayIsThisInstance("http://127.0.0.1:7795", fetcher)).toBe(false);
  });

  test("false when __healthz reports a different instance", async () => {
    const fetcher = (async () => Response.json({ service: "gini-web", instance: `${runtimeInstance()}-mismatch` })) as unknown as typeof fetch;
    expect(await gatewayIsThisInstance("http://127.0.0.1:7791", fetcher)).toBe(false);
  });

  test("false when the probe responds non-ok", async () => {
    const fetcher = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    expect(await gatewayIsThisInstance("http://127.0.0.1:7792", fetcher)).toBe(false);
  });

  test("false when the probe throws (gateway unreachable)", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await gatewayIsThisInstance("http://127.0.0.1:7793", fetcher)).toBe(false);
  });

  test("probes on every call (no caching of the identity result)", async () => {
    let probes = 0;
    const fetcher = (async () => {
      probes += 1;
      return Response.json({ service: "gini-web", instance: runtimeInstance() });
    }) as unknown as typeof fetch;
    const url = "http://127.0.0.1:7794";
    expect(await gatewayIsThisInstance(url, fetcher)).toBe(true);
    expect(await gatewayIsThisInstance(url, fetcher)).toBe(true);
    expect(probes).toBe(2);
  });
});
