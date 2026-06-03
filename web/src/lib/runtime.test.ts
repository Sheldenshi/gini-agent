// Tests for the BFF CSRF guard and header forwarding behavior. The guard
// runs on every proxied request and is the trust-boundary check between
// the browser-facing BFF and the bearer-gated gateway.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { guardCsrf, pickForwardHeaders, proxyRequest } from "./runtime";

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

describe("guardCsrf — loopback short-circuit (gateway is the single front)", () => {
  // The gateway validates the real Host/Origin and rewrites BOTH to loopback
  // before proxying here, so a loopback Host is trusted even when the operator
  // set GINI_TRUSTED_ORIGINS for the gateway's external origin.
  test("POST + loopback Host + loopback Origin passes even with an allowlist set", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).toBeNull();
  });

  test("POST + loopback Host + loopback Origin passes with no allowlist", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).toBeNull();
  });

  test("loopback Host + non-loopback Origin (no allowlist) → 403", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "https://evil.example", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("loopback Host + malformed Origin → 403", () => {
    const res = guardCsrf(makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "not a url" }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — relay-agnostic BFF", () => {
  // The BFF no longer carries a relay lane: the gateway owns relay trust and
  // only ever proxies a loopback Host/Origin to the BFF. A relay Host reaching
  // the BFF directly is therefore refused.
  const SUB = "g3100.gini-relay.lilaclabs.ai";

  test("relay-subdomain Origin POST is refused at the BFF", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", origin: `https://${SUB}`, host: SUB, url: `https://${SUB}/api/runtime/tunnel` }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("relay-subdomain Host no-Origin GET is refused at the BFF", () => {
    const res = guardCsrf(makeReq({ method: "GET", host: SUB, url: `https://${SUB}/api/runtime/tunnel` }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
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

describe("proxyRequest — served downloads", () => {
  test("attachment text/csv passes through byte-identical (no UTF-8 re-encode)", async () => {
    // Raw bytes including a lone 0xff that a text() decode would mangle into
    // U+FFFD. A served upload carries Content-Disposition: attachment, so the
    // proxy must stream it opaquely.
    const raw = new Uint8Array([0x68, 0x69, 0xff, 0x0a]);
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment"
        }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/uploads/abc", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["uploads", "abc"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(raw));
  });
});

describe("proxyRequest — upload size cap", () => {
  test("content-length over the cap returns 413 before forwarding", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 201 });
      }) as unknown as typeof fetch;
      const req = new Request("http://127.0.0.1:7777/api/runtime/uploads", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-length": "11",
          "content-type": "multipart/form-data; boundary=x"
        },
        body: "this is more than ten bytes"
      });
      const res = await proxyRequest(req, ["uploads"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(res.status).toBe(413);
      expect(forwarded).toBe(false);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("non-upload POST is not capped (forwards even over the cap)", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const req = new Request("http://127.0.0.1:7777/api/runtime/chat/abc/messages", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-length": "11",
          "content-type": "application/json"
        },
        body: "this is more than ten bytes"
      });
      const res = await proxyRequest(req, ["chat", "abc", "messages"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(forwarded).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("header-less over-cap upload returns 413 after buffering", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 201 });
      }) as unknown as typeof fetch;
      // A streamed body has no content-length, so the early-reject can't catch
      // it — the post-read buffered-length check must enforce the cap.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20).fill(0x41));
          controller.close();
        }
      });
      const req = new Request("http://127.0.0.1:7777/api/runtime/uploads", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-type": "application/octet-stream"
        },
        body: stream,
        // @ts-expect-error duplex is required for a stream request body
        duplex: "half"
      });
      expect(req.headers.get("content-length")).toBeNull();
      const res = await proxyRequest(req, ["uploads"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(res.status).toBe(413);
      expect(forwarded).toBe(false);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
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
