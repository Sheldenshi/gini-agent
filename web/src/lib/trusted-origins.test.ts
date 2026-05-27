import { describe, expect, test } from "bun:test";
import { parseTrustedOriginUrls } from "./trusted-origins";

describe("parseTrustedOriginUrls", () => {
  test("returns null when raw is undefined or empty", () => {
    expect(parseTrustedOriginUrls(undefined)).toBeNull();
    expect(parseTrustedOriginUrls("")).toBeNull();
    expect(parseTrustedOriginUrls("   ")).toBeNull();
    expect(parseTrustedOriginUrls("\n\t")).toBeNull();
  });

  test("returns empty array when set but every entry malformed", () => {
    // Distinguishes unset (null) from "operator typoed the env var"
    // (empty array). The BFF guard uses this distinction to fail closed
    // rather than silently fall back to the loopback-Host check.
    expect(parseTrustedOriginUrls("not-a-url")).toEqual([]);
    expect(parseTrustedOriginUrls("nope, neither, this")).toEqual([]);
  });

  test("parses single valid origin", () => {
    const result = parseTrustedOriginUrls("https://gini.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].protocol).toBe("https:");
    expect(result![0].host).toBe("gini.example.com");
  });

  test("parses multiple comma-separated origins", () => {
    const result = parseTrustedOriginUrls("https://a.example.com, http://b.example.com:8080");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].host).toBe("a.example.com");
    expect(result![1].host).toBe("b.example.com:8080");
    expect(result![1].protocol).toBe("http:");
  });

  test("skips entries with non-root pathname", () => {
    // The reviewer's specific concern: an operator pasted a full URL
    // with a path and `.host` would silently drop it. Reject those
    // entries so the operator sees the failure rather than a broader
    // allowlist than they intended.
    const result = parseTrustedOriginUrls("https://gini.example.com/admin");
    expect(result).toEqual([]);
  });

  test("accepts entry with root pathname", () => {
    // `new URL("https://gini.example.com/")` has pathname="/" — that's
    // still valid; the validator only rejects non-root paths.
    const result = parseTrustedOriginUrls("https://gini.example.com/");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].host).toBe("gini.example.com");
  });

  test("skips entries with query / hash / userinfo", () => {
    expect(parseTrustedOriginUrls("https://gini.example.com?token=secret")).toEqual([]);
    expect(parseTrustedOriginUrls("https://gini.example.com#fragment")).toEqual([]);
    expect(parseTrustedOriginUrls("https://user@gini.example.com")).toEqual([]);
    expect(parseTrustedOriginUrls("https://user:pass@gini.example.com")).toEqual([]);
  });

  test("mixed valid + invalid entries keep the valid ones", () => {
    const result = parseTrustedOriginUrls("https://good.example.com, junk, https://bad.example.com/path, https://also-good.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result!.map((u) => u.host)).toEqual(["good.example.com", "also-good.example.com"]);
  });

  test("trims whitespace around entries", () => {
    const result = parseTrustedOriginUrls("  https://a.example.com  ,\thttps://b.example.com\n");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result!.map((u) => u.host)).toEqual(["a.example.com", "b.example.com"]);
  });

  test("skips empty entries between commas", () => {
    const result = parseTrustedOriginUrls("https://a.example.com,,,https://b.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result!.map((u) => u.host)).toEqual(["a.example.com", "b.example.com"]);
  });

  test("preserves explicit ports separately from default ports", () => {
    // The proxy's hostMatches applies default-port equivalence; the BFF's
    // Origin set equality does not. This helper returns the parsed URL
    // verbatim so each caller can pick its own matching semantics.
    const result = parseTrustedOriginUrls("https://x.example.com:443, https://x.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].host).toBe("x.example.com");
    expect(result![1].host).toBe("x.example.com");
  });
});
