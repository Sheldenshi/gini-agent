// Tests for `gini report-crash`. Every gh call goes through an injected fake
// GhRunner — no real `gh`, no network, no GitHub issue is ever created. The
// supervisor gate, gh-auth check, and clock are injected; report + state files
// live under a unique GINI_STATE_ROOT in /tmp.
//
// Coverage:
//   - not-launchd -> gh never touched
//   - gh unauthed -> graceful no-op, no create/comment
//   - no open issue -> issue create with marker + label, state written
//   - open issue + within budget -> comment (not create)
//   - open issue + <1h since last comment -> suppressed
//   - open issue + comment cap reached -> suppressed
//   - redaction: a literal secret in the stack never reaches the issue body

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportCrash } from "./report-crash";
import type { CliContext } from "../context";
import type { GhResult, GhRunner } from "../../integrations/github-issues";
import {
  buildCrashReport,
  writeRateLimitState,
  readRateLimitState,
  type CrashReport
} from "../../runtime/crash-report";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

interface FakeCall {
  args: string[];
  input?: string;
}

const isIssue = (verb: string) => (c: FakeCall) => c.args[0] === "issue" && c.args[1] === verb;

// Scriptable fake: maps a matcher on the gh subcommand to a canned result.
function makeGh(handlers: {
  authOk?: boolean;
  listResult?: GhResult;
  createResult?: GhResult;
  commentResult?: GhResult;
}): { gh: GhRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const ok = (stdout = ""): GhResult => ({ ok: true, stdout, stderr: "", status: 0 });
  const gh: GhRunner = {
    run(args, opts) {
      calls.push({ args, input: opts?.input });
      if (args[0] === "auth") {
        return handlers.authOk === false
          ? { ok: false, stdout: "", stderr: "not logged in", status: 1 }
          : ok("Logged in");
      }
      if (args[0] === "label") return ok();
      if (args[0] === "issue" && args[1] === "list") return handlers.listResult ?? ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        return handlers.createResult ?? ok("https://github.com/Lilac-Labs/gini-agent/issues/42\n");
      }
      if (args[0] === "issue" && args[1] === "comment") return handlers.commentResult ?? ok();
      return ok();
    }
  };
  return { gh, calls };
}

function makeReport(overrides: Partial<Parameters<typeof buildCrashReport>[0]> = {}): CrashReport {
  return buildCrashReport({
    instance: "test-inst",
    supervisor: "launchd",
    source: "runtime",
    error: new Error("kaboom"),
    logTail: [],
    sysInfo: { platform: "darwin", arch: "arm64", nodeVersion: "v22.0.0" },
    clock: () => new Date("2026-05-29T00:00:00.000Z"),
    ...overrides
  });
}

describe("reportCrash", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;
  let reportPath: string;

  function writeReport(report: CrashReport): void {
    reportPath = join(stateRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
  }

  function ctxFor(): CliContext {
    return {
      config: { instance: "test-inst" } as CliContext["config"],
      cliArgs: ["report-crash", "--report", reportPath],
      command: "report-crash",
      ephemeralSmoke: false,
      explicitInstance: true,
      rawArgs: ["report-crash", "--instance", "test-inst", "--report", reportPath],
      web: { webPort: 0, webPortPinned: false, noWeb: true, runtimePortPinned: false }
    };
  }

  beforeEach(() => {
    stateRoot = `/tmp/gini-report-crash-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    mkdirSync(stateRoot, { recursive: true });
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test("not under launchd -> gh is never called", async () => {
    writeReport(makeReport());
    const { gh, calls } = makeGh({});
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => null });
    expect(calls.length).toBe(0);
  });

  test("gh unauthenticated -> no create or comment", async () => {
    writeReport(makeReport());
    const { gh, calls } = makeGh({ authOk: false });
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd" });
    expect(calls.some(isIssue("create"))).toBe(false);
    expect(calls.some(isIssue("comment"))).toBe(false);
  });

  test("no open issue -> creates issue with marker + label, writes state", async () => {
    const report = makeReport();
    writeReport(report);
    const { gh, calls } = makeGh({});
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    const create = calls.find(isIssue("create"));
    expect(create).toBeDefined();
    expect(create!.args).toContain("--label");
    expect(create!.args).toContain("gini-crash");
    expect(create!.input).toContain(`gini-crash-fingerprint: ${report.fingerprint}`);
    expect(calls.some(isIssue("comment"))).toBe(false);
    const state = readRateLimitState(report.fingerprint);
    expect(state.lastFiledAt).toBe("2026-05-29T10:00:00.000Z");
    expect(state.commentCount).toBe(0);
  });

  test("open issue within budget -> comments, does not create", async () => {
    const report = makeReport();
    writeReport(report);
    const marker = `<!-- gini-crash-fingerprint: ${report.fingerprint} -->`;
    const listJson = JSON.stringify([{ number: 7, body: `existing body\n${marker}` }]);
    const { gh, calls } = makeGh({ listResult: { ok: true, stdout: listJson, stderr: "", status: 0 } });
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    expect(calls.some(isIssue("create"))).toBe(false);
    const comment = calls.find(isIssue("comment"));
    expect(comment).toBeDefined();
    expect(comment!.args).toContain("7");
    const state = readRateLimitState(report.fingerprint);
    expect(state.commentCount).toBe(1);
    expect(state.lastCommentAt).toBe("2026-05-29T10:00:00.000Z");
  });

  test("open issue but <1h since last comment -> suppressed", async () => {
    const report = makeReport();
    writeReport(report);
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: "2026-05-29T09:00:00.000Z",
      lastCommentAt: "2026-05-29T09:30:00.000Z",
      commentCount: 1
    });
    const marker = `<!-- gini-crash-fingerprint: ${report.fingerprint} -->`;
    const listJson = JSON.stringify([{ number: 7, body: marker }]);
    const { gh, calls } = makeGh({ listResult: { ok: true, stdout: listJson, stderr: "", status: 0 } });
    // 10:00 is only 30 min after the 09:30 last comment.
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    expect(calls.some(isIssue("comment"))).toBe(false);
    expect(readRateLimitState(report.fingerprint).commentCount).toBe(1);
  });

  test("open issue but comment cap reached -> suppressed", async () => {
    const report = makeReport();
    writeReport(report);
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: "2026-05-01T00:00:00.000Z",
      lastCommentAt: "2026-05-01T00:00:00.000Z",
      commentCount: 20
    });
    const marker = `<!-- gini-crash-fingerprint: ${report.fingerprint} -->`;
    const listJson = JSON.stringify([{ number: 7, body: marker }]);
    const { gh, calls } = makeGh({ listResult: { ok: true, stdout: listJson, stderr: "", status: 0 } });
    // Far past the 1h window, but the hard cap should still suppress.
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-06-01T00:00:00.000Z") });
    expect(calls.some(isIssue("comment"))).toBe(false);
    expect(readRateLimitState(report.fingerprint).commentCount).toBe(20);
  });

  test("literal secret in the stack is redacted out of the issue body", async () => {
    const err = new Error("connect failed");
    err.stack = "Error: connect failed\n    at f (/a/b.ts:1:1) token sk-abcdefghijklmnop1234 here";
    const report = makeReport({ error: err });
    writeReport(report);
    const { gh, calls } = makeGh({});
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd" });
    const create = calls.find(isIssue("create"));
    expect(create).toBeDefined();
    expect(create!.input).not.toContain("sk-abcdefghijklmnop1234");
    expect(create!.input).toContain("[redacted]");
  });

  test("a secret in the error message is redacted out of the issue TITLE", async () => {
    // The title is built from error.name/message — it must be redacted too,
    // not just the body. A leaked token in the title would be plainly visible
    // on the issue list.
    const err = new Error("auth failed for sk-titleleak0123456789abcd token");
    const report = makeReport({ error: err });
    writeReport(report);
    const { gh, calls } = makeGh({});
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd" });
    const create = calls.find(isIssue("create"));
    expect(create).toBeDefined();
    const titleIdx = create!.args.indexOf("--title");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    const title = create!.args[titleIdx + 1]!;
    expect(title).not.toContain("sk-titleleak0123456789abcd");
    expect(title).toContain("[redacted]");
  });

  test("known issueNumber in state -> comments WITHOUT searching", async () => {
    const report = makeReport();
    writeReport(report);
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: "2026-05-29T09:00:00.000Z",
      lastCommentAt: null,
      commentCount: 0,
      issueNumber: 13
    });
    const { gh, calls } = makeGh({});
    // 10:00 is >1h after the last (null) comment; comment proceeds.
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    // No search and no create — we went straight to the known issue.
    expect(calls.some(isIssue("list"))).toBe(false);
    expect(calls.some(isIssue("create"))).toBe(false);
    const comment = calls.find(isIssue("comment"));
    expect(comment).toBeDefined();
    expect(comment!.args).toContain("13");
    const state = readRateLimitState(report.fingerprint);
    expect(state.issueNumber).toBe(13);
    expect(state.commentCount).toBe(1);
  });

  test("absent + recent lastFiledAt -> suppressed (no duplicate create during a loop)", async () => {
    const report = makeReport();
    writeReport(report);
    // Filed 30 min ago; the just-created issue may not be indexed yet, so the
    // search returns absent. We must NOT create a second issue.
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: "2026-05-29T09:30:00.000Z",
      lastCommentAt: null,
      commentCount: 0
    });
    const { gh, calls } = makeGh({ listResult: { ok: true, stdout: "[]", stderr: "", status: 0 } });
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    expect(calls.some(isIssue("create"))).toBe(false);
  });

  test("lookup error during a crash loop does NOT create a second issue", async () => {
    const report = makeReport();
    writeReport(report);
    // We filed an issue moments ago. The next crash's `gh issue list` fails
    // (rate limit / transient). A failed lookup is not 'absent' — creating
    // here would spawn a duplicate. Suppress instead.
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: "2026-05-29T09:59:30.000Z",
      lastCommentAt: null,
      commentCount: 0
    });
    const { gh, calls } = makeGh({ listResult: { ok: false, stdout: "", stderr: "API rate limit", status: 1 } });
    await reportCrash(ctxFor(), { gh, supervisorImpl: () => "launchd", clock: () => new Date("2026-05-29T10:00:00.000Z") });
    expect(calls.some(isIssue("create"))).toBe(false);
    expect(calls.some(isIssue("comment"))).toBe(false);
  });
});
