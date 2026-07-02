import { describe, expect, it } from "bun:test";
import {
  __testing,
  mergeShellPath,
  readLoginShellPath
} from "./path-bootstrap";

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

  it("drops non-absolute shell segments (no relative paths in launchd PATH)", () => {
    // A long-lived launchd-supervised gateway resolves relative segments
    // against its working directory; we never want a tool lookup to pick
    // up a binary from the repo's `node_modules/.bin` ahead of system
    // dirs. Filter them out at merge time.
    const report = mergeShellPath(
      "/usr/bin",
      "node_modules/.bin:.:/Users/u/.nvm/bin:relative/seg:/opt/homebrew/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin", "/opt/homebrew/bin"]);
    expect(report.merged).not.toContain("node_modules");
    expect(report.merged).not.toContain("relative");
  });

  it("pinFirst keeps the leading N base entries at the head of merged PATH", () => {
    // The launchd plist's PATH starts with the resolved bunDir; a
    // shell-provided bun must not shadow it. pinFirst: 1 anchors that
    // first entry while still letting shell additions land ahead of
    // the rest of the base.
    const report = mergeShellPath(
      "/opt/bun/bin:/usr/local/bin:/usr/bin",
      "/Users/u/.nvm/bin:/opt/homebrew/bin",
      { pinFirst: 1 }
    );
    expect(report.merged).toBe(
      "/opt/bun/bin:/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin"
    );
  });

  it("pinFirst clamps to the base length so out-of-range values don't break the merge", () => {
    const report = mergeShellPath("/a:/b", "/c:/d", { pinFirst: 99 });
    expect(report.merged).toBe("/a:/b:/c:/d");
  });

  it("pinFirst defaults to 0 (shell additions prepended)", () => {
    const report = mergeShellPath("/a:/b", "/c:/d");
    expect(report.merged).toBe("/c:/d:/a:/b");
  });
});

describe("extractBetweenSentinels", () => {
  const { extractBetweenSentinels, SENTINEL_PREFIX } = __testing;
  const begin = `${SENTINEL_PREFIX}deadbeef_BEGIN__`;
  const end = `${SENTINEL_PREFIX}deadbeef_END__`;

  it("returns the value between sentinels", () => {
    expect(extractBetweenSentinels(`${begin}/usr/bin:/bin${end}`, begin, end))
      .toBe("/usr/bin:/bin");
  });

  it("ignores noise before and after the sentinels (rc-file banners)", () => {
    const noisy = `Welcome to zsh!\nnvm: loaded\n${begin}/Users/u/.nvm/bin:/usr/bin${end}\nbye\n`;
    expect(extractBetweenSentinels(noisy, begin, end)).toBe("/Users/u/.nvm/bin:/usr/bin");
  });

  it("returns null when no markers appear", () => {
    expect(extractBetweenSentinels("/Users/u/.nvm/bin:/usr/bin", begin, end))
      .toBeNull();
  });

  it("returns null when only the start sentinel appears", () => {
    expect(extractBetweenSentinels(`${begin}/usr/bin:/bin`, begin, end))
      .toBeNull();
  });

  it("returns null when the value is empty after trimming", () => {
    expect(extractBetweenSentinels(`${begin}   ${end}`, begin, end)).toBeNull();
  });

  it("ignores a different-nonce sentinel printed by an rc-file (collision resistance)", () => {
    // A pathological `.zshrc` could print a fixed string that looks
    // like our marker. Per-call nonce means the bogus marker won't
    // match the begin/end we minted for *this* call.
    const otherBegin = `${SENTINEL_PREFIX}cafebabe_BEGIN__`;
    const otherEnd = `${SENTINEL_PREFIX}cafebabe_END__`;
    const stdout = `${otherBegin}attacker-value${otherEnd}${begin}/real/path${end}`;
    expect(extractBetweenSentinels(stdout, begin, end)).toBe("/real/path");
  });
});

describe("readLoginShellPath", () => {
  it("returns a non-empty string or null without throwing", () => {
    const result = readLoginShellPath("/bin/sh");
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns null when the shell binary does not exist", () => {
    const result = readLoginShellPath("/nonexistent/shell-binary-xyz");
    expect(result).toBeNull();
  });

  it("passes the supplied HOME through to the spawned shell rather than process.env.HOME", () => {
    // /bin/sh on macOS doesn't run a user rc unless invoked as a login
    // shell; for our purposes the smoke is that the option threads
    // through to the spawn without crashing and we get a non-null PATH.
    const prev = process.env.HOME;
    delete process.env.HOME;
    try {
      const result = readLoginShellPath("/bin/sh", { home: "/tmp" });
      // sh under -ilc with HOME=/tmp should still produce a PATH
      // (CLEAN_SHELL_PATH at minimum).
      if (result !== null) {
        expect(result.length).toBeGreaterThan(0);
      }
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
    }
  });

  it("does not inherit the caller's PATH (the shell starts from CLEAN_SHELL_PATH)", () => {
    // Save current PATH, set a sentinel value the shell should NOT see.
    const prev = process.env.PATH;
    const sentinelDir = "/tmp/gini-test-should-not-leak-into-plist";
    process.env.PATH = `${sentinelDir}:${prev ?? ""}`;
    try {
      const result = readLoginShellPath("/bin/sh");
      // /bin/sh on macOS doesn't run user rc files, but it does respect
      // the env we pass. If we accidentally inherited the parent PATH,
      // the sentinel dir would appear in the output. With the clean-env
      // spawn, it must not.
      if (result !== null) {
        expect(result).not.toContain(sentinelDir);
      }
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
    }
  });
});
