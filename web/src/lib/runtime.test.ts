// Tests for the BFF CSRF guard and header forwarding behavior. The guard
// runs on every proxied request and is the trust-boundary check between
// the browser-facing BFF and the bearer-gated gateway.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { guardCsrf, pickForwardHeaders } from "./runtime";

const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
});

function makeReq(opts: {
  method?: string;
  origin?: string;
  host?: string;
  secFetchSite?: string;
  url?: string;
}): Request {
  const headers = new Headers();
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.host !== undefined) headers.set("host", opts.host);
  if (opts.secFetchSite) headers.set("sec-fetch-site", opts.secFetchSite);
  return new Request(opts.url ?? "http://127.0.0.1:7777/api/runtime/chat", {
    method: opts.method ?? "GET",
    headers
  });
}

describe("guardCsrf — no Origin", () => {
  test("POST + no Origin → 403 (unsafe methods require Origin)", async () => {
    const res = guardCsrf(makeReq({ method: "POST", host: "127.0.0.1:7777" }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — Origin allowlist", () => {
  test("POST + Origin matching allowlist → pass", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({
        method: "POST",
        origin: "https://allowed.example",
        host: "allowed.example",
        url: "https://allowed.example/api/runtime/chat"
      }),
      []
    );
    expect(res).toBeNull();
  });

  test("POST + Origin not in allowlist → 403", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({
        method: "POST",
        origin: "https://evil.example",
        host: "evil.example",
        url: "https://evil.example/api/runtime/chat"
      }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — safe methods", () => {
  test("GET with no Origin on loopback Host → pass", () => {
    const res = guardCsrf(makeReq({ method: "GET", host: "127.0.0.1:7777" }), []);
    expect(res).toBeNull();
  });

  test("HEAD with no Origin on loopback Host → pass", () => {
    const res = guardCsrf(makeReq({ method: "HEAD", host: "127.0.0.1:7777" }), []);
    expect(res).toBeNull();
  });
});

describe("guardCsrf — Sec-Fetch-Site", () => {
  test("GET on loopback with sec-fetch-site=cross-site → 403", () => {
    const res = guardCsrf(
      makeReq({
        method: "GET",
        host: "127.0.0.1:7777",
        secFetchSite: "cross-site"
      }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("pickForwardHeaders", () => {
  test("forwards X-Device-Token so the gateway sees it on /badge + /read", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      "x-device-token": "abc123"
    });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("x-device-token")).toBe("abc123");
  });

  test("forwards last-event-id (SSE reconnect dedup)", () => {
    const incoming = new Headers({ "last-event-id": "block_42:170" });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("last-event-id")).toBe("block_42:170");
  });

  test("drops headers not in the allowlist (e.g. cookie)", () => {
    const incoming = new Headers({ cookie: "session=secret" });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("cookie")).toBeNull();
  });
});
