import { describe, expect, test } from "bun:test";
import { safetyCheck } from "./browser";

// Direct unit coverage for the URL safety guard. We exercise the function
// without spinning up Chromium since the guard runs synchronously on the
// raw URL string before any browser work begins.
describe("browser safetyCheck", () => {
  test("blocks IPv4-mapped IPv6 dotted-quad form pointing at metadata", () => {
    const result = safetyCheck("http://[::ffff:169.254.169.254]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 canonical hex form pointing at metadata", () => {
    // Bun normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe], so the
    // hex-form decoder is what actually catches the request in practice.
    const result = safetyCheck("http://[::ffff:a9fe:a9fe]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks fe80:: link-local IPv6", () => {
    const result = safetyCheck("http://[fe80::1]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("does not false-positive on fe8:: (outside fe80::/10 range)", () => {
    // fe8::1 zero-expands to 0fe8:: which is not in the link-local range.
    // The previous regex `^fe[89ab][0-9a-f]?:` would over-match; the fix
    // requires the fourth hex digit so this no longer triggers.
    const result = safetyCheck("http://[fe8::1]/");
    expect(result === undefined || !result.startsWith("Blocked:")).toBe(true);
  });

  test("does not leak secret-bearing input through Invalid URL error", () => {
    // Malformed URL that nonetheless contains an apparent token. The
    // pre-parse secret scan should catch it and return a generic
    // "Blocked:" message that does NOT echo the raw input.
    const sneaky = "not-a-url sk-ant-api03-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain(sneaky);
  });

  test("allows ordinary https URLs", () => {
    expect(safetyCheck("https://example.com/")).toBeUndefined();
  });
});
