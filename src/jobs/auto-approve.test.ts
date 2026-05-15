// Per-job auto-approve envelope tests. See ADR dangerously-auto-approve.md
// ("Per-job scope"). A scheduled job may opt into approval bypass for just
// its own spawned tasks via two optional JobRecord fields:
//   - autoApproveCommands: regex patterns matched against terminal commands.
//   - dangerouslyAutoApprove: full bypass for every approval-gated tool.
// At fire-time `dispatchPromptRun` clones the RuntimeConfig, overlays the
// envelope onto the clone, and submits the spawned task with the clone — so
// the operator's global config object never mutates.
//
// These tests verify:
//   1. autoApproveCommands on a job lets a terminal_exec fire-and-complete
//      without an approval row (allowlist fast-path; audit row carries the
//      matched pattern as autoApprovedReason).
//   2. dangerouslyAutoApprove on a job covers non-terminal tools too
//      (file_write through pendingOrAuto -> resolveApproval; approval row
//      written + immediately resolved; audit row carries
//      autoApprovedReason="dangerouslyAutoApprove").
//   3. Without the envelope, a job-spawned terminal_exec stalls in
//      waiting_approval (regression guard so the per-job opt-in stays
//      opt-in).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { createScheduledJob, runJobNow } from "./index";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-job-auto-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-job-auto-test-logs",
    ...opts
  };
}

async function waitForJobRun(config: RuntimeConfig, runId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const run = state.jobRuns.find((r) => r.id === runId);
    if (run && (run.status === "completed" || run.status === "failed")) return;
    await Bun.sleep(20);
  }
  throw new Error(`Job run ${runId} did not settle within ${timeoutMs}ms`);
}

async function waitForTaskSettled(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")) return;
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach a terminal/paused state within ${timeoutMs}ms`);
}

describe("per-job auto-approve envelope", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-job-auto-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("job autoApproveCommands lets terminal_exec fire unattended (allowlist fast path)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-job-auto-ws-"));
    // Config has NO global autoApproveCommands — the per-job envelope is
    // the only reason the spawned task should skip the approval gate.
    const config = buildConfig(workspaceRoot, "job-auto-allowlist");
    const provider = normalizeProvider(config.provider);

    // Echo provider drives the spawned chat-task: first response calls
    // terminal_exec, second response wraps up with a final assistant text.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hi" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "ran echo",
      toolCalls: [],
      finishReason: "stop"
    });

    // Pre-create a chat session so the job runs through the chat-task agent
    // loop (mode:"chat"). Without a session linkage the legacy imperative
    // path is taken, which only handles prefix-dispatch shapes and would
    // never invoke a `terminal_exec` tool call.
    const sessionId = "session_auto_allow";
    await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Job auto-allow",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
    });

    const job = await createScheduledJob(config, {
      name: "auto-allow",
      intervalSeconds: 60,
      prompt: "run echo hi",
      // matchAutoApprove uses a bash-glob subset (`*` = any chars, `?` =
      // any single char). Patterns are anchored — "echo *" matches
      // "echo hi" but not "rm -rf / && echo hi".
      autoApproveCommands: ["echo *"],
      chatSessionId: sessionId,
      oneShot: true
    });
    expect(job.autoApproveCommands).toEqual(["echo *"]);

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();
    // dispatchPromptRun for a chat-bound job returns the spawned task id.
    const taskId = (result as { taskId: string }).taskId;
    expect(taskId).toBeString();

    await waitForTaskSettled(config, taskId);
    const stateAfter = readState(config.instance);
    const task = stateAfter.tasks.find((t) => t.id === taskId);
    // Allowlist fast-path: the task must NOT stall at the approval gate.
    expect(task?.status).toBe("completed");

    // No approval row was created — allowlist bypasses approval entirely.
    const approvals = stateAfter.approvals.filter((a) => a.taskId === taskId);
    expect(approvals).toHaveLength(0);

    // But the side-effect audit row records why the human gate was skipped,
    // and the matched pattern is the per-job envelope's pattern.
    const execAudits = stateAfter.audit.filter((a) => a.action === "terminal.exec" && a.taskId === taskId);
    expect(execAudits).toHaveLength(1);
    expect(execAudits[0]?.evidence?.autoApproved).toBe(true);
    expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("echo *");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("job dangerouslyAutoApprove covers non-terminal tools (file_write through resolveApproval)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-job-auto-ws-"));
    // Global config does NOT set dangerouslyAutoApprove. Only the job's
    // envelope should trigger the bypass.
    const config = buildConfig(workspaceRoot, "job-auto-dangerous");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "from-job.txt", content: "by job" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "wrote it",
      toolCalls: [],
      finishReason: "stop"
    });

    const sessionId = "session_auto_dangerous";
    await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Job dangerous",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
    });

    const job = await createScheduledJob(config, {
      name: "auto-dangerous",
      intervalSeconds: 60,
      prompt: "write from-job.txt",
      dangerouslyAutoApprove: true,
      chatSessionId: sessionId,
      oneShot: true
    });
    expect(job.dangerouslyAutoApprove).toBe(true);

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();
    const taskId = (result as { taskId: string }).taskId;
    await waitForTaskSettled(config, taskId);

    const stateAfter = readState(config.instance);
    const task = stateAfter.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");

    // The approval row was written AND marked approved by the runtime.
    const approvals = stateAfter.approvals.filter((a) => a.taskId === taskId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("approved");
    expect(approvals[0]?.action).toBe("file.write");

    // approval.approved audit row carries the auto-approve marker — actor
    // is "runtime" because the bypass auto-resolved instead of a human.
    const approveAudits = stateAfter.audit.filter((a) => a.action === "approval.approved" && a.taskId === taskId);
    expect(approveAudits).toHaveLength(1);
    expect(approveAudits[0]?.actor).toBe("runtime");
    expect(approveAudits[0]?.evidence?.autoApprovedReason).toBe("dangerouslyAutoApprove");

    // Side-effect audit row stamped too.
    const writeAudits = stateAfter.audit.filter((a) => a.action === "file.write" && a.taskId === taskId);
    expect(writeAudits).toHaveLength(1);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("dangerouslyAutoApprove");

    // The file should land on disk.
    expect(await Bun.file(join(workspaceRoot, "from-job.txt")).text()).toBe("by job");

    // The operator's RuntimeConfig was NOT mutated — the per-job envelope
    // lives on the cloned config the spawned task saw.
    expect(config.dangerouslyAutoApprove).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a job WITHOUT the envelope stalls at the approval gate (regression guard)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-job-auto-ws-"));
    const config = buildConfig(workspaceRoot, "job-auto-none");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo no-bypass" }) } }
      ],
      finishReason: "tool_calls"
    });

    const sessionId = "session_auto_none";
    await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Job no envelope",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
    });

    const job = await createScheduledJob(config, {
      name: "no-envelope",
      intervalSeconds: 60,
      prompt: "run echo",
      chatSessionId: sessionId,
      oneShot: true
    });
    // Confirm the legacy default: both fields are absent.
    expect(job.autoApproveCommands).toBeUndefined();
    expect(job.dangerouslyAutoApprove).toBeUndefined();

    const result = await runJobNow(config, job.id, "manual");
    const taskId = (result as { taskId: string }).taskId;
    await waitForTaskSettled(config, taskId);

    const stateAfter = readState(config.instance);
    const task = stateAfter.tasks.find((t) => t.id === taskId);
    // Without the envelope the spawned task stalls — this is the exact bug
    // the per-job opt-in fixes when the user has explicitly asked for
    // unattended execution.
    expect(task?.status).toBe("waiting_approval");
    expect(task?.approvalIds.length).toBeGreaterThanOrEqual(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("createScheduledJob auto-approve validation", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-job-auto-val-"));
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

  test("rejects non-boolean dangerouslyAutoApprove", async () => {
    const config = buildConfig("/tmp", "job-validation-1");
    await expect(
      createScheduledJob(config, {
        name: "bad-flag",
        intervalSeconds: 60,
        prompt: "x",
        dangerouslyAutoApprove: "true" as unknown as boolean
      })
    ).rejects.toThrow(/dangerouslyAutoApprove must be a boolean/);
  });

  test("rejects non-array autoApproveCommands", async () => {
    const config = buildConfig("/tmp", "job-validation-2");
    await expect(
      createScheduledJob(config, {
        name: "bad-array",
        intervalSeconds: 60,
        prompt: "x",
        autoApproveCommands: "echo *" as unknown as string[]
      })
    ).rejects.toThrow(/autoApproveCommands must be an array/);
  });

  test("rejects non-string entries inside autoApproveCommands", async () => {
    const config = buildConfig("/tmp", "job-validation-3");
    await expect(
      createScheduledJob(config, {
        name: "bad-entry",
        intervalSeconds: 60,
        prompt: "x",
        autoApproveCommands: ["ok", 7 as unknown as string]
      })
    ).rejects.toThrow(/autoApproveCommands entries must be strings/);
  });

  test("rejects empty-string entries inside autoApproveCommands", async () => {
    const config = buildConfig("/tmp", "job-validation-4");
    await expect(
      createScheduledJob(config, {
        name: "empty-entry",
        intervalSeconds: 60,
        prompt: "x",
        autoApproveCommands: ["ok", ""]
      })
    ).rejects.toThrow(/non-empty strings/);
  });

  test("absent envelope keeps legacy behavior (no fields set on the JobRecord)", async () => {
    const config = buildConfig("/tmp", "job-validation-default");
    const job = await createScheduledJob(config, {
      name: "default",
      intervalSeconds: 60,
      prompt: "x"
    });
    expect(job.autoApproveCommands).toBeUndefined();
    expect(job.dangerouslyAutoApprove).toBeUndefined();
  });
});
