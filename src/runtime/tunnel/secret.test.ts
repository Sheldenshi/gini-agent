import { describe, expect, test } from "bun:test";
import { constantTimeEquals, generateTunnelSecret } from "./secret";

describe("generateTunnelSecret", () => {
  test("emits a 32-char base64url-encoded string", () => {
    const secret = generateTunnelSecret();
    expect(secret.length).toBe(32);
    expect(/^[A-Za-z0-9_-]+$/.test(secret)).toBe(true);
  });

  test("yields a different value on each call", () => {
    const a = generateTunnelSecret();
    const b = generateTunnelSecret();
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEquals", () => {
  test("matches identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
  });

  test("rejects different strings of equal length", () => {
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });

  test("rejects different lengths", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(constantTimeEquals("", "abc")).toBe(false);
    expect(constantTimeEquals("abc", "")).toBe(false);
  });
});
