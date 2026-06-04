/// <reference lib="dom" />

// Raw @/lib/pairing fetchers + isLoopbackFront. The global fetch is stubbed so we
// can assert each fetcher's URL/method/credentials and the shared error path
// (non-ok response throws the server's error or an HTTP fallback).
//
// fetch is restored in afterEach; window.location.hostname is overridden per test
// for the loopback checks and reset after.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  approvePairingRequest,
  cancelPairingRequest,
  claimPairingRequest,
  createPairingRequest,
  isLoopbackFront,
  listPairingRequests,
  pollPairingRequest,
  rejectPairingRequest
} from "./pairing";

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

type FetchCall = { url: string; init: RequestInit };
let lastCall: FetchCall | null;

function stubFetch(body: unknown, { ok = true, status = 200 } = {}) {
  fetchMock = mock(async (url: string, init: RequestInit = {}) => {
    lastCall = { url, init };
    return {
      ok,
      status,
      json: async () => body
    } as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  lastCall = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("pairing fetchers", () => {
  test("createPairingRequest POSTs to /request with an empty json body", async () => {
    stubFetch({ id: "abc", code: "123456" });
    const out = await createPairingRequest();
    expect(out).toEqual({ id: "abc", code: "123456" });
    expect(lastCall?.url).toBe("/api/pairing/request");
    expect(lastCall?.init.method).toBe("POST");
    expect(lastCall?.init.body).toBe("{}");
    expect(lastCall?.init.credentials).toBe("same-origin");
    expect((lastCall?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    );
  });

  test("pollPairingRequest GETs /request/:id (id encoded)", async () => {
    stubFetch({ status: "pending" });
    const out = await pollPairingRequest("a b/c");
    expect(out).toEqual({ status: "pending" });
    expect(lastCall?.url).toBe("/api/pairing/request/a%20b%2Fc");
    expect(lastCall?.init.method).toBeUndefined();
  });

  test("claimPairingRequest POSTs /request/:id/claim", async () => {
    stubFetch({ ok: true });
    const out = await claimPairingRequest("xyz");
    expect(out).toEqual({ ok: true });
    expect(lastCall?.url).toBe("/api/pairing/request/xyz/claim");
    expect(lastCall?.init.method).toBe("POST");
    expect(lastCall?.init.body).toBe("{}");
  });

  test("cancelPairingRequest POSTs /request/:id/cancel", async () => {
    stubFetch({ ok: true });
    await cancelPairingRequest("xyz");
    expect(lastCall?.url).toBe("/api/pairing/request/xyz/cancel");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("listPairingRequests GETs /requests", async () => {
    stubFetch({ requests: [] });
    const out = await listPairingRequests();
    expect(out).toEqual({ requests: [] });
    expect(lastCall?.url).toBe("/api/pairing/requests");
  });

  test("approvePairingRequest POSTs /requests/:id/approve", async () => {
    stubFetch({ request: { id: "1" } });
    await approvePairingRequest("1");
    expect(lastCall?.url).toBe("/api/pairing/requests/1/approve");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("rejectPairingRequest POSTs /requests/:id/reject", async () => {
    stubFetch({ request: { id: "1" } });
    await rejectPairingRequest("1");
    expect(lastCall?.url).toBe("/api/pairing/requests/1/reject");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("a non-ok response with an error body throws that message", async () => {
    stubFetch({ error: "nope" }, { ok: false, status: 403 });
    await expect(createPairingRequest()).rejects.toThrow("nope");
  });

  test("a non-ok response with no error body throws an HTTP fallback", async () => {
    stubFetch({}, { ok: false, status: 500 });
    await expect(listPairingRequests()).rejects.toThrow("HTTP 500");
  });

  test("a body that fails to parse as json is treated as empty (HTTP fallback on error)", async () => {
    fetchMock = mock(async (url: string, init: RequestInit = {}) => {
      lastCall = { url, init };
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("invalid json");
        }
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(listPairingRequests()).rejects.toThrow("HTTP 502");
  });
});

describe("isLoopbackFront", () => {
  let originalHostname: string;

  function setHostname(host: string) {
    Object.defineProperty(window.location, "hostname", {
      configurable: true,
      value: host
    });
  }

  beforeEach(() => {
    originalHostname = window.location.hostname;
  });

  afterEach(() => {
    setHostname(originalHostname);
  });

  test("true for 127.0.0.1", () => {
    setHostname("127.0.0.1");
    expect(isLoopbackFront()).toBe(true);
  });

  test("true for localhost", () => {
    setHostname("localhost");
    expect(isLoopbackFront()).toBe(true);
  });

  test("true for ::1 and [::1]", () => {
    setHostname("::1");
    expect(isLoopbackFront()).toBe(true);
    setHostname("[::1]");
    expect(isLoopbackFront()).toBe(true);
  });

  test("false for a public relay host", () => {
    setHostname("g31.relay.example");
    expect(isLoopbackFront()).toBe(false);
  });
});
