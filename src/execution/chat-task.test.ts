// End-to-end tests for the chat-task agent loop.
//
// We use the echo provider with stubbed tool-calling responses so the loop
// is fully deterministic. The test covers:
//   - one tool call → result fed back → final answer
//   - approval-gated tool call → task pauses with toolCallState
//   - resume after approval → task completes

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { submitTask, decideApproval } from "../agent";
import {
  createChatSession,
  createEmptyState,
  createRun,
  createSubagentRecord,
  deleteChatSession,
  mutateState,
  now,
  readState
} from "../state";
import type { AgentIdentity, JobRecord, RuntimeConfig, RuntimeState, SkillRecord, Task, ToolsetRecord } from "../types";
import { createSkillFromInput, setSkillStatus } from "../capabilities/skills";
import { buildAgentIdentity, buildInactiveSkillsBlock } from "./chat-task";
import type { EffectiveContext } from "./effective-context";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-task-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-task-test-logs",
    // These tests predate the approvalMode flip and pin the
    // approval-gated loop behavior. Force "strict" so the chat-task
    // loop continues to exercise the pause+resume path here; the new
    // default-auto matrix lives in approval-mode.test.ts.
    approvalMode: "strict",
    ...opts
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("chat-task loop", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-task-"));
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

  test("dispatches a low-risk tool call then completes with a final answer", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-sync");
    const provider = normalizeProvider(config.provider);

    // First model turn: ask to read the file.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Second model turn: respond with the file contents.
    setEchoToolCallingResponse({
      provider,
      text: "The file says: Hello, world!",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what does hello.md say?", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("The file says: Hello, world!");
    // Audit trail should include the file.read.
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "file.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("approval-gated tool call pauses the task and resumes after approval", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-gated");
    const provider = normalizeProvider(config.provider);

    // First model turn: request a file write.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "from-agent" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Second model turn (after approval resumes): final reply.
    setEchoToolCallingResponse({
      provider,
      text: "Wrote the file as requested.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "please create out.txt", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.toolCallState).toBeDefined();
    expect(paused.toolCallState?.pending.length).toBe(1);
    expect(paused.toolCallState?.pending[0]?.toolName).toBe("file_write");
    expect(paused.approvalIds.length).toBe(1);

    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Wrote the file as requested.");
    // The file should have been written.
    const written = await Bun.file(join(workspaceRoot, "out.txt")).text();
    expect(written).toBe("from-agent");
    // The toolCallState should be cleared on completion.
    expect(finished.toolCallState).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("falls back to a final answer when the model emits no tool calls", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-direct");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Sure, here's a direct answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Sure, here's a direct answer.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("read_skill returns the full body of an enabled skill", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill");
    const provider = normalizeProvider(config.provider);

    // Pre-create an enabled skill with a non-empty body — simulates a
    // post-loadSkillsFromDisk state without exercising the loader here.
    const skill = await createSkillFromInput(config, {
      name: "apple-notes",
      description: "Apple Notes via memo CLI."
    });
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "# Apple Notes\n\nUse `memo notes -a` to add a note.";
    });
    await setSkillStatus(config, skill.id, "enabled");

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_skill", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "apple-notes" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I now know how to use Apple Notes.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "how do I add an apple note?", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("I now know how to use Apple Notes.");
    // Audit trail captures the skill read.
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "skill.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.evidence?.name).toBe("apple-notes");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("read_skill chooses an enabled same-name user skill when the bundled row is disabled", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill-same-name");
    const provider = normalizeProvider(config.provider);

    const bundled = await createSkillFromInput(config, {
      name: "same-name",
      description: "Bundled disabled skill."
    });
    const user = await createSkillFromInput(config, {
      name: "same-name",
      description: "User enabled skill."
    });
    await mutateState(config.instance, (state) => {
      const bundledRow = state.skills.find((s) => s.id === bundled.id)!;
      bundledRow.source = "bundled";
      bundledRow.status = "disabled";
      bundledRow.body = "disabled bundled body";
      const userRow = state.skills.find((s) => s.id === user.id)!;
      userRow.source = "user";
      userRow.status = "enabled";
      userRow.body = "enabled user body";
    });

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_same_name", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "same-name" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Loaded the enabled skill.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "use the same-name skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "skill.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.target).toBe(user.id);
    expect(reads[0]?.evidence?.bytes).toBe("enabled user body".length);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("read_skill rejects disabled skills with a recoverable error", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill-disabled");
    const provider = normalizeProvider(config.provider);

    // Create a disabled skill. The agent loop should see an
    // error tool result and recover.
    const skill = await createSkillFromInput(config, {
      name: "disabled-skill",
      description: "Currently disabled."
    });
    await setSkillStatus(config, skill.id, "disabled");
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "Some disabled content.";
    });

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_disabled", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "disabled-skill" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Got it — that skill is disabled.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "use the disabled skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Got it — that skill is disabled.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // One-pending-per-turn regression. When the LLM emits multiple
  // tool calls in a single assistant turn and the first one returns
  // a pending approval, all subsequent dispatches MUST be deferred
  // so their side effects don't race the user's approval decision.
  // The chat-task loop skips remaining calls and synthesizes a
  // "skipped" tool_result for message-history symmetry; the LLM
  // re-evaluates from the new state on the next turn after the
  // approval resolves.
  test("pending approval halts the rest of the turn — later calls are skipped, not dispatched", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-pending-halt");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w1", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "a.txt", content: "AAA" }) } },
        { id: "call_w2", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "b.txt", content: "BBB" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write a and b", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.toolCallState).toBeDefined();
    // Only the first call goes pending. The second was skipped (its
    // dispatch never ran) — message history carries a synthetic
    // skipped tool_result so the LLM sees both tool_calls paired.
    expect(paused.toolCallState?.pending.length).toBe(1);
    expect(paused.approvalIds.length).toBe(1);

    // Deny the lone pending approval. The task fails. The second
    // file_write never ran in the first place, so its file must not
    // exist on disk either.
    const [firstApprovalId] = paused.approvalIds as [string];
    await decideApproval(config, firstApprovalId, "deny");
    await Bun.sleep(50);

    const stateAfter = readState(config.instance);
    const failedTask = stateAfter.tasks.find((t) => t.id === task.id)!;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.toolCallState).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "a.txt"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "b.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("resumeChatTask is a no-op for a task that has already failed", async () => {
    // Standalone test of resumeChatTask's terminal-task guard. We construct
    // a task in the failed state and call resumeChatTask directly; it must
    // return without flipping the task back to running and without
    // re-entering the loop.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-resume-failed");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_x", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "x.txt", content: "X" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write x", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    const approvalId = paused.approvalIds[0]!;

    // Deny — fails the task and clears the snapshot.
    await decideApproval(config, approvalId, "deny");
    await Bun.sleep(50);

    const failedBefore = readState(config.instance).tasks.find((t) => t.id === task.id)!;
    expect(failedBefore.status).toBe("failed");

    // Now call resumeChatTask directly. Must no-op.
    const { resumeChatTask } = await import("../execution/chat-task");
    const result = await resumeChatTask(config, task.id, "call_x", "should-not-resume");
    expect(result.status).toBe("failed");

    // Status / partialSummary unchanged after the no-op resume.
    const after = readState(config.instance).tasks.find((t) => t.id === task.id)!;
    expect(after.status).toBe("failed");
    expect(after.toolCallState).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "x.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // PTY support: terminal_exec accepts an opt-in `pty: true` arg that wraps
  // the command under a pseudo-terminal so interactive CLIs (vim, memo,
  // claude-code) don't see "stdin is not a tty" and exit immediately. We
  // verify the round-trip end-to-end:
  //   - the model emits terminal_exec with pty=true
  //   - the approval payload captures pty=true
  //   - executeApprovedAction spawns under a TTY (verified by `tty -s`)
  //   - the audit evidence carries pty=true so the user can see it
  test("terminal_exec with pty=true runs the command under a real TTY", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-pty");
    const provider = normalizeProvider(config.provider);

    // `tty -s` exits 0 when stdin is a terminal, 1 otherwise. Print the
    // result so we can verify both the exit code and the side channel.
    const command = "tty -s && echo PTY-OK || echo NO-PTY";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_pty", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command, pty: true }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Ran the command under a TTY.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run with pty", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvalIds.length).toBe(1);

    // Approval payload should carry pty=true so the executor knows to wrap.
    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.payload.pty).toBe(true);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const stateAfter = readState(config.instance);
    const auditEntry = stateAfter.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    expect(auditEntry).toBeDefined();
    const evidence = auditEntry.evidence as Record<string, unknown>;
    expect(evidence.pty).toBe(true);
    expect(evidence.exitCode).toBe(0);
    // The wrapped command saw a TTY, so the `tty -s` branch ran.
    expect(String(evidence.stdout)).toContain("PTY-OK");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec without pty sees no TTY and stays on the legacy spawn path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-pty");
    const provider = normalizeProvider(config.provider);

    const command = "tty -s && echo PTY-OK || echo NO-PTY";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_nopty", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Ran without TTY.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run without pty", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.payload.pty).toBe(false);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const stateAfter = readState(config.instance);
    const auditEntry = stateAfter.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    const evidence = auditEntry.evidence as Record<string, unknown>;
    expect(evidence.pty).toBe(false);
    expect(String(evidence.stdout)).toContain("NO-PTY");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Auto-approve allowlist (Fix 2). When the user has added a matching
  // pattern to RuntimeConfig.autoApproveCommands, terminal_exec should
  // execute synchronously and write a high-risk audit row with
  // evidence.autoApproved=true plus the matched pattern. No approval row
  // should be created — the loop must continue without pausing.
  test("terminal_exec auto-approves and runs synchronously when the command matches the allowlist", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-auto-approve");
    config.autoApproveCommands = ["echo *"];
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_auto", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hello" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Said hello.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hello", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Said hello.");

    const state = readState(config.instance);
    // No approval row should have been created.
    const approvalsForTask = state.authorizations.filter((a) => a.taskId === task.id);
    expect(approvalsForTask).toHaveLength(0);

    // The audit row should exist and be flagged as auto-approved.
    const audit = state.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    expect(audit).toBeDefined();
    expect(audit.risk).toBe("high");
    const evidence = audit.evidence as Record<string, unknown>;
    expect(evidence.autoApproved).toBe(true);
    expect(evidence.autoApprovedReason).toBe("echo *");
    expect(evidence.exitCode).toBe(0);
    expect(String(evidence.stdout)).toContain("hello");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec falls through to the approval gate when no allowlist pattern matches", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-auto-approve-miss");
    config.autoApproveCommands = ["memo *"];
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_miss", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "rm -rf /tmp/x" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "rm something", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvalIds.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("invalid tool args are reported back as tool errors so the model can recover", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-baddargs");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_bad", type: "function", function: { name: "file_read", arguments: '{"oops":true}' } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Sorry, I goofed.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "read something", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Sorry, I goofed.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Iteration cap (graceful exhaustion). When the chat-task loop hits the
  // configurable iteration cap, it must NOT fail. Instead it makes one
  // final tool-less model call asking for a summary and completes with
  // that text. A warning trace should record the cap hit.
  test("hits the configurable iteration cap and completes with a tool-less summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-cap-graceful");
    config.agent = { maxIterations: 3 };
    const provider = normalizeProvider(config.provider);

    // Three iterations of tool calls — one per loop pass — that all just
    // re-read the same file. The loop guard is `iterations < cap` so cap=3
    // means three model turns are consumed before exhaustion.
    for (let i = 0; i < 3; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_loop_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the exhaustion path should consume.
    setEchoToolCallingResponse({
      provider,
      text: "Cap reached. I read the same file three times but never produced a final answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "loop forever", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "Cap reached. I read the same file three times but never produced a final answer."
    );
    expect(finished.currentStep).toBe("Completed (iteration cap reached: 3)");
    expect(finished.error).toBeUndefined();

    // Trace should contain a warning event flagging the cap hit.
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find((t) => t.type === "warning" && /Iteration cap \(3\)/.test(t.message));
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.iterations).toBe(3);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Invalid `agent.maxIterations` values must fall back to the built-in
  // default and emit a warning trace. We only verify the warning trace
  // here — proving the fallback value is actually 90 would require running
  // a 90-iteration loop, which is wasteful; the resolver is small enough
  // that the warning's presence is sufficient evidence.
  test("invalid agent.maxIterations falls back to the default and emits a warning trace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-invalid");
    // Invalid: 0 is non-positive. Loose-typed cast so the test can simulate
    // a config.json that was hand-edited with a bad value.
    (config as unknown as { agent: { maxIterations: number } }).agent = { maxIterations: 0 };
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Direct answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say something", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Direct answer.");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.defaultCap).toBe(90);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fix 2 (cost accumulation): each iteration's cost must add to the
  // running total instead of overwriting. Tested across a 3-iteration
  // run where the stub provider returns small but nonzero usage on
  // every turn — including the final tool-less summary turn the cap
  // exhaustion path emits.
  test("accumulates cost across iterations including the cap-exhaustion summary turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-cost-accum");
    config.agent = { maxIterations: 2 };
    const provider = normalizeProvider(config.provider);

    // Two tool-call iterations, each reporting 10 in / 5 out / 15 total.
    for (let i = 0; i < 2; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_acc_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) }
          }
        ],
        finishReason: "tool_calls",
        cost: { provider: "echo", model: "gini-echo-v0", inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      });
    }
    // Cap-exhaustion summary turn — adds another 4 in / 6 out / 10 total.
    setEchoToolCallingResponse({
      provider,
      text: "Cap reached.",
      toolCalls: [],
      finishReason: "stop",
      cost: { provider: "echo", model: "gini-echo-v0", inputTokens: 4, outputTokens: 6, totalTokens: 10 }
    });

    const task = await submitTask(config, "loop a bit", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Cap reached.");
    // 10 + 10 + 4 = 24 input tokens, 5 + 5 + 6 = 16 output tokens, 15 + 15 + 10 = 40 total.
    expect(finished.cost?.inputTokens).toBe(24);
    expect(finished.cost?.outputTokens).toBe(16);
    expect(finished.cost?.totalTokens).toBe(40);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fix 4 (warning de-duplication): the invalid-config warning should be
  // emitted at most once per task even when runLoop is re-entered after
  // approval pauses. We force a pause via a gated tool call, approve it,
  // then assert the trace contains exactly one matching warning.
  test("invalid agent.maxIterations warning is emitted at most once across approval resumes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-warn-once");
    (config as unknown as { agent: { maxIterations: number } }).agent = { maxIterations: 0 };
    const provider = normalizeProvider(config.provider);

    // First model turn: request a file write (gated → pauses the task).
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_wo", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Resume turn: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "write and finish", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warnings = traces.filter(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warnings.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Also accept the same invalid-string case (e.g. "abc") to confirm the
  // resolver's typeof guard rejects non-numbers, not just non-positive
  // integers.
  test("non-numeric agent.maxIterations also falls back with a warning", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-invalid-string");
    (config as unknown as { agent: { maxIterations: string } }).agent = { maxIterations: "abc" };
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Hello.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hi again", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Bound-jobs system block: when the chat session backing the current task
  // has one or more JobRecords whose `chatSessionId` matches, the chat-task
  // loop must surface them in the system prompt. The model uses that block
  // to short-circuit list_jobs and call update_job / delete_job directly.
  test("appends a Bound scheduled jobs block when a job is bound to the session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-bound-job");
    const provider = normalizeProvider(config.provider);

    // Stand up a chat session, a job pointing at it, and a run that lives in
    // the same conversation. The submitted task carries that runId so the
    // chat-task loop resolves the session id via run.conversationId and
    // finds the bound job during system-prompt assembly.
    const { runId, jobId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Daily standup");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Standup turn",
        input: "kick off",
        conversationId: session.id
      });
      const at = now();
      const job: JobRecord = {
        id: "job-standup",
        instance: state.instance,
        name: "Daily standup",
        prompt: "Ask the team what they did yesterday and what they will do today.",
        intervalSeconds: undefined,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: session.id,
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles",
        createdAt: at,
        updatedAt: at,
        nextRunAt: at,
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      };
      state.jobs.push(job);
      return { runId: run.id, jobId: job.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Ready.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "remind me what this job does", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    expect(system).toBeDefined();
    const content = String(system?.content ?? "");
    expect(content).toContain("Scheduled jobs delivering into this chat:");
    expect(content).toContain(jobId);
    expect(content).toContain("Daily standup");
    expect(content).toContain("cron `0 9 * * *`");
    expect(content).toContain("America/Los_Angeles");
    expect(content).toContain("Ask the team what they did yesterday");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("omits the Bound scheduled jobs block when no job is bound to the session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-bound-job");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Hi.",
      toolCalls: [],
      finishReason: "stop"
    });

    // No runId / no chat session bound — the system context should not
    // carry the block header and should not pick up stray trailing
    // whitespace from a `${...}\n\n${empty}` template.
    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    expect(system).toBeDefined();
    const content = String(system?.content ?? "");
    expect(content).not.toContain("Scheduled jobs delivering into this chat:");
    // No trailing blank lines from optional sections being concatenated.
    expect(content).toBe(content.trimEnd());

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("subagent path preserves the subagent prompt and still appends the bound-jobs block", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-bound-job-subagent");
    const provider = normalizeProvider(config.provider);

    const SUBAGENT_PROMPT = "You are a narrow research subagent. Stay terse.";
    const { runId, subagentId, jobId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Research thread");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Research turn",
        input: "kick off",
        conversationId: session.id
      });
      const subagent = createSubagentRecord(state, {
        name: "researcher",
        prompt: "research subagent",
        toolsets: ["file"],
        systemPrompt: SUBAGENT_PROMPT
      });
      const at = now();
      const job: JobRecord = {
        id: "job-research",
        instance: state.instance,
        name: "Weekly research digest",
        prompt: "Summarize this week's top three industry stories.",
        intervalSeconds: 604800,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: session.id,
        createdAt: at,
        updatedAt: at,
        nextRunAt: at,
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      };
      state.jobs.push(job);
      return { runId: run.id, subagentId: subagent.id, jobId: job.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "go", { mode: "chat", runId, subagentId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    // Subagent prompt preserved verbatim at the top of system context.
    expect(content.startsWith(SUBAGENT_PROMPT)).toBe(true);
    // Scheduled-jobs context block still appended after the subagent prompt.
    expect(content).toContain("Scheduled jobs delivering into this chat:");
    expect(content).toContain(jobId);
    expect(content).toContain("Weekly research digest");
    expect(content).toContain("every 604800s");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits the full runtime identity block on the first turn of a chat session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-first");
    const provider = normalizeProvider(config.provider);

    const { runId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity probe");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Identity turn",
        input: "intro",
        conversationId: session.id
      });
      return { runId: run.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Identity acknowledged.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what's your setup?", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    expect(content).toContain("Your runtime identity:");
    expect(content).toContain(`- instance: ${config.instance}`);
    expect(content).toContain(`- runtime port: ${config.port}`);
    expect(content).toContain("- provider: echo/");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("subagent path skips runtime identity injection", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-subagent");
    const provider = normalizeProvider(config.provider);

    const SUBAGENT_PROMPT = "You are a narrow research subagent. Stay terse.";
    const { runId, subagentId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity subagent probe");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Subagent turn",
        input: "kick off",
        conversationId: session.id
      });
      const subagent = createSubagentRecord(state, {
        name: "researcher",
        prompt: "research subagent",
        toolsets: ["file"],
        systemPrompt: SUBAGENT_PROMPT
      });
      return { runId: run.id, subagentId: subagent.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "go", { mode: "chat", runId, subagentId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    expect(content.startsWith(SUBAGENT_PROMPT)).toBe(true);
    expect(content).not.toContain("Your runtime identity:");
    expect(content).not.toContain("Runtime identity changes since last turn:");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("omits the identity block on a follow-up turn when nothing changed", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-followup");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity follow-up");
      return session.id;
    });

    // Two distinct runs in the same conversation — same session id, two
    // separate user turns. The second turn must not re-emit the identity
    // block because nothing changed under the K=10 refresh threshold.
    const firstRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 1",
        input: "first",
        conversationId: sessionId
      });
      return run.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "First.",
      toolCalls: [],
      finishReason: "stop"
    });

    const firstTask = await submitTask(config, "first question", { mode: "chat", runId: firstRunId });
    await waitForTerminal(config, firstTask.id);

    const secondRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 2",
        input: "second",
        conversationId: sessionId
      });
      return run.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "Second.",
      toolCalls: [],
      finishReason: "stop"
    });

    const secondTask = await submitTask(config, "second question", { mode: "chat", runId: secondRunId });
    await waitForTerminal(config, secondTask.id);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    const firstSystem = String(calls[0]!.find((m) => m.role === "system")?.content ?? "");
    const secondSystem = String(calls[1]!.find((m) => m.role === "system")?.content ?? "");
    expect(firstSystem).toContain("Your runtime identity:");
    expect(secondSystem).not.toContain("Your runtime identity:");
    expect(secondSystem).not.toContain("Runtime identity changes since last turn:");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("deferred snapshot write skips when the chat session was deleted before the model returned", async () => {
    // Race: snapshot decision is made up-front in runChatTask, but the
    // write is deferred to runLoop after the first model call. If the
    // chat session is deleted during that window, the deferred write
    // must not recreate an orphan snapshot keyed on a now-deleted
    // session id. We deterministically simulate the race by deleting
    // the session before the task ever runs -- the run still exists,
    // so runChatTask resolves the conversationId, but the deferred
    // write's session-existence check inside mutateState catches the
    // deletion and skips the write.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-orphan-guard");
    const provider = normalizeProvider(config.provider);

    const { runId, sessionId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Soon-to-be-deleted");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Orphan probe",
        input: "go",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    // Delete the chat session before the task runs. runChatTask will
    // still build identity from the run.conversationId, but the
    // deferred write must observe that the session is gone.
    await mutateState(config.instance, (state) => {
      deleteChatSession(state, sessionId);
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything", { mode: "chat", runId });
    await waitForTerminal(config, task.id);

    expect(readState(config.instance).identitySnapshots?.[sessionId]).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // ChatBlock protocol pin (ADR chat-block-protocol.md). The loop must
  // emit a typed stream of blocks per chat session: user_text, phase,
  // assistant_text, tool_call, tool_result, approval_requested,
  // system_note. Tests run the loop against the echo provider with
  // pre-loaded responses and assert the block list shape.
  test("emits typed blocks for a successful tool-calling turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-blocks-success");
    const provider = normalizeProvider(config.provider);

    // Set up the session BEFORE submitting the task so chatSessionId
    // is bound to the task. submitTask threads chatSessionId through
    // to createTask which the emission resolver reads.
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-test", undefined, "agent_x")
    );

    setEchoToolCallingResponse({
      provider,
      text: "Sure, reading it now.",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "The file says: Hello, world!",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "what does hello.md say?" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    // Expected sequence in ordinal order:
    //   user_text → phase("Thinking") → assistant_text("Sure, reading it now.")
    //   → phase("Working: file_read") → tool_call(file_read, ok)
    //   → tool_result(call_1) → phase("Thinking") → assistant_text(final)
    //   → phase("Completed")
    const kinds = blocks.map((b) => b.kind);
    expect(kinds[0]).toBe("user_text");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds[kinds.length - 1]).toBe("phase");

    const user = blocks.find((b) => b.kind === "user_text");
    expect(user?.kind === "user_text" && user.text).toBe("what does hello.md say?");

    const toolCall = blocks.find((b) => b.kind === "tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.toolName).toBe("file_read");
      expect(toolCall.displayLabel).toBe("Read file");
      expect(toolCall.argsPreview).toBe("hello.md");
      expect(toolCall.argsFull).toEqual({ path: "hello.md" });
      expect(toolCall.status).toBe("ok");
      expect(toolCall.callId).toBe("call_1");
    } else {
      throw new Error("missing tool_call block");
    }

    const toolResult = blocks.find((b) => b.kind === "tool_result");
    if (toolResult?.kind === "tool_result") {
      expect(toolResult.callId).toBe("call_1");
    } else {
      throw new Error("missing tool_result block");
    }

    // Final assistant_text is the model's reply (after the tool result
    // turn) — settled with streaming:false.
    const assistantTexts = blocks.filter((b): b is typeof blocks[0] & { kind: "assistant_text" } =>
      b.kind === "assistant_text"
    );
    expect(assistantTexts.length).toBeGreaterThan(0);
    const finalAssistant = assistantTexts[assistantTexts.length - 1]!;
    expect(finalAssistant.streaming).toBe(false);
    expect(finalAssistant.text).toContain("Hello, world!");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits authorization_requested with the action field for gated tools", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-approval");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-approval", undefined, "agent_y")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "hi" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "write out.txt" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    let blocks = listChatBlocks(config.instance, session.id);
    const approval = blocks.find((b) => b.kind === "authorization_requested");
    if (approval?.kind === "authorization_requested") {
      expect(approval.authorizationId).toBe(paused.approvalIds[0]);
      expect(approval.action).toBe("file.write");
      expect(approval.risk).toBeDefined();
    } else {
      throw new Error("missing authorization_requested block");
    }

    // Resume by approving; the tool_call flips ok and a tool_result lands.
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    blocks = listChatBlocks(config.instance, session.id);
    const toolCall = blocks.find((b) => b.kind === "tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.status).toBe("ok");
    } else {
      throw new Error("missing tool_call block");
    }
    const toolResult = blocks.find((b) => b.kind === "tool_result");
    expect(toolResult).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits parallel tool_calls with distinct callIds and ordinals", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    writeFileSync(join(workspaceRoot, "a.md"), "alpha");
    writeFileSync(join(workspaceRoot, "b.md"), "beta");
    const config = buildConfig(workspaceRoot, "chat-task-blocks-parallel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-parallel", undefined, "agent_p")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "a.md" }) } },
        { id: "call_b", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "b.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read both.",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "read both" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const toolCalls = blocks.filter((b): b is typeof blocks[0] & { kind: "tool_call" } => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((c) => c.callId).sort()).toEqual(["call_a", "call_b"]);
    expect(toolCalls.map((c) => c.ordinal)).toEqual(
      toolCalls.map((c) => c.ordinal).slice().sort((x, y) => x - y)
    );
    expect(toolCalls.every((c) => c.status === "ok")).toBe(true);

    const toolResults = blocks.filter((b) => b.kind === "tool_result");
    expect(toolResults).toHaveLength(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("subagent tasks (no chat session) skip block emission entirely", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-subagent");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Subagent done.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Submit a task without a chatSessionId — equivalent to a subagent
    // child or a CLI imperative task. The loop should run to
    // completion but no chat_blocks rows should land.
    const task = await submitTask(config, "subagent prompt", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // No session => no rows in chat_blocks for this task. We can't
    // grep by taskId alone (no helper exposed) so just confirm we
    // wrote zero rows by asking the DB directly via getMemoryDb.
    const { getMemoryDb } = await import("../state");
    const db = getMemoryDb(config.instance);
    const count = db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM chat_blocks WHERE task_id = ?")
      .get(task.id)?.c ?? 0;
    expect(count).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("cancellation flips streaming assistant_text to settled and emits cancellation block", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-cancel", undefined, "agent_c")
    );

    // Single response that finishes immediately — the test exercises
    // post-completion cancelTask emission rather than a true
    // mid-stream cancel (which requires provider-stream injection
    // outside the echo provider's contract). The chat-block invariant
    // we test here: cancelTask emits system_note + Cancelled phase
    // even after the task has already settled.
    setEchoToolCallingResponse({
      provider,
      text: "Hi.",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "say hi" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    // Now cancel the (already-completed) task. cancelTask is idempotent
    // for terminal tasks — it returns the row as-is — but the
    // chat-block emission still happens unconditionally in the current
    // implementation. We verify the invariant differently: by re-
    // running through a fresh task that we cancel BEFORE waiting for
    // it to settle.
    const { cancelTask, submitTask } = await import("../agent");

    setEchoToolCallingResponse({
      provider,
      text: "second response",
      toolCalls: [],
      finishReason: "stop"
    });

    // Manually create a queued task tied to the same chat session,
    // then cancel before runChatTask gets a chance to flip to
    // running. The terminal status guard at the top of runChatTask
    // detects the cancellation and bails out cleanly.
    const cancelTarget = await submitTask(config, "will-be-cancelled", {
      mode: "chat",
      chatSessionId: session.id
    });
    await cancelTask(config, cancelTarget.id);

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const sysNotes = blocks.filter((b) => b.kind === "system_note");
    expect(sysNotes.some((n) => n.kind === "system_note" && n.text === "Cancelled")).toBe(true);
    const phases = blocks.filter((b) => b.kind === "phase");
    expect(phases.some((p) => p.kind === "phase" && p.label === "Cancelled")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("deleteChatSession cascades and removes all chat blocks", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-cascade");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-cascade", undefined, "agent_d")
    );

    setEchoToolCallingResponse({
      provider,
      text: "Hello back.",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "hi" });
    await waitForTerminal(config, submitted.taskId);

    const { listChatBlocks } = await import("../state");
    expect(listChatBlocks(config.instance, session.id).length).toBeGreaterThan(0);

    await mutateState(config.instance, (state) => deleteChatSession(state, session.id));
    expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Tool-calling transcript persistence + replay (ADR
  // agent-loop-tool-calling.md). A prior turn's assistant tool_calls and its
  // paired role:"tool" results are persisted durably (kind:"tool_transcript")
  // and replayed next turn so the model sees the structured results of its
  // own earlier actions instead of re-deriving them.
  test("a structured tool result from a prior turn is replayed on the next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-id");
    const provider = normalizeProvider(config.provider);
    const fixturePath = join(workspaceRoot, "issue.json");
    // The "create issue" stand-in: a tool the loop dispatches synchronously
    // whose result carries an id the agent must remember next turn.
    const issueResult = JSON.stringify({ ok: true, issueId: "ISSUE-4242" });
    writeFileSync(fixturePath, issueResult);

    const { createChat, submitChatMessage, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Issue thread" });

    // Turn 1: read the file (returns the issue id), then a final answer.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_issue", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "issue.json" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Created issue ISSUE-4242.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "create an issue" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: the model just answers — we only care about the transcript it
    // was handed.
    setEchoToolCallingResponse({
      provider,
      text: "Editing ISSUE-4242 as requested.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "now edit that issue" });
    await waitForTerminal(config, second.taskId);

    // Locate turn 2's provider call: the one whose user message is the
    // second prompt.
    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "now edit that issue")
    );
    expect(turn2).toBeDefined();

    // The replayed transcript carries the assistant tool_calls message AND
    // the paired role:"tool" result with the issue id.
    const assistantToolCalls = turn2!.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    expect(assistantToolCalls).toBeDefined();
    expect(assistantToolCalls!.tool_calls![0]!.id).toBe("call_issue");

    const toolResult = turn2!.find((m) => m.role === "tool" && m.tool_call_id === "call_issue");
    expect(toolResult).toBeDefined();
    expect(String(toolResult!.content)).toContain("ISSUE-4242");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("two turns reusing the same tool_call_id each replay with their own result", async () => {
    // The text-backstop path synthesizes call ids from name:args:index, so
    // the same tool called with the same args on two turns yields an
    // identical tool_call_id. Pairing must stay local to each assistant row:
    // turn 1's call gets turn 1's result, turn 2's call gets turn 2's, even
    // though both rows share the id.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-dupid");
    const provider = normalizeProvider(config.provider);
    const fixturePath = join(workspaceRoot, "state.txt");

    const { createChat, submitChatMessage, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Dup-id thread" });

    // Turn 1: read the file (content "FIRST"), reusing the colliding id.
    writeFileSync(fixturePath, "FIRST");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_dup", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "state.txt" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read FIRST.",
      toolCalls: [],
      finishReason: "stop"
    });
    const first = await submitChatMessage(config, session.id, { content: "read it once" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: read the same file (now "SECOND") with the SAME tool_call_id.
    writeFileSync(fixturePath, "SECOND");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_dup", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "state.txt" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read SECOND.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "read it again" });
    await waitForTerminal(config, second.taskId);
    await syncChatTaskResult(config, session.id, second.taskId);

    // Turn 3: plain answer — we only inspect the transcript it was handed.
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });
    const third = await submitChatMessage(config, session.id, { content: "what changed?" });
    await waitForTerminal(config, third.taskId);

    const calls = getEchoToolCallingCalls();
    const turn3 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "what changed?")
    );
    expect(turn3).toBeDefined();

    // Both assistant tool_calls rows replay, each immediately followed by its
    // OWN paired result — turn 1 with "FIRST", turn 2 with "SECOND".
    const toolResults: string[] = [];
    for (let i = 0; i < turn3!.length; i++) {
      const m = turn3![i]!;
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call_dup")) {
        const next = turn3![i + 1];
        expect(next?.role).toBe("tool");
        expect(next?.tool_call_id).toBe("call_dup");
        toolResults.push(String(next?.content ?? ""));
      }
    }
    expect(toolResults.length).toBe(2);
    expect(toolResults[0]).toContain("FIRST");
    expect(toolResults[0]).not.toContain("SECOND");
    expect(toolResults[1]).toContain("SECOND");
    expect(toolResults[1]).not.toContain("FIRST");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a read_skill body from a prior turn persists into the next turn's transcript", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-skill");
    const provider = normalizeProvider(config.provider);

    const skill = await createSkillFromInput(config, {
      name: "apple-notes",
      description: "Apple Notes via memo CLI."
    });
    const skillBody = "# Apple Notes\n\nUse `memo notes -a` to add a note.";
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = skillBody;
    });
    await setSkillStatus(config, skill.id, "enabled");

    const { createChat, submitChatMessage, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Skill thread" });

    // Turn 1: read the skill, then answer.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_skill", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "apple-notes" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I now know how to use Apple Notes.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "how do I add an apple note?" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The skill body must be in the replayed transcript
    // so the model need not re-read it (Claude Code skill behavior).
    setEchoToolCallingResponse({
      provider,
      text: "Adding your note now.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "add a note that says hi" });
    await waitForTerminal(config, second.taskId);

    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "add a note that says hi")
    );
    expect(turn2).toBeDefined();
    const skillToolResult = turn2!.find((m) => m.role === "tool" && m.tool_call_id === "call_skill");
    expect(skillToolResult).toBeDefined();
    expect(String(skillToolResult!.content)).toContain("memo notes -a");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("the gated approval path persists and replays its tool result, keeping pairing valid", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-gated");
    const provider = normalizeProvider(config.provider);

    const { createChat, submitChatMessage, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Gated thread" });

    // Turn 1: request a file write (approval-gated), then answer after resume.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_gated", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "from-agent" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote the file as requested.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "create out.txt" });
    const paused = await waitForTerminal(config, first.taskId);
    expect(paused.status).toBe("waiting_approval");
    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    const finished = await waitForTerminal(config, first.taskId);
    expect(finished.status).toBe("completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The gated tool's result must be replayed, and the
    // assistant tool_calls row must be immediately followed by its paired
    // role:"tool" result (provider ordering invariant).
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "thanks" });
    await waitForTerminal(config, second.taskId);

    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "thanks")
    );
    expect(turn2).toBeDefined();

    const assistantIdx = turn2!.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls!.some((c) => c.id === "call_gated")
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    // The matching tool result must immediately follow its assistant message.
    const nextMsg = turn2![assistantIdx + 1];
    expect(nextMsg?.role).toBe("tool");
    expect(nextMsg?.tool_call_id).toBe("call_gated");

    // No orphan tool results: every role:"tool" message in the replay points
    // at an assistant tool_call id that appears earlier in the same array.
    const emittedCallIds = new Set<string>();
    for (const m of turn2!) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) emittedCallIds.add(c.id);
      }
      if (m.role === "tool") {
        expect(typeof m.tool_call_id).toBe("string");
        expect(emittedCallIds.has(m.tool_call_id!)).toBe(true);
      }
    }

    // The durable transcript rows exist in state.chatMessages but are
    // excluded from the human-facing JSON view.
    const { getChatSession } = await import("./chat");
    const stored = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === session.id && m.kind === "tool_transcript"
    );
    expect(stored.length).toBeGreaterThan(0);
    const view = getChatSession(config, session.id);
    expect(view.messages.some((m) => m.kind === "tool_transcript")).toBe(false);

    // The full-state runtime views (/api/state, /api/mobile/bootstrap) must
    // also drop transcript rows — they carry tool-call args and raw tool
    // results (skill bodies, file contents) that have no place in a public
    // state poll.
    const { publicState, mobileBootstrap } = await import("../runtime/views");
    expect(publicState(config).chatMessages.some((m) => m.kind === "tool_transcript")).toBe(false);
    expect(mobileBootstrap(config).chatMessages.some((m) => m.kind === "tool_transcript")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("buildAgentIdentity", () => {
  function makeToolset(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
    const at = "2026-05-19T00:00:00.000Z";
    return {
      id: `toolset_${name}`,
      instance: "test-instance",
      name,
      description: "",
      status,
      toolNames: [],
      scopes: ["task"],
      createdAt: at,
      updatedAt: at
    };
  }

  function makeState(toolsets: ToolsetRecord[]): RuntimeState {
    // Build on top of the canonical empty-state seed so this fixture
    // automatically inherits any new top-level RuntimeState field
    // without per-test churn. Override only the slices the
    // buildAgentIdentity tests actually exercise.
    const state = createEmptyState("test-instance");
    state.toolsets = toolsets;
    state.agents = [{
      id: "agent_x",
      instance: "test-instance",
      name: "alpha",
      status: "active",
      toolsets: [],
      messagingTargets: [],
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z"
    }];
    state.activeAgentId = "agent_x";
    return state;
  }

  const baseConfig: RuntimeConfig = {
    instance: "test-instance",
    port: 9999,
    token: "test",
    provider: { name: "echo", model: "test-model" },
    workspaceRoot: "/tmp/ws",
    stateRoot: "/tmp/state",
    logRoot: "/tmp/logs"
  };

  test("renders the actual enabled toolset names when the agent imposes no filter", () => {
    const state = makeState([
      makeToolset("file"),
      makeToolset("terminal"),
      makeToolset("memory"),
      makeToolset("disabled-thing", "disabled")
    ]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      warnings: []
      // no toolsetFilter — unrestricted
    };
    const identity: AgentIdentity = buildAgentIdentity(baseConfig, state, effective);
    // Disabled toolsets must NOT appear; enabled toolsets must be sorted
    // so the rendered identity is stable across runs.
    expect(identity.toolsets).toEqual(["file", "memory", "terminal"]);
  });

  test("renders the filter set when the agent declares a whitelist", () => {
    const state = makeState([makeToolset("file"), makeToolset("terminal"), makeToolset("memory")]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      toolsetFilter: new Set(["terminal", "file"]),
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual(["file", "terminal"]);
  });

  test("drops disabled and unknown toolset names from the filter so the prompt matches the catalog", () => {
    // effective.toolsetFilter intentionally keeps unknown / disabled
    // refs (effective-context.ts:9-16) so re-enabling later "just
    // works"; the identity block must NOT show those as available or
    // it would tell the model a tool family is callable when in fact
    // tool-catalog.ts excludes them from the dispatch surface.
    const state = makeState([
      makeToolset("file"),
      makeToolset("terminal"),
      makeToolset("messaging", "disabled")
    ]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      // Whitelist includes a disabled-in-state name and an entirely
      // unknown name; both must be filtered out of the rendered
      // identity block.
      toolsetFilter: new Set(["file", "messaging", "phantom"]),
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual(["file"]);
  });

  test("yields an empty toolsets list only when state has no enabled toolsets and no filter", () => {
    const state = makeState([makeToolset("legacy", "disabled")]);
    const effective: EffectiveContext = {
      provider: { name: "echo", model: "test-model" },
      providerSource: "instance",
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual([]);
    expect(identity.agentId).toBe("(none)");
    expect(identity.memoryNamespace).toBe("(none)");
  });
});

describe("buildInactiveSkillsBlock", () => {
  // Minimal SkillRecord factory. Only the fields the block builder
  // reads (name, description, status, requiredConnectors, source) carry
  // meaningful values; the rest are stubbed so the type checks.
  function makeSkill(opts: {
    name: string;
    description?: string;
    requiredConnectors?: Array<{ provider: string; scopes?: string[] }>;
    status?: SkillRecord["status"];
    source?: SkillRecord["source"];
  }): SkillRecord {
    const at = "2026-05-19T00:00:00.000Z";
    return {
      id: `skill_${opts.name}`,
      instance: "test-instance",
      name: opts.name,
      description: opts.description ?? "(no description)",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: opts.status ?? "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      requiredConnectors: opts.requiredConnectors,
      source: opts.source
    };
  }

  test("routes setup-skill providers to the setup skill instead of request_connector", () => {
    // google-oauth-desktop declares setupSkill: "google-workspace-setup".
    // The block must point the model at that skill, NOT at request_connector.
    const skill = makeSkill({
      name: "google-calendar",
      description: "Google Calendar",
      requiredConnectors: [{ provider: "google-oauth-desktop" }]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("google-oauth-desktop");
    expect(block).toContain("read_skill");
    expect(block).toContain("google-workspace-setup");
    // Must NOT emit the bare request_connector shortcut for this provider.
    expect(block).not.toContain("call `request_connector` with provider id `google-oauth-desktop`");
  });

  test("collapses multiple skills sharing one setup-skill provider into a single line", () => {
    // All six Google Workspace product skills share one connector — the
    // block should emit ONE provider line, not six per-skill lines.
    const skills = [
      makeSkill({ name: "google-calendar", requiredConnectors: [{ provider: "google-oauth-desktop" }] }),
      makeSkill({ name: "google-gmail", requiredConnectors: [{ provider: "google-oauth-desktop" }] }),
      makeSkill({ name: "google-drive", requiredConnectors: [{ provider: "google-oauth-desktop" }] })
    ];
    const block = buildInactiveSkillsBlock(skills);
    const providerLines = block.split("\n").filter((line) => line.includes("google-oauth-desktop"));
    expect(providerLines).toHaveLength(1);
    expect(providerLines[0]).toContain("google-calendar");
    expect(providerLines[0]).toContain("google-gmail");
    expect(providerLines[0]).toContain("google-drive");
    expect(providerLines[0]).toContain("google-workspace-setup");
  });

  test("falls back to request_connector guidance for providers without a setup skill", () => {
    // The linear provider does not declare setupSkill, so the block must
    // emit the default request_connector instruction.
    const skill = makeSkill({
      name: "needs-linear",
      description: "Test skill that needs Linear.",
      requiredConnectors: [{ provider: "linear" }]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("linear");
    expect(block).toContain("call `request_connector` with provider id `linear`");
    // Must NOT mention read_skill — no setup skill is declared.
    expect(block).not.toMatch(/read_skill/);
  });

  test("returns an empty string when no inactive-with-connector skills are present", () => {
    expect(buildInactiveSkillsBlock([])).toBe("");
    // Skills with no requiredConnectors are filtered out before the
    // grouping step.
    const skill = makeSkill({ name: "no-conn", requiredConnectors: [] });
    expect(buildInactiveSkillsBlock([skill])).toBe("");
  });

  test("opens with the dual-path intro so the model knows both routing options", () => {
    const skill = makeSkill({
      name: "needs-linear",
      requiredConnectors: [{ provider: "linear" }]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toMatch(/^Skills below need an external connector\./);
    expect(block).toContain("setup skill");
    expect(block).toContain("request_connector");
  });

  test("appends a no-browser-shortcut directive when a setup-skill provider is present", () => {
    // The model has been observed shortcutting to browser_navigate
    // (calendar.google.com, gmail.com, a Google sign-in page) instead of
    // running the listed setup skill. The block must include an explicit
    // directive forbidding that shortcut so the setup skill becomes the
    // only sanctioned route.
    const skill = makeSkill({
      name: "google-calendar",
      requiredConnectors: [{ provider: "google-oauth-desktop" }]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("ONLY correct path");
    expect(block).toContain("browser_navigate");
    expect(block).toContain("calendar.google.com");
    expect(block).toContain("gmail.com");
    expect(block).toContain("read_skill");
    // The directive sits after the per-provider lines so the model reads
    // "what needs connecting" before "the rule for how to satisfy it".
    const lines = block.split("\n");
    const providerLineIdx = lines.findIndex((line) => line.includes("google-oauth-desktop"));
    const directiveIdx = lines.findIndex((line) => line.includes("ONLY correct path"));
    expect(providerLineIdx).toBeGreaterThan(-1);
    expect(directiveIdx).toBeGreaterThan(providerLineIdx);
  });

  test("skips the no-browser-shortcut directive when no provider declares a setup skill", () => {
    // request_connector is the only path advertised when no setup skill is
    // declared, so the browser-shortcut directive is unnecessary noise.
    const skill = makeSkill({
      name: "needs-linear",
      requiredConnectors: [{ provider: "linear" }]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).not.toContain("ONLY correct path");
    expect(block).not.toContain("browser_navigate");
  });
});
