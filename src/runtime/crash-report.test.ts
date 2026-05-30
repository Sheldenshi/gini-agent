// Tests for the pure crash-report module: fingerprint stability/divergence,
// redaction (patterns + literal secrets-env + tunnel secret), jsonl-tail
// payload dropping, and clock-injected rate-limit state round-trips.
//
// All disk writes are routed to a unique GINI_STATE_ROOT under /tmp so nothing
// touches the real ~/.gini.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildCrashReport,
  crashReportsDir,
  fingerprint,
  normalizeForFingerprint,
  readRateLimitState,
  redactReportText,
  writeCrashReportFile,
  writeRateLimitState,
  type CrashSysInfo
} from "./crash-report";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

const SYS_INFO: CrashSysInfo = {
  platform: "darwin",
  arch: "arm64",
  nodeVersion: "v22.0.0",
  giniCommit: "abc1234"
};

describe("fingerprint", () => {
  test("is stable across pid / line:col / path / timestamp / uuid noise", () => {
    const a = new Error("boom");
    a.stack = [
      "Error: boom",
      "    at handler (/Users/alice/gini/src/server.ts:120:14)",
      "    at run (/Users/alice/gini/src/cli/index.ts:42:9)"
    ].join("\n");
    const b = new Error("boom");
    b.stack = [
      "Error: boom",
      "    at handler (/opt/build/12345/server.ts:998:2)",
      "    at run (/opt/build/12345/index.ts:7:1)"
    ].join("\n");
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test("differs when the error message changes", () => {
    const a = new Error("boom one");
    const b = new Error("boom two");
    a.stack = "Error: boom one\n    at f (/a/b.ts:1:1)";
    b.stack = "Error: boom two\n    at f (/a/b.ts:1:1)";
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test("differs when the call site changes", () => {
    const a = new Error("same");
    const b = new Error("same");
    a.stack = "Error: same\n    at alpha (/a/b.ts:1:1)";
    b.stack = "Error: same\n    at beta (/a/b.ts:1:1)";
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test("handles non-Error throwables", () => {
    expect(fingerprint("plain string")).toBe(fingerprint("plain string"));
    expect(typeof fingerprint({ weird: true })).toBe("string");
  });
});

describe("normalizeForFingerprint", () => {
  test("strips paths, positions, hex, uuids, timestamps, pids", () => {
    const input =
      "at f (/Users/x/proj/server.ts:120:14) 0xdeadbeef " +
      "550e8400-e29b-41d4-a716-446655440000 2026-05-29T12:34:56.789Z pid 98337";
    const out = normalizeForFingerprint(input);
    expect(out).not.toContain("/Users/x/proj");
    expect(out).not.toContain("120:14");
    expect(out).not.toContain("0xdeadbeef");
    expect(out).not.toContain("550e8400");
    expect(out).not.toContain("2026-05-29");
    expect(out).not.toContain("98337");
    expect(out).toContain("server.ts");
  });
});

describe("redactReportText", () => {
  test("redacts OpenAI / GitHub / pat / bearer / authorization forms", () => {
    const text = [
      "key sk-abcdefghijklmnop1234",
      "ghp_0123456789abcdefghijklmnopqrstuv",
      "gho_0123456789abcdefghijklmnopqrstuv",
      "github_pat_0123456789abcdefghij_klmnop",
      "Authorization: Bearer xyztoken123456",
      "Bearer anothertoken9999"
    ].join("\n");
    const out = redactReportText(text);
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuv");
    expect(out).not.toContain("gho_0123456789abcdefghijklmnopqrstuv");
    expect(out).not.toContain("github_pat_0123456789abcdefghij_klmnop");
    expect(out).not.toContain("xyztoken123456");
    expect(out).not.toContain("anothertoken9999");
    expect(out).toContain("[redacted]");
  });

  test("redacts literal secrets-env values and the tunnel secret", () => {
    const text = "leaked OPENAI value hunter2-literal and tunnel ts-secret-zzz here";
    const out = redactReportText(text, {
      secretsEnvBody: "export OPENAI_API_KEY='hunter2-literal'\nFOO=bar",
      tunnelSecret: "ts-secret-zzz"
    });
    expect(out).not.toContain("hunter2-literal");
    expect(out).not.toContain("ts-secret-zzz");
    expect(out).toContain("[redacted]");
    // A non-secret value still present (FOO=bar is a value too, but "bar"
    // appears nowhere in the text, so the surrounding prose is intact).
    expect(out).toContain("leaked OPENAI value");
  });
});

describe("buildCrashReport", () => {
  test("drops the data payload from each log line, keeping at + message", () => {
    const report = buildCrashReport({
      instance: "test-inst",
      supervisor: "launchd",
      source: "runtime",
      error: new Error("kaboom"),
      logTail: [
        { at: "2026-05-29T00:00:00.000Z", message: "task.started", data: { secretPrompt: "user content" } },
        { at: "2026-05-29T00:00:01.000Z", message: "task.finished", data: { result: "more user content" } }
      ],
      sysInfo: SYS_INFO,
      clock: () => new Date("2026-05-29T00:00:02.000Z")
    });
    expect(report.logTail).toEqual([
      { at: "2026-05-29T00:00:00.000Z", message: "task.started" },
      { at: "2026-05-29T00:00:01.000Z", message: "task.finished" }
    ]);
    // The serialized form must not carry any of the dropped payload bytes.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("user content");
    expect(serialized).not.toContain("secretPrompt");
    expect(report.fingerprint).toBe(fingerprint(new Error("kaboom")));
    expect(report.at).toBe("2026-05-29T00:00:02.000Z");
  });
});

describe("file writes + rate-limit state", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    stateRoot = `/tmp/gini-crash-report-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test("writeCrashReportFile lands under <stateRoot>/crash-reports/", () => {
    const report = buildCrashReport({
      instance: "test-inst",
      supervisor: "launchd",
      source: "runtime",
      error: new Error("disk-write"),
      logTail: [],
      sysInfo: SYS_INFO,
      clock: () => new Date("2026-05-29T00:00:00.000Z")
    });
    const path = writeCrashReportFile(report);
    expect(path.startsWith(join(stateRoot, "crash-reports"))).toBe(true);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.fingerprint).toBe(report.fingerprint);
  });

  test("rate-limit state round-trips and defaults cleanly", () => {
    const fp = "deadbeef";
    expect(readRateLimitState(fp)).toEqual({ lastFiledAt: null, lastCommentAt: null, commentCount: 0 });
    writeRateLimitState(fp, {
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: "2026-05-29T01:00:00.000Z",
      commentCount: 3
    });
    expect(readRateLimitState(fp)).toEqual({
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: "2026-05-29T01:00:00.000Z",
      commentCount: 3
    });
    expect(crashReportsDir()).toBe(join(stateRoot, "crash-reports"));
  });
});
