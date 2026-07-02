// Recurring-job fan-out tests (concern fan-out design; ADR job-pre-run-hooks.md).
//
// Exercises the general fan-out primitive end-to-end through the jobs scheduler
// with stub hook handlers registered via the test-only registry override — no
// email, no Gmail. Asserts the routed dispatch contract:
//   - a routed hook + a job with routes => one worker per non-empty bucket, each
//     into its OWN session, carrying its bucket's fenced context
//   - an empty bucket => no worker
//   - one route's spawn throwing => that bucket's hookState NOT committed while the
//     sibling's IS (per-bucket at-least-once)
//   - a flat items result with no routes => exactly the legacy single dispatch
//     (regression pin)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { createScheduledJob, runJobNow } from "../jobs";
import { mutateState, readState } from "../state";
import { __registerHookForTest, __resetHooksForTest } from "../hooks";
import "../hooks/builtins";
import type { JobRoute, RuntimeConfig } from "../types";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-fanout-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-fanout-test-logs",
    approvalMode: "yolo"
  };
}

async function createSession(config: RuntimeConfig, id: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    state.chatSessions.unshift({
      id,
      instance: state.instance,
      title: "fanout session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageIds: [],
      taskIds: [],
      runIds: []
    });
  });
}

// Set the job's fan-out routing table (P1 leaves createScheduledJob untouched —
// the email layer wires routes via provisioning in P2; tests stamp it directly).
async function setRoutes(config: RuntimeConfig, jobId: string, routes: Record<string, JobRoute>): Promise<void> {
  await mutateState(config.instance, (state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.routes = routes;
  });
}

// Worker tasks spawned by the fan-out carry their target session id (stamped by
// submitTask) but NO jobId (they go through spawnSubagent), so filter by session.
function tasksInSession(config: RuntimeConfig, sessionId: string) {
  return readState(config.instance).tasks.filter((t) => t.chatSessionId === sessionId);
}

describe("recurring-job fan-out", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-fanout-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-fanout-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    __resetHooksForTest();
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("two non-empty buckets fan out to two workers in two sessions", async () => {
    const config = buildConfig(workspaceRoot, "fanout-two");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const jobSession = "session_job";
    const sessionA = "session_a";
    const sessionB = "session_b";
    await createSession(config, jobSession);
    await createSession(config, sessionA);
    await createSession(config, sessionB);

    __registerHookForTest("test-fanout-two", async () => ({
      kind: "context",
      buckets: {
        alpha: [{ text: "alpha item", untrusted: false }],
        beta: [{ text: "beta item", untrusted: false }]
      },
      state: { alpha: { cursor: "a1" }, beta: { cursor: "b1" } }
    }));

    const job = await createScheduledJob(config, {
      name: "fanout",
      intervalSeconds: 60,
      prompt: "handle the concern",
      chatSessionId: jobSession,
      preRunHook: { handlerId: "test-fanout-two", config: {} }
    });
    await setRoutes(config, job.id, {
      alpha: { chatSessionId: sessionA, systemPrompt: "you are alpha", prompt: "alpha task" },
      beta: { chatSessionId: sessionB, systemPrompt: "you are beta" }
    });

    await runJobNow(config, job.id, "manual");

    // One worker per bucket, each in its OWN session — and NONE in the job session.
    const aTasks = tasksInSession(config, sessionA);
    const bTasks = tasksInSession(config, sessionB);
    expect(aTasks).toHaveLength(1);
    expect(bTasks).toHaveLength(1);
    expect(tasksInSession(config, jobSession)).toHaveLength(0);

    // Each worker's prompt carries its route prompt + its bucket's context.
    expect(aTasks[0]!.input).toContain("alpha task");
    expect(aTasks[0]!.input).toContain("alpha item");
    // beta has no route prompt → falls back to the job prompt.
    expect(bTasks[0]!.input).toContain("handle the concern");
    expect(bTasks[0]!.input).toContain("beta item");

    // The single per-tick run finalized completed (not routed through a worker).
    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");

    // Both buckets' sub-state committed.
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({
      alpha: { cursor: "a1" },
      beta: { cursor: "b1" }
    });
  });

  test("a constrained route (the triage shape) spawns a parentless subagent carrying its systemPrompt + toolset whitelist", async () => {
    const config = buildConfig(workspaceRoot, "fanout-constrained");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const triageSession = "session_triage";
    await createSession(config, triageSession);

    // Detect routed the unclaimed remainder to the constant "triage" bucket.
    __registerHookForTest("test-fanout-triage", async () => ({
      kind: "context",
      buckets: { triage: [{ text: "unmatched email", untrusted: true }] },
      state: { triage: { cursor: "t1" } }
    }));

    const job = await createScheduledJob(config, {
      name: "Email watch",
      intervalSeconds: 60,
      prompt: "fallback",
      preRunHook: { handlerId: "test-fanout-triage", config: {} }
    });
    // The triage route the email layer builds: the respond-or-flag playbook as the
    // worker's systemPrompt + the minimal toolset whitelist (email + terminal).
    await setRoutes(config, job.id, {
      triage: {
        chatSessionId: triageSession,
        prompt: "triage prompt",
        systemPrompt: "You are triaging newly-arrived emails that matched no specific watch.",
        toolsets: ["email", "terminal"]
      }
    });

    await runJobNow(config, job.id, "manual");

    const tasks = tasksInSession(config, triageSession);
    expect(tasks).toHaveLength(1);
    // The worker is a PARENTLESS subagent (depth cap no-ops) — never job-bound.
    expect(tasks[0]!.parentTaskId).toBeUndefined();
    expect(tasks[0]!.jobId).toBeUndefined();
    expect(tasks[0]!.subagentId).toBeString();
    // The SubagentRecord pins the constraint: the respond-or-flag systemPrompt +
    // the email/terminal toolset whitelist (so the worker can email_watch-escalate
    // and drive gws, but nothing broader).
    const subagent = readState(config.instance).subagents.find((s) => s.id === tasks[0]!.subagentId);
    expect(subagent).toBeDefined();
    expect(subagent!.systemPrompt).toContain("triaging newly-arrived emails that matched no specific watch");
    expect(subagent!.toolsetIds).toEqual(["email", "terminal"]);
  });

  test("an empty bucket spawns no worker", async () => {
    const config = buildConfig(workspaceRoot, "fanout-empty");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionA = "session_a";
    const sessionB = "session_b";
    await createSession(config, sessionA);
    await createSession(config, sessionB);

    __registerHookForTest("test-fanout-empty", async () => ({
      kind: "context",
      buckets: {
        alpha: [{ text: "alpha item", untrusted: false }],
        beta: [] // empty → no worker
      },
      state: { alpha: { cursor: "a1" } }
    }));

    const job = await createScheduledJob(config, {
      name: "fanout-empty",
      intervalSeconds: 60,
      prompt: "handle",
      preRunHook: { handlerId: "test-fanout-empty", config: {} }
    });
    await setRoutes(config, job.id, {
      alpha: { chatSessionId: sessionA },
      beta: { chatSessionId: sessionB }
    });

    await runJobNow(config, job.id, "manual");

    expect(tasksInSession(config, sessionA)).toHaveLength(1);
    // The empty bucket spawned nothing (zero-idle-turn discipline).
    expect(tasksInSession(config, sessionB)).toHaveLength(0);
  });

  test("a failed route does not commit its bucket while the sibling does (per-bucket at-least-once)", async () => {
    const config = buildConfig(workspaceRoot, "fanout-partial");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionA = "session_a";
    await createSession(config, sessionA);
    // sessionB is deliberately NOT created → the beta route points at a deleted
    // session, so its dispatch is audited + skipped (un-committed).

    __registerHookForTest("test-fanout-partial", async () => ({
      kind: "context",
      buckets: {
        alpha: [{ text: "alpha item", untrusted: false }],
        beta: [{ text: "beta item", untrusted: false }]
      },
      state: { alpha: { cursor: "a-new" }, beta: { cursor: "b-new" } }
    }));

    const job = await createScheduledJob(config, {
      name: "fanout-partial",
      intervalSeconds: 60,
      prompt: "handle",
      preRunHook: { handlerId: "test-fanout-partial", config: {} }
    });
    await setRoutes(config, job.id, {
      alpha: { chatSessionId: sessionA },
      beta: { chatSessionId: "session_b_missing" }
    });
    // Seed a prior cursor for beta so we can prove it was preserved.
    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.hookState = { alpha: { cursor: "a-old" }, beta: { cursor: "b-old" } };
    });

    await runJobNow(config, job.id, "manual");

    // alpha dispatched; beta skipped (deleted session).
    expect(tasksInSession(config, sessionA)).toHaveLength(1);
    // Only alpha's sub-state advanced; beta keeps its prior cursor to re-detect.
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({
      alpha: { cursor: "a-new" },
      beta: { cursor: "b-old" }
    });
    // The skip was audited.
    const audit = readState(config.instance).audit.find(
      (a) => a.action === "job.route.session_missing" && a.target === job.id
    );
    expect(audit).toBeDefined();
    // The run still finalized completed (one sibling dispatched).
    expect(readState(config.instance).jobRuns.find((r) => r.jobId === job.id)?.status).toBe("completed");
  });

  test("a silent watch's advanced cursor commits even when a sibling bucket dispatches", async () => {
    const config = buildConfig(workspaceRoot, "fanout-silent");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionA = "session_a";
    await createSession(config, sessionA);

    // The handler dispatches ONE bucket (alpha) and silently advances a SECOND
    // routeKey's cursor (gamma) without emitting any bucket for it — exactly what
    // detect does when it seeds a baseline / drops all mail as automated / a triage
    // tick only claimed mail. gamma's fresh cursor must still commit.
    __registerHookForTest("test-fanout-silent", async () => ({
      kind: "context",
      buckets: {
        alpha: [{ text: "alpha item", untrusted: false }]
      },
      state: { alpha: { cursor: "a-new" }, gamma: { cursor: "g-new" } }
    }));

    const job = await createScheduledJob(config, {
      name: "fanout-silent",
      intervalSeconds: 60,
      prompt: "handle",
      preRunHook: { handlerId: "test-fanout-silent", config: {} }
    });
    await setRoutes(config, job.id, {
      alpha: { chatSessionId: sessionA }
    });
    // Seed prior cursors so we can prove gamma advanced (not stayed at its old value).
    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.hookState = { alpha: { cursor: "a-old" }, gamma: { cursor: "g-old" } };
    });

    await runJobNow(config, job.id, "manual");

    // alpha dispatched; gamma silently advanced — BOTH slices committed.
    expect(tasksInSession(config, sessionA)).toHaveLength(1);
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({
      alpha: { cursor: "a-new" },
      gamma: { cursor: "g-new" }
    });
  });

  test("an empty buckets object falls through to the legacy flat path", async () => {
    const config = buildConfig(workspaceRoot, "fanout-empty-buckets");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const jobSession = "session_job";
    await createSession(config, jobSession);

    // A handler that returns an EMPTY buckets object (no routed mail) must behave
    // as the legacy single dispatch into the job session, not a no-op fan-out run.
    __registerHookForTest("test-fanout-empty-buckets", async () => ({
      kind: "context",
      buckets: {},
      state: { cursor: "z1" }
    }));

    const job = await createScheduledJob(config, {
      name: "fanout-empty-buckets",
      intervalSeconds: 60,
      prompt: "draft a reply",
      chatSessionId: jobSession,
      preRunHook: { handlerId: "test-fanout-empty-buckets", config: {} }
    });
    // No routes set.

    const result = await runJobNow(config, job.id, "manual");
    // Legacy path returns a single taskId (not a fan-out result).
    expect((result as { taskId?: string }).taskId).toBeString();
    expect((result as { fanOut?: boolean }).fanOut).toBeUndefined();

    const state = readState(config.instance);
    const jobTasks = state.tasks.filter((t) => t.jobId === job.id);
    expect(jobTasks).toHaveLength(1);
    // The hook state committed as a single opaque blob (legacy persistHookState).
    expect(state.jobs.find((j) => j.id === job.id)?.hookState).toEqual({ cursor: "z1" });
  });

  test("a flat items result with no routes takes exactly the legacy single dispatch", async () => {
    const config = buildConfig(workspaceRoot, "fanout-legacy");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const jobSession = "session_legacy";
    await createSession(config, jobSession);

    __registerHookForTest("test-flat-legacy", async () => ({
      kind: "context",
      items: [{ text: "matched flat", untrusted: false }],
      state: { cursor: "z1" }
    }));

    const job = await createScheduledJob(config, {
      name: "legacy",
      intervalSeconds: 60,
      prompt: "draft a reply",
      chatSessionId: jobSession,
      preRunHook: { handlerId: "test-flat-legacy", config: {} }
    });
    // No routes set.

    const result = await runJobNow(config, job.id, "manual");
    // Legacy path returns a single taskId (not a fan-out result).
    expect((result as { taskId?: string }).taskId).toBeString();
    expect((result as { fanOut?: boolean }).fanOut).toBeUndefined();

    const state = readState(config.instance);
    // Exactly one task, bound to the job (the legacy dispatchPromptRun path).
    const jobTasks = state.tasks.filter((t) => t.jobId === job.id);
    expect(jobTasks).toHaveLength(1);
    expect(jobTasks[0]!.input).toContain("draft a reply");
    expect(jobTasks[0]!.input).toContain("matched flat");
    // The hook's state committed as a single opaque blob (no per-bucket merge).
    expect(state.jobs.find((j) => j.id === job.id)?.hookState).toEqual({ cursor: "z1" });
  });
});
