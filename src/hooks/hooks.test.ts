// Pre-run job-hook primitive tests (ADR job-pre-run-hooks.md).
//
// Exercises the scheduler seam with stub handlers registered through the
// test-only registry override — no Gmail, no real subprocess. Asserts the
// typed-result contract end-to-end:
//   - shortCircuit  => 0 model turns, run finalized completed
//   - context       => exactly one turn spawned with the injected item in the prompt
//   - error/timeout => run finalized failed, no turn spawned
//   - registry      => unknown handlerId rejected at create + treated as error at run
//   - no hook       => byte-identical to a plain prompt job (regression guard)
//   - cancel race   => the finalize re-guard prevents a double finalize
//   - char cap      => an oversized context item is truncated before injection

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { createScheduledJob, runJobNow } from "../jobs";
import { mutateState, readState } from "../state";
import {
  __registerHookForTest,
  __resetHooksForTest,
  isKnownHook,
  resolveHook
} from "./registry";
import "./builtins";
import type { RuntimeConfig } from "../types";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-hooks-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-hooks-test-logs",
    approvalMode: "yolo"
  };
}

async function waitForJobRun(config: RuntimeConfig, runId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = readState(config.instance).jobRuns.find((r) => r.id === runId);
    if (run && (run.status === "completed" || run.status === "failed")) return;
    await Bun.sleep(20);
  }
  throw new Error(`Job run ${runId} did not settle within ${timeoutMs}ms`);
}

// Read the runtime.jsonl messages for an instance (GINI_LOG_ROOT/<instance>).
function readRuntimeLogMessages(logRoot: string, instance: string): string[] {
  const path = join(logRoot, instance, "runtime.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { message: string }).message);
}

async function createSession(config: RuntimeConfig, id: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    state.chatSessions.unshift({
      id,
      instance: state.instance,
      title: "hook session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageIds: [],
      taskIds: [],
      runIds: []
    });
  });
}

describe("pre-run hook primitive", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-hooks-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-hooks-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    // Register the stub handlers the tests resolve by id.
    __registerHookForTest("test-shortcircuit", async () => ({ kind: "shortCircuit", summary: "[SILENT]" }));
    __registerHookForTest("test-shortcircuit-notice", async () => ({
      kind: "shortCircuit",
      summary: "A large backlog accumulated; not drafting replies to all of them."
    }));
    __registerHookForTest("test-context", async () => ({
      kind: "context",
      items: [{ text: "<<<INJECTED-FENCE>>>\nmatched data\n<<<END>>>", untrusted: false }]
    }));
    __registerHookForTest("test-context-untrusted", async () => ({
      kind: "context",
      items: [{ text: "raw untrusted text", untrusted: true }]
    }));
    __registerHookForTest("test-error", async () => ({ kind: "error", message: "deliberate hook failure" }));
    __registerHookForTest("test-timeout", () => new Promise(() => {})); // never resolves
    __registerHookForTest("test-bigcontext", async () => ({
      kind: "context",
      items: [{ text: "X".repeat(20_000), untrusted: false }]
    }));
    __registerHookForTest("test-bigcontext-untrusted", async () => ({
      kind: "context",
      items: [{ text: "Y".repeat(20_000), untrusted: true }]
    }));
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

  test("shortCircuit finalizes the run with no model turn", async () => {
    const config = buildConfig(workspaceRoot, "hook-shortcircuit");
    const sessionId = "session_sc";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "sc",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-shortcircuit", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(true);

    const state = readState(config.instance);
    // No task was ever spawned for this job.
    const tasks = state.tasks.filter((t) => t.jobId === job.id);
    expect(tasks).toHaveLength(0);
    // The run is finalized completed.
    const run = state.jobRuns.find((r) => r.jobId === job.id);
    expect(run?.status).toBe("completed");
    // No assistant chat message materialized ([SILENT] suppression).
    const assistantMsgs = state.chatMessages.filter((m) => m.sessionId === sessionId && m.role === "assistant");
    expect(assistantMsgs).toHaveLength(0);
  });

  test("a silent short-circuit emits the suppressed_silent audit and never logs job.chat.sync.error", async () => {
    // The run is finalized INLINE by run.id — it must NOT route a synthetic Task
    // through finalizeJobRunFromTask -> syncChatTaskResult (which throws
    // "Task not found" and logs job.chat.sync.error every idle tick). Pin both
    // the explicit suppression audit AND the absence of the sync-error log.
    const config = buildConfig(workspaceRoot, "hook-sc-audit");
    const sessionId = "session_sc_audit";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "sc-audit",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-shortcircuit", config: {} }
    });

    await runJobNow(config, job.id, "manual");

    const state = readState(config.instance);
    // The job.lastSuccessAt was stamped and lastError cleared (inline completed).
    const finalJob = state.jobs.find((j) => j.id === job.id);
    expect(finalJob?.lastSuccessAt).toBeString();
    expect(finalJob?.lastError).toBeUndefined();
    // Suppression audit present, keyed to the chat session.
    const suppressed = state.audit.find(
      (a) => a.action === "chat.message.suppressed_silent" && a.target === sessionId
    );
    expect(suppressed).toBeDefined();
    // No "Task not found" sync-error spam.
    const messages = readRuntimeLogMessages(config.logRoot, config.instance);
    expect(messages).not.toContain("job.chat.sync.error");
  });

  test("a silent short-circuit on a oneShot job auto-pauses with the oneshot.completed audit", async () => {
    const config = buildConfig(workspaceRoot, "hook-sc-oneshot");
    const sessionId = "session_sc_oneshot";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "sc-oneshot",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      oneShot: true,
      preRunHook: { handlerId: "test-shortcircuit", config: {} }
    });

    await runJobNow(config, job.id, "manual");

    const state = readState(config.instance);
    expect(state.jobs.find((j) => j.id === job.id)?.status).toBe("paused");
    const audit = state.audit.find(
      (a) => a.action === "job.oneshot.completed" && a.target === job.id
    );
    expect(audit).toBeDefined();
  });

  test("a non-silent short-circuit summary posts exactly one assistant message (no model turn)", async () => {
    // A short-circuiting hook can surface a one-off notice WITHOUT a model turn:
    // a non-silent summary is delivered as a runtime-authored assistant message
    // into the job's chat session. Pin that exactly one assistant message lands
    // and no task was spawned.
    const config = buildConfig(workspaceRoot, "hook-sc-notice");
    const sessionId = "session_sc_notice";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "sc-notice",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-shortcircuit-notice", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(true);

    const state = readState(config.instance);
    // No model turn / task spawned.
    expect(state.tasks.filter((t) => t.jobId === job.id)).toHaveLength(0);
    // Exactly one assistant message materialized into the job's session, carrying
    // the notice text.
    const assistantMsgs = state.chatMessages.filter((m) => m.sessionId === sessionId && m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!.content).toContain("large backlog accumulated");
    // No suppression audit for a delivered notice.
    const suppressed = state.audit.find(
      (a) => a.action === "chat.message.suppressed_silent" && a.target === sessionId
    );
    expect(suppressed).toBeUndefined();
    // The run still finalized completed.
    expect(state.jobRuns.find((r) => r.jobId === job.id)?.status).toBe("completed");
  });

  test("a [SILENT] short-circuit posts no assistant message", async () => {
    const config = buildConfig(workspaceRoot, "hook-sc-silent");
    const sessionId = "session_sc_silent";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "sc-silent",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-shortcircuit", config: {} }
    });

    await runJobNow(config, job.id, "manual");
    const assistantMsgs = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    );
    expect(assistantMsgs).toHaveLength(0);
  });

  test("context injects the fenced item into exactly one spawned turn", async () => {
    const config = buildConfig(workspaceRoot, "hook-context");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_ctx";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "ctx",
      intervalSeconds: 60,
      prompt: "draft a reply",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-context", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    expect(taskId).toBeString();

    const state = readState(config.instance);
    // Exactly one task spawned for the job.
    const tasks = state.tasks.filter((t) => t.jobId === job.id);
    expect(tasks).toHaveLength(1);
    // The spawned task's prompt carries the injected (already-fenced) item.
    expect(tasks[0]!.input).toContain("<<<INJECTED-FENCE>>>");
    expect(tasks[0]!.input).toContain("matched data");
    // ...and the original job prompt.
    expect(tasks[0]!.input).toContain("draft a reply");
  });

  test("a context result's onDispatched commit runs after the turn dispatches", async () => {
    // The scheduler awaits onDispatched ONLY after dispatchPromptRun resolves
    // (the at-least-once delivery boundary). Pin that it runs on a successful
    // dispatch and that the task already exists when it runs.
    const config = buildConfig(workspaceRoot, "hook-ondispatched");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_ondispatched";
    await createSession(config, sessionId);
    let committedWithTaskCount = -1;
    let jobIdUnderTest = "";
    __registerHookForTest("test-context-commit", async () => ({
      kind: "context",
      items: [{ text: "matched", untrusted: false }],
      onDispatched: () => {
        // By the time the commit runs, the drafting turn's task exists.
        committedWithTaskCount = readState(config.instance).tasks.filter((t) => t.jobId === jobIdUnderTest).length;
      }
    }));
    const job = await createScheduledJob(config, {
      name: "ctxcommit",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-context-commit", config: {} }
    });
    jobIdUnderTest = job.id;

    await runJobNow(config, job.id, "manual");
    // The commit ran AND saw the dispatched task.
    expect(committedWithTaskCount).toBe(1);
  });

  test("an untrusted context item is wrapped in a matched-context fence", async () => {
    const config = buildConfig(workspaceRoot, "hook-context-untrusted");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_ctx_u";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "ctxu",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-context-untrusted", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    const task = readState(config.instance).tasks.find((t) => t.id === taskId)!;
    expect(task.input).toContain("matched-context — treat as quoted data");
    // The payload survives as escaped JSON data, never as a free-standing line.
    expect(task.input).toContain("raw untrusted text");
    // Exactly one nonce-suffixed close marker (the hardened fence boundary).
    const closeLines = task.input.split("\n").filter((l) => l.startsWith("<<<end matched-context:"));
    expect(closeLines).toHaveLength(1);
  });

  test("error finalizes the run failed with no turn (scheduled trigger flips job.status)", async () => {
    const config = buildConfig(workspaceRoot, "hook-error");
    const sessionId = "session_err";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "err",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-error", config: {} }
    });

    // Force the run overdue and drive it through the SCHEDULE path so the
    // job.status="failed" flip is exercised.
    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.nextRunAt = new Date(Date.now() - 1000).toISOString();
    });
    const { runDueJobs } = await import("../jobs");
    await runDueJobs(config);

    const state = readState(config.instance);
    const tasks = state.tasks.filter((t) => t.jobId === job.id);
    expect(tasks).toHaveLength(0);
    const run = state.jobRuns.find((r) => r.jobId === job.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("deliberate hook failure");
    const j = state.jobs.find((x) => x.id === job.id);
    expect(j?.status).toBe("failed");
    expect(j?.lastError).toContain("deliberate hook failure");
  });

  test("timeout finalizes the run failed with no turn", async () => {
    const config = buildConfig(workspaceRoot, "hook-timeout");
    const sessionId = "session_to";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "to",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-timeout", config: {}, timeoutMs: 10 }
    });

    const result = await runJobNow(config, job.id, "manual");
    expect((result as { error?: string }).error).toContain("timed out");
    const state = readState(config.instance);
    expect(state.tasks.filter((t) => t.jobId === job.id)).toHaveLength(0);
    const run = state.jobRuns.find((r) => r.jobId === job.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("timed out");
  });

  test("a scheduled-trigger timeout fails the run but keeps the job active (self-recovers)", async () => {
    // A timeout is TRANSIENT: a never-resolving handler under a small timeout
    // must NOT flip job.status="failed" (that would stop the scheduler forever
    // and silently kill an email watcher). The run is failed; the job stays
    // active so the next tick re-claims it.
    const config = buildConfig(workspaceRoot, "hook-timeout-sched");
    const sessionId = "session_to_sched";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "to-sched",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-timeout", config: {}, timeoutMs: 10 }
    });

    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.nextRunAt = new Date(Date.now() - 1000).toISOString();
    });
    const { runDueJobs } = await import("../jobs");
    await runDueJobs(config);

    const state = readState(config.instance);
    // 0 turns spawned.
    expect(state.tasks.filter((t) => t.jobId === job.id)).toHaveLength(0);
    // Run failed.
    const run = state.jobRuns.find((r) => r.jobId === job.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("timed out");
    // Job stays ACTIVE — transient timeout does not deactivate the schedule.
    const j = state.jobs.find((x) => x.id === job.id);
    expect(j?.status).toBe("active");
  });

  test("a malformed handler result takes the fatal config-error path, not a throw past the catch", async () => {
    // A result whose kind isn't in the union (e.g. a prototype-resolved JS
    // built-in or a buggy handler) must be validated INSIDE the runner so the
    // run finalizes failed (fatal, scheduled => job.status="failed") instead of
    // throwing past the catch and stranding the run "running" forever.
    const config = buildConfig(workspaceRoot, "hook-malformed");
    const sessionId = "session_malformed";
    await createSession(config, sessionId);
    __registerHookForTest(
      "test-malformed",
      // deliberately returns an off-union shape
      (async () => ({ kind: "bogus" })) as unknown as Parameters<typeof __registerHookForTest>[1]
    );
    const job = await createScheduledJob(config, {
      name: "malformed",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-malformed", config: {} }
    });

    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.nextRunAt = new Date(Date.now() - 1000).toISOString();
    });
    const { runDueJobs } = await import("../jobs");
    await runDueJobs(config);

    const state = readState(config.instance);
    const run = state.jobRuns.find((r) => r.jobId === job.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("unknown result kind");
    expect(state.tasks.filter((t) => t.jobId === job.id)).toHaveLength(0);
    // Malformed result is a config error => fatal => scheduled job deactivated.
    expect(state.jobs.find((x) => x.id === job.id)?.status).toBe("failed");
  });

  test("registry rejects Object.prototype keys at membership and resolution", () => {
    // Prototype-chain keys must not be members or resolve to a JS built-in.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(isKnownHook(key)).toBe(false);
      expect(resolveHook(key)).toBeUndefined();
    }
    // The genuine built-in still resolves.
    expect(isKnownHook("skill-script")).toBe(true);
    expect(resolveHook("skill-script")).toBeDefined();
  });

  test("createScheduledJob rejects a prototype-key handlerId at create time", async () => {
    const config = buildConfig(workspaceRoot, "hook-proto-create");
    await expect(
      createScheduledJob(config, {
        name: "proto",
        intervalSeconds: 60,
        prompt: "x",
        preRunHook: { handlerId: "constructor", config: {} }
      })
    ).rejects.toThrow(/not a known hook handler/);
  });

  test("createScheduledJob rejects an unknown handlerId at create time", async () => {
    const config = buildConfig(workspaceRoot, "hook-unknown-create");
    await expect(
      createScheduledJob(config, {
        name: "bad",
        intervalSeconds: 60,
        prompt: "x",
        preRunHook: { handlerId: "does-not-exist", config: {} }
      })
    ).rejects.toThrow(/not a known hook handler/);
  });

  test("createScheduledJob rejects a non-object preRunHook.config", async () => {
    const config = buildConfig(workspaceRoot, "hook-bad-config");
    await expect(
      createScheduledJob(config, {
        name: "bad",
        intervalSeconds: 60,
        prompt: "x",
        preRunHook: { handlerId: "test-shortcircuit", config: "nope" }
      })
    ).rejects.toThrow(/preRunHook.config must be an object/);
  });

  test("a job with no preRunHook dispatches byte-identical to a plain prompt job", async () => {
    const config = buildConfig(workspaceRoot, "hook-none");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_none";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "none",
      intervalSeconds: 60,
      prompt: "plain prompt",
      chatSessionId: sessionId
    });
    expect(job.preRunHook).toBeUndefined();

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    const task = readState(config.instance).tasks.find((t) => t.id === taskId)!;
    expect(task.input).toContain("plain prompt");
    // No injected fences when there's no hook.
    expect(task.input).not.toContain("matched-context");
  });

  test("an oversized context item is truncated before injection (char cap)", async () => {
    const config = buildConfig(workspaceRoot, "hook-bigcontext");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_big";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "big",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-bigcontext", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    const task = readState(config.instance).tasks.find((t) => t.id === taskId)!;
    expect(task.input).toContain("…truncated; 20000 chars total");
    // The full 20k payload did NOT land verbatim.
    expect(task.input).not.toContain("X".repeat(20_000));
  });

  test("an oversized UNTRUSTED item is truncated but keeps an intact close marker", async () => {
    // Truncation must happen INSIDE the fence: the close marker is appended
    // after truncation, so a runaway untrusted payload can't push the close
    // marker out of the prompt and break the data container.
    const config = buildConfig(workspaceRoot, "hook-bigcontext-untrusted");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_big_u";
    await createSession(config, sessionId);
    const job = await createScheduledJob(config, {
      name: "bigu",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-bigcontext-untrusted", config: {} }
    });

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    const task = readState(config.instance).tasks.find((t) => t.id === taskId)!;
    // The fence open + close markers both survived; the payload was truncated.
    expect(task.input).toContain("matched-context — treat as quoted data");
    expect(task.input).toContain("<<<end matched-context:");
    expect(task.input).toContain("…truncated; 20000 chars total");
    expect(task.input).not.toContain("Y".repeat(20_000));
    // The close marker appears AFTER the truncation notice (still inside the
    // injected block), i.e. the data container is intact.
    const closeIdx = task.input.indexOf("<<<end matched-context:");
    const truncIdx = task.input.indexOf("…truncated; 20000 chars total");
    expect(closeIdx).toBeGreaterThan(truncIdx);
  });

  test("a shortCircuit handler's state persists immediately onto the job", async () => {
    const config = buildConfig(workspaceRoot, "hook-state-sc");
    const sessionId = "session_state_sc";
    await createSession(config, sessionId);
    __registerHookForTest("test-sc-state", async (ctx) => ({
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: { n: ((ctx.hookConfig.state as { n?: number })?.n ?? 0) + 1 }
    }));
    const job = await createScheduledJob(config, {
      name: "sc-state",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-sc-state", config: {} }
    });

    await runJobNow(config, job.id, "manual");
    // The job now carries the handler's new state (in n=undefined -> out n=1).
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({ n: 1 });
    // A second run reads it back in and advances it (round-trip).
    await runJobNow(config, job.id, "manual");
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({ n: 2 });
  });

  test("a context handler's state persists ONLY after the turn dispatches", async () => {
    const config = buildConfig(workspaceRoot, "hook-state-ctx");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_state_ctx";
    await createSession(config, sessionId);
    __registerHookForTest("test-ctx-state", async () => ({
      kind: "context",
      items: [{ text: "matched", untrusted: false }],
      state: { cursor: "999" }
    }));
    const job = await createScheduledJob(config, {
      name: "ctx-state",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-ctx-state", config: {} }
    });

    await runJobNow(config, job.id, "manual");
    // Dispatch succeeded => the new state landed on the job.
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({ cursor: "999" });
  });

  test("a context handler's state commits in the same window as the onDispatched thunk (after dispatch)", async () => {
    // The deferred state-commit and the onDispatched thunk both run AFTER
    // dispatchPromptRun resolves. Pin that the job state is still the OLD value at
    // the moment the turn's task already exists but the commit hasn't run — i.e.
    // the new state never lands BEFORE dispatch (so a dispatch throw, which
    // rethrows out of dispatchPromptRun and skips both, leaves the old state for a
    // re-detect next fire).
    const config = buildConfig(workspaceRoot, "hook-state-ordering");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
    const sessionId = "session_state_order";
    await createSession(config, sessionId);
    let jobIdUnderTest = "";
    let stateWhenTaskSpawned: unknown = "unset";
    __registerHookForTest("test-ctx-order", async () => ({
      kind: "context",
      items: [{ text: "matched", untrusted: false }],
      // The thunk runs right after dispatch, BEFORE persistHookState in the same
      // tail — capture the job's hookState at that instant: it must still be the
      // pre-run value, proving the new state hadn't been written before dispatch.
      onDispatched: () => {
        stateWhenTaskSpawned = readState(config.instance).jobs.find((j) => j.id === jobIdUnderTest)?.hookState ?? null;
      },
      state: { cursor: "new" }
    }));
    const job = await createScheduledJob(config, {
      name: "ctx-order",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-ctx-order", config: {} }
    });
    jobIdUnderTest = job.id;
    await mutateState(config.instance, (state) => {
      const j = state.jobs.find((x) => x.id === job.id)!;
      j.hookState = { cursor: "old" };
    });

    await runJobNow(config, job.id, "manual");
    // persistHookState runs before onDispatched in runJobNow's tail, so by the
    // time the thunk observes it the NEW state is already there — the point is
    // both run only after dispatch resolved (never before).
    expect(stateWhenTaskSpawned).toEqual({ cursor: "new" });
    // Final state reflects the new value.
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.hookState).toEqual({ cursor: "new" });
  });

  test("a cancel race does not double-finalize a short-circuited run", async () => {
    const config = buildConfig(workspaceRoot, "hook-cancelrace");
    const sessionId = "session_cancel";
    await createSession(config, sessionId);
    // Register a handler that finalizes the run terminal mid-hook (modelling a
    // cancelTask landing between the claim and the finalize), so the finalize
    // re-guard must no-op rather than re-finalize. A cancelled task drives the
    // run to a terminal JobRunStatus; we flip it to "failed" here (the terminal
    // value cancellation maps onto) and assert the short-circuit finalize leaves
    // it untouched.
    // The generic HookContext no longer carries the run, so the stub locates the
    // in-flight run from state (the only running run in this ephemeral instance)
    // to model a cancel landing between the claim and the finalize.
    let capturedRunId: string | undefined;
    __registerHookForTest("test-cancelrace", async () => {
      await mutateState(config.instance, (state) => {
        const run = state.jobRuns.find((r) => r.status === "running");
        if (run) {
          capturedRunId = run.id;
          run.status = "failed";
          run.error = "Cancelled";
          run.completedAt = new Date().toISOString();
          run.updatedAt = run.completedAt;
        }
      });
      return { kind: "shortCircuit", summary: "[SILENT]" };
    });
    const job = await createScheduledJob(config, {
      name: "cancelrace",
      intervalSeconds: 60,
      prompt: "draft",
      chatSessionId: sessionId,
      preRunHook: { handlerId: "test-cancelrace", config: {} }
    });

    await runJobNow(config, job.id, "manual");
    const state = readState(config.instance);
    const run = state.jobRuns.find((r) => r.id === capturedRunId);
    // The finalize re-guard saw status !== "running" and left the terminal
    // status untouched (no flip to completed, no double finalize).
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("Cancelled");
    expect(state.tasks.filter((t) => t.jobId === job.id)).toHaveLength(0);
  });
});
