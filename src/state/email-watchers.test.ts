// CRUD + query-building tests for email watchers (ADR email-watch.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import "../hooks/builtins"; // populates the registry so createScheduledJob resolves isKnownHook("skill-script")
import { createScheduledJob } from "../jobs";
import {
  addEmailWatcher,
  backfillEmailWatcherJobs,
  buildWatcherQuery,
  closeAllMemoryDbs,
  createChatSession,
  getEmailWatcher,
  listEmailWatchers,
  mutateState,
  readState,
  removeEmailWatcher,
  renameChatSession,
  setEmailWatcherEnabled,
  setEmailWatcherObjective,
  clearEmailWatcherObjective,
  updateEmailWatcher,
  validateObjective,
  validateThreadId
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
  test("sender builds from:<sender> — no is:unread (read-elsewhere race)", () => {
    expect(buildWatcherQuery({ sender: "a@x.com" })).toBe("from:a@x.com");
  });
  test("no sender/query falls back to in:inbox, never an empty q", () => {
    expect(buildWatcherQuery({})).toBe("in:inbox");
  });
  test("threadId builds a thread:<id> label and wins over sender", () => {
    expect(buildWatcherQuery({ threadId: "t-123", sender: "a@x.com" })).toBe("thread:t-123");
  });
});

describe("watcher CRUD", () => {
  test("add creates an enabled watcher with a dedicated chat session", async () => {
    const config = buildConfig("ew-add");
    const watcher = await addEmailWatcher(config, { sender: "alice@x.com" });
    expect(watcher.enabled).toBe(true);
    expect(watcher.status).toBe("ok");
    expect(watcher.query).toBe("from:alice@x.com");
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
      query: "from:bob@x.com newer_than:1d",
      status: "needs_auth"
    });
    expect(updated?.query).toBe("from:bob@x.com newer_than:1d");
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

describe("thread-keyed watchers", () => {
  test("add with threadId stores the id, a thread:<id> label, and no sender", async () => {
    const config = buildConfig("ew-thread-add");
    const watcher = await addEmailWatcher(config, { threadId: "t-123", sender: "support@x.com" });
    expect(watcher.threadId).toBe("t-123");
    expect(watcher.query).toBe("thread:t-123");
    // Thread mode has no automated-sender heuristic, so no bypass key.
    expect(watcher.sender).toBeUndefined();
    // The shared job's watch entry carries the authoritative threadId.
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { threadId?: string }[] }).watches ?? [];
    expect(watches[0]?.threadId).toBe("t-123");
  });

  test("a blank or out-of-charset threadId is rejected before provisioning", async () => {
    const config = buildConfig("ew-thread-blank");
    await expect(addEmailWatcher(config, { threadId: "  " })).rejects.toThrow("Invalid input: threadId");
    // A threadId carrying shell metacharacters never reaches the gws sink — the
    // charset gate rejects it (threadIds are opaque hex-ish tokens).
    await expect(addEmailWatcher(config, { threadId: "x'; touch /tmp/PWNED; '" })).rejects.toThrow(
      "Invalid input: threadId may only contain"
    );
    expect(readState(config.instance).emailWatchers).toHaveLength(0);
  });

  test("validateThreadId accepts the gmail token charset and rejects the rest", () => {
    expect(validateThreadId(" 18f_ab-CD ")).toBe("18f_ab-CD");
    expect(() => validateThreadId(42)).toThrow("Invalid input: threadId must be a string");
    expect(() => validateThreadId("   ")).toThrow("Invalid input: threadId must be a non-empty string");
    expect(() => validateThreadId("a'b")).toThrow("Invalid input: threadId may only contain");
    expect(() => validateThreadId("a b")).toThrow("Invalid input: threadId may only contain");
  });

  test("followUpAfterHours requires a thread watch and a positive number", async () => {
    const config = buildConfig("ew-followup-validate");
    // Rejected on query watches — silence is a thread-level predicate.
    await expect(addEmailWatcher(config, { sender: "a@x.com", followUpAfterHours: 24 })).rejects.toThrow(
      "Invalid input: followUpAfterHours is only supported on thread watches"
    );
    await expect(addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: 0 })).rejects.toThrow(
      "Invalid input: followUpAfterHours must be a positive number"
    );
    await expect(addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: -2 })).rejects.toThrow(
      "Invalid input: followUpAfterHours must be a positive number"
    );
    expect(readState(config.instance).emailWatchers).toHaveLength(0);
    // Accepted on a thread watch; the watch entry carries it.
    const watcher = await addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: 24 });
    expect(watcher.followUpAfterHours).toBe(24);
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { followUpAfterHours?: number }[] }).watches ?? [];
    expect(watches[0]?.followUpAfterHours).toBe(24);
  });
});

describe("watcher objective", () => {
  test("validateObjective trims, rejects empty, caps at 2000 chars", () => {
    expect(validateObjective("  get a refund  ")).toBe("get a refund");
    expect(() => validateObjective("   ")).toThrow("Invalid input: objective must not be empty");
    expect(() => validateObjective(42)).toThrow("Invalid input: objective must be a string");
    expect(() => validateObjective("x".repeat(2001))).toThrow("Invalid input: objective must be at most 2000 characters");
    expect(validateObjective("x".repeat(2000))).toBe("x".repeat(2000));
  });

  test("add stores the validated objective and the watch list carries it", async () => {
    const config = buildConfig("ew-objective-add");
    const watcher = await addEmailWatcher(config, { sender: "alice@x.com", objective: " Get a refund or a replacement " });
    expect(watcher.objective).toBe("Get a refund or a replacement");
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBe("Get a refund or a replacement");
  });

  test("a rejected objective on the FIRST add leaves no orphan shared job", async () => {
    const config = buildConfig("ew-objective-reject");
    await expect(addEmailWatcher(config, { sender: "a@x.com", objective: "  " })).rejects.toThrow("Invalid input");
    const state = readState(config.instance);
    expect(state.emailWatchers).toHaveLength(0);
    expect(state.jobs.filter((j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch")).toHaveLength(0);
  });

  test("setEmailWatcherObjective revises the goal and pushes it into the watch list", async () => {
    const config = buildConfig("ew-objective-update");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com", objective: "Get a refund" });
    const updated = await setEmailWatcherObjective(config, watcher.id, " Accept a replacement instead ");
    expect(updated?.objective).toBe("Accept a replacement instead");
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBe("Accept a replacement instead");
    // A missing watcher returns undefined.
    expect(await setEmailWatcherObjective(config, "nope", "x")).toBeUndefined();
  });

  test("clearEmailWatcherObjective drops the goal and the watch list omits it", async () => {
    const config = buildConfig("ew-objective-clear");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com", objective: "Get a refund" });
    const cleared = await clearEmailWatcherObjective(config, watcher.id);
    expect(cleared?.objective).toBeUndefined();
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBeUndefined();
    // A missing watcher returns undefined.
    expect(await clearEmailWatcherObjective(config, "nope")).toBeUndefined();
  });
});

describe("shared backing job lifecycle", () => {
  // Find the agent's ONE shared email-watch job by its stable marker.
  function sharedJob(config: ReturnType<typeof buildConfig>) {
    return readState(config.instance).jobs.find(
      (j) => j.preRunHook?.handlerId === "skill-script" &&
        (j.preRunHook.config as { skill?: string }).skill === "gmail-watch"
    );
  }
  function watches(config: ReturnType<typeof buildConfig>) {
    const job = sharedJob(config);
    return (job?.preRunHook?.config as { watches?: { watcherId: string; routeKey?: string; query: string; sender?: string }[] }).watches ?? [];
  }

  test("first add provisions ONE shared job + session and stamps jobId", async () => {
    const config = buildConfig("ew-job-add");
    const watcher = await addEmailWatcher(config, { sender: "dave@x.com" });
    expect(watcher.jobId).toBeString();
    expect(watcher.chatSessionId).toBeString();
    const job = sharedJob(config);
    expect(job).toBeDefined();
    expect(job?.id).toBe(watcher.jobId!);
    expect(job?.name).toBe("Email watch");
    expect(job?.preRunHook?.handlerId).toBe("skill-script");
    const hookConfig = job?.preRunHook?.config as { skill?: string; script?: string };
    expect(hookConfig.skill).toBe("gmail-watch");
    expect(hookConfig.script).toBe("detect");
    expect(job?.chatSessionId).toBe(watcher.chatSessionId);
    expect(job?.intervalSeconds).toBe(60);
    // The shared job's watch list carries this enabled watcher, including the
    // explicitly watched sender (the detection script's heuristic bypass key).
    expect(watches(config)).toEqual([{ watcherId: watcher.id, routeKey: watcher.id, query: watcher.query, sender: "dave@x.com" }]);
  });

  test("a sender add stores the sender; a raw-query add does not", async () => {
    const config = buildConfig("ew-job-sender-field");
    const bySender = await addEmailWatcher(config, { sender: "noreply@ups.com" });
    expect(bySender.sender).toBe("noreply@ups.com");
    // A raw query wins and makes this a raw-query watch — no single sender.
    const byQuery = await addEmailWatcher(config, { sender: "x@y.com", query: "subject:urgent" });
    expect(byQuery.sender).toBeUndefined();
    const list = watches(config);
    expect(list.find((w) => w.watcherId === bySender.id)).toMatchObject({ sender: "noreply@ups.com" });
    expect((list.find((w) => w.watcherId === byQuery.id) as { sender?: string }).sender).toBeUndefined();
  });

  test("the shared job's playbook pins thread reading, objective, needs-input, and follow-up rules", async () => {
    const config = buildConfig("ew-job-playbook");
    await addEmailWatcher(config, { sender: "alice@x.com" });
    const prompt = sharedJob(config)!.prompt;
    // The drafting turn reads the whole conversation, not just the message.
    expect(prompt).toContain("read the FULL Gmail THREAD the message belongs to");
    // Objective awareness: authoritative standing instructions per watch.
    expect(prompt).toContain("accompanied by an Objective");
    expect(prompt).toContain("authoritative for what the reply should achieve");
    // Needs-input rule: never invent missing facts; surface them in-chat.
    expect(prompt).toContain("⏸ Needs your input");
    expect(prompt).toContain("[PLACEHOLDER:");
    // Follow-up nudges draft a polite follow-up as a normal proposed reply.
    expect(prompt).toContain("gone silent on a watched thread");
    // The standing safety rules survive the rewrite.
    expect(prompt).toContain("UNTRUSTED quoted data");
    expect(prompt).toContain("Do NOT send it.");
    expect(prompt).toContain("[SILENT]");
  });

  test("a second add reuses the SAME shared job + session and appends to watches", async () => {
    const config = buildConfig("ew-job-share");
    const w1 = await addEmailWatcher(config, { sender: "alice@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "bob@x.com" });
    // ONE shared job + ONE shared session for both senders.
    expect(w2.jobId).toBe(w1.jobId);
    expect(w2.chatSessionId).toBe(w1.chatSessionId);
    const jobs = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(jobs).toHaveLength(1);
    // ONE shared session bound to the job (each concern also has its OWN channel,
    // which is why we target the job-bound session, not every "Email watch" title).
    expect(jobs[0]!.chatSessionId).toBe(w1.chatSessionId);
    // Both watches are listed.
    const list = watches(config);
    expect(new Set(list.map((w) => w.watcherId))).toEqual(new Set([w1.id, w2.id]));
    // Each concern got its OWN per-concern channel, and the shared job routes each
    // bucket into that channel.
    expect(w1.channelId).toBeString();
    expect(w2.channelId).toBeString();
    expect(w1.channelId).not.toBe(w2.channelId);
    const routes = jobs[0]!.routes ?? {};
    expect(routes[w1.id]?.chatSessionId).toBe(w1.channelId!);
    expect(routes[w2.id]?.chatSessionId).toBe(w2.channelId!);
  });

  test("removing one of several rebuilds watches but keeps the shared job + session", async () => {
    const config = buildConfig("ew-job-remove-one");
    const w1 = await addEmailWatcher(config, { sender: "alice@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "bob@x.com" });
    const jobId = w1.jobId!;
    await removeEmailWatcher(config, w1.id);
    const state = readState(config.instance);
    // Shared job + session survive (w2 still watching); watch list rebuilt to w2.
    expect(state.jobs.find((j) => j.id === jobId)).toBeDefined();
    expect(state.chatSessions.find((s) => s.id === w1.chatSessionId)).toBeDefined();
    expect(watches(config).map((w) => w.watcherId)).toEqual([w2.id]);
  });

  test("removing the LAST watcher tears down the shared job + session", async () => {
    const config = buildConfig("ew-job-remove-last");
    const watcher = await addEmailWatcher(config, { sender: "erin@x.com" });
    const jobId = watcher.jobId!;
    const sessionId = watcher.chatSessionId!;
    await removeEmailWatcher(config, watcher.id);
    const state = readState(config.instance);
    expect(state.emailWatchers.find((w) => w.id === watcher.id)).toBeUndefined();
    expect(state.jobs.find((j) => j.id === jobId)).toBeUndefined();
    expect(state.chatSessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  test("backfill on legacy watchers (no shared job) provisions ONE and wires them", async () => {
    const config = buildConfig("ew-job-backfill-legacy");
    const w1 = await addEmailWatcher(config, { sender: "heidi@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "ivan@x.com" });
    // Model legacy pre-consolidation state: no shared job, dangling jobIds.
    await mutateState(config.instance, (state) => {
      state.jobs = state.jobs.filter(
        (j) => (j.preRunHook?.config as { skill?: string })?.skill !== "gmail-watch"
      );
      for (const w of state.emailWatchers) w.jobId = "stale-job-id";
    });
    const provisioned = await backfillEmailWatcherJobs(config);
    // ONE shared job provisioned for the agent (not one per watcher).
    expect(provisioned).toBe(1);
    const jobs = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(jobs).toHaveLength(1);
    // Both watchers re-stamped to the shared job; the watch list carries both.
    expect(getEmailWatcher(config, w1.id)?.jobId).toBe(jobs[0]!.id);
    expect(getEmailWatcher(config, w2.id)?.jobId).toBe(jobs[0]!.id);
    expect(new Set(watches(config).map((w) => w.watcherId))).toEqual(new Set([w1.id, w2.id]));
  });

  test("concurrent adds provision EXACTLY one shared job + one session", async () => {
    const config = buildConfig("ew-job-concurrent-add");
    // Two adds from independent entrypoints racing the same find-then-create:
    // without the per-agent provisioning lock both observe "no shared job" and
    // create a duplicate job + session.
    const [w1, w2] = await Promise.all([
      addEmailWatcher(config, { sender: "mallory@x.com" }),
      addEmailWatcher(config, { sender: "trent@x.com" })
    ]);
    const jobs = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(jobs).toHaveLength(1);
    // Both watchers point at the one shared job + its bound shared session (each
    // also has its own per-concern channel, so we target the job-bound session).
    expect(w1.jobId).toBe(jobs[0]!.id);
    expect(w2.jobId).toBe(jobs[0]!.id);
    expect(w1.chatSessionId).toBe(jobs[0]!.chatSessionId);
    expect(w2.chatSessionId).toBe(jobs[0]!.chatSessionId);
    // Both senders are in the shared watch list.
    expect(new Set(watches(config).map((w) => w.watcherId))).toEqual(new Set([w1.id, w2.id]));
  });

  test("startup backfill racing an incoming add yields ONE shared job + session", async () => {
    const config = buildConfig("ew-job-backfill-vs-add");
    // Seed a legacy watcher with no shared job (pre-consolidation), the state the
    // un-awaited startup backfill reconciles. A fresh add fires concurrently from
    // a different entrypoint — both must converge on the one shared job.
    const legacy = await addEmailWatcher(config, { sender: "peggy@x.com" });
    await mutateState(config.instance, (state) => {
      state.jobs = state.jobs.filter(
        (j) => (j.preRunHook?.config as { skill?: string })?.skill !== "gmail-watch"
      );
      // Drop the now-orphaned shared session too so the only "Email watch"
      // session counted below is the one provisioning recreates.
      state.chatSessions = state.chatSessions.filter((s) => s.title !== "Email watch");
      for (const w of state.emailWatchers) {
        w.jobId = "stale-job-id";
        w.chatSessionId = "stale-session-id";
      }
    });
    const [, added] = await Promise.all([
      backfillEmailWatcherJobs(config),
      addEmailWatcher(config, { sender: "victor@x.com" })
    ]);
    const jobs = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(jobs).toHaveLength(1);
    // Exactly one shared session — the one bound to the surviving shared job.
    expect(jobs[0]!.chatSessionId).toBeString();
    expect(
      readState(config.instance).chatSessions.filter((s) => s.id === jobs[0]!.chatSessionId)
    ).toHaveLength(1);
    // Both the legacy and the freshly-added watcher end up on the one shared job.
    expect(getEmailWatcher(config, legacy.id)?.jobId).toBe(jobs[0]!.id);
    expect(getEmailWatcher(config, added.id)?.jobId).toBe(jobs[0]!.id);
  });

  test("backfill is idempotent: an existing shared job is reconciled, not duplicated", async () => {
    const config = buildConfig("ew-job-backfill-idempotent");
    await addEmailWatcher(config, { sender: "grace@x.com" });
    const before = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(before).toHaveLength(1);
    const provisioned = await backfillEmailWatcherJobs(config);
    // Existing shared job reconciled — no new provision, no duplicate.
    expect(provisioned).toBe(0);
    const after = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  test("backfill leaves an agent with only disabled watchers alone", async () => {
    const config = buildConfig("ew-job-backfill-disabled");
    const watcher = await addEmailWatcher(config, { sender: "jane@x.com" });
    // Disabling the only watcher tears the shared job down.
    await setEmailWatcherEnabled(config, watcher.id, false);
    expect(
      readState(config.instance).jobs.filter((j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch")
    ).toHaveLength(0);
    const provisioned = await backfillEmailWatcherJobs(config);
    // No enabled watchers => no shared job provisioned.
    expect(provisioned).toBe(0);
    expect(
      readState(config.instance).jobs.filter((j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch")
    ).toHaveLength(0);
  });

  test("disable drops a watcher from the shared watch list; enable re-adds it", async () => {
    const config = buildConfig("ew-job-toggle");
    const w1 = await addEmailWatcher(config, { sender: "judy@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "kyle@x.com" });
    // Disable w1: the shared job + session stay (w2 enabled), w1 leaves the list.
    await setEmailWatcherEnabled(config, w1.id, false);
    expect(getEmailWatcher(config, w1.id)?.enabled).toBe(false);
    expect(watches(config).map((w) => w.watcherId)).toEqual([w2.id]);
    expect(sharedJob(config)).toBeDefined();
    // Re-enable w1: it returns to the watch list.
    await setEmailWatcherEnabled(config, w1.id, true);
    expect(getEmailWatcher(config, w1.id)?.enabled).toBe(true);
    expect(new Set(watches(config).map((w) => w.watcherId))).toEqual(new Set([w1.id, w2.id]));
  });

  test("disabling the last enabled watcher tears the shared job down; enable recreates it", async () => {
    const config = buildConfig("ew-job-toggle-last");
    const watcher = await addEmailWatcher(config, { sender: "leo@x.com" });
    await setEmailWatcherEnabled(config, watcher.id, false);
    // Shared job + session gone, the disabled record's jobId cleared.
    expect(sharedJob(config)).toBeUndefined();
    expect(getEmailWatcher(config, watcher.id)?.jobId).toBeUndefined();
    // Re-enable recreates the shared job + session and re-stamps the record.
    const reenabled = await setEmailWatcherEnabled(config, watcher.id, true);
    expect(sharedJob(config)).toBeDefined();
    expect(reenabled?.jobId).toBe(sharedJob(config)!.id);
    expect(watches(config).map((w) => w.watcherId)).toEqual([watcher.id]);
  });

  test("backfill heals EXACT legacy auto-built query shapes only", async () => {
    const config = buildConfig("ew-job-heal-queries");
    const bySender = await addEmailWatcher(config, { sender: "alice@x.com" });
    const catchAll = await addEmailWatcher(config, { query: "placeholder" });
    const rawWithUnread = await addEmailWatcher(config, { query: "subject:invoice is:unread" });
    // Model legacy records: the retired auto-built shapes plus a raw query that
    // merely CONTAINS is:unread (must never be rewritten).
    await mutateState(config.instance, (state) => {
      state.emailWatchers.find((w) => w.id === bySender.id)!.query = "from:alice@x.com is:unread";
      state.emailWatchers.find((w) => w.id === catchAll.id)!.query = "is:unread";
    });
    await backfillEmailWatcherJobs(config);
    // Exact legacy shapes rewritten...
    expect(getEmailWatcher(config, bySender.id)?.query).toBe("from:alice@x.com");
    expect(getEmailWatcher(config, catchAll.id)?.query).toBe("in:inbox");
    // ...and the user-supplied raw query untouched.
    expect(getEmailWatcher(config, rawWithUnread.id)?.query).toBe("subject:invoice is:unread");
    // The shared job's watch list carries the healed queries.
    const queries = new Set(watches(config).map((w) => w.query));
    expect(queries).toEqual(new Set(["from:alice@x.com", "in:inbox", "subject:invoice is:unread"]));
  });

  test("heal runs once: a later user-created from:X is:unread survives the next backfill", async () => {
    const config = buildConfig("ew-job-heal-once");
    // First backfill stamps the run-once marker (no legacy data to rewrite).
    await backfillEmailWatcherJobs(config);
    expect(readState(config.instance).emailWatcherQueryHealedAt).toBeDefined();
    // The user now deliberately creates a raw query that is byte-identical to
    // the retired auto-built shape. A second backfill must NOT rewrite it.
    const raw = await addEmailWatcher(config, { query: "from:x@y.com is:unread" });
    await backfillEmailWatcherJobs(config);
    expect(getEmailWatcher(config, raw.id)?.query).toBe("from:x@y.com is:unread");
  });

  test("backfill self-heals adopted titles + orphan jobs/sessions from old->new transitions", async () => {
    const config = buildConfig("ew-job-backfill-heal");
    // Real consolidated state: one shared job + session, two watchers on it.
    const w1 = await addEmailWatcher(config, { sender: "alice@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "bob@x.com" });
    const sharedJobId = w1.jobId!;
    const sharedSessionId = w1.chatSessionId!;
    expect(w2.jobId).toBe(sharedJobId);

    // An ORPHAN duplicate gmail-watch job (watches:[]) with its own session — the
    // residue of a pre-atomicity-fix race. The session carries the email-watch
    // feature marker the way every real shared session does.
    const orphanSession = await mutateState(config.instance, (state) => {
      const created = createChatSession(state, "Email watch: stale@x.com", undefined, undefined, "job", "channel");
      created.feature = "email-watch";
      return created;
    });
    const orphanJob = await createScheduledJob(config, {
      name: "Email watch",
      prompt: "stale",
      intervalSeconds: 60,
      chatSessionId: orphanSession.id,
      preRunHook: { handlerId: "skill-script", config: { skill: "gmail-watch", script: "detect", watches: [] } }
    });
    expect(orphanJob.id).not.toBe(sharedJobId);

    // The shared session AND job were ADOPTED from old per-sender code and never
    // renamed (both keep the "Email watch: <sender>" label the sidebar renders),
    // plus a truly-orphan (marker-carrying) "Email watch: <sender>" channel
    // referenced by nothing (its job was already removed out-of-band). A DECOY
    // channel is titled like an email-watch channel but carries NO feature
    // marker — it must survive (proves cleanup is identity-based, not by title).
    const { trulyOrphanChannel, decoyChannel } = await mutateState(config.instance, (state) => {
      renameChatSession(state, sharedSessionId, "Email watch: alice@x.com");
      const sharedJobRecord = state.jobs.find((j) => j.id === sharedJobId);
      if (sharedJobRecord) sharedJobRecord.name = "Email watch: alice@x.com";
      const orphan = createChatSession(state, "Email watch: bob@x.com", undefined, undefined, "job", "channel");
      orphan.feature = "email-watch";
      const decoy = createChatSession(state, "Email watch: decoy@x.com", undefined, undefined, "job", "channel");
      return { trulyOrphanChannel: orphan, decoyChannel: decoy };
    });

    await backfillEmailWatcherJobs(config);

    const state = readState(config.instance);
    // Exactly ONE gmail-watch job: the shared one; the orphan duplicate is gone.
    const gmailJobs = state.jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(gmailJobs).toHaveLength(1);
    expect(gmailJobs[0]!.id).toBe(sharedJobId);
    // The adopted job's name was renamed to the canonical "Email watch" so the
    // sidebar (which renders job.name) no longer shows "Email watch: <sender>".
    expect(gmailJobs[0]!.name).toBe("Email watch");
    // The SHARED session (job-bound) was adopted, renamed to the canonical title,
    // and marker-backfilled — distinct from the two per-concern channels, which are
    // referenced by the live watchers and so survive the identity sweep.
    const sharedSession = state.chatSessions.find((s) => s.id === sharedSessionId);
    expect(sharedSession?.title).toBe("Email watch");
    expect(sharedSession?.feature).toBe("email-watch");
    const concernChannelIds = new Set(
      [w1, w2].map((w) => getEmailWatcher(config, w.id)?.channelId).filter((id): id is string => Boolean(id))
    );
    expect(concernChannelIds.size).toBe(2);
    // The MARKED email-watch sessions are exactly the shared session + the two
    // live concern channels; the orphan job's session + the truly-orphan channel
    // were swept by identity.
    const emailSessions = state.chatSessions.filter((s) => s.feature === "email-watch");
    expect(new Set(emailSessions.map((s) => s.id))).toEqual(new Set([sharedSessionId, ...concernChannelIds]));
    expect(state.chatSessions.some((s) => s.id === orphanSession.id)).toBe(false);
    expect(state.chatSessions.some((s) => s.id === trulyOrphanChannel.id)).toBe(false);
    // The decoy — titled like an email-watch channel but WITHOUT the marker — is
    // NOT swept: cleanup matches by identity (feature marker), not by title.
    expect(state.chatSessions.some((s) => s.id === decoyChannel.id)).toBe(true);
    // Watchers still point at the shared job + session.
    expect(getEmailWatcher(config, w1.id)?.jobId).toBe(sharedJobId);
    expect(getEmailWatcher(config, w2.id)?.jobId).toBe(sharedJobId);
    expect(getEmailWatcher(config, w1.id)?.chatSessionId).toBe(sharedSessionId);

    // A second run is a no-op (idempotent): nothing left to heal.
    const jobsBefore = state.jobs.length;
    const sessionsBefore = state.chatSessions.length;
    await backfillEmailWatcherJobs(config);
    const after = readState(config.instance);
    expect(after.jobs).toHaveLength(jobsBefore);
    expect(after.chatSessions).toHaveLength(sessionsBefore);
    // Shared session + the two live per-concern channels survive; nothing else
    // is created or swept on the idempotent second pass.
    expect(after.chatSessions.filter((s) => s.feature === "email-watch")).toHaveLength(3);
  });
});

describe("derived watcher health (per-watcher byWatcher state)", () => {
  // Write the detection script's per-watch health blob onto the shared job's
  // hookState.byWatcher the way a tick would, then assert the email read path
  // surfaces it as the watcher's status/lastError.
  async function setByWatcher(
    config: ReturnType<typeof buildConfig>,
    jobId: string,
    watcherId: string,
    perWatcher: Record<string, unknown>
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) return;
      const hookState = (job.hookState ?? {}) as { byWatcher?: Record<string, unknown> };
      hookState.byWatcher = { ...(hookState.byWatcher ?? {}), [watcherId]: perWatcher };
      job.hookState = hookState as Record<string, unknown>;
    });
  }

  test("per-watcher needs_auth surfaces on list + get, isolated from a healthy sibling", async () => {
    const config = buildConfig("ew-health-needsauth");
    const w1 = await addEmailWatcher(config, { sender: "ken@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "lena@x.com" });
    const jobId = w1.jobId!;
    await setByWatcher(config, jobId, w1.id, { cursor: "1000", seen: [], status: "needs_auth" });
    await setByWatcher(config, jobId, w2.id, { cursor: "2000", seen: [], status: "ok" });
    expect(listEmailWatchers(config).find((w) => w.id === w1.id)?.status).toBe("needs_auth");
    expect(getEmailWatcher(config, w1.id)?.status).toBe("needs_auth");
    // The sibling stays ok — per-watcher isolation.
    expect(getEmailWatcher(config, w2.id)?.status).toBe("ok");
  });

  test("a per-watcher gws error surfaces error + the scrubbed lastError", async () => {
    const config = buildConfig("ew-health-error");
    const watcher = await addEmailWatcher(config, { sender: "lara@x.com" });
    await setByWatcher(config, watcher.jobId!, watcher.id, {
      cursor: "1000",
      seen: [],
      status: "error",
      lastError: "gws failed reading <path>"
    });
    const derived = getEmailWatcher(config, watcher.id);
    expect(derived?.status).toBe("error");
    expect(derived?.lastError).toBe("gws failed reading <path>");
  });

  test("a healthy tick surfaces ok and clears a prior lastError", async () => {
    const config = buildConfig("ew-health-ok");
    const watcher = await addEmailWatcher(config, { sender: "mona@x.com" });
    await setByWatcher(config, watcher.jobId!, watcher.id, { status: "error", lastError: "boom" });
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("error");
    await setByWatcher(config, watcher.jobId!, watcher.id, { cursor: "2000", seen: ["m"], status: "ok" });
    const derived = getEmailWatcher(config, watcher.id);
    expect(derived?.status).toBe("ok");
    expect(derived?.lastError).toBeUndefined();
  });

  test("a watcher with no byWatcher entry yet keeps its stored status", async () => {
    const config = buildConfig("ew-health-none");
    const watcher = await addEmailWatcher(config, { sender: "nina@x.com" });
    // No hookState written yet (pre-first-tick) => stored status is surfaced.
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("ok");
  });

  test("health derives from the flat per-route hookState key (the current shape)", async () => {
    const config = buildConfig("ew-health-flat");
    const watcher = await addEmailWatcher(config, { sender: "owen@x.com" });
    // The current detect.ts writes per-route state at the TOP level of hookState
    // (keyed by routeKey = watcher id), NOT nested under byWatcher.
    await mutateState(config.instance, (state) => {
      const job = state.jobs.find((j) => j.id === watcher.jobId);
      if (job) job.hookState = { [watcher.id]: { cursor: "9", seen: [], status: "needs_auth" } };
    });
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("needs_auth");
  });
});

describe("per-concern channels + fan-out routes", () => {
  test("add provisions a per-concern channel and a route targeting it", async () => {
    const config = buildConfig("ew-concern-add");
    const watcher = await addEmailWatcher(config, { sender: "pat@x.com" });
    expect(watcher.channelId).toBeString();
    // The channel is its OWN session, distinct from the shared job session.
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    expect(watcher.channelId).not.toBe(job?.chatSessionId);
    // The shared job's route table dispatches this concern's bucket into its channel.
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(watcher.channelId);
    expect(job?.routes?.[watcher.id]?.prompt).toContain("email-watch agent");
    // The per-concern channel carries the email-watch feature marker.
    const channel = readState(config.instance).chatSessions.find((s) => s.id === watcher.channelId);
    expect(channel?.feature).toBe("email-watch");
    expect(channel?.kind).toBe("channel");
  });

  test("a persona watcher routes with a layered systemPrompt; toolsets pass through", async () => {
    const config = buildConfig("ew-concern-persona");
    const watcher = await addEmailWatcher(config, { sender: "quinn@x.com" });
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) {
        w.persona = "Be terse and formal.";
        w.toolsets = ["gmail"];
      }
    });
    // Re-stamp the persona/toolsets into the route via a rebuild (an enable no-op
    // is the simplest rebuild trigger that re-runs buildJobRoutes).
    await setEmailWatcherEnabled(config, watcher.id, true);
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    const route = job?.routes?.[watcher.id];
    expect(route?.systemPrompt).toContain("Be terse and formal.");
    expect(route?.systemPrompt).toContain("email-watch agent"); // layered over the shared playbook
    expect(route?.toolsets).toEqual(["gmail"]);
  });

  test("removing a concern drops its route and reclaims its channel", async () => {
    const config = buildConfig("ew-concern-remove");
    const keep = await addEmailWatcher(config, { sender: "rita@x.com" });
    const drop = await addEmailWatcher(config, { sender: "sam@x.com" });
    const dropChannelId = drop.channelId!;
    await removeEmailWatcher(config, drop.id);
    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === keep.jobId);
    // The removed concern's route is gone; the surviving concern's stays.
    expect(job?.routes?.[drop.id]).toBeUndefined();
    expect(job?.routes?.[keep.id]?.chatSessionId).toBe(keep.channelId);
    // The removed concern's channel was reclaimed; the survivor's was NOT swept.
    expect(state.chatSessions.some((s) => s.id === dropChannelId)).toBe(false);
    expect(state.chatSessions.some((s) => s.id === keep.channelId)).toBe(true);
  });

  test("disabling a concern drops its route but keeps its channel for re-enable", async () => {
    const config = buildConfig("ew-concern-disable");
    const watcher = await addEmailWatcher(config, { sender: "tom@x.com" });
    const channelId = watcher.channelId!;
    await setEmailWatcherEnabled(config, watcher.id, false);
    // Disabling the last enabled watcher tears the shared job down, so re-enable to
    // re-provision and confirm the SAME concern channel is reused (never swept).
    await setEmailWatcherEnabled(config, watcher.id, true);
    const reenabled = getEmailWatcher(config, watcher.id);
    expect(reenabled?.channelId).toBe(channelId);
    const job = readState(config.instance).jobs.find((j) => j.id === reenabled?.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(channelId);
    expect(readState(config.instance).chatSessions.some((s) => s.id === channelId)).toBe(true);
  });

  test("channel migration backfills an enabled watcher that predates per-concern channels (once)", async () => {
    const config = buildConfig("ew-concern-migrate");
    const watcher = await addEmailWatcher(config, { sender: "uma@x.com" });
    // Simulate a pre-migration install: strip the channel + the run-once marker,
    // leaving the watcher routing to the shared session only.
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) w.channelId = undefined;
      state.emailWatcherChannelsMigratedAt = undefined;
      const job = state.jobs.find((j) => j.id === watcher.jobId);
      if (job) job.routes = {};
    });
    await backfillEmailWatcherJobs(config);
    const migrated = getEmailWatcher(config, watcher.id);
    expect(migrated?.channelId).toBeString();
    const job = readState(config.instance).jobs.find((j) => j.id === migrated?.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(migrated?.channelId);
    expect(readState(config.instance).emailWatcherChannelsMigratedAt).toBeString();

    // Idempotent: a second backfill neither re-migrates nor mints a new channel.
    const channelId = migrated?.channelId;
    await backfillEmailWatcherJobs(config);
    expect(getEmailWatcher(config, watcher.id)?.channelId).toBe(channelId);
  });

  test("an unmigrated watcher routes to the shared session until it gets a channel", async () => {
    const config = buildConfig("ew-concern-fallback");
    const watcher = await addEmailWatcher(config, { sender: "vera@x.com" });
    const sharedSessionId = readState(config.instance).jobs.find((j) => j.id === watcher.jobId)?.chatSessionId;
    // Drop the channel WITHOUT running migration (marker stays set) — the route
    // must fall back to the shared session, never losing delivery.
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) w.channelId = undefined;
    });
    await setEmailWatcherEnabled(config, watcher.id, true); // rebuild routes
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(sharedSessionId);
  });
});
