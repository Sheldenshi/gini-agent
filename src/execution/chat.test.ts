// Integration tests for the chat session view, focused on the
// waiting-approval placeholder behavior.
//
// Before the fix, syncChatTaskResult accepted waiting_approval as a sync
// trigger and persisted a real ChatMessageRecord with content like
// "Waiting for approval". A short-circuit then prevented updates, so the
// placeholder text never refreshed once the approval was granted and the
// task completed.
//
// After the fix:
//   - syncChatTaskResult only writes a real assistant message for
//     completed / failed / cancelled.
//   - waiting_approval is rendered as a synthetic (ephemeral) assistant
//     message synthesized in getChatSession; once the task transitions to
//     completed and the real synced message lands, the synthetic one
//     disappears and the UI shows the final summary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  setEchoStructuredResponse,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { decideApproval } from "../agent";
import { createChatMessage, mutateState, readState } from "../state";
import { createScheduledJob } from "../jobs";
import {
  getChatSession,
  submitChatMessage,
  syncChatTaskResult,
  createChat
} from "./chat";
import type { RuntimeConfig, Task } from "../types";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7340,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-test-logs",
    // Pin the gated path so these waiting-approval placeholder tests
    // remain meaningful under the new default-auto approval policy.
    approvalMode: "strict"
  };
}

async function waitForStatus(
  config: RuntimeConfig,
  taskId: string,
  match: (task: Task) => boolean,
  timeoutMs = 5000
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && match(task)) return task;
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach the expected state within ${timeoutMs}ms`);
}

describe("chat session waiting-approval placeholder", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-svc-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-svc-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  test("synthesizes a placeholder for waiting_approval and swaps it for the real summary on completion", async () => {
    const config = buildConfig(workspaceRoot, "chat-placeholder-fix");
    const provider = normalizeProvider(config.provider);

    // Turn 1: model requests an approval-gated tool (file write).
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "ok" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2 (after approval resolves): model emits the final answer.
    setEchoToolCallingResponse({
      provider,
      text: "All done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const session = await createChat(config, { title: "placeholder-test" });
    const submission = await submitChatMessage(config, session.id, {
      content: "please write out.txt"
    });
    const taskId = submission.taskId;

    const paused = await waitForStatus(config, taskId, (t) => t.status === "waiting_approval");
    expect(paused.status).toBe("waiting_approval");

    // No real persisted assistant ChatMessageRecord while waiting_approval.
    let stateNow = readState(config.instance);
    let realAssistant = stateNow.chatMessages.find(
      (m) => m.taskId === taskId && m.role === "assistant"
    );
    expect(realAssistant).toBeUndefined();

    // getChatSession should still surface a placeholder via the synthetic
    // path so the UI can show "Waiting for approval".
    let view = getChatSession(config, session.id);
    let assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).toBe(`${taskId}-streaming`);
    expect(assistantMsgs[0]?.content).toContain("Waiting for approval");

    // Calling syncChatTaskResult while waiting_approval should now refuse
    // — the real synced message must wait until the task is terminal.
    await expect(syncChatTaskResult(config, session.id, taskId)).rejects.toThrow(/not ready/);

    // Approve the action; the loop completes the task with a real summary.
    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    await waitForStatus(config, taskId, (t) => t.status === "completed");

    // Now sync writes the real assistant message with the final summary.
    await syncChatTaskResult(config, session.id, taskId);

    stateNow = readState(config.instance);
    realAssistant = stateNow.chatMessages.find(
      (m) => m.taskId === taskId && m.role === "assistant"
    );
    expect(realAssistant).toBeDefined();
    expect(realAssistant?.content).toBe("All done.");

    // getChatSession returns only the real assistant message — the
    // synthetic placeholder has dropped because the task is terminal AND
    // a real synced message exists.
    view = getChatSession(config, session.id);
    assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).not.toBe(`${taskId}-streaming`);
    expect(assistantMsgs[0]?.content).toBe("All done.");
  });

  test("surfaces the connector.request approval reason as a durable assistant bubble (kind:approval_reason)", async () => {
    // requestConnectorTool persists the model's `reason` as a real
    // ChatMessageRecord at approval-creation time, tagged kind:"approval_reason".
    // This durable row is what the user sees as the chat bubble above the
    // inline form (with rendered URLs), AND what stays in history after the
    // form is submitted and the approval resolves.
    //
    // Bypassing dispatchToolCall in this test — we set up the state shape
    // dispatchToolCall produces and assert getChatSession returns the
    // persisted row (not a synthesized placeholder) and that the row
    // carries the kind tag.
    const config = buildConfig(workspaceRoot, "chat-placeholder-connector");

    const session = await createChat(config, { title: "connector-placeholder" });

    const reasonText = [
      "To connect Google OAuth Desktop client, you need a Client ID and Client secret.",
      "",
      "1. Open https://console.cloud.google.com/apis/credentials",
      "2. Create OAuth client ID -> Desktop app",
      "3. Paste the values below."
    ].join("\n");

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_connreq",
        title: "connect provider",
        input: "please connect google",
        status: "waiting_approval",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "running tool"
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      const approval = {
        id: "approval_connreq",
        instance: state.instance,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        action: "connector.request" as const,
        target: "google",
        risk: "medium" as const,
        reason: reasonText,
        payload: {
          provider: "google",
          providerLabel: "Google OAuth Desktop client",
          fields: [
            { name: "client_id", label: "Client ID", secret: false, required: true },
            { name: "client_secret", label: "Client secret", secret: true, required: true }
          ]
        }
      };
      state.approvals.push(approval);
      task.approvalIds.push(approval.id);
      // Mirror what requestConnectorTool does at dispatch time: persist
      // the reason as a real assistant message tagged approval_reason.
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: reasonText,
        taskId: task.id,
        kind: "approval_reason"
      });
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    // Exactly one assistant row for this task while waiting_approval:
    // the persisted approval_reason. No synthesized placeholder layered
    // on top of it.
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).toMatch(/^msg_/);
    expect(assistantMsgs[0]?.kind).toBe("approval_reason");
    expect(assistantMsgs[0]?.content).toBe(reasonText);
    expect(assistantMsgs[0]?.content).toContain("https://console.cloud.google.com/apis/credentials");
  });

  test("approval_reason bubble survives task progress: partial-summary streaming renders alongside it", async () => {
    // After the user submits the inline form, the task resumes and the
    // model starts working again (gws install, gws auth login, etc.).
    // partialSummary on the task should still synthesize a streaming
    // bubble — the approval_reason row must NOT suppress it, otherwise
    // the user sees no progress until the task finishes.
    const config = buildConfig(workspaceRoot, "chat-placeholder-progress");
    const session = await createChat(config, { title: "approval-then-progress" });
    const reasonText = "Last step: paste your Client ID and Client Secret below.";

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_progress",
        title: "post-approval progress",
        input: "calendar today",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        partialSummary: "Running gws auth login..."
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: reasonText,
        taskId: task.id,
        kind: "approval_reason"
      });
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    // Two assistant rows: the persisted approval_reason AND the
    // synthesized partial-summary placeholder.
    expect(assistantMsgs).toHaveLength(2);
    const reasonRow = assistantMsgs.find((m) => m.kind === "approval_reason");
    const streamingRow = assistantMsgs.find((m) => m.id === `${taskId}-streaming`);
    expect(reasonRow?.content).toBe(reasonText);
    expect(streamingRow?.content).toBe("Running gws auth login...");
  });

  test("falls back to the generic placeholder when no connector.request approval is linked", async () => {
    // Sanity check: other approval types (e.g. file.write) still get the
    // existing currentStep / "Waiting for approval" placeholder. We don't
    // want this fix to silently change other approval flows.
    const config = buildConfig(workspaceRoot, "chat-placeholder-fallback");

    const session = await createChat(config, { title: "fallback-placeholder" });

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_filewrite",
        title: "write a file",
        input: "write x.txt",
        status: "waiting_approval",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "preparing file write"
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      const approval = {
        id: "approval_filewrite",
        instance: state.instance,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        action: "file.write" as const,
        target: "x.txt",
        risk: "medium" as const,
        reason: "About to write a file",
        payload: { path: "x.txt", content: "x" }
      };
      state.approvals.push(approval);
      task.approvalIds.push(approval.id);
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    // file.write approvals don't trigger the new branch — falls through to
    // currentStep, exactly as before.
    expect(assistantMsgs[0]?.content).toBe("preparing file write");
  });

  test("syncChatTaskResult writes the failure message for failed tasks", async () => {
    // Sanity check that the trimmed sync-trigger set still routes
    // failures into a real assistant message (was always the case;
    // verifying we didn't accidentally remove failed too).
    const config = buildConfig(workspaceRoot, "chat-placeholder-fail-sync");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "x.txt", content: "X" }) }
        }
      ],
      finishReason: "tool_calls"
    });

    const session = await createChat(config, { title: "fail-sync" });
    const submission = await submitChatMessage(config, session.id, { content: "do it" });
    const paused = await waitForStatus(config, submission.taskId, (t) => t.status === "waiting_approval");
    const approvalId = paused.approvalIds[0]!;
    // Deny → failTask runs.
    await decideApproval(config, approvalId, "deny");
    const failed = await waitForStatus(config, submission.taskId, (t) => t.status === "failed");
    expect(failed.status).toBe("failed");

    const message = await syncChatTaskResult(config, session.id, submission.taskId);
    expect(message).not.toBeNull();
    expect(message?.role).toBe("assistant");
    expect(message?.content).toContain("Approval denied");
  });

  test("auto-renames a default chat with a provider-generated title after two synced turns", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-default");
    setEchoStructuredResponse("chat-title", { title: "Low Maintenance Garden Plan" });

    const session = await createChat(config, { title: "" });
    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    let stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Untitled chat");

    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Low Maintenance Garden Plan");
  });

  test("does not auto-rename manually titled chats", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-manual");
    setEchoStructuredResponse("chat-title", { title: "Should Not Apply" });

    const session = await createChat(config, { title: "Manual title" });
    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);
    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    const stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Manual title");
  });

  test("does not auto-rename chats bound to scheduled-job delivery", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-job-delivery");
    setEchoStructuredResponse("chat-title", { title: "Should Not Apply" });

    const session = await createChat(config, { title: "" });
    await createScheduledJob(config, {
      name: "garden reminder",
      prompt: "check the garden",
      intervalSeconds: 60,
      chatSessionId: session.id
    });

    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);
    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    const stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Untitled chat");
  });
});
