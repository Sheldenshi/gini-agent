// End-to-end tests for the chat-task agent loop.
//
// We use the echo provider with stubbed tool-calling responses so the loop
// is fully deterministic. The test covers:
//   - one tool call → result fed back → final answer
//   - approval-gated tool call → task pauses with toolCallState
//   - resume after approval → task completes

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  setEchoToolCallingResponse,
  normalizeProvider,
  type ToolCallingMessage
} from "../provider";
import { submitTask, decideApproval, resolveSetupRequest } from "../agent";
import {
  bankIdForAgent,
  createChatMessage,
  createChatSession,
  createEmptyState,
  createRun,
  createSubagentRecord,
  deleteChatSession,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  listChatBlocks,
  mutateState,
  now,
  readState
} from "../state";
import { echoEmbed } from "../embeddings";
import { resolveDefaultPriorContextTokenBudget } from "../provider-capabilities";
import type { AgentIdentity, GoogleAccount, JobRecord, RuntimeConfig, RuntimeState, SkillRecord, Task, ToolsetRecord } from "../types";
import { createSkillFromInput, setSkillStatus } from "../capabilities/skills";
import {
  buildAgentIdentity,
  buildConnectedAccountsBlock,
  buildEnabledSkillsBlock,
  buildInactiveSkillsBlock,
  buildMcpServersBlock,
  buildSkillScriptsBlock,
  elideOldToolResultsToBudget,
  nextNavWithoutAction
} from "./chat-task";
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
    const config = buildConfig(workspaceRoot, "chat-task-cap-graceful");
    config.agent = { maxIterations: 3 };
    const provider = normalizeProvider(config.provider);

    // Three iterations of tool calls — one per loop pass — each reading a
    // DISTINCT file so the per-iteration signatures differ and the
    // identical-repeat loop-breaker does not pre-empt the genuine cap path.
    // The loop guard is `iterations < cap` so cap=3 means three model turns
    // are consumed before exhaustion.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(workspaceRoot, `hello${i}.md`), `Hello, world! (${i})`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_loop_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: `hello${i}.md` }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the exhaustion path should consume.
    setEchoToolCallingResponse({
      provider,
      text: "Cap reached. I read three files but never produced a final answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "loop forever", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "Cap reached. I read three files but never produced a final answer."
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

  // Loop-breaker (identical-repeat). A model that emits the IDENTICAL tool
  // call and gets the IDENTICAL result several iterations in a row is stuck;
  // the loop must stop at MAX_IDENTICAL_TOOL_REPEATS (3) — well before the
  // 90-iteration cap — and route to the same graceful tool-less summary exit.
  // We drive a cold browser_connect (no page open → deterministic ok:false
  // guard refusal every turn) to reproduce the real stuck-loop scenario.
  test("stops at the identical-repeat loop-breaker and completes via a tool-less summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-loop-breaker");
    const provider = normalizeProvider(config.provider);

    // Three identical iterations: same cold browser_connect args, same guard
    // refusal each time. The third pass trips the loop-breaker (runLength 3).
    for (let i = 0; i < 3; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_repeat_${i}`,
            type: "function",
            function: {
              name: "browser_connect",
              arguments: JSON.stringify({ reason: "Sign in to Example", url: "https://example.com/login" })
            }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the loop-breaker exit should consume.
    setEchoToolCallingResponse({
      provider,
      text: "That sign-in path keeps refusing. Try connecting the service from settings, then ask again.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "sign in to example", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "That sign-in path keeps refusing. Try connecting the service from settings, then ask again."
    );
    expect(finished.currentStep).toBe("Completed (stopped: tool loop made no progress)");
    expect(finished.error).toBeUndefined();

    // Exactly four model calls: three repeated tool turns + one tool-less
    // summary — proving we stopped at the loop-breaker, not the 90-cap.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(4);
    // The final summary turn is the tool-less exit: its last message is the
    // repeat-specific summary instruction asking for a final answer.
    const summaryTurn = calls[3]!;
    const lastMessage = summaryTurn[summaryTurn.length - 1]!;
    expect(lastMessage.role).toBe("user");
    expect(String(lastMessage.content)).toContain("repeated the same tool call");

    // Trace records the loop-breaker stop.
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const breaker = traces.find(
      (t) => t.type === "warning" && /identical tool call\(s\) and result\(s\) \(loop-breaker\)/.test(t.message)
    );
    expect(breaker).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Action-only loop-breaker. A model that emits the IDENTICAL tool call
  // (same name + arguments) but gets a DIFFERENT result every iteration —
  // the real browser_navigate case, where each live-page snapshot jitters —
  // slips past the exact-match guard, so the coarser action-only guard must
  // catch it at MAX_SAME_ACTION_REPEATS (6) instead of running to the 90-cap.
  // We drive get_current_time, whose result (a timestamp) differs each call.
  test("stops at the action-only loop-breaker when results jitter but the action repeats", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-action-loop-breaker");
    const provider = normalizeProvider(config.provider);

    // Six identical get_current_time calls: same name + args every turn, but
    // the clock advances so each result differs. The exact-match guard never
    // fires; the action-only guard trips on the sixth pass (runLength 6).
    for (let i = 0; i < 6; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_clock_${i}`,
            type: "function",
            function: { name: "get_current_time", arguments: JSON.stringify({}) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the loop-breaker exit should consume.
    setEchoToolCallingResponse({
      provider,
      text: "I kept checking the time without making progress on your request.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what time is it", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "I kept checking the time without making progress on your request."
    );
    expect(finished.currentStep).toBe("Completed (stopped: tool loop made no progress)");
    expect(finished.error).toBeUndefined();

    // Exactly seven model calls: six repeated tool turns + one tool-less
    // summary — proving the action-only guard stopped us at 6, not the 90-cap.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(7);

    // Trace records the action-only loop-breaker stop (not the exact-match one).
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const breaker = traces.find(
      (t) =>
        t.type === "warning" &&
        /repeating the same tool call\(s\) with identical arguments \(loop-breaker\)/.test(t.message)
    );
    expect(breaker).toBeDefined();

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

  test("invalid agent.priorContextTokens falls back to the provider-derived default", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-invalid");
    (config as unknown as { agent: { priorContextTokens: number } }).agent = { priorContextTokens: 0 };
    const provider = normalizeProvider(config.provider);
    const expectedDefault = resolveDefaultPriorContextTokenBudget(provider);

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
      (t) => t.type === "warning" && /agent\.priorContextTokens/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.defaultBudget).toBe(expectedDefault);

    const contextTrace = traces.find(
      (t) => t.type === "model" && t.message === "chat-task system context built"
    );
    const contextData = contextTrace?.data as Record<string, unknown> | undefined;
    expect(contextData?.priorContextTokenDefault).toBe(expectedDefault);
    expect(contextData?.priorContextTokenRequested).toBe(expectedDefault);
    expect(typeof contextData?.priorContextTokenAvailable).toBe("number");
    expect(contextData?.priorContextTokenBudget as number).toBeLessThanOrEqual(expectedDefault);
    expect(contextData?.priorContextTokenBudget as number)
      .toBeLessThanOrEqual(contextData?.priorContextTokenAvailable as number);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("oversized agent.priorContextTokens override is clamped to available provider context", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-clamp");
    config.agent = { priorContextTokens: 1_000_000 };
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

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /exceeds available provider context/i.test(t.message)
    );
    expect(warning).toBeDefined();

    const contextTrace = traces.find(
      (t) => t.type === "model" && t.message === "chat-task system context built"
    );
    const contextData = contextTrace?.data as Record<string, unknown> | undefined;
    expect(contextData?.priorContextTokenRequested).toBe(1_000_000);
    expect(contextData?.priorContextTokenBudget as number)
      .toBeLessThanOrEqual(contextData?.priorContextTokenAvailable as number);

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

  // [SILENT] sentinel suppression at the chat-block layer. A scheduled
  // job (or fan-out subagent worker) that has nothing to report responds
  // with exactly "[SILENT]". The legacy message layer drops the
  // ChatMessageRecord, but the UI renders chat blocks — so a completed
  // turn whose final text is exactly "[SILENT]" must NOT leave a visible
  // assistant_text block behind.
  test("suppresses the assistant_text block when the final turn text is exactly [SILENT]", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-suppress");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Inbox triage");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Watcher turn",
        input: "kick off",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "[SILENT]",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    expect(blocks.some((b) => b.kind === "assistant_text")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("does NOT suppress when the final text merely contains [SILENT]", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-contains");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Inbox triage");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Watcher turn",
        input: "kick off",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "[SILENT] but here's an update",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    const assistantText = blocks.filter((b) => b.kind === "assistant_text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0]).toMatchObject({ text: "[SILENT] but here's an update" });

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("writes a normal assistant_text block when the final text is real content", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-normal");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Inbox triage");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Watcher turn",
        input: "kick off",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "You have one new invoice from Acme.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    const assistantText = blocks.filter((b) => b.kind === "assistant_text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0]).toMatchObject({ text: "You have one new invoice from Acme." });

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
    // The emitted identity now rides in the ephemeral role:"user" tail
    // placed immediately before the real user message — NOT in the
    // byte-stable system prefix. See ADR stable-system-prefix.md.
    const turn = calls[0]!;
    const system = turn.find((m) => m.role === "system");
    const systemContent = String(system?.content ?? "");
    expect(systemContent).not.toContain("Your runtime identity:");
    const userIdx = turn.findIndex((m) => m.role === "user" && m.content === "what's your setup?");
    expect(userIdx).toBeGreaterThan(0);
    const tail = turn[userIdx - 1]!;
    expect(tail.role).toBe("user");
    const tailContent = String(tail.content ?? "");
    expect(tailContent).toContain("Your runtime identity:");
    expect(tailContent).toContain(`- instance: ${config.instance}`);
    expect(tailContent).toContain(`- runtime port: ${config.port}`);
    expect(tailContent).toContain("- provider: echo/");

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
    const turn = calls[0]!;
    const system = turn.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    expect(content.startsWith(SUBAGENT_PROMPT)).toBe(true);
    expect(content).not.toContain("Your runtime identity:");
    expect(content).not.toContain("Runtime identity changes since last turn:");
    // Subagents keep their single override prompt + the real user message:
    // no ephemeral identity/memory tail is injected on the subagent path.
    expect(turn.filter((m) => m.role === "user").length).toBe(1);
    for (const m of turn) {
      const text = String(m.content ?? "");
      expect(text).not.toContain("Your runtime identity:");
      expect(text).not.toContain("Runtime identity changes since last turn:");
    }

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
    // Identity now rides in the ephemeral role:"user" tail, so check every
    // message of each turn — not just the (now identity-free) system prefix.
    const firstTurnText = calls[0]!.map((m) => String(m.content ?? "")).join("\n");
    const secondTurnText = calls[1]!.map((m) => String(m.content ?? "")).join("\n");
    // First turn emits the full identity (in the tail); the system prefix
    // itself never carries it anymore.
    expect(firstTurnText).toContain("Your runtime identity:");
    expect(String(calls[0]!.find((m) => m.role === "system")?.content ?? "")).not.toContain("Your runtime identity:");
    // Quiet follow-up turn: no identity anywhere — neither system nor tail
    // (and with nothing recalled, no tail message is injected at all).
    expect(secondTurnText).not.toContain("Your runtime identity:");
    expect(secondTurnText).not.toContain("Runtime identity changes since last turn:");

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

  test("message 0 is a byte-stable prefix across two turns in the same session", async () => {
    // Headline cache contract: with no identity/skill/job/connector change
    // between turns, the system message (message 0) must be byte-identical
    // turn-to-turn so automatic provider prefix caching stays warm. Message 0
    // is stable regardless of whether recall returns anything, because the
    // per-turn-varying content (emitted identity, recalled memory) now lives
    // in the ephemeral role:"user" tail rather than in message 0. See ADR
    // stable-system-prefix.md.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-stable-prefix");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Stable prefix");
      return session.id;
    });

    const firstRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 1",
        input: "first",
        conversationId: sessionId
      });
      return run.id;
    });
    setEchoToolCallingResponse({ provider, text: "One.", toolCalls: [], finishReason: "stop" });
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
    setEchoToolCallingResponse({ provider, text: "Two.", toolCalls: [], finishReason: "stop" });
    const secondTask = await submitTask(config, "second question", { mode: "chat", runId: secondRunId });
    await waitForTerminal(config, secondTask.id);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    expect(calls[0]![0]!.role).toBe("system");
    expect(calls[1]![0]!.role).toBe("system");
    // Byte equality of message 0 across the two turns is the whole point.
    expect(calls[0]![0]!.content).toBe(calls[1]![0]!.content);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("delivers emitted identity then recalled memory in a role:user tail before the user message", async () => {
    // Both per-turn blocks must still reach the model: the emitted identity
    // (turn 1 of a session) and the recalled-memory block, in that order,
    // inside a single role:"user" message placed immediately before the real
    // user message. Recall is driven through the real pipeline with the echo
    // embedder and the reranker pinned to `none` so it returns the seeded
    // unit deterministically and offline.
    const prevEmbed = process.env.GINI_EMBEDDING_PROVIDER;
    const prevReranker = process.env.GINI_RERANKER_PROVIDER;
    process.env.GINI_EMBEDDING_PROVIDER = "echo";
    process.env.GINI_RERANKER_PROVIDER = "none";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-tail-delivery");
    const provider = normalizeProvider(config.provider);
    const MEMORY_TEXT = "the user keeps bees on a rooftop in Lisbon";

    try {
      // Active agent so resolveEffectiveContext yields a memory namespace and
      // recall runs; seed one matching unit into that agent's bank.
      const agentId = "agent_tail";
      const sessionId = await mutateState(config.instance, (state) => {
        state.agents.push({
          id: agentId,
          instance: state.instance,
          name: "tail",
          providerName: "echo",
          model: "gini-echo-v0",
          toolsets: [],
          messagingTargets: [],
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        });
        state.activeAgentId = agentId;
        const session = createChatSession(state, "Tail delivery");
        return session.id;
      });
      ensureDefaultBank(config.instance);
      ensureAgentBank(config.instance, agentId);
      insertMemoryUnit(config.instance, {
        bankId: bankIdForAgent(agentId),
        agentId,
        text: MEMORY_TEXT,
        embedding: echoEmbed(MEMORY_TEXT),
        embeddingModel: "echo-embed-v0",
        network: "world"
      });

      const runId = await mutateState(config.instance, (state) => {
        const run = createRun(state, {
          kind: "conversation_turn",
          title: "Tail turn",
          input: "intro",
          conversationId: sessionId
        });
        return run.id;
      });

      setEchoToolCallingResponse({ provider, text: "Noted.", toolCalls: [], finishReason: "stop" });
      const task = await submitTask(config, MEMORY_TEXT, { mode: "chat", runId });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const calls = getEchoToolCallingCalls();
      expect(calls.length).toBeGreaterThan(0);
      const turn = calls[0]!;
      // The stable system prefix carries neither block anymore.
      const systemContent = String(turn.find((m) => m.role === "system")?.content ?? "");
      expect(systemContent).not.toContain("Your runtime identity:");
      expect(systemContent).not.toContain("Long-term memory of prior conversations");
      // The tail is the role:"user" message immediately before the real input.
      const userIdx = turn.findIndex((m) => m.role === "user" && m.content === MEMORY_TEXT);
      expect(userIdx).toBeGreaterThan(0);
      const tail = turn[userIdx - 1]!;
      expect(tail.role).toBe("user");
      const tailContent = String(tail.content ?? "");
      const identityIdx = tailContent.indexOf("Your runtime identity:");
      const memoryIdx = tailContent.indexOf("Long-term memory of prior conversations");
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(memoryIdx).toBeGreaterThanOrEqual(0);
      expect(tailContent).toContain(MEMORY_TEXT);
      // Identity before memory, mirroring the old system-prompt order.
      expect(identityIdx).toBeLessThan(memoryIdx);
    } finally {
      if (prevEmbed === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
      else process.env.GINI_EMBEDDING_PROVIDER = prevEmbed;
      if (prevReranker === undefined) delete process.env.GINI_RERANKER_PROVIDER;
      else process.env.GINI_RERANKER_PROVIDER = prevReranker;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not replay a prior turn's ephemeral tail on the next turn", async () => {
    // The tail is built live and never persisted, so the next turn's prior
    // transcript (priorChatMessages reads only durable chatMessages) must not
    // contain the previous tail's identity/memory text. Turn 1 emits identity
    // into its tail; turn 2's outgoing messages must carry none of it as
    // replayed history. Recall is isolated (no active agent), so the only
    // tail content under test is the turn-1 identity block.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-double-inject");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "No double inject");
      return session.id;
    });

    const firstRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 1",
        input: "first",
        conversationId: sessionId
      });
      return run.id;
    });
    setEchoToolCallingResponse({ provider, text: "One.", toolCalls: [], finishReason: "stop" });
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
    setEchoToolCallingResponse({ provider, text: "Two.", toolCalls: [], finishReason: "stop" });
    const secondTask = await submitTask(config, "second question", { mode: "chat", runId: secondRunId });
    await waitForTerminal(config, secondTask.id);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    // Turn 1 emitted identity into its tail.
    const firstTurnText = calls[0]!.map((m) => String(m.content ?? "")).join("\n");
    expect(firstTurnText).toContain("Your runtime identity:");
    // Turn 2's messages, EXCLUDING its own freshly-built tail, must not carry
    // the prior turn's identity as replayed history. (The quiet second turn
    // emits no identity of its own, so any occurrence would be a stale replay.)
    const secondTurn = calls[1]!;
    const userIdx = secondTurn.findIndex((m) => m.role === "user" && m.content === "second question");
    const historyAndPrefix = secondTurn.filter((_, i) => i !== userIdx - 1);
    const historyText = historyAndPrefix.map((m) => String(m.content ?? "")).join("\n");
    expect(historyText).not.toContain("Your runtime identity:");
    // Durable transcript rows likewise never include the tail.
    const stored = readState(config.instance).chatMessages.filter((m) => m.sessionId === sessionId);
    for (const m of stored) {
      expect(String(m.content ?? "")).not.toContain("Your runtime identity:");
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("packs prior chat history for the provider without deleting stored history", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-pack", {
      agent: { priorContextTokens: 80 }
    });
    const provider = normalizeProvider(config.provider);
    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Packed history");
      createChatMessage(state, {
        sessionId: session.id,
        role: "user",
        content: `old secret should not be replayed ${"x".repeat(500)}`
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: `old answer should not be replayed ${"y".repeat(500)}`
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "user",
        content: "recent anchor question"
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: "recent anchor answer"
      });
      return session.id;
    });

    const runId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Packed turn",
        input: "current",
        conversationId: sessionId
      });
      return run.id;
    });

    setEchoToolCallingResponse({ provider, text: "Done.", toolCalls: [], finishReason: "stop" });
    const task = await submitTask(config, "current question", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const firstCall = getEchoToolCallingCalls()[0]!;
    const providerText = firstCall.map((m) => String(m.content ?? "")).join("\n");
    expect(providerText).toContain("Earlier chat history is outside the current model context.");
    expect(providerText).toContain("recent anchor question");
    expect(providerText).toContain("recent anchor answer");
    expect(providerText).not.toContain("old secret should not be replayed");
    expect(providerText).not.toContain("old answer should not be replayed");

    const storedText = readState(config.instance).chatMessages.map((m) => m.content).join("\n");
    expect(storedText).toContain("old secret should not be replayed");
    expect(storedText).toContain("old answer should not be replayed");

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

  test("connector.request surfaces the reason as an assistant bubble above the setup card", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-connector");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-connector", undefined, "agent_z")
    );

    const reason = "Brave Search would help me find a fresh answer here. Want to connect it?";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_c", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "brave-search", reason }) } }
      ],
      finishReason: "tool_calls"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "search the web for the best cafe" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);

    // The minimal setup card carries no inline reason; the reason is its
    // own assistant bubble, ordered above the card.
    const setupIdx = blocks.findIndex((b) => b.kind === "setup_requested");
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    const setup = blocks[setupIdx];
    if (setup?.kind === "setup_requested") {
      expect(setup.action).toBe("connector.request");
    } else {
      throw new Error("missing setup_requested block");
    }
    const reasonIdx = blocks.findIndex((b) => b.kind === "assistant_text" && b.text === reason);
    expect(reasonIdx).toBeGreaterThanOrEqual(0);
    expect(reasonIdx).toBeLessThan(setupIdx);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("connector.request cancel resumes the chat loop with a fallback result", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-connector-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-connector-cancel", undefined, "agent_z")
    );

    const reason = "I need Brave Search access to answer with current weather.";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_c", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "brave-search", reason }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I can't look up current weather without Brave Search access. Connect Brave Search or provide the weather details.",
      toolCalls: [],
      finishReason: "stop"
    });

    const { submitChatMessage } = await import("./chat");
    const submitted = await submitChatMessage(config, session.id, { content: "what is the weather in sf today" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("connector.request");

    await resolveSetupRequest(config, setup!.id, "cancel", { actor: "user" });

    let finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    const deadline = Date.now() + 5000;
    while (finished?.status !== "completed" && Date.now() < deadline) {
      await Bun.sleep(20);
      finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    }
    expect(finished?.status).toBe("completed");
    expect(finished?.summary).toBe(
      "I can't look up current weather without Brave Search access. Connect Brave Search or provide the weather details."
    );

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    let lastPhase = blocks[blocks.length - 1];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.kind === "phase") {
        lastPhase = blocks[i];
        break;
      }
    }
    expect(lastPhase?.kind).toBe("phase");
    if (lastPhase?.kind === "phase") {
      expect(lastPhase.label).toBe("Completed");
      expect(lastPhase.taskId).toBe(submitted.taskId);
    }
    const requestConnectorCall = blocks.find(
      (b) => b.kind === "tool_call" && b.toolName === "request_connector"
    );
    expect(requestConnectorCall?.kind).toBe("tool_call");
    if (requestConnectorCall?.kind === "tool_call") {
      expect(requestConnectorCall.status).toBe("ok");
    }
    expect(blocks.some((b) => b.kind === "tool_result" && b.preview.includes("User canceled connector setup for brave-search"))).toBe(true);
    expect(blocks.some((b) => b.kind === "assistant_text" && b.text === finished?.summary)).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup!.id)?.status).toBe("cancelled");

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

  test("a gated tool that persists an approval_reason row still replays its call+result next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-gated-reason");
    const provider = normalizeProvider(config.provider);

    const { createChat, submitChatMessage, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Connector thread" });

    // Turn 1: request_connector (approval-gated) for a provider with no
    // setupSkill, so it goes straight to a pending setup request. Unlike
    // file_write, this path persists a plain assistant kind:"approval_reason"
    // row BETWEEN the assistant tool_calls row and the on-resume tool result,
    // which is exactly what the turn-window pairing must span.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_conn", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "linear", reason: "list my open issues" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Connected to Linear.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "connect linear" });
    const paused = await waitForTerminal(config, first.taskId);
    expect(paused.status).toBe("waiting_approval");

    // An approval_reason row was persisted during dispatch — this is the
    // interleaved non-tool row that the old window logic stopped at.
    const reasonRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === session.id && m.kind === "approval_reason"
    );
    expect(reasonRows.length).toBeGreaterThan(0);

    // Resolve the setup request the way the /complete handler does: the
    // synthesized toolResult is fed back via resumeChatTask, which persists
    // the gated tool result row.
    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === first.taskId);
    expect(setup).toBeDefined();
    await resolveSetupRequest(config, setup!.id, "complete", {
      actor: "user",
      toolResult: "Connected to Linear. Proceed with the original request."
    });
    const finished = await waitForTerminal(config, first.taskId);
    expect(finished.status).toBe("completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The gated tool's call+result must survive replay
    // even though an approval_reason row sits between them in the transcript.
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
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls!.some((c) => c.id === "call_conn")
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    // The matching tool result must immediately follow its assistant message.
    const nextMsg = turn2![assistantIdx + 1];
    expect(nextMsg?.role).toBe("tool");
    expect(nextMsg?.tool_call_id).toBe("call_conn");
    expect(String(nextMsg?.content)).toContain("Connected to Linear");

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

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("advertises deferred tools on demand and loads one via load_tools, feeding back a callable confirmation", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-load");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load the browser_snapshot schema via load_tools. (We stop at the
    // load round-trip rather than driving a real browser — the load branch is
    // what this test pins; the browser dispatch itself is exercised live.)
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_snapshot"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: final answer (no browser call, to keep the test hermetic).
    setEchoToolCallingResponse({
      provider,
      text: "Browser tools are ready.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "get ready to browse", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Browser tools are ready.");
    // loadedTools is cleared on terminal completion.
    expect(finished.loadedTools).toBeUndefined();

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    // First model call: system prompt advertises the on-demand index with
    // browser_snapshot by name.
    const firstSystem = String(calls[0]!.find((m) => m.role === "system")?.content ?? "");
    expect(firstSystem).toContain("Tools available on demand");
    expect(firstSystem).toContain("browser_snapshot");

    // After the load, the second model call's message history carries the
    // load_tools tool result confirming the tool is now callable.
    const secondTurn = calls[1]!;
    const loadResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("callable directly")
    );
    expect(loadResult).toBeDefined();
    const envelope = JSON.parse(String((loadResult as { content: string }).content)) as {
      ok: boolean;
      loaded: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.loaded).toContain("browser_snapshot");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("the dispatcher's deferred guard nudges toward load_tools and does not over-trigger", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-nudge");

    const { dispatchToolCall } = await import("./tool-dispatch");
    const { isDeferredToolName } = await import("./tool-catalog");
    const { createTask, upsertTask } = await import("../state");
    const taskRow = createTask(config.instance, "nudge probe");
    await mutateState(config.instance, (state) => upsertTask(state, taskRow));

    // A genuinely unknown (non-deferred) tool still throws Unknown tool —
    // the guard is scoped to deferred names and does not over-trigger.
    expect(isDeferredToolName("totally_made_up_tool")).toBe(false);
    let threw = false;
    try {
      await dispatchToolCall(config, taskRow.id, "totally_made_up_tool", "call_x", "{}");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // browser_snapshot is a known deferred tool. The guard helper classifies
    // it as deferred so a not-yet-loaded reference reaching the dispatcher's
    // default case would return the recoverable load_tools nudge rather than
    // throwing Unknown tool.
    expect(isDeferredToolName("browser_snapshot")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The riskiest invariant: a deferred tool the model loaded must stay live
  // across an approval pause/resume. We load two deferred self tools
  // (set_provider + get_self), call set_provider (strict → gates), assert the
  // paused task carries loadedTools, then approve and — on the RESUMED turn —
  // call get_self directly. get_self only dispatches successfully if it is
  // still in providerTools after the resume, which proves runLoop re-seeds
  // loadedToolNames from task.loadedTools (a merely-completing final-text turn
  // would not prove the loaded schema survived).
  test("loaded deferred tool set persists across an approval pause/resume and dispatches after resume", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    // strict so set_provider gates instead of auto-resolving.
    const config = buildConfig(workspaceRoot, "chat-task-deferred-resume");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load set_provider AND get_self.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["set_provider", "get_self"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: call set_provider directly (top-level args). Strict → pauses.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_sp", type: "function", function: { name: "set_provider", arguments: JSON.stringify({ provider: "echo" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 3 (the RESUMED turn): call the previously-loaded get_self directly.
    // It's a query op → resolves sync (no second gate) and writes a self.get
    // audit row, proving the loaded schema survived the resume.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_gs", type: "function", function: { name: "get_self", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 4: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Provider set.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "switch to echo", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id, 10000);
    expect(paused.status).toBe("waiting_approval");
    // The loaded set survived onto the task across the pause snapshot.
    expect(paused.loadedTools).toContain("set_provider");
    expect(paused.loadedTools).toContain("get_self");
    expect(paused.toolCallState).toBeDefined();
    expect(paused.toolCallState?.pending[0]?.toolName).toBe("set_provider");
    expect(paused.approvalIds.length).toBe(1);

    // Approve → resume. runLoop re-seeds loadedToolNames from task.loadedTools
    // so get_self is live again on the resumed iteration.
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Provider set.");
    // get_self dispatched on the resumed turn — proving the loaded deferred
    // tool was in providerTools post-resume (not nudged as unloaded).
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "self.get" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    // Cleared on terminal completion.
    expect(finished.loadedTools).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Loop gate, never-loaded case: the model emits a deferred tool it never
  // loaded. The chat-task loop gate (NOT the dispatcher's default-case
  // backstop, which browser_snapshot never reaches — it has its own dispatch
  // case) must block execution and feed back a "not loaded yet" nudge, and the
  // loop must continue to a final answer. We assert NO browser.snapshot audit
  // row exists (proving the thunk never ran).
  test("loop gate blocks a deferred tool the model never loaded and nudges toward load_tools", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-unloaded");
    const provider = normalizeProvider(config.provider);

    // Turn 1: jump straight to browser_snapshot without loading it first.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_snap", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: model recovers with a final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Understood — I'll load the browser tools first next time.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "snapshot the page", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Understood — I'll load the browser tools first next time.");

    const state = readState(config.instance);
    // The browser thunk never ran: no browser.snapshot audit row.
    const snapAudits = state.audit.filter((a) => a.action === "browser.snapshot" && a.taskId === task.id);
    expect(snapAudits).toHaveLength(0);

    // The second model turn's history carries the "not loaded yet" nudge as the
    // tool result for the unloaded browser_snapshot call.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    const nudge = calls[1]!.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("not loaded yet")
    );
    expect(nudge).toBeDefined();
    const envelope = JSON.parse(String((nudge as { content: string }).content)) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("browser_snapshot");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Loop gate, same-batch case: the model emits load_tools AND the tool it just
  // loaded in ONE tool_calls array. The provider generated browser_snapshot
  // without ever having its schema (it wasn't in the tools array that turn), so
  // the loaded set as it stood at turn start does NOT contain it — the gate
  // must block browser_snapshot this turn while load_tools still succeeds. A
  // subsequent turn can then call browser_snapshot for real (now loadable).
  test("loop gate blocks a same-batch load+call but lets the tool through on the next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-samebatch");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load_tools(browser_snapshot) AND browser_snapshot(...) together.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_snapshot"] }) } },
        { id: "call_snap", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: model recovers with a final answer (we stop before a real browser
    // call to keep the test hermetic; the point is that the same-batch call was
    // gated while load_tools succeeded).
    setEchoToolCallingResponse({
      provider,
      text: "Browser tools loaded; ready to snapshot.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "snapshot the page", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // browser_snapshot was NOT executed this turn — no browser.snapshot audit.
    const snapAudits = state.audit.filter((a) => a.action === "browser.snapshot" && a.taskId === task.id);
    expect(snapAudits).toHaveLength(0);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    const secondTurn = calls[1]!;
    // load_tools succeeded: its tool result confirms callability.
    const loadResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("callable directly")
    );
    expect(loadResult).toBeDefined();
    // browser_snapshot got the "not loaded yet" nudge this turn.
    const snapResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("not loaded yet")
    );
    expect(snapResult).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // create_agent approve/resume regression: the direct self tool routes
  // through the unchanged self.config approval branch. Approving the gate
  // must run the create_agent handler (agent row lands) and resume the loop.
  test("create_agent direct tool gates, then approval lands the agent and resumes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-create-agent-resume");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load create_agent.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["create_agent"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: call create_agent directly. Strict → gates.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_ca", type: "function", function: { name: "create_agent", arguments: JSON.stringify({ name: "E2E2" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 3: final answer after approval.
    setEchoToolCallingResponse({
      provider,
      text: "Agent created.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "create an agent called E2E2", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id, 10000);
    expect(paused.status).toBe("waiting_approval");

    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.action).toBe("self.config");
    expect(approval.payload.opName).toBe("create_agent");
    // No agent yet — the side effect is deferred to approval time.
    expect(stateBefore.agents.some((a) => a.name === "E2E2")).toBe(false);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Agent created.");

    // The handler ran on approval — the agent row now exists.
    const stateAfter = readState(config.instance);
    expect(stateAfter.agents.some((a) => a.name === "E2E2")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

// Navigation-without-action counter (loop-breaker guard 3). Driving the real
// browser tool through the loop would launch Chromium — heavy and flaky in a
// unit test — so the counter step is a pure helper tested directly. The model's
// emitted tool names per iteration are all the input it needs.
describe("nextNavWithoutAction", () => {
  test("navigation tools increment, page-actions reset, neutral tools are unchanged", () => {
    // A run of navigations climbs.
    expect(nextNavWithoutAction(0, ["browser_navigate"])).toBe(1);
    expect(nextNavWithoutAction(1, ["browser_navigate"])).toBe(2);
    expect(nextNavWithoutAction(2, ["browser_back"])).toBe(3);
    // A page-action resets to zero.
    expect(nextNavWithoutAction(7, ["browser_click"])).toBe(0);
    expect(nextNavWithoutAction(3, ["browser_type"])).toBe(0);
    // Neutral tools (snapshot, scroll, time, etc.) leave the count alone.
    expect(nextNavWithoutAction(4, ["browser_snapshot"])).toBe(4);
    expect(nextNavWithoutAction(4, ["get_current_time"])).toBe(4);
    expect(nextNavWithoutAction(0, [])).toBe(0);
  });

  test("multiple tools in one iteration apply in order (last write wins on reset)", () => {
    // navigate then click in the same turn nets a reset.
    expect(nextNavWithoutAction(5, ["browser_navigate", "browser_click"])).toBe(0);
    // click then navigate ends incremented from zero.
    expect(nextNavWithoutAction(5, ["browser_click", "browser_navigate"])).toBe(1);
    // two navigations in one turn climb by two.
    expect(nextNavWithoutAction(2, ["browser_navigate", "browser_navigate"])).toBe(4);
  });

  test("oscillation between two URLs climbs to the threshold (the case guard 2 misses)", () => {
    // Alternating navigate targets keep the ACTION signature flipping, so the
    // action-only guard resets every turn — but the navigation counter climbs
    // monotonically because no page-action ever intervenes.
    let count = 0;
    for (let i = 0; i < 8; i++) {
      count = nextNavWithoutAction(count, ["browser_navigate"]);
    }
    expect(count).toBe(8);
  });
});

// In-loop tool-result elision. A pure function over a messages array + budget,
// so a direct unit test is deterministic — no need to force a real provider
// overflow through the loop.
describe("elideOldToolResultsToBudget", () => {
  const ELISION_MARKER =
    "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";

  function bigToolResult(id: string, fill: string): ToolCallingMessage {
    return { role: "tool", tool_call_id: id, content: fill.repeat(400) };
  }

  test("no-op when already within budget", () => {
    const messages: ToolCallingMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "call_0", content: "small result" }
    ];
    const before = JSON.stringify(messages);
    expect(elideOldToolResultsToBudget(messages, 1_000_000)).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("shrinks oldest tool results first while protecting the most-recent six", () => {
    // Ten oversized tool results plus interleaving assistant rows. With a tiny
    // budget, the elidable set is everything but the most-recent six; the
    // helper walks oldest→newest until it fits.
    const messages: ToolCallingMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: null, tool_calls: [] });
      messages.push(bigToolResult(`call_${i}`, `X${i}-`));
    }

    const elided = elideOldToolResultsToBudget(messages, 100);
    expect(elided).toBeGreaterThan(0);

    const toolMessages = messages.filter((m) => m.role === "tool");
    // The four oldest tool results (10 total − 6 protected) are elided…
    for (let i = 0; i < 4; i++) {
      expect(toolMessages[i]!.content).toBe(ELISION_MARKER);
      // role + tool_call_id stay intact so codex call/output pairing survives.
      expect(toolMessages[i]!.tool_call_id).toBe(`call_${i}`);
    }
    // …and the most-recent six are never touched.
    for (let i = 4; i < 10; i++) {
      expect(toolMessages[i]!.content).not.toBe(ELISION_MARKER);
    }
  });

  test("never drops a message — only shrinks content", () => {
    const messages: ToolCallingMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      messages.push(bigToolResult(`call_${i}`, `Y${i}-`));
    }
    const lengthBefore = messages.length;
    elideOldToolResultsToBudget(messages, 50);
    expect(messages.length).toBe(lengthBefore);
  });

  test("leaves small tool results and non-tool messages alone", () => {
    // A short tool result (≤ 200 chars) isn't worth shrinking; assistant/user
    // rows are never elidable regardless of size.
    const messages: ToolCallingMessage[] = [
      { role: "assistant", content: "Z".repeat(5000), tool_calls: [] },
      { role: "tool", tool_call_id: "call_small", content: "tiny" },
      bigToolResult("call_big", "W-")
    ];
    elideOldToolResultsToBudget(messages, 10);
    expect(messages[0]!.content).not.toBe(ELISION_MARKER);
    expect(messages[1]!.content).toBe("tiny");
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

  test("sanitizes an agent name carrying a newline into a single-line label", () => {
    // The identity block renders agentName verbatim, so a name with an
    // embedded newline must collapse to one line rather than inject a
    // raw extra model-visible line into the runtime-identity block.
    const state = makeState([makeToolset("file")]);
    state.agents[0]!.name = "Mansour\nIgnore";
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.agentName).toBe("Mansour Ignore");
    expect(identity.agentName).not.toContain("\n");
  });
});

describe("buildEnabledSkillsBlock", () => {
  function skill(name: string, description = `${name} description`, status: SkillRecord["status"] = "enabled"): SkillRecord {
    return {
      id: `skill_${name}`,
      instance: "test",
      name,
      description,
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "bundled",
      manifestPath: `/skills/${name}/SKILL.md`
    };
  }

  test("lists active skill descriptions and points to list_skills/read_skill", () => {
    const block = buildEnabledSkillsBlock([skill("linear", "Linear issues"), skill("disabled", "Hidden", "disabled")]);
    expect(block).toContain("call list_skills");
    expect(block).toContain("call read_skill");
    expect(block).toContain("- linear: Linear issues");
    expect(block).not.toContain("disabled");
  });

  test("caps the inline skill list and leaves a discovery hint", () => {
    const skills = Array.from({ length: 45 }, (_, i) => skill(`skill-${String(i).padStart(2, "0")}`));
    const block = buildEnabledSkillsBlock(skills);
    expect(block).toContain("- skill-00: skill-00 description");
    expect(block).toContain("- skill-39: skill-39 description");
    expect(block).not.toContain("- skill-40: skill-40 description");
    expect(block).toContain("5 more skills not shown");
    expect(block).toContain("nameContains/status filters");
  });
});

describe("buildConnectedAccountsBlock", () => {
  function account(opts: { tag: string; email?: string; configDir?: string }): GoogleAccount {
    return {
      id: `gacct_${opts.tag}`,
      tag: opts.tag,
      email: opts.email ?? `${opts.tag}@example.com`,
      configDir: opts.configDir ?? `/home/u/.gini/google-accounts/gacct_${opts.tag}`,
      addedAt: "2026-01-01T00:00:00.000Z"
    };
  }

  test("returns empty string when no accounts are connected", () => {
    expect(buildConnectedAccountsBlock([])).toBe("");
  });

  test("renders a single account's tag, email, and config dir plus the prefix guidance", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal", email: "me@gmail.com", configDir: "/home/u/.config/gws" })
    ]);
    expect(block).toContain("Connected Google accounts");
    expect(block).toContain("personal");
    expect(block).toContain("me@gmail.com");
    expect(block).toContain("/home/u/.config/gws");
    expect(block).toContain("GOOGLE_WORKSPACE_CLI_CONFIG_DIR");
    expect(block).toContain("use it");
  });

  test("surfaces both accounts, aggregate-on-read, and ask-on-write guidance when 2+ are connected", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal" }),
      account({ tag: "work" })
    ]);
    expect(block).toContain("personal");
    expect(block).toContain("work");
    // Unscoped reads fan out across every account instead of picking one.
    expect(block).toContain("EVERY connected account");
    // Writes still ask when no account is named.
    expect(block).toContain("ASK which account first");
  });

  test("shows the sign-in-pending placeholder for an account with no email yet", () => {
    const block = buildConnectedAccountsBlock([account({ tag: "school", email: "" })]);
    expect(block).toContain("school");
    expect(block).toContain("(sign-in pending)");
  });
});

describe("buildInactiveSkillsBlock", () => {
  // Minimal SkillRecord factory. Only the fields the block builder
  // reads (name, description, status, requiredCredentials, source) carry
  // meaningful values; the rest are stubbed so the type checks. Skills now
  // declare credentials BY NAME; the block maps each name to its provider
  // (LINEAR_API_KEY → linear, google-workspace-oauth → google-oauth-desktop).
  function makeSkill(opts: {
    name: string;
    description?: string;
    requiredCredentials?: string[];
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
      requiredCredentials: opts.requiredCredentials,
      source: opts.source
    };
  }

  test("routes setup-skill providers to the setup skill instead of request_connector", () => {
    // google-workspace-oauth maps to google-oauth-desktop, which declares
    // setupSkill: "google-workspace-setup". The block must point the model at
    // that skill, NOT at request_connector.
    const skill = makeSkill({
      name: "google-calendar",
      description: "Google Calendar",
      requiredCredentials: ["google-workspace-oauth"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("google-oauth-desktop");
    expect(block).toContain("read_skill");
    expect(block).toContain("google-workspace-setup");
    // Must NOT emit the bare request_connector shortcut for this provider.
    expect(block).not.toContain("call `request_connector` with provider id `google-oauth-desktop`");
  });

  test("collapses multiple skills sharing one credential into a single line", () => {
    // All Google Workspace product skills share one credential — the block
    // should emit ONE provider line, not one per skill.
    const skills = [
      makeSkill({ name: "google-calendar", requiredCredentials: ["google-workspace-oauth"] }),
      makeSkill({ name: "google-gmail", requiredCredentials: ["google-workspace-oauth"] }),
      makeSkill({ name: "google-drive", requiredCredentials: ["google-workspace-oauth"] })
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
    // LINEAR_API_KEY → linear, which does not declare setupSkill, so the
    // block must emit the default request_connector instruction.
    const skill = makeSkill({
      name: "needs-linear",
      description: "Test skill that needs Linear.",
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("linear");
    expect(block).toContain("call `request_connector` with provider id `linear`");
    // Must NOT mention read_skill — no setup skill is declared.
    expect(block).not.toMatch(/read_skill/);
  });

  test("instructs a templateless request_connector for a credential with no registered provider", () => {
    // SOME_SERVICE_API_KEY maps to no provider module, so providerForCredential
    // falls back to the name itself. The block must NOT emit the bare
    // provider-id shortcut (there is no provider to connect) — it must tell the
    // model to call request_connector with the {name, type, skillId} shape so
    // the user can enter the secret in chat. The name is UPPER_SNAKE so the
    // inferred type is api-key.
    const skill = makeSkill({
      name: "needs-some-service",
      description: "Test skill that needs an unmapped credential.",
      requiredCredentials: ["SOME_SERVICE_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("SOME_SERVICE_API_KEY");
    expect(block).toContain('name: "SOME_SERVICE_API_KEY"');
    expect(block).toContain('type: "api-key"');
    expect(block).toContain(`skillId: "${skill.id}"`);
    // No provider-id shortcut and no read_skill dead-end for a name with no
    // registered provider.
    expect(block).not.toContain("call `request_connector` with provider id `SOME_SERVICE_API_KEY`");
    expect(block).not.toMatch(/read_skill/);
    expect(block).not.toContain("will be rejected");
  });

  // Minimal RuntimeState carrying only the connectors the block reads.
  function stateWithConnectors(connectors: RuntimeState["connectors"]): RuntimeState {
    return {
      version: 1,
      instance: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
      connectors, improvements: [], pairingCodes: [], pairingRequests: [], devices: [],
      promotions: [], snapshots: [], tools: [], toolsets: [], subagents: [],
      mcpServers: [], messagingBridges: [], importReports: [], agents: [],
      activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
      jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
      runs: [], planSteps: []
    };
  }

  test("a disabled generic connector sharing the credential name still yields the api-key templateless line by NAME", () => {
    // Regression: a disabled/unhealthy "generic" connector row sharing the
    // credential name must NOT masquerade as the owning provider. The earlier
    // code returned the row's provider ("generic"), grouped under that key, and
    // emitted a bogus `{name:"generic", type:"oauth2"}` line. The line must name
    // the actual credential and be api-key (templateless is api-key only).
    const skill = makeSkill({
      name: "needs-some-service",
      requiredCredentials: ["SOME_SERVICE_API_KEY"]
    });
    const state = stateWithConnectors([
      {
        id: "id_generic_row",
        instance: "test",
        name: "SOME_SERVICE_API_KEY",
        provider: "generic",
        status: "disabled",
        scopes: [],
        secretRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        health: "unknown",
        source: "user"
      }
    ]);
    const block = buildInactiveSkillsBlock([skill], state);
    expect(block).toContain('name: "SOME_SERVICE_API_KEY"');
    expect(block).toContain('type: "api-key"');
    // Never the bogus generic/oauth2 line.
    expect(block).not.toContain('name: "generic"');
    expect(block).not.toContain('type: "oauth2"');
  });

  test("returns an empty string when no inactive-with-credential skills are present", () => {
    expect(buildInactiveSkillsBlock([])).toBe("");
    // Skills with no requiredCredentials are filtered out before the
    // grouping step.
    const skill = makeSkill({ name: "no-cred", requiredCredentials: [] });
    expect(buildInactiveSkillsBlock([skill])).toBe("");
  });

  test("opens with the dual-path intro so the model knows both routing options", () => {
    const skill = makeSkill({
      name: "needs-linear",
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toMatch(/^Skills below need an external connector\./);
    // Both request_connector routing options are advertised: a registered
    // provider id, and the templateless api-key {name, type:"api-key", skillId}
    // shape for a credential with no registered provider.
    expect(block).toContain("request_connector");
    expect(block).toContain("provider id");
    expect(block).toContain('{name, type:"api-key", skillId}');
  });

  test("appends a no-browser-shortcut directive when a setup-skill provider is present", () => {
    // The model has been observed shortcutting to browser_navigate
    // (calendar.google.com, gmail.com, a Google sign-in page) instead of
    // running the listed setup skill. The block must include an explicit
    // directive forbidding that shortcut so the setup skill becomes the
    // only sanctioned route.
    const skill = makeSkill({
      name: "google-calendar",
      requiredCredentials: ["google-workspace-oauth"]
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
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).not.toContain("ONLY correct path");
    expect(block).not.toContain("browser_navigate");
  });
});

describe("buildMcpServersBlock", () => {
  function stateWith(servers: RuntimeState["mcpServers"]): RuntimeState {
    return {
      version: 1,
      instance: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
      connectors: [], improvements: [], pairingCodes: [], pairingRequests: [], devices: [],
      promotions: [], snapshots: [], tools: [], toolsets: [], subagents: [],
      mcpServers: servers, messagingBridges: [], importReports: [], agents: [],
      activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
      jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
      runs: [], planSteps: []
    };
  }

  function server(name: string, tools: Array<{ name: string }>): RuntimeState["mcpServers"][number] {
    return {
      id: `mcp_${name}`,
      instance: "test",
      name,
      command: "",
      args: [],
      envKeys: [],
      status: "configured",
      exposedTools: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      transport: "http",
      url: "https://example.test/mcp",
      tools
    };
  }

  test("returns empty string when no servers are configured", () => {
    expect(buildMcpServersBlock(stateWith([]))).toBe("");
  });

  test("lists tool names per server so the model has the full inventory", () => {
    // The inventory line is what lets the model reach for a tool the skill
    // never documented. Skills should not have to be re-edited every time
    // an MCP server adds a tool.
    const state = stateWith([
      server("linear", [
        { name: "list_issues" },
        { name: "save_issue" },
        { name: "list_initiatives" },
        { name: "extract_images" }
      ])
    ]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("- linear (4 tools)");
    expect(block).toContain("tools: extract_images, list_initiatives, list_issues, save_issue");
  });

  test("includes the default-yes posture instruction", () => {
    // Without this, the model treats the skill's documented tools as
    // exhaustive and refuses tasks for tools that actually exist on the
    // server's inventory list.
    const state = stateWith([server("linear", [{ name: "list_issues" }])]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("Do not refuse");
    expect(block).toContain("validation error on bad args");
  });

  test("omits the per-server inventory line when a server has no cached tools yet", () => {
    // Health probe hasn't populated tools yet — show the server but skip
    // the inventory line so we don't lie about emptiness. (The default-yes
    // posture sentence below still mentions the word `tools:`, so we
    // assert on the indented inventory line specifically.)
    const state = stateWith([server("linear", [])]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("- linear");
    expect(block).not.toMatch(/^ {2}tools:/m);
  });

  test("alphabetizes both servers and their tool name lists for determinism", () => {
    // Toolset hashes and prompt-cache stability depend on stable ordering
    // across boots even when the order tools were registered varies.
    const state = stateWith([
      server("zenith", [{ name: "z_one" }, { name: "a_two" }]),
      server("acme", [{ name: "c_one" }, { name: "a_two" }])
    ]);
    const block = buildMcpServersBlock(state);
    const acmeIdx = block.indexOf("- acme");
    const zenithIdx = block.indexOf("- zenith");
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(zenithIdx).toBeGreaterThan(acmeIdx);
    expect(block).toContain("tools: a_two, c_one");
    expect(block).toContain("tools: a_two, z_one");
  });
});

describe("buildSkillScriptsBlock", () => {
  // listEnabledSkillScripts statSyncs the real scripts/ dir under each
  // skill's manifestPath, so the seeded skills need real files on disk.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gini-skill-scripts-block-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedSkill(
    state: RuntimeState,
    name: string,
    scripts: string[],
    opts: { status?: SkillRecord["status"] } = {}
  ): void {
    const skillDir = join(dir, name);
    const scriptsDir = join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    for (const script of scripts) {
      writeFileSync(join(scriptsDir, script), "console.log('{}')");
    }
    state.skills.push({
      id: `skill_${name}`,
      instance: state.instance,
      name,
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: opts.status ?? "enabled",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "bundled",
      manifestPath: join(skillDir, "SKILL.md")
    });
  }

  test("returns empty string when no visible skill ships scripts", () => {
    const state = createEmptyState("test");
    seedSkill(state, "no-scripts", []);
    expect(buildSkillScriptsBlock(state, new Set(["no-scripts"]))).toBe("");
  });

  test("lists each visible skill's scripts, alphabetized by skill and script", () => {
    const state = createEmptyState("test");
    seedSkill(state, "bbb", ["alpha.sh"]);
    seedSkill(state, "aaa", ["two.ts", "one.ts"]);
    const block = buildSkillScriptsBlock(state, new Set(["aaa", "bbb"]));
    expect(block).toBe(
      [
        "Skill scripts (invoke with skill_run, never re-implement in terminal_exec; call list_skills/read_skill for omitted skills):",
        "- aaa: one, two",
        "- bbb: alpha"
      ].join("\n")
    );
  });

  test("caps the inline skill script list and leaves a discovery hint", () => {
    const state = createEmptyState("test");
    const names = new Set<string>();
    for (let i = 0; i < 45; i++) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      names.add(name);
      seedSkill(state, name, ["run.ts"]);
    }
    const block = buildSkillScriptsBlock(state, names);
    expect(block).toContain("- skill-00: run");
    expect(block).toContain("- skill-39: run");
    expect(block).not.toContain("- skill-40: run");
    expect(block).toContain("5 more skill script entries not shown");
    expect(block).toContain("call list_skills");
  });

  test("omits skills that are enabled but not visible (inactive connector)", () => {
    const state = createEmptyState("test");
    seedSkill(state, "visible", ["go.ts"]);
    seedSkill(state, "hidden", ["go.ts"]);
    const block = buildSkillScriptsBlock(state, new Set(["visible"]));
    expect(block).toContain("- visible: go");
    expect(block).not.toContain("hidden");
  });
});
