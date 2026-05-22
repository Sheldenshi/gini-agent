import { describe, expect, test } from "bun:test";
import {
  generateSecret,
  normalizeSecret,
  stripTunnelPrefix,
  tunnelPathPrefix
} from "./secret-path";

describe("secret-path", () => {
  test("generates a base64url-shaped secret of stable length", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBe(32);
  });

  test("two consecutive generations differ", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  test("normalizeSecret accepts valid material and rejects nonsense", () => {
    expect(normalizeSecret("abcdefghij0123456789")).toBe("abcdefghij0123456789");
    expect(normalizeSecret(" abcd1234WXYZ___- ")).toBe("abcd1234WXYZ___-");
    expect(normalizeSecret("short")).toBeNull();
    expect(normalizeSecret("contains/slash-still-fails-format")).toBeNull();
    expect(normalizeSecret(42)).toBeNull();
    expect(normalizeSecret(undefined)).toBeNull();
    expect(normalizeSecret("a".repeat(129))).toBeNull();
  });

  test("tunnelPathPrefix wraps the secret with leading and trailing slashes", () => {
    expect(tunnelPathPrefix("abc")).toBe("/abc/");
  });

  test("stripTunnelPrefix removes the prefix and preserves the rest", () => {
    expect(stripTunnelPrefix("/abc/api/status", "abc")).toBe("/api/status");
    expect(stripTunnelPrefix("/abc/", "abc")).toBe("/");
    expect(stripTunnelPrefix("/abc", "abc")).toBe("/");
  });

  test("stripTunnelPrefix returns null when the prefix does not match", () => {
    expect(stripTunnelPrefix("/api/status", "abc")).toBeNull();
    expect(stripTunnelPrefix("/abc-other/api", "abc")).toBeNull();
    expect(stripTunnelPrefix("/zzz/abc/api", "abc")).toBeNull();
  });
});
