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
  test("sender builds from:<sender> — no is:unread (read-elsewhere race)", () => {
    expect(buildWatcherQuery({ sender: "a@x.com" })).toBe("from:a@x.com");
  });
  test("no sender/query falls back to in:inbox, never an empty q", () => {
    expect(buildWatcherQuery({})).toBe("in:inbox");
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
    return (job?.preRunHook?.config as { watches?: { watcherId: string; query: string; sender?: string }[] }).watches ?? [];
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
    expect(watches(config)).toEqual([{ watcherId: watcher.id, query: watcher.query, sender: "dave@x.com" }]);
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
    const sessions = readState(config.instance).chatSessions.filter((s) => s.title === "Email watch");
    expect(sessions).toHaveLength(1);
    // Both watches are listed.
    const list = watches(config);
    expect(new Set(list.map((w) => w.watcherId))).toEqual(new Set([w1.id, w2.id]));
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
    const sessions = readState(config.instance).chatSessions.filter((s) => s.title === "Email watch");
    expect(sessions).toHaveLength(1);
    // Both watchers point at the one shared job + session.
    expect(w1.jobId).toBe(jobs[0]!.id);
    expect(w2.jobId).toBe(jobs[0]!.id);
    expect(w1.chatSessionId).toBe(sessions[0]!.id);
    expect(w2.chatSessionId).toBe(sessions[0]!.id);
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
    const sessions = readState(config.instance).chatSessions.filter((s) => s.title === "Email watch");
    expect(sessions).toHaveLength(1);
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
    // Exactly ONE MARKED email-watch session, titled exactly "Email watch"
    // (adopted title renamed + marker backfilled); the orphan job's session + the
    // marker-carrying truly-orphan channel swept by identity.
    const emailSessions = state.chatSessions.filter((s) => s.feature === "email-watch");
    expect(emailSessions).toHaveLength(1);
    expect(emailSessions[0]!.id).toBe(sharedSessionId);
    expect(emailSessions[0]!.title).toBe("Email watch");
    expect(emailSessions[0]!.feature).toBe("email-watch");
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
    expect(after.chatSessions.filter((s) => s.feature === "email-watch")).toHaveLength(1);
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
});
