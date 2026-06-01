// Tests for maybeAskAboutCrashes (the restart-ask glue). We inject a recorder
// createJobImpl + supervisorImpl + clock so no real job is dispatched and no
// model turn runs. Pending reports are seeded via writeCrashReportFile into a
// unique GINI_STATE_ROOT under /tmp; markAsked/wasAskedRecently/listPending run
// for real against that temp root so ask-once + filtering are exercised
// end-to-end. The `default` instance is never touched — all asserts use the
// injected recorder, not real launchctl/jobs/state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { maybeAskAboutCrashes } from "./crash-recovery";
import {
  buildCrashReport,
  listPendingReports,
  readRateLimitState,
  writeCrashReportFile,
  type CrashSysInfo
} from "./crash-report";
import type { RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

const SYS_INFO: CrashSysInfo = {
  platform: "darwin",
  arch: "arm64",
  nodeVersion: "v22.0.0"
};

const FIXED_NOW = new Date("2026-05-29T12:00:00.000Z");

// Minimal config; only `instance` is read by maybeAskAboutCrashes.
function configFor(instance: string): RuntimeConfig {
  return { instance } as RuntimeConfig;
}

interface CreateJobCall {
  config: RuntimeConfig;
  input: Record<string, unknown>;
}

// A recorder that stands in for createScheduledJob — records the call and
// returns a stub so nothing is dispatched and no model turn runs.
function makeRecorder(): {
  impl: (config: RuntimeConfig, input: Record<string, unknown>) => Promise<unknown>;
  calls: CreateJobCall[];
} {
  const calls: CreateJobCall[] = [];
  const impl = async (config: RuntimeConfig, input: Record<string, unknown>) => {
    calls.push({ config, input });
    return { id: "job-stub" };
  };
  return { impl, calls };
}

// Seed a pending crash report for the given instance with a controllable
// fingerprint (driven by the error message).
function seedPending(instance: string, message: string): void {
  const report = buildCrashReport({
    instance,
    supervisor: "launchd",
    source: "runtime",
    error: new Error(message),
    logTail: [],
    sysInfo: SYS_INFO,
    clock: () => FIXED_NOW
  });
  writeCrashReportFile(report);
}

describe("maybeAskAboutCrashes", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    stateRoot = `/tmp/gini-crash-recovery-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test("batches distinct fingerprints into ONE ask, stamps lastAskedAt, mentions the skill + count", async () => {
    // Two reports of the SAME fingerprint (same message) + one DISTINCT one.
    seedPending("default", "boom");
    seedPending("default", "boom");
    seedPending("default", "different");

    // The two distinct fingerprints actually queued (read off disk so we
    // compare against the exact fingerprints the reports carry, not a freshly
    // constructed Error whose stack — and thus fingerprint — would differ).
    const distinctFingerprints = [
      ...new Set(listPendingReports().map((p) => p.report.fingerprint))
    ];
    expect(distinctFingerprints.length).toBe(2);

    const { impl: createJobImpl, calls } = makeRecorder();
    await maybeAskAboutCrashes(configFor("default"), {
      createJobImpl,
      supervisorImpl: () => "launchd",
      clock: () => FIXED_NOW
    });

    // Exactly one job, batching both distinct fingerprints.
    expect(calls.length).toBe(1);
    const input = calls[0]!.input;
    expect(input.name).toBe("crash-report-consent");
    expect(input.oneShot).toBe(true);
    expect(input.intervalSeconds).toBe(2);
    expect(input.timeoutSeconds).toBe(120);
    expect(input.createDedicatedSession).toEqual({ title: "Crash report" });
    const prompt = String(input.prompt);
    // 2 distinct fingerprints -> count of 2 in the prompt.
    expect(prompt).toContain("2 crashes");
    expect(prompt).toContain("gini-bug-report skill");
    // The consent is scoped to the exact batch: the FULL fingerprints must
    // appear so the skill can match exactly (an 8-char prefix could misattribute
    // a later same-prefix crash to this consent).
    for (const fp of distinctFingerprints) {
      expect(prompt).toContain(fp);
      // A full sha256 fingerprint is 64 hex chars; pin we're not slicing.
      expect(fp.length).toBe(64);
    }

    // lastAskedAt stamped for each fresh (distinct) fingerprint.
    for (const fp of distinctFingerprints) {
      expect(readRateLimitState(fp).lastAskedAt).toBe(FIXED_NOW.toISOString());
    }
  });

  test("a second call (simulated respawn) does NOT re-ask (ask-once within the window)", async () => {
    seedPending("default", "boom");

    const first = makeRecorder();
    await maybeAskAboutCrashes(configFor("default"), {
      createJobImpl: first.impl,
      supervisorImpl: () => "launchd",
      clock: () => FIXED_NOW
    });
    expect(first.calls.length).toBe(1);

    // The report is still in pending/ (filing only happens on consent). A
    // respawn 1 minute later must NOT produce a second ask.
    const later = new Date(FIXED_NOW.getTime() + 60_000);
    const second = makeRecorder();
    await maybeAskAboutCrashes(configFor("default"), {
      createJobImpl: second.impl,
      supervisorImpl: () => "launchd",
      clock: () => later
    });
    expect(second.calls.length).toBe(0);
  });

  test("non-default instance -> no ask", async () => {
    seedPending("chengdu-v1", "boom");
    const { impl: createJobImpl, calls } = makeRecorder();
    await maybeAskAboutCrashes(configFor("chengdu-v1"), {
      createJobImpl,
      supervisorImpl: () => "launchd",
      clock: () => FIXED_NOW
    });
    expect(calls.length).toBe(0);
  });

  test("not under launchd -> no ask", async () => {
    seedPending("default", "boom");
    const { impl: createJobImpl, calls } = makeRecorder();
    await maybeAskAboutCrashes(configFor("default"), {
      createJobImpl,
      supervisorImpl: () => null,
      clock: () => FIXED_NOW
    });
    expect(calls.length).toBe(0);
  });

  test("a pending report from a different instance is filtered out", async () => {
    // Only a foreign-instance report is queued; the default has nothing of its
    // own to ask about.
    seedPending("some-other-instance", "boom");
    const { impl: createJobImpl, calls } = makeRecorder();
    await maybeAskAboutCrashes(configFor("default"), {
      createJobImpl,
      supervisorImpl: () => "launchd",
      clock: () => FIXED_NOW
    });
    expect(calls.length).toBe(0);
  });
});
