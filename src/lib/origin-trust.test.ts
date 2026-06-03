// Tests for the single-front (gateway) host/origin trust guard. This is the
// security boundary that replaces the BFF's relay-aware guard once the gateway
// is the only network-facing surface, so every lane is exercised here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isLoopbackHost, isRelayHost, trustedOrigins, webBoundRequestAllowed } from "./origin-trust";

const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;
const originalRelayDomain = process.env.GINI_RELAY_DOMAIN;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
  delete process.env.GINI_RELAY_DOMAIN;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
  if (originalRelayDomain === undefined) delete process.env.GINI_RELAY_DOMAIN;
  else process.env.GINI_RELAY_DOMAIN = originalRelayDomain;
});

function makeReq(opts: {
  method?: string;
  origin?: string;
  host?: string;
  secFetchSite?: string;
  secFetchDest?: string;
  url?: string;
}): Request {
  const headers = new Headers();
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.host !== undefined) headers.set("host", opts.host);
  if (opts.secFetchSite) headers.set("sec-fetch-site", opts.secFetchSite);
  if (opts.secFetchDest) headers.set("sec-fetch-dest", opts.secFetchDest);
  return new Request(opts.url ?? "http://127.0.0.1:7778/api/runtime/chat", {
    method: opts.method ?? "GET",
    headers
  });
}

describe("isLoopbackHost", () => {
  test("accepts localhost / 127.0.0.1 / [::1], with or without port", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7778")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:7778")).toBe(true);
  });
  test("rejects non-loopback hosts", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.5:7778")).toBe(false);
    expect(isLoopbackHost("[2001:db8::1]:80")).toBe(false);
  });
});

describe("isRelayHost", () => {
  test("accepts the relay apex and its subdomains, with or without port", () => {
    expect(isRelayHost("gini-relay.lilaclabs.ai")).toBe(true);
    expect(isRelayHost("g3100.gini-relay.lilaclabs.ai")).toBe(true);
    expect(isRelayHost("g3100.gini-relay.lilaclabs.ai:443")).toBe(true);
  });
  test("rejects non-relay hosts", () => {
    expect(isRelayHost("example.com")).toBe(false);
    expect(isRelayHost("evil-gini-relay.lilaclabs.ai.attacker.com")).toBe(false);
  });
  test("honors a custom GINI_RELAY_DOMAIN", () => {
    process.env.GINI_RELAY_DOMAIN = "relay.test";
    expect(isRelayHost("sub.relay.test")).toBe(true);
    expect(isRelayHost("gini-relay.lilaclabs.ai")).toBe(false);
  });
  test("handles bracketed IPv6 hosts without matching", () => {
    expect(isRelayHost("[::1]:443")).toBe(false);
  });
});

describe("trustedOrigins", () => {
  test("returns null when unset or whitespace-only", () => {
    expect(trustedOrigins()).toBeNull();
    process.env.GINI_TRUSTED_ORIGINS = "   ";
    expect(trustedOrigins()).toBeNull();
  });
  test("parses valid origins into a Set of scheme//host", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://a.example, https://b.example:8443";
    const set = trustedOrigins();
    expect(set).not.toBeNull();
    expect(set!.has("https://a.example")).toBe(true);
    expect(set!.has("https://b.example:8443")).toBe(true);
  });
  test("skips entries with a path/query/hash/userinfo and malformed entries", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://ok.example, https://bad.example/path, https://q.example?x=1, https://h.example#f, https://u:p@cred.example, not-a-url, ";
    const set = trustedOrigins();
    expect(set!.has("https://ok.example")).toBe(true);
    expect(set!.size).toBe(1);
  });
  test("returns an empty Set when every entry is malformed (fail-closed input)", () => {
    process.env.GINI_TRUSTED_ORIGINS = "not-a-url, also bad";
    const set = trustedOrigins();
    expect(set).not.toBeNull();
    expect(set!.size).toBe(0);
  });
});

describe("webBoundRequestAllowed — no Origin", () => {
  test("unsafe method without Origin is refused", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "POST", host: "127.0.0.1:7778" }))).toBe(false);
  });
  test("safe method on loopback Host (no allowlist) passes", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778" }))).toBe(true);
  });
  test("safe method on relay Host (no allowlist) passes", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "g31.gini-relay.lilaclabs.ai", url: "https://g31.gini-relay.lilaclabs.ai/" }))).toBe(true);
  });
  test("safe method on an unknown Host (no allowlist) is refused", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "evil.example", url: "https://evil.example/" }))).toBe(false);
  });
  test("with an allowlist set, relay and loopback hosts still pass safe no-Origin requests; unknown hosts are refused", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    // Relay front is auto-trusted.
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "g31.gini-relay.lilaclabs.ai", url: "https://g31.gini-relay.lilaclabs.ai/" }))).toBe(true);
    // Loopback is trusted regardless of the allowlist — this is the runtime's own
    // readiness probe shape (no-Origin loopback GET to /api/runtime/__healthz),
    // which the tunnel connect flow runs against the gateway port.
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778", url: "http://127.0.0.1:7778/api/runtime/__healthz" }))).toBe(true);
    // An unknown non-loopback, non-relay Host with no Origin is still refused.
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "evil.example", url: "https://evil.example/" }))).toBe(false);
  });
});

describe("webBoundRequestAllowed — loopback trusted regardless of allowlist", () => {
  test("loopback Origin on a loopback Host passes even with an allowlist set", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    expect(webBoundRequestAllowed(makeReq({ method: "POST", host: "127.0.0.1:7778", origin: "http://127.0.0.1:7778" }))).toBe(true);
  });
});

describe("webBoundRequestAllowed — Origin present", () => {
  test("malformed Origin is refused", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "not a url", host: "127.0.0.1:7778" }))).toBe(false);
  });
  test("relay-subdomain Origin passes even with an allowlist set", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const sub = "g31.gini-relay.lilaclabs.ai";
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: `https://${sub}`, host: sub, secFetchSite: "same-origin", url: `https://${sub}/api/runtime/tunnel` }))).toBe(true);
  });
  test("allowlist-matched Origin passes; unmatched is refused", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "https://allowed.example", host: "allowed.example", url: "https://allowed.example/api/runtime/chat" }))).toBe(true);
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "https://evil.example", host: "evil.example", url: "https://evil.example/api/runtime/chat" }))).toBe(false);
  });
  test("loopback Origin equal to loopback Host passes when no allowlist is set", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "http://127.0.0.1:7778", host: "127.0.0.1:7778" }))).toBe(true);
  });
  test("non-loopback Host with a mismatched Origin is refused (no allowlist)", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "https://evil.example", host: "tailnet.example", url: "https://tailnet.example/api/runtime/chat" }))).toBe(false);
  });
  test("loopback Host but mismatched Origin is refused (no allowlist)", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "POST", origin: "https://evil.example", host: "127.0.0.1:7778" }))).toBe(false);
  });
});

describe("webBoundRequestAllowed — Sec-Fetch-Site", () => {
  test("cross-site is refused even on an otherwise-trusted request", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778", secFetchSite: "cross-site" }))).toBe(false);
  });
  test("same-origin and none are allowed", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778", secFetchSite: "same-origin" }))).toBe(true);
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778", secFetchSite: "none" }))).toBe(true);
  });

  test("a cross-site TOP-LEVEL navigation (Sec-Fetch-Dest=document) is allowed — opening the tunnel URL via a link", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "g31.gini-relay.lilaclabs.ai", url: "https://g31.gini-relay.lilaclabs.ai/", secFetchSite: "cross-site", secFetchDest: "document" }))).toBe(true);
  });

  test("a cross-site subresource (non-document destination) is still refused", () => {
    expect(webBoundRequestAllowed(makeReq({ method: "GET", host: "127.0.0.1:7778", secFetchSite: "cross-site", secFetchDest: "image" }))).toBe(false);
  });
});
