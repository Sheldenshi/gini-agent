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
  createRun,
  createSubagentRecord,
  mutateState,
  now,
  readState
} from "../state";
import type { JobRecord, RuntimeConfig, Task } from "../types";
import { createSkillFromInput, setSkillStatus } from "../capabilities/skills";

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

  // Halt-siblings regression tests (Review P1 #2). When a single LLM turn
  // emits multiple approval-gated tool calls, denying one must auto-deny
  // the rest, clear the captured snapshot, and prevent any later approve
  // from running side effects.
  test("denying one of multiple sibling approvals auto-denies the rest and prevents side effects", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-sibling-deny");
    const provider = normalizeProvider(config.provider);

    // First model turn: ask for two file writes in parallel. Both become
    // pending approvals on the same task (parallel tool_calls).
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
    expect(paused.toolCallState?.pending.length).toBe(2);
    expect(paused.approvalIds.length).toBe(2);

    // Deny the first sibling. The fix should auto-deny the second.
    const [firstApprovalId, secondApprovalId] = paused.approvalIds as [string, string];
    await decideApproval(config, firstApprovalId, "deny");

    // Wait for the task to land in failed (failTask is async).
    await Bun.sleep(50);

    const stateAfter = readState(config.instance);
    const failedTask = stateAfter.tasks.find((t) => t.id === task.id)!;
    expect(failedTask.status).toBe("failed");
    // Snapshot cleared.
    expect(failedTask.toolCallState).toBeUndefined();

    // Second approval was auto-denied.
    const second = stateAfter.approvals.find((a) => a.id === secondApprovalId)!;
    expect(second.status).toBe("denied");

    // Try to approve the auto-denied sibling — must throw because it's no
    // longer pending.
    await expect(decideApproval(config, secondApprovalId, "approve")).rejects.toThrow(/already denied/);

    // Verify no files were written. Even if executeApprovedAction was
    // somehow called, the terminal-task short-circuit prevents the side
    // effect.
    expect(existsSync(join(workspaceRoot, "a.txt"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "b.txt"))).toBe(false);

    // Audit trail should record the cascade.
    const cascadeAudits = stateAfter.audit.filter((a) => a.action === "approval.cancelled_sibling_denial");
    expect(cascadeAudits.length).toBe(1);
    expect(cascadeAudits[0]?.approvalId).toBe(secondApprovalId);

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
    const approval = stateBefore.approvals.find((a) => a.id === paused.approvalIds[0]!)!;
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
    const approval = stateBefore.approvals.find((a) => a.id === paused.approvalIds[0]!)!;
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
    const approvalsForTask = state.approvals.filter((a) => a.taskId === task.id);
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
});
