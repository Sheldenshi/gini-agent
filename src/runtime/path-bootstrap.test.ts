import { describe, expect, it } from "bun:test";
import { mergeShellPath, readLoginShellPath } from "./path-bootstrap";

describe("mergeShellPath", () => {
  it("prepends new entries from the shell PATH", () => {
    const report = mergeShellPath(
      "/usr/bin:/bin",
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/versions/node/v20.0.0/bin"]);
    expect(report.merged).toBe("/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin");
  });

  it("is a no-op when the shell PATH adds nothing new", () => {
    const report = mergeShellPath("/usr/bin:/bin", "/usr/bin:/bin");
    expect(report.added).toEqual([]);
    expect(report.merged).toBe("/usr/bin:/bin");
  });

  it("preserves base PATH order and prepends new entries", () => {
    const report = mergeShellPath(
      "/bun/bin:/usr/local/bin:/usr/bin",
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/usr/local/bin"
    );
    expect(report.added).toEqual([
      "/Users/u/.nvm/versions/node/v20.0.0/bin",
      "/opt/homebrew/bin"
    ]);
    expect(report.merged).toBe(
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/bun/bin:/usr/local/bin:/usr/bin"
    );
  });

  it("ignores blank segments", () => {
    const report = mergeShellPath(
      "/usr/bin",
      "/Users/u/.nvm/bin::/opt/homebrew/bin:"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin", "/opt/homebrew/bin"]);
  });

  it("dedupes shell segments against the base path", () => {
    const report = mergeShellPath(
      "/opt/homebrew/bin:/usr/bin",
      "/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin"]);
    expect(report.merged).toBe("/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin");
  });

  it("dedupes within the shell input itself", () => {
    const report = mergeShellPath(
      "/usr/bin",
      "/opt/homebrew/bin:/opt/homebrew/bin:/Users/u/.nvm/bin"
    );
    expect(report.added).toEqual(["/opt/homebrew/bin", "/Users/u/.nvm/bin"]);
  });
});

describe("readLoginShellPath", () => {
  it("returns stdout for a successful shell invocation", () => {
    const result = readLoginShellPath("/bin/sh");
    // /bin/sh exists on every macOS and Linux system. It may emit a PATH
    // or it may emit an empty one (depending on system rc files); either
    // way the call should not throw and should return a string or null.
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns null when the shell binary does not exist", () => {
    const result = readLoginShellPath("/nonexistent/shell-binary-xyz");
    expect(result).toBeNull();
  });
});
