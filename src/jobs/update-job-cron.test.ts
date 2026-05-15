// updateJob schedule-mode transitions. The four directions are:
//   - interval -> interval (just change the interval)
//   - cron     -> cron     (change expression and/or timezone)
//   - interval -> cron     (set cronExpression, clear interval sentinel)
//   - cron     -> interval (clear cron, set positive intervalSeconds)
// Plus the mutual-exclusion guard: a single patch may not set BOTH a
// positive intervalSeconds AND a cronExpression.
//
// These tests live alongside the other jobs/* tests because src/jobs.test.ts
// already covers a wide surface (jobs.test.ts has no updateJob coverage today),
// and the cron edges are a tightly scoped slice better isolated here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import { createScheduledJob, updateJob } from "./index";
import type { RuntimeConfig } from "../types";

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-update-cron-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-update-cron-test-logs"
  };
}

describe("updateJob schedule-mode transitions", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-update-cron-"));
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

  test("interval -> interval (change interval, recompute nextRunAt)", async () => {
    const config = buildConfig("update-interval-interval");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });
    expect(created.intervalSeconds).toBe(60);
    const before = Date.now();
    const updated = await updateJob(config, created.id, { intervalSeconds: 300 });
    expect(updated.intervalSeconds).toBe(300);
    expect(updated.cronExpression).toBeUndefined();
    expect(updated.cronTimezone).toBeUndefined();
    const nextMs = new Date(updated.nextRunAt).getTime();
    // nextRunAt should be ~now + 300s (allow generous drift).
    expect(nextMs - before).toBeGreaterThanOrEqual(300 * 1000 - 2000);
    expect(nextMs - before).toBeLessThanOrEqual(300 * 1000 + 2000);
  });

  test("cron -> cron (change cron expression, recompute nextRunAt via croner)", async () => {
    const config = buildConfig("update-cron-cron-expr");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });
    expect(created.cronExpression).toBe("0 9 * * *");

    const before = Date.now();
    const updated = await updateJob(config, created.id, { cronExpression: "0 17 * * *" });
    expect(updated.cronExpression).toBe("0 17 * * *");
    // Timezone preserved when not specified in patch.
    expect(updated.cronTimezone).toBe("UTC");
    // Cron sentinel preserved.
    expect(updated.intervalSeconds).toBe(0);
    // nextRunAt should match what croner says for the new expression/TZ.
    const expected = new Cron("0 17 * * *", { timezone: "UTC" }).nextRun(new Date(before));
    expect(expected).not.toBeNull();
    const nextMs = new Date(updated.nextRunAt).getTime();
    expect(Math.abs(nextMs - expected!.getTime())).toBeLessThanOrEqual(1000);
  });

  test("cron -> cron timezone-only update on an already-cron job", async () => {
    const config = buildConfig("update-cron-tz-only");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });

    const updated = await updateJob(config, created.id, {
      cronTimezone: "America/Los_Angeles"
    });
    expect(updated.cronExpression).toBe("0 9 * * *");
    expect(updated.cronTimezone).toBe("America/Los_Angeles");
    // 09:00 LA is UTC hour 16 (PDT) or 17 (PST) — never 9.
    const utcHour = new Date(updated.nextRunAt).getUTCHours();
    expect([16, 17]).toContain(utcHour);
  });

  test("interval -> cron (set cronExpression with intervalSeconds: null, sentinel applied)", async () => {
    const config = buildConfig("update-interval-to-cron");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });
    expect(created.cronExpression).toBeUndefined();

    const updated = await updateJob(config, created.id, {
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
      intervalSeconds: null
    });
    expect(updated.cronExpression).toBe("0 9 * * *");
    expect(updated.cronTimezone).toBe("UTC");
    // The cron-driven sentinel.
    expect(updated.intervalSeconds).toBe(0);
    // nextRunAt should be a real cron-matched future moment, not now + 60s.
    const expected = new Cron("0 9 * * *", { timezone: "UTC" }).nextRun(new Date());
    expect(expected).not.toBeNull();
    const nextMs = new Date(updated.nextRunAt).getTime();
    expect(Math.abs(nextMs - expected!.getTime())).toBeLessThanOrEqual(2000);
  });

  test("interval -> cron without explicit intervalSeconds: null still coerces sentinel", async () => {
    // A polite caller can patch just `cronExpression` and trust the runtime
    // to coerce intervalSeconds to the 0 sentinel.
    const config = buildConfig("update-interval-to-cron-implicit");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });

    const updated = await updateJob(config, created.id, {
      cronExpression: "0 9 * * *"
    });
    expect(updated.cronExpression).toBe("0 9 * * *");
    expect(updated.cronTimezone).toBe("UTC"); // default
    expect(updated.intervalSeconds).toBe(0);
  });

  test("cron -> interval (clear cron with cronExpression: null + positive intervalSeconds)", async () => {
    const config = buildConfig("update-cron-to-interval");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });

    const before = Date.now();
    const updated = await updateJob(config, created.id, {
      cronExpression: null,
      cronTimezone: null,
      intervalSeconds: 120
    });
    expect(updated.cronExpression).toBeUndefined();
    expect(updated.cronTimezone).toBeUndefined();
    expect(updated.intervalSeconds).toBe(120);
    // nextRunAt = now + 120s (drift envelope).
    const nextMs = new Date(updated.nextRunAt).getTime();
    expect(nextMs - before).toBeGreaterThanOrEqual(120 * 1000 - 2000);
    expect(nextMs - before).toBeLessThanOrEqual(120 * 1000 + 2000);
  });

  test("cron -> interval implicit: positive intervalSeconds alone clears cron", async () => {
    // Symmetric convenience: the UI sends `{ intervalSeconds: 120 }` and the
    // runtime infers "you want interval mode now" because the existing job
    // was cron-driven.
    const config = buildConfig("update-cron-to-interval-implicit");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });

    const updated = await updateJob(config, created.id, { intervalSeconds: 120 });
    expect(updated.cronExpression).toBeUndefined();
    expect(updated.cronTimezone).toBeUndefined();
    expect(updated.intervalSeconds).toBe(120);
  });

  test("rejects when patch sets both positive intervalSeconds AND cronExpression", async () => {
    const config = buildConfig("update-reject-both");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });

    await expect(
      updateJob(config, created.id, {
        intervalSeconds: 30,
        cronExpression: "0 9 * * *"
      })
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects timezone-only patch when job is interval-driven", async () => {
    const config = buildConfig("update-reject-tz-on-interval");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });

    await expect(
      updateJob(config, created.id, { cronTimezone: "America/Los_Angeles" })
    ).rejects.toThrow(/cronTimezone may only be set when cronExpression is set/);
  });

  test("rejects malformed cronExpression on update", async () => {
    const config = buildConfig("update-reject-malformed");
    const created = await createScheduledJob(config, {
      name: "watch",
      prompt: "x",
      intervalSeconds: 60
    });

    await expect(
      updateJob(config, created.id, { cronExpression: "totally not cron" })
    ).rejects.toThrow(/Invalid input: cronExpression/);
  });

  test("rejects unknown cronTimezone on update", async () => {
    const config = buildConfig("update-reject-bad-tz");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });

    await expect(
      updateJob(config, created.id, { cronTimezone: "Mars/Phobos" })
    ).rejects.toThrow(/Invalid input: cronTimezone/);
  });

  test("rejects cronExpression: null on a cron job without a replacement intervalSeconds", async () => {
    const config = buildConfig("update-reject-clear-cron-without-interval");
    const created = await createScheduledJob(config, {
      name: "daily",
      prompt: "x",
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC"
    });

    await expect(
      updateJob(config, created.id, { cronExpression: null })
    ).rejects.toThrow(/clearing cronExpression requires a positive intervalSeconds/);
  });
});
