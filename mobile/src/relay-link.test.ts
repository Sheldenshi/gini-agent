import { describe, expect, test } from "bun:test";
import { isRelayHost, RELAY_DOMAIN, relayPairingRedirect } from "./relay-link";

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
