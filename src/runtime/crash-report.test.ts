// Tests for the pure crash-report module: fingerprint stability/divergence,
// redaction (patterns + literal secrets-env), jsonl-tail
// payload dropping, and clock-injected rate-limit state round-trips.
//
// All disk writes are routed to a unique GINI_STATE_ROOT under /tmp so nothing
// touches the real ~/.gini.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildCrashReport,
  crashReportsDir,
  dismissedCrashReportsDir,
  filedCrashReportsDir,
  fingerprint,
  listPendingReports,
  markAsked,
  normalizeForFingerprint,
  pendingCrashReportsDir,
  readRateLimitState,
  redactReportText,
  resolvePendingReport,
  wasAskedRecently,
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

  test("redacts the FULL Authorization header value (Basic, bare token, not just Bearer)", () => {
    // The header value can be `Basic <base64>`, a bare token with no scheme,
    // or carry multiple space-separated tokens. Redacting only the first
    // whitespace-delimited token leaves the rest of the credential exposed.
    const text = [
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Authorization: ghp_0123456789abcdefghijklmnopqrstuv",
      "Authorization: some-opaque-api-key-value here-too"
    ].join("\n");
    const out = redactReportText(text);
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuv");
    expect(out).not.toContain("some-opaque-api-key-value");
    expect(out).not.toContain("here-too");
    expect(out).toContain("[redacted]");
  });

  test("redacts literal secrets-env values", () => {
    const text = "leaked OPENAI value hunter2-literal here";
    const out = redactReportText(text, {
      secretsEnvBody: "export OPENAI_API_KEY='hunter2-literal'\nFOO=bar"
    });
    expect(out).not.toContain("hunter2-literal");
    expect(out).toContain("[redacted]");
    // A non-secret value still present (FOO=bar is a value too, but "bar"
    // appears nowhere in the text, so the surrounding prose is intact).
    expect(out).toContain("leaked OPENAI value");
  });

  test("passes a non-string input through untouched instead of throwing", () => {
    // A malformed field (e.g. a numeric `message`) must not make .replace throw
    // — return it unchanged so the whole crash report isn't dropped.
    const num = 123 as unknown as string;
    expect(() => redactReportText(num)).not.toThrow();
    expect(redactReportText(num)).toBe(num);
  });

  test("redacts a single-quote-escaped secrets-env value as loaded (not half-stripped)", () => {
    // The writer escapes embedded single quotes as '\'' (close, escaped
    // quote, reopen). unquoteSecretsValue inverts that, so the literal we
    // redact is exactly `ab'cd` — an ad-hoc slice(1,-1) would have left the
    // `\''` debris and failed to match the loaded value.
    const secret = "ab'cd-secret-99";
    const escaped = "'ab'\\''cd-secret-99'"; // shellSingleQuote(secret)
    const out = redactReportText(`the key is ${secret} appears here`, {
      secretsEnvBody: `export WEIRD_KEY=${escaped}`
    });
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });
});

describe("buildCrashReport redaction", () => {
  test("redacts secrets in error.message/stack and logTail, keeps fingerprint stable, drops raw data", () => {
    // An error whose message + stack embed a fake OpenAI token, a gh token, a
    // bearer/authorization header, and a literal secrets-env value. None may
    // survive into the built report.
    const literalSecret = "hunter2-literal-value";
    const err = new Error(
      `boom sk-abcdefghijklmnop1234 and ${literalSecret}`
    );
    err.stack = [
      "Error: boom sk-abcdefghijklmnop1234",
      "  Authorization: Bearer xyztoken123456",
      `  token ghp_0123456789abcdefghijklmnopqrstuv leaked ${literalSecret}`,
      "  at handler (/Users/x/server.ts:1:1)"
    ].join("\n");

    const report = buildCrashReport({
      instance: "test-inst",
      supervisor: "launchd",
      source: "runtime",
      error: err,
      logTail: [
        {
          at: "2026-05-29T00:00:00.000Z",
          message: "log gho_0123456789abcdefghijklmnopqrstuv",
          data: { secret: "raw payload bytes" }
        }
      ],
      sysInfo: SYS_INFO,
      clock: () => new Date("2026-05-29T00:00:02.000Z"),
      secretsEnvBody: `export OPENAI_API_KEY='${literalSecret}'\nFOO=bar`
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-abcdefghijklmnop1234");
    expect(serialized).not.toContain("ghp_0123456789abcdefghijklmnopqrstuv");
    expect(serialized).not.toContain("gho_0123456789abcdefghijklmnopqrstuv");
    expect(serialized).not.toContain("Bearer xyztoken123456");
    expect(serialized).not.toContain("xyztoken123456");
    expect(serialized).not.toContain(literalSecret);
    // The raw log `data` payload is dropped entirely.
    expect(serialized).not.toContain("raw payload bytes");
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("[redacted]");
    // Fingerprint is computed from the RAW error (sha256) and stays stable —
    // redaction of the human-readable fields doesn't perturb it.
    expect(report.fingerprint).toBe(fingerprint(err));
  });

  test("a built + written pending report carries no secret bytes on disk", () => {
    const prevStateRoot = process.env.GINI_STATE_ROOT;
    const stateRoot = `/tmp/gini-crash-redact-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    process.env.GINI_STATE_ROOT = stateRoot;
    try {
      const literalSecret = "literal-disk-secret-77";
      const nameSecret = "ghp_0123456789abcdefghijklmnopqrstuv";
      const err = new Error(`disk sk-abcdefghijklmnop1234 ${literalSecret}`);
      // A secret embedded in error.name reaches the issue TITLE + body, so it
      // crosses the same trust boundary as message/stack and must be redacted.
      err.name = `Boom${nameSecret}`;
      err.stack = [
        "Error: disk",
        "  Authorization: Basic dXNlcjpwYXNzd29yZA==",
        "  ghp_0123456789abcdefghijklmnopqrstuv"
      ].join("\n");
      const report = buildCrashReport({
        instance: "test-inst",
        supervisor: "launchd",
        source: "runtime",
        error: err,
        logTail: [{ at: "2026-05-29T00:00:00.000Z", message: "evt", data: { x: "raw" } }],
        sysInfo: SYS_INFO,
        clock: () => new Date("2026-05-29T00:00:00.000Z"),
        secretsEnvBody: `export OPENAI_API_KEY='${literalSecret}'`
      });
      // The redacted name no longer carries the secret token.
      expect(report.error.name).not.toContain(nameSecret);
      expect(report.error.name).toContain("[redacted]");
      const path = writeCrashReportFile(report);
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).not.toContain("sk-abcdefghijklmnop1234");
      expect(onDisk).not.toContain("ghp_0123456789abcdefghijklmnopqrstuv");
      expect(onDisk).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(onDisk).not.toContain(literalSecret);
      expect(onDisk).not.toContain("raw");
      expect(onDisk).toContain("[redacted]");
    } finally {
      if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = prevStateRoot;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test("a non-string log/error field does NOT throw and still produces a written report", () => {
    const prevStateRoot = process.env.GINI_STATE_ROOT;
    const stateRoot = `/tmp/gini-crash-nonstring-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    process.env.GINI_STATE_ROOT = stateRoot;
    try {
      // A malformed `{ "message": 123 }` tail line must not make redaction call
      // .replace on a number and throw, which would otherwise drop the whole
      // report. redactReportText now passes any non-string through untouched.
      let report: ReturnType<typeof buildCrashReport> | undefined;
      expect(() => {
        report = buildCrashReport({
          instance: "test-inst",
          supervisor: "launchd",
          source: "runtime",
          error: new Error("boom"),
          logTail: [
            { at: "2026-05-29T00:00:00.000Z", message: 123 as unknown as string },
            { at: "2026-05-29T00:00:01.000Z", message: "ok-string" }
          ],
          sysInfo: SYS_INFO,
          clock: () => new Date("2026-05-29T00:00:02.000Z")
        });
      }).not.toThrow();
      // The non-string message passes through untouched; the string one survives.
      expect(report!.logTail[0]!.message).toBe(123 as unknown as string);
      expect(report!.logTail[1]!.message).toBe("ok-string");
      // The report still writes to the pending queue.
      const path = writeCrashReportFile(report!);
      expect(existsSync(path)).toBe(true);
    } finally {
      if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = prevStateRoot;
      rmSync(stateRoot, { recursive: true, force: true });
    }
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

  function buildReport(error: unknown): ReturnType<typeof buildCrashReport> {
    return buildCrashReport({
      instance: "test-inst",
      supervisor: "launchd",
      source: "runtime",
      error,
      logTail: [],
      sysInfo: SYS_INFO,
      clock: () => new Date("2026-05-29T00:00:00.000Z")
    });
  }

  test("writeCrashReportFile lands under <stateRoot>/crash-reports/pending/", () => {
    const report = buildReport(new Error("disk-write"));
    const path = writeCrashReportFile(report);
    expect(path.startsWith(pendingCrashReportsDir())).toBe(true);
    expect(pendingCrashReportsDir()).toBe(join(stateRoot, "crash-reports", "pending"));
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.fingerprint).toBe(report.fingerprint);
  });

  test("listPendingReports reads queued reports and skips unparseable files", () => {
    const a = writeCrashReportFile(buildReport(new Error("alpha")));
    const b = writeCrashReportFile(buildReport(new Error("beta")));
    // A corrupt/half-written report and a non-json file must not break the read.
    writeFileSync(join(pendingCrashReportsDir(), "garbage.json"), "{not json");
    writeFileSync(join(pendingCrashReportsDir(), "ignore.txt"), "{}");
    const pending = listPendingReports();
    expect(pending.map((p) => p.path).sort()).toEqual([a, b].sort());
    const messages = pending.map((p) => p.report.error.message).sort();
    expect(messages).toEqual(["alpha", "beta"]);
  });

  test("listPendingReports returns [] when the queue dir is absent", () => {
    expect(listPendingReports()).toEqual([]);
  });

  test("resolvePendingReport moves a report into filed/ or dismissed/", () => {
    const filed = writeCrashReportFile(buildReport(new Error("file-me")));
    const dismissed = writeCrashReportFile(buildReport(new Error("drop-me")));

    const filedDest = resolvePendingReport(filed, "filed");
    expect(filedDest.startsWith(filedCrashReportsDir())).toBe(true);
    expect(basename(filedDest)).toBe(basename(filed));
    expect(existsSync(filed)).toBe(false);
    expect(existsSync(filedDest)).toBe(true);

    const dismissedDest = resolvePendingReport(dismissed, "dismissed");
    expect(dismissedDest.startsWith(dismissedCrashReportsDir())).toBe(true);
    expect(existsSync(dismissed)).toBe(false);
    expect(existsSync(dismissedDest)).toBe(true);

    // Both moves leave the pending queue empty.
    expect(listPendingReports()).toEqual([]);
  });

  test("rate-limit state round-trips (incl. lastAskedAt) and defaults cleanly", () => {
    const fp = "deadbeef";
    expect(readRateLimitState(fp)).toEqual({
      lastFiledAt: null,
      lastCommentAt: null,
      commentCount: 0,
      lastAskedAt: null
    });
    writeRateLimitState(fp, {
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: "2026-05-29T01:00:00.000Z",
      commentCount: 3,
      lastAskedAt: "2026-05-29T02:00:00.000Z"
    });
    expect(readRateLimitState(fp)).toEqual({
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: "2026-05-29T01:00:00.000Z",
      commentCount: 3,
      lastAskedAt: "2026-05-29T02:00:00.000Z"
    });
    expect(crashReportsDir()).toBe(join(stateRoot, "crash-reports"));
  });

  test("markAsked stamps lastAskedAt and wasAskedRecently honors the window", () => {
    const fp = "feedface";
    const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
    const windowMs = 24 * 60 * 60 * 1000;
    // Never asked -> not recent.
    expect(wasAskedRecently(fp, nowMs, windowMs)).toBe(false);

    markAsked(fp, "2026-05-29T11:00:00.000Z");
    expect(readRateLimitState(fp).lastAskedAt).toBe("2026-05-29T11:00:00.000Z");
    // 1h ago, inside a 24h window -> recent.
    expect(wasAskedRecently(fp, nowMs, windowMs)).toBe(true);
    // Same stamp, but 25h later -> outside the window -> not recent.
    expect(wasAskedRecently(fp, nowMs + 25 * 60 * 60 * 1000, windowMs)).toBe(false);
  });

  test("markAsked preserves the rest of the rate-limit state", () => {
    const fp = "cafebabe";
    writeRateLimitState(fp, {
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: null,
      commentCount: 2,
      lastAskedAt: null,
      issueNumber: 42
    });
    markAsked(fp, "2026-05-29T03:00:00.000Z");
    expect(readRateLimitState(fp)).toEqual({
      lastFiledAt: "2026-05-29T00:00:00.000Z",
      lastCommentAt: null,
      commentCount: 2,
      lastAskedAt: "2026-05-29T03:00:00.000Z",
      issueNumber: 42
    });
  });
});
