// Cron-driven scheduling tests. Covers:
//   - createScheduledJob accepts a 5-field Unix cron expression + IANA
//     timezone and anchors `nextRunAt` to the next cron-matched moment.
//   - per-job IANA timezone resolves "09:00 America/Los_Angeles" to the
//     correct UTC instant (different day across the dateline when relevant).
//   - DST spring-forward boundary: nextRunAt for "0 9 * * *" in
//     America/Los_Angeles advances across the missing 02:00 local hour
//     without skipping a fire (croner owns the DST math; this test is a
//     smoke check that our scheduler integration relays it correctly).
//   - Mutual-exclusion validation: intervalSeconds + cronExpression rejected.
//   - cronTimezone without cronExpression rejected (timezone alone is
//     meaningless on an interval job).
//   - Malformed cron expressions and IANA timezones surface as typed
//     `Invalid input: …` errors.
//   - End-to-end: runDueJobs with a fixed-past nextRunAt fires the
//     cron-driven job and advances nextRunAt to the next cron-matched moment.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import { createScheduledJob, runDueJobs } from "./index";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-cron-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-cron-test-logs"
  };
}

describe("createScheduledJob cron + timezone", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-cron-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
  });

  test("daily 09:00 UTC anchors nextRunAt to the next 09:00 UTC", async () => {
    const config = buildConfig("cron-daily-utc");
    const before = Date.now();
    const job = await createScheduledJob(config, {
      name: "daily-utc",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });
    expect(job.cronExpression).toBe("0 9 * * *");
    expect(job.cronTimezone).toBe("UTC");
    // Cron-driven jobs store intervalSeconds=0 as the "not driven by
    // interval" sentinel.
    expect(job.intervalSeconds).toBe(0);

    const nextMs = new Date(job.nextRunAt).getTime();
    expect(nextMs).toBeGreaterThan(before);
    // Independently compute what croner would say given the same expr/tz.
    const expected = new Cron("0 9 * * *", { timezone: "UTC" }).nextRun(new Date(before));
    expect(expected).not.toBeNull();
    // Allow a small drift envelope — `before` was captured a few ms before
    // createScheduledJob ran, and croner strips milliseconds.
    expect(Math.abs(nextMs - expected!.getTime())).toBeLessThanOrEqual(1000);
  });

  test("daily 09:00 cronTimezone=America/Los_Angeles resolves to LA's wall clock", async () => {
    // Pick a moment where UTC and LA are on different calendar days:
    // 06:00 UTC = 22:00 PST (previous day) / 23:00 PDT. Either way, "next
    // 09:00 LA" resolves to a UTC instant where the UTC hour is NOT 9.
    const config = buildConfig("cron-daily-la");

    const job = await createScheduledJob(config, {
      name: "daily-la",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "America/Los_Angeles"
    });
    expect(job.cronTimezone).toBe("America/Los_Angeles");

    const nextMs = new Date(job.nextRunAt).getTime();
    // The UTC hour of the resolved instant must be 16 (PDT, UTC-7) or 17
    // (PST, UTC-8) — never 9. This is the whole point of the timezone
    // field: anchor to wall-clock LA, not wall-clock UTC.
    const utcHour = new Date(nextMs).getUTCHours();
    expect([16, 17]).toContain(utcHour);
  });

  test("DST spring-forward in America/Los_Angeles still produces a daily fire", async () => {
    // 2026 US spring-forward is 2026-03-08: at 02:00 PST the clock jumps
    // to 03:00 PDT. Croner handles this natively. We pick a `start` just
    // BEFORE 09:00 PST on 2026-03-07 so the two subsequent fires straddle
    // the boundary: next1 = 2026-03-07 09:00 PST, next2 = 2026-03-08 09:00
    // PDT. In UTC the gap is 23 hours because PST -> PDT loses an hour;
    // this is the canonical DST smoke test.
    const cron = new Cron("0 9 * * *", { timezone: "America/Los_Angeles" });
    const start = new Date("2026-03-07T08:59:00-08:00"); // 1 minute before first 9am PST
    const next1 = cron.nextRun(start);
    expect(next1).not.toBeNull();
    const next2 = cron.nextRun(next1!);
    expect(next2).not.toBeNull();
    const deltaMs = next2!.getTime() - next1!.getTime();
    expect(deltaMs).toBe(23 * 3600 * 1000);

    // Wire the same expression through createScheduledJob and confirm
    // its nextRunAt anchors to a 09:00-LA instant (UTC hour 16 or 17).
    const config = buildConfig("cron-dst-spring");
    const job = await createScheduledJob(config, {
      name: "dst-spring",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "America/Los_Angeles"
    });
    const utcHour = new Date(job.nextRunAt).getUTCHours();
    expect([16, 17]).toContain(utcHour);
  });

  test("rejects when both intervalSeconds and cronExpression are explicitly given", async () => {
    const config = buildConfig("cron-reject-both");
    await expect(
      createScheduledJob(config, {
        name: "both",
        prompt: "x",
        intervalSeconds: 60,
        cronExpression: "0 9 * * *"
      })
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects malformed cronExpression", async () => {
    const config = buildConfig("cron-reject-malformed");
    // Garbage tokens.
    await expect(
      createScheduledJob(config, {
        name: "bad",
        prompt: "x",
        cronExpression: "foo bar baz qux quux"
      })
    ).rejects.toThrow(/Invalid input: cronExpression/);
    // Wrong field count — croner's auto mode rejects 4-part as ambiguous.
    await expect(
      createScheduledJob(config, {
        name: "bad",
        prompt: "x",
        cronExpression: "* * * *"
      })
    ).rejects.toThrow(/Invalid input: cronExpression/);
    // Out-of-range value (1-9 is invalid for day-of-week, which is 0-6).
    await expect(
      createScheduledJob(config, {
        name: "bad",
        prompt: "x",
        cronExpression: "0 9 * * 1-9"
      })
    ).rejects.toThrow(/Invalid input: cronExpression/);
  });

  test("rejects malformed cronTimezone", async () => {
    const config = buildConfig("cron-reject-tz");
    await expect(
      createScheduledJob(config, {
        name: "badtz",
        prompt: "x",
        cronExpression: "0 9 * * *",
        cronTimezone: "Asia/Madeup"
      })
    ).rejects.toThrow(/Invalid input: cronTimezone/);
  });

  test("rejects cronTimezone without cronExpression", async () => {
    // A timezone alone is meaningless on an interval job — reject so the
    // payload's intent is unambiguous.
    const config = buildConfig("cron-reject-tz-alone");
    await expect(
      createScheduledJob(config, {
        name: "tz-alone",
        prompt: "x",
        intervalSeconds: 60,
        cronTimezone: "America/Los_Angeles"
      })
    ).rejects.toThrow(/cronTimezone may only be set when cronExpression is set/);
  });

  test("default cronTimezone is 'UTC' when cronExpression is set but cronTimezone is omitted", async () => {
    const config = buildConfig("cron-default-tz");
    const job = await createScheduledJob(config, {
      name: "default-tz",
      prompt: "x",
      cronExpression: "0 9 * * *"
    });
    expect(job.cronTimezone).toBe("UTC");
  });
});

describe("runDueJobs with a cron-driven job", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-cron-run-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
  });

  test("fires the cron job and advances nextRunAt to the next cron-matched moment", async () => {
    const config = buildConfig("cron-fires");

    // Use a script-driven cron job so the run completes synchronously
    // inside runDueJobs (no need to mock the chat agent). Hourly cron is
    // unambiguous; we force nextRunAt into the past so the scheduler
    // claims it immediately.
    const job = await createScheduledJob(config, {
      name: "hourly",
      prompt: "x",
      cronExpression: "0 * * * *",
      cronTimezone: "UTC",
      script: "echo cron"
    });
    expect(job.cronExpression).toBe("0 * * * *");

    // Anchor overdueAt to a known UTC-hour boundary so the missed-fire
    // count is deterministic regardless of wall-clock minute when this
    // test happens to run. Two whole hours in the past at minute=00 means
    // the cron walks: consume = (now's-2h):00 + 1h = (now-1h):00, next =
    // (now's hour):00 which is `≤ now` (because nowMs > thisHour:00), so
    // missed=1; subsequent next is (now+1h):00 which is `> now`, stop.
    const setupNow = Date.now();
    const nowDate = new Date(setupNow);
    const thisHourStartMs = Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate(),
      nowDate.getUTCHours(),
      0,
      0
    );
    const overdueAt = thisHourStartMs - 2 * 60 * 60 * 1000; // 2 hours before this UTC hour
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(overdueAt).toISOString();
    });

    await runDueJobs(config);

    const after = readState(config.instance);
    const runs = after.jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");

    const updated = after.jobs.find((candidate) => candidate.id === job.id)!;
    const newNextMs = new Date(updated.nextRunAt).getTime();
    // nextRunAt must be in the future and aligned to an hour boundary
    // (UTC), because the cron expression is "0 * * * *".
    expect(newNextMs).toBeGreaterThan(setupNow);
    const newNext = new Date(newNextMs);
    expect(newNext.getUTCMinutes()).toBe(0);
    expect(newNext.getUTCSeconds()).toBe(0);
    // consume = (this-hour - 1h):00. next-after-consume = (this-hour):00,
    // which is strictly less than `dateNow` (set inside runDueJobs after
    // we wrote overdueAt). So one extra fire was missed. The next-after
    // that is (this-hour + 1h):00 which is strictly in the future, so the
    // walk stops there. missedRuns increments by exactly 1.
    expect(updated.missedRuns).toBe(1);
  });
});
