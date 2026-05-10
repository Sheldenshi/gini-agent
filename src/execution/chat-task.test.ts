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
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { submitTask, decideApproval } from "../agent";
import { mutateState, readState } from "../state";
import type { RuntimeConfig, Task } from "../types";
import { createSkillFromInput, setSkillStatus } from "../capabilities/skills";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-task-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-task-test-logs"
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

  test("read_skill returns the full body of a trusted skill", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill");
    const provider = normalizeProvider(config.provider);

    // Pre-create a trusted skill with a non-empty body — simulates a
    // post-loadSkillsFromDisk state without exercising the loader here.
    const skill = await createSkillFromInput(config, {
      name: "apple-notes",
      description: "Apple Notes via memo CLI."
    });
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "# Apple Notes\n\nUse `memo notes -a` to add a note.";
    });
    await setSkillStatus(config, skill.id, "trusted");

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

  test("read_skill rejects non-trusted skills with a recoverable error", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill-untrusted");
    const provider = normalizeProvider(config.provider);

    // Create a draft skill (default status). The agent loop should see an
    // error tool result and recover.
    const skill = await createSkillFromInput(config, {
      name: "draft-skill",
      description: "Not yet trusted."
    });
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "Some draft content.";
    });

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_draft", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "draft-skill" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Got it — that skill isn't trusted.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "use the draft skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Got it — that skill isn't trusted.");

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
});
