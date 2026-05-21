import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { augmentPathFromLoginShell } from "./path-bootstrap";

describe("augmentPathFromLoginShell", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("prepends new entries from the login shell PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin"
    });
    expect(report.applied).toBe(true);
    expect(report.added).toEqual(["/Users/u/.nvm/versions/node/v20.0.0/bin"]);
    expect(process.env.PATH).toBe("/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin");
  });

  it("is idempotent when shell PATH adds nothing new", () => {
    process.env.PATH = "/usr/bin:/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/usr/bin:/bin"
    });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("no-new-entries");
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("preserves existing PATH entries at their original positions", () => {
    process.env.PATH = "/bun/bin:/usr/local/bin:/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/usr/local/bin"
    });
    expect(report.applied).toBe(true);
    expect(process.env.PATH).toBe(
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/bun/bin:/usr/local/bin:/usr/bin"
    );
  });

  it("skips when shouldSkip returns true", () => {
    process.env.PATH = "/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: true,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/should/not/be/read"
    });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("skip-env");
    expect(process.env.PATH).toBe("/usr/bin");
  });

  it("skips when SHELL is not set", () => {
    process.env.PATH = "/usr/bin";
    const originalShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const report = augmentPathFromLoginShell({
        skip: false,
        readLoginShellPath: () => "/should/not/be/read"
      });
      expect(report.applied).toBe(false);
      expect(report.reason).toBe("no-shell");
    } finally {
      if (originalShell !== undefined) process.env.SHELL = originalShell;
    }
  });

  it("treats a null shell read as shell-failed", () => {
    process.env.PATH = "/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => null
    });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("shell-failed");
  });

  it("treats a throwing shell read as shell-failed", () => {
    process.env.PATH = "/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => {
        throw new Error("spawn failed");
      }
    });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("shell-failed");
  });

  it("treats empty stdout as shell-empty", () => {
    process.env.PATH = "/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "   \n  "
    });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("shell-empty");
  });

  it("ignores blank segments in the shell PATH", () => {
    process.env.PATH = "/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/Users/u/.nvm/bin::/opt/homebrew/bin:"
    });
    expect(report.applied).toBe(true);
    expect(report.added).toEqual(["/Users/u/.nvm/bin", "/opt/homebrew/bin"]);
  });

  it("dedupes segments that already appear in process.env.PATH", () => {
    process.env.PATH = "/opt/homebrew/bin:/usr/bin";
    const report = augmentPathFromLoginShell({
      skip: false,
      shell: "/bin/zsh",
      readLoginShellPath: () => "/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin"
    });
    expect(report.added).toEqual(["/Users/u/.nvm/bin"]);
    expect(process.env.PATH).toBe("/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin");
  });
});
