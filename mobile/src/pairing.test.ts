import { describe, expect, test } from "bun:test";
import { createPairingClient, PairingError } from "./pairing";

const RELAY = "https://abc.gini-relay.lilaclabs.ai";

interface FakeResult {
  status?: number;
  body?: unknown;
  text?: string;
}

// A fetch stub that records calls and returns a real Response so the client's
// `await response.text()` + status handling exercise the genuine code path.
function fakeFetch(responder: (url: string, init: RequestInit) => FakeResult) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    const reqInit = (init ?? {}) as RequestInit;
    calls.push({ url: String(url), init: reqInit });
    const r = responder(String(url), reqInit);
    const text = r.text !== undefined ? r.text : r.body !== undefined ? JSON.stringify(r.body) : "";
    return new Response(text, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe("createPairingClient", () => {
  test("normalizes the origin and rejects a public http URL", () => {
    expect(createPairingClient(`${RELAY}/some/path?x=1`).origin).toBe(RELAY);
    expect(() => createPairingClient("http://evil.example.com")).toThrow();
  });

  test("rejects a non-pairable https host (relay/loopback policy enforced in the client)", () => {
    expect(() => createPairingClient("https://evil.example.com")).toThrow(PairingError);
  });

  test("a local http gateway is allowed (dev / LAN)", () => {
    expect(createPairingClient("http://localhost:7351").origin).toBe("http://localhost:7351");
  });
});

describe("create", () => {
  test("POSTs the native handshake and returns id/code/bindSecret", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: "preq_1", code: "123-456", bindSecret: "deadbeef" }
    }));
    const client = createPairingClient(RELAY, fn);
    const out = await client.create();
    expect(out).toEqual({ id: "preq_1", code: "123-456", bindSecret: "deadbeef" });
    expect(calls[0]!.url).toBe(`${RELAY}/api/pairing/request`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!.init, "x-gini-pair-client")).toBe("native");
    expect(calls[0]!.init.body).toBe("{}");
  });

  test("sends the device name in the body when provided", async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: "preq_1", code: "123-456", bindSecret: "deadbeef" }
    }));
    const client = createPairingClient(RELAY, fn);
    await client.create("iPhone 16 Pro");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ deviceName: "iPhone 16 Pro" }));
  });

  test("throws on a malformed create response", async () => {
    const { fn } = fakeFetch(() => ({ status: 201, body: { id: "preq_1", code: "123-456" } }));
    await expect(createPairingClient(RELAY, fn).create()).rejects.toThrow(PairingError);
  });

  test("surfaces the gateway error + status on a non-2xx", async () => {
    const { fn } = fakeFetch(() => ({ status: 429, body: { error: "Too many pairing requests." } }));
    const client = createPairingClient(RELAY, fn);
    try {
      await client.create();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PairingError);
      expect((e as PairingError).status).toBe(429);
      expect((e as PairingError).message).toBe("Too many pairing requests.");
    }
  });

  test("falls back to HTTP <status> when the error body isn't JSON", async () => {
    const { fn } = fakeFetch(() => ({ status: 502, text: "<html>bad gateway</html>" }));
    const client = createPairingClient(RELAY, fn);
    try {
      await client.create();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PairingError).message).toBe("HTTP 502");
    }
  });
});

describe("poll", () => {
  test("GETs with the secret header and returns the status", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { status: "approved" } }));
    const client = createPairingClient(RELAY, fn);
    const status = await client.poll("preq_1", "secret-xyz");
    expect(status).toBe("approved");
    expect(calls[0]!.url).toBe(`${RELAY}/api/pairing/request/preq_1`);
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(headerOf(calls[0]!.init, "x-gini-pair-secret")).toBe("secret-xyz");
  });

  test("throws on a malformed poll response", async () => {
    const { fn } = fakeFetch(() => ({ body: { notStatus: true } }));
    await expect(createPairingClient(RELAY, fn).poll("preq_1", "s")).rejects.toThrow(PairingError);
  });

  test("throws on an unrecognized status string (off-contract value)", async () => {
    const { fn } = fakeFetch(() => ({ body: { status: "approvedish" } }));
    await expect(createPairingClient(RELAY, fn).poll("preq_1", "s")).rejects.toThrow(PairingError);
  });

  test("percent-encodes the request id", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { status: "pending" } }));
    await createPairingClient(RELAY, fn).poll("preq/odd id", "s");
    expect(calls[0]!.url).toBe(`${RELAY}/api/pairing/request/preq%2Fodd%20id`);
  });
});

describe("claim", () => {
  test("POSTs with the secret header and returns the token", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { ok: true, token: "gini_device_abc" } }));
    const client = createPairingClient(RELAY, fn);
    const token = await client.claim("preq_1", "secret-xyz");
    expect(token).toBe("gini_device_abc");
    expect(calls[0]!.url).toBe(`${RELAY}/api/pairing/request/preq_1/claim`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!.init, "x-gini-pair-secret")).toBe("secret-xyz");
  });

  test("throws when the gateway returns no token", async () => {
    const { fn } = fakeFetch(() => ({ body: { ok: true } }));
    await expect(createPairingClient(RELAY, fn).claim("preq_1", "s")).rejects.toThrow(PairingError);
  });
});

describe("cancel", () => {
  test("POSTs and resolves on an empty body", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, text: "" }));
    await createPairingClient(RELAY, fn).cancel("preq_1", "secret-xyz");
    expect(calls[0]!.url).toBe(`${RELAY}/api/pairing/request/preq_1/cancel`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!.init, "x-gini-pair-secret")).toBe("secret-xyz");
  });
});
