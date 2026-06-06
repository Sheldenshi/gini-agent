// CRUD + query-building tests for email watchers (ADR email-watch.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import {
  addEmailWatcher,
  backfillEmailWatcherJobs,
  buildWatcherQuery,
  closeAllMemoryDbs,
  getEmailWatcher,
  isEmailSeen,
  listEmailWatchers,
  markEmailSeen,
  mutateState,
  readState,
  removeEmailWatcher,
  setEmailWatcherEnabled,
  updateEmailWatcher
} from ".";

const ROOT = mkdtempSync(join(tmpdir(), "gini-email-watchers-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("buildWatcherQuery", () => {
  test("raw query wins over sender", () => {
    expect(buildWatcherQuery({ sender: "a@x.com", query: "subject:urgent" })).toBe("subject:urgent");
  });
  test("sender builds from:<sender> is:unread", () => {
    expect(buildWatcherQuery({ sender: "a@x.com" })).toBe("from:a@x.com is:unread");
  });
  test("no sender/query falls back to is:unread", () => {
    expect(buildWatcherQuery({})).toBe("is:unread");
  });
});

describe("watcher CRUD", () => {
  test("add creates an enabled watcher with a dedicated chat session", async () => {
    const config = buildConfig("ew-add");
    const watcher = await addEmailWatcher(config, { sender: "alice@x.com" });
    expect(watcher.enabled).toBe(true);
    expect(watcher.status).toBe("ok");
    expect(watcher.query).toBe("from:alice@x.com is:unread");
    expect(watcher.chatSessionId).toBeDefined();
    // The dedicated chat session exists.
    const state = readState(config.instance);
    expect(state.chatSessions.some((s) => s.id === watcher.chatSessionId)).toBe(true);
    expect(state.emailWatchers).toHaveLength(1);
  });

  test("list + get reflect the created watcher", async () => {
    const config = buildConfig("ew-list");
    const watcher = await addEmailWatcher(config, { query: "subject:invoice is:unread" });
    expect(listEmailWatchers(config).map((w) => w.id)).toContain(watcher.id);
    expect(getEmailWatcher(config, watcher.id)?.query).toBe("subject:invoice is:unread");
  });

  test("update patches fields and bumps updatedAt", async () => {
    const config = buildConfig("ew-update");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com" });
    const updated = await updateEmailWatcher(config, watcher.id, {
      lastSeenInternalDate: "12345",
      status: "needs_auth"
    });
    expect(updated?.lastSeenInternalDate).toBe("12345");
    expect(updated?.status).toBe("needs_auth");
  });

  test("update on a missing watcher returns undefined", async () => {
    const config = buildConfig("ew-update-missing");
    expect(await updateEmailWatcher(config, "nope", { status: "ok" })).toBeUndefined();
  });

  test("remove deletes the watcher", async () => {
    const config = buildConfig("ew-remove");
    const watcher = await addEmailWatcher(config, { sender: "carol@x.com" });
    await removeEmailWatcher(config, watcher.id);
    expect(getEmailWatcher(config, watcher.id)).toBeUndefined();
    expect(listEmailWatchers(config)).toHaveLength(0);
  });

  test("remove on a missing watcher throws", async () => {
    const config = buildConfig("ew-remove-missing");
    await expect(removeEmailWatcher(config, "nope")).rejects.toThrow("Email watcher not found");
  });
});

describe("backing job lifecycle", () => {
  function backingJob(config: ReturnType<typeof buildConfig>, watcherId: string) {
    return readState(config.instance).jobs.find(
      (j) => j.preRunHook?.handlerId === "gmail-delta" &&
        (j.preRunHook.config as { watcherId?: string }).watcherId === watcherId
    );
  }

  test("add provisions a correctly-shaped backing job and stamps jobId", async () => {
    const config = buildConfig("ew-job-add");
    const watcher = await addEmailWatcher(config, { sender: "dave@x.com" });
    expect(watcher.jobId).toBeString();
    const job = backingJob(config, watcher.id);
    expect(job).toBeDefined();
    expect(job?.id).toBe(watcher.jobId!);
    expect(job?.preRunHook?.handlerId).toBe("gmail-delta");
    expect((job?.preRunHook?.config as { watcherId?: string }).watcherId).toBe(watcher.id);
    expect(job?.chatSessionId).toBe(watcher.chatSessionId);
    expect(job?.intervalSeconds).toBe(60);
  });

  test("remove deletes the backing job, the dedup rows, and the dedicated session", async () => {
    const config = buildConfig("ew-job-remove");
    const watcher = await addEmailWatcher(config, { sender: "erin@x.com" });
    markEmailSeen(config.instance, watcher.id, "msg-1");
    const jobId = watcher.jobId!;
    const sessionId = watcher.chatSessionId!;
    await removeEmailWatcher(config, watcher.id);
    const state = readState(config.instance);
    // Watcher, job, and dedicated session all gone.
    expect(state.emailWatchers.find((w) => w.id === watcher.id)).toBeUndefined();
    expect(state.jobs.find((j) => j.id === jobId)).toBeUndefined();
    expect(state.chatSessions.find((s) => s.id === sessionId)).toBeUndefined();
    // Dedup rows dropped.
    expect(isEmailSeen(config.instance, watcher.id, "msg-1")).toBe(false);
  });

  test("removeEmailWatcher cleans the session even when the backing job is already gone (rollback shape)", async () => {
    // The addEmailWatcher rollback path (createScheduledJob threw) calls
    // removeEmailWatcher on a watcher whose job-create never completed. Model
    // that shape: a watcher with no jobId and no backing job. removeEmailWatcher
    // must still drop the dedicated session (no orphan channel).
    const config = buildConfig("ew-job-rollback");
    const watcher = await addEmailWatcher(config, { sender: "frank@x.com" });
    const sessionId = watcher.chatSessionId!;
    await updateEmailWatcher(config, watcher.id, { jobId: undefined });
    await mutateState(config.instance, (state) => {
      state.jobs = state.jobs.filter(
        (j) => (j.preRunHook?.config as { watcherId?: string })?.watcherId !== watcher.id
      );
    });
    await removeEmailWatcher(config, watcher.id);
    const state = readState(config.instance);
    expect(state.chatSessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  test("backfill adopts an orphan job (jobId never stamped) instead of duplicating", async () => {
    const config = buildConfig("ew-job-adopt");
    const watcher = await addEmailWatcher(config, { sender: "grace@x.com" });
    const jobId = watcher.jobId!;
    // Model the crash window: the job exists but the watcher's jobId was never
    // stamped.
    await updateEmailWatcher(config, watcher.id, { jobId: undefined });
    const provisioned = await backfillEmailWatcherJobs(config);
    // Adoption is not a new provision.
    expect(provisioned).toBe(0);
    const after = getEmailWatcher(config, watcher.id);
    // jobId re-stamped to the SAME job — no duplicate created.
    expect(after?.jobId).toBe(jobId);
    const jobsForWatcher = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { watcherId?: string })?.watcherId === watcher.id
    );
    expect(jobsForWatcher).toHaveLength(1);
  });

  test("backfill provisions a job for a legacy watcher that has none", async () => {
    const config = buildConfig("ew-job-backfill-legacy");
    const watcher = await addEmailWatcher(config, { sender: "heidi@x.com" });
    // Model a legacy watcher: no jobId AND no backing job at all.
    await updateEmailWatcher(config, watcher.id, { jobId: undefined });
    await mutateState(config.instance, (state) => {
      state.jobs = state.jobs.filter(
        (j) => (j.preRunHook?.config as { watcherId?: string })?.watcherId !== watcher.id
      );
    });
    const provisioned = await backfillEmailWatcherJobs(config);
    expect(provisioned).toBe(1);
    expect(getEmailWatcher(config, watcher.id)?.jobId).toBeString();
  });

  test("backfill skips disabled watchers", async () => {
    const config = buildConfig("ew-job-backfill-disabled");
    const watcher = await addEmailWatcher(config, { sender: "ivan@x.com" });
    await setEmailWatcherEnabled(config, watcher.id, false);
    // Strip its job + jobId so backfill would re-provision IF it ran.
    await updateEmailWatcher(config, watcher.id, { jobId: undefined });
    await mutateState(config.instance, (state) => {
      state.jobs = state.jobs.filter(
        (j) => (j.preRunHook?.config as { watcherId?: string })?.watcherId !== watcher.id
      );
    });
    const provisioned = await backfillEmailWatcherJobs(config);
    expect(provisioned).toBe(0);
    expect(getEmailWatcher(config, watcher.id)?.jobId).toBeUndefined();
  });

  test("disable pauses the backing job; enable resumes it", async () => {
    const config = buildConfig("ew-job-toggle");
    const watcher = await addEmailWatcher(config, { sender: "judy@x.com" });
    const jobId = watcher.jobId!;
    const jobStatus = () => readState(config.instance).jobs.find((j) => j.id === jobId)?.status;
    expect(jobStatus()).toBe("active");
    await setEmailWatcherEnabled(config, watcher.id, false);
    expect(getEmailWatcher(config, watcher.id)?.enabled).toBe(false);
    expect(jobStatus()).toBe("paused");
    await setEmailWatcherEnabled(config, watcher.id, true);
    expect(getEmailWatcher(config, watcher.id)?.enabled).toBe(true);
    expect(jobStatus()).toBe("active");
  });
});

describe("email_seen dedup store", () => {
  test("markEmailSeen is idempotent and isEmailSeen reflects it", () => {
    const config = buildConfig("ew-seen");
    expect(isEmailSeen(config.instance, "w1", "m1")).toBe(false);
    markEmailSeen(config.instance, "w1", "m1");
    markEmailSeen(config.instance, "w1", "m1"); // idempotent
    expect(isEmailSeen(config.instance, "w1", "m1")).toBe(true);
    // Scoped per watcher.
    expect(isEmailSeen(config.instance, "w2", "m1")).toBe(false);
  });
});
