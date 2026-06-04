// Unit tests for the local-only http allowlist and base-URL normalizer.
// Pins the gateway transport policy: iOS ATS is disabled globally, so
// plaintext http:// must stay confined to host addresses on the user's
// own machine or a private network they control.

import { describe, expect, test, mock } from "bun:test";

// AsyncStorage isn't available under bun:test. Stub it before importing
// auth.ts so the module-load side effects don't crash.
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {}
  }
}));

// Stub the push module that saveCredentials lazy-requires on a credential swap,
// so the reset-on-swap behavior is observable without loading react-native.
const resetPushSpy = mock(() => {});
mock.module("./push", () => ({
  resetRegistrationForCredentialSwap: resetPushSpy
}));

import {
  isLocalGatewayHost,
  normalizeBaseUrl,
  PUBLIC_HTTP_REJECTION,
  saveCredentials
} from "./auth";

describe("isLocalGatewayHost", () => {
  test("loopback hosts are local", () => {
    expect(isLocalGatewayHost("localhost")).toBe(true);
    expect(isLocalGatewayHost("127.0.0.1")).toBe(true);
    expect(isLocalGatewayHost("::1")).toBe(true);
  });

  test("bracketed IPv6 loopback is local (WHATWG URL hostname shape)", () => {
    // WHATWG URL surfaces "::1" as "[::1]" via the .hostname getter,
    // so the allowlist must strip the brackets before comparing.
    expect(isLocalGatewayHost("[::1]")).toBe(true);
  });

  test("RFC1918 ranges are local", () => {
    expect(isLocalGatewayHost("10.0.0.1")).toBe(true);
    expect(isLocalGatewayHost("172.16.0.1")).toBe(true);
    expect(isLocalGatewayHost("172.31.255.255")).toBe(true);
    expect(isLocalGatewayHost("192.168.1.1")).toBe(true);
  });

  test("CGNAT 100.64.0.0/10 is local (Tailscale)", () => {
    expect(isLocalGatewayHost("100.64.0.1")).toBe(true);
    expect(isLocalGatewayHost("100.127.255.255")).toBe(true);
  });

  test("any .local hostname is local (mDNS)", () => {
    expect(isLocalGatewayHost("my-pi.local")).toBe(true);
    expect(isLocalGatewayHost("gateway.local")).toBe(true);
  });

  test("addresses outside RFC1918 are not local", () => {
    expect(isLocalGatewayHost("172.32.0.1")).toBe(false);
    expect(isLocalGatewayHost("172.15.0.1")).toBe(false);
  });

  test("addresses outside CGNAT range are not local", () => {
    expect(isLocalGatewayHost("100.128.0.1")).toBe(false);
    expect(isLocalGatewayHost("100.63.255.255")).toBe(false);
  });

  test("public hostnames and TEST-NET ranges are not local", () => {
    expect(isLocalGatewayHost("google.com")).toBe(false);
    expect(isLocalGatewayHost("203.0.113.5")).toBe(false);
    expect(isLocalGatewayHost("11.0.0.1")).toBe(false);
  });

  test(".local must be the trailing label, not a substring", () => {
    expect(isLocalGatewayHost("my.local.evil.com")).toBe(false);
    expect(isLocalGatewayHost("localdomain.com")).toBe(false);
  });

  test("empty and malformed inputs are not local", () => {
    expect(isLocalGatewayHost("")).toBe(false);
    expect(isLocalGatewayHost("not-an-ip")).toBe(false);
  });

  test("malformed IPv4 octets are not local", () => {
    // out-of-range octets
    expect(isLocalGatewayHost("10.0.0.256")).toBe(false);
    expect(isLocalGatewayHost("999.0.0.1")).toBe(false);
    // wrong octet count
    expect(isLocalGatewayHost("10.0.0")).toBe(false);
    expect(isLocalGatewayHost("10.0.0.1.5")).toBe(false);
    // non-numeric / empty octet
    expect(isLocalGatewayHost("10..0.1")).toBe(false);
    expect(isLocalGatewayHost("10.0.0.x")).toBe(false);
    expect(isLocalGatewayHost("10.0.0.-1")).toBe(false);
    // overlong octet
    expect(isLocalGatewayHost("10.0.0.1234")).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  test("accepts https:// to any host", () => {
    expect(normalizeBaseUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeBaseUrl("https://127.0.0.1:7421")).toBe("https://127.0.0.1:7421");
    expect(normalizeBaseUrl("https://gateway.example.net")).toBe(
      "https://gateway.example.net"
    );
  });

  test("accepts http:// to local hosts", () => {
    expect(normalizeBaseUrl("http://localhost:7421")).toBe("http://localhost:7421");
    expect(normalizeBaseUrl("http://127.0.0.1:7421")).toBe("http://127.0.0.1:7421");
    expect(normalizeBaseUrl("http://192.168.1.10:7421")).toBe("http://192.168.1.10:7421");
    expect(normalizeBaseUrl("http://my-pi.local:7421")).toBe("http://my-pi.local:7421");
    expect(normalizeBaseUrl("http://100.64.0.1")).toBe("http://100.64.0.1");
  });

  test("accepts http:// to bracketed IPv6 loopback", () => {
    // The original symptom: a pasted "http://[::1]:7421" round-trips
    // through WHATWG URL with hostname="[::1]" and was rejected by the
    // bracket-less loopback allowlist before the strip-and-compare fix.
    expect(normalizeBaseUrl("http://[::1]:7421")).toBe("http://[::1]:7421");
  });

  test("rejects http:// to non-loopback IPv6", () => {
    // Non-loopback IPv6 over plaintext stays in the cleartext-warning
    // bucket — the bracket strip must not accidentally widen the
    // allowlist to arbitrary v6 hosts.
    expect(() => normalizeBaseUrl("http://[2001:db8::1]:7421")).toThrow(
      PUBLIC_HTTP_REJECTION
    );
  });

  test("rejects http:// to public hosts with the cleartext warning", () => {
    expect(() => normalizeBaseUrl("http://example.com")).toThrow(PUBLIC_HTTP_REJECTION);
    expect(() => normalizeBaseUrl("http://203.0.113.5")).toThrow(PUBLIC_HTTP_REJECTION);
    expect(() => normalizeBaseUrl("http://gateway.example.net")).toThrow(
      PUBLIC_HTTP_REJECTION
    );
  });

  test("rejects empty input", () => {
    expect(() => normalizeBaseUrl("")).toThrow("Base URL is required.");
    expect(() => normalizeBaseUrl("   ")).toThrow("Base URL is required.");
  });

  test("rejects unparseable input", () => {
    expect(() => normalizeBaseUrl("not a url")).toThrow("Invalid base URL.");
  });

  test("rejects non-http(s) schemes", () => {
    expect(() => normalizeBaseUrl("ftp://example.com")).toThrow(
      "Base URL must use http or https."
    );
    expect(() => normalizeBaseUrl("ws://localhost")).toThrow(
      "Base URL must use http or https."
    );
  });

  test("strips query strings, paths, and fragments", () => {
    expect(normalizeBaseUrl("https://example.com/path?token=leaked#frag")).toBe(
      "https://example.com"
    );
  });
});

describe("saveCredentials push-registration reset on swap", () => {
  test("resets push on a credential swap, not on a same-identity re-save", async () => {
    resetPushSpy.mockClear();
    // First save (cache empty) → counts as a swap → reset re-arms registration.
    await saveCredentials({ baseUrl: "https://a.gini-relay.lilaclabs.ai", token: "tok1" });
    expect(resetPushSpy).toHaveBeenCalledTimes(1);
    // Re-saving the SAME identity must NOT reset (avoids needless re-registration).
    await saveCredentials({ baseUrl: "https://a.gini-relay.lilaclabs.ai", token: "tok1" });
    expect(resetPushSpy).toHaveBeenCalledTimes(1);
    // A different host → swap → reset.
    await saveCredentials({ baseUrl: "https://b.gini-relay.lilaclabs.ai", token: "tok1" });
    expect(resetPushSpy).toHaveBeenCalledTimes(2);
    // A different token on the same host → swap → reset.
    await saveCredentials({ baseUrl: "https://b.gini-relay.lilaclabs.ai", token: "tok2" });
    expect(resetPushSpy).toHaveBeenCalledTimes(3);
  });

  test("a push reset failure does not break saveCredentials", async () => {
    resetPushSpy.mockClear();
    resetPushSpy.mockImplementationOnce(() => {
      throw new Error("push unavailable");
    });
    // A new identity triggers the reset, which throws; saveCredentials must still resolve.
    await saveCredentials({ baseUrl: "https://c.gini-relay.lilaclabs.ai", token: "tok3" });
    expect(resetPushSpy).toHaveBeenCalledTimes(1);
  });
});
