import { describe, expect, test } from "bun:test";
import {
  isGatewaySwitch,
  isPairableHost,
  isRelayHost,
  RELAY_DOMAIN,
  relayPairingRedirect
} from "./relay-link";

describe("isRelayHost", () => {
  test.each([
    [RELAY_DOMAIN, true],
    [`5dyc5p1spyewh9br5mv4djp4pc.${RELAY_DOMAIN}`, true],
    [`SUB.${RELAY_DOMAIN}`.toUpperCase(), true], // case-insensitive
    [`sub.${RELAY_DOMAIN}:443`, true], // strips port
    ["example.com", false],
    [`${RELAY_DOMAIN}.evil.com`, false], // trailing-label match, not substring
    ["", false]
  ])("%p -> %p", (host, expected) => {
    expect(isRelayHost(host)).toBe(expected);
  });
});

describe("isPairableHost", () => {
  test.each([
    [`abc.${RELAY_DOMAIN}`, true],
    [RELAY_DOMAIN, true],
    ["localhost", true],
    ["localhost:8081", true],
    ["127.0.0.1", true],
    ["127.0.0.1:7351", true],
    ["::1", true],
    ["[::1]:7351", true],
    ["192.168.1.42:7337", false], // LAN host — reachable via token paste, not pairing
    ["10.0.0.5", false],
    ["example.com", false]
  ])("%p -> %p", (host, expected) => {
    expect(isPairableHost(host)).toBe(expected);
  });
});

describe("isGatewaySwitch", () => {
  const A = `https://aaa.${RELAY_DOMAIN}`;
  const B = `https://bbb.${RELAY_DOMAIN}`;
  test("no existing credentials → no confirmation (first-time pair)", () => {
    expect(isGatewaySwitch(null, A)).toBe(false);
    expect(isGatewaySwitch(undefined, A)).toBe(false);
    expect(isGatewaySwitch("", A)).toBe(false);
  });
  test("same host → no confirmation (re-pair)", () => {
    expect(isGatewaySwitch(A, A)).toBe(false);
    expect(isGatewaySwitch(`${A}`, `${A}`)).toBe(false);
  });
  test("different host → confirmation required (gateway switch)", () => {
    expect(isGatewaySwitch(A, B)).toBe(true);
  });
  test("a malformed existing or incoming value errs toward confirming", () => {
    expect(isGatewaySwitch("not a url", A)).toBe(true);
    expect(isGatewaySwitch(A, "not a url")).toBe(true);
  });
});

describe("relayPairingRedirect", () => {
  test("an https relay link becomes /pair?relay=<origin>", () => {
    const out = relayPairingRedirect(`https://abc.${RELAY_DOMAIN}`);
    expect(out).toBe(`/pair?relay=${encodeURIComponent(`https://abc.${RELAY_DOMAIN}`)}`);
  });

  test("the link's own path and query are ignored — only the host matters", () => {
    const out = relayPairingRedirect(`https://abc.${RELAY_DOMAIN}/pair?foo=bar#frag`);
    expect(out).toBe(`/pair?relay=${encodeURIComponent(`https://abc.${RELAY_DOMAIN}`)}`);
  });

  test("the apex relay domain also redirects", () => {
    expect(relayPairingRedirect(`https://${RELAY_DOMAIN}/`)).toBe(
      `/pair?relay=${encodeURIComponent(`https://${RELAY_DOMAIN}`)}`
    );
  });

  test("a non-https relay link is ignored (no cleartext pairing)", () => {
    expect(relayPairingRedirect(`http://abc.${RELAY_DOMAIN}`)).toBeNull();
  });

  test("the app's own gini:// scheme links pass through untouched", () => {
    expect(relayPairingRedirect("gini://pair")).toBeNull();
  });

  test("a non-relay https host is ignored", () => {
    expect(relayPairingRedirect("https://example.com/pair")).toBeNull();
  });

  test("a malformed URL returns null instead of throwing", () => {
    expect(relayPairingRedirect("not a url")).toBeNull();
  });
});
