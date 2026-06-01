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
  ProviderAuthError,
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  setEchoStructuredResponse,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { decideApproval, failTask } from "../agent";
import { createChatMessage, insertChatBlock, listChatBlocks, mutateState, readState } from "../state";
import { createScheduledJob } from "../jobs";
import {
  getChatSession,
  listChatSessions,
  submitChatMessage,
  syncChatTaskResult,
  createChat
} from "./chat";
import type { Authorization, RuntimeConfig, SetupRequest, Task } from "../types";

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

    // No real persisted assistant summary ChatMessageRecord while
    // waiting_approval. The model-facing tool_transcript rows (the assistant
    // tool_calls row persisted before the pause) are excluded — they are
    // replay state, not the terminal summary the UI renders.
    let stateNow = readState(config.instance);
    let realAssistant = stateNow.chatMessages.find(
      (m) => m.taskId === taskId && m.role === "assistant" && m.kind !== "tool_transcript"
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
      (m) => m.taskId === taskId && m.role === "assistant" && m.kind !== "tool_transcript"
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
      // connector.request is a SetupRequest (user-actor) — no risk field.
      const approval = {
        id: "approval_connreq",
        instance: state.instance,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        action: "connector.request" as const,
        target: "google",
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
      state.setupRequests.push(approval);
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
      state.authorizations.push(approval);
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

  test("failTask surfaces a re-auth note when the provider credential expired", async () => {
    // A turn that dies on an expired/invalid provider token must render an
    // actionable system note (provider name + re-auth metadata) rather than
    // passing the raw provider line through verbatim. See issue #205.
    const config = {
      ...buildConfig(workspaceRoot, "chat-fail-auth-note"),
      provider: { name: "codex" as const, model: "gpt-5-codex" }
    };
    const session = await createChat(config, { title: "auth-fail" });
    const taskId = "task_authfail";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });

    await failTask(
      config,
      taskId,
      new Error("Provided authentication token is expired. Please try signing in again.")
    );

    const note = listChatBlocks(config.instance, session.id).find((b) => b.kind === "system_note");
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.authError).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      detail: "Provided authentication token is expired. Please try signing in again."
    });
    expect(note.text).toBe("Codex authentication failed. Re-authenticate Codex to continue.");

    // The failed provider is recorded on the task so text-only clients
    // (messaging/CLI) get the same actionable line via syncChatTaskResult,
    // not the raw "token expired" message.
    const failedTask = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(failedTask?.authErrorProvider).toBe("codex");
    const synced = await syncChatTaskResult(config, session.id, taskId);
    expect(synced?.content).toBe("Codex authentication failed. Re-authenticate Codex to continue.");

    // A non-auth failure must NOT carry authError — the raw message passes
    // through as before.
    const plainTaskId = "task_plainfail";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: plainTaskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });
    await failTask(config, plainTaskId, new Error("Rate limit exceeded"));
    const plainNote = listChatBlocks(config.instance, session.id)
      .filter((b) => b.kind === "system_note")
      .at(-1);
    if (plainNote?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(plainNote.authError).toBeUndefined();
    expect(plainNote.text).toBe("Rate limit exceeded");
  });

  test("ProviderAuthError names the provider that served the turn, not the active one", async () => {
    // The model-call site tags the failure with the provider it actually used.
    // failTask must trust that over re-resolving the (possibly since-changed)
    // active provider, so the CTA points at the right credential. See #205.
    const config = {
      ...buildConfig(workspaceRoot, "chat-fail-auth-provider"),
      provider: { name: "codex" as const, model: "gpt-5-codex" }
    };
    const session = await createChat(config, { title: "auth-provider" });
    const taskId = "task_authprovider";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });

    // Instance provider is codex, but the turn ran on openai — the tagged
    // error wins.
    await failTask(config, taskId, new ProviderAuthError("openai", "401 unauthorized"));

    const note = listChatBlocks(config.instance, session.id).find((b) => b.kind === "system_note");
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.authError?.provider).toBe("openai");
    expect(note.text).toBe("OpenAI authentication failed. Re-authenticate OpenAI to continue.");
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

// listChatSessions enriches each session with `pendingApprovalCount` so the
// sidebar can render an "awaiting approval" indicator without a second
// round-trip. The count joins state.authorizations and state.setupRequests
// (both pending) against the session's taskIds.
describe("chat list pendingApprovalCount enrichment", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-list-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-list-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function seedTask(config: RuntimeConfig, sessionId: string, taskId: string): Promise<void> {
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: taskId,
        input: "",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: sessionId
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === sessionId);
      if (sessionRecord) sessionRecord.taskIds.push(taskId);
    });
  }

  async function seedAuthorization(
    config: RuntimeConfig,
    overrides: Partial<Authorization> & Pick<Authorization, "id" | "taskId" | "status">
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      const authorization: Authorization = {
        instance: state.instance,
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "out.txt",
        risk: "medium",
        reason: "test authorization",
        payload: {},
        ...overrides
      };
      state.authorizations.push(authorization);
    });
  }

  async function seedSetupRequest(
    config: RuntimeConfig,
    overrides: Partial<SetupRequest> & Pick<SetupRequest, "id" | "taskId" | "status">
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      const setupRequest: SetupRequest = {
        instance: state.instance,
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        reason: "test setup",
        payload: {},
        ...overrides
      };
      state.setupRequests.push(setupRequest);
    });
  }

  test("returns 0 when the session has no approvals", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-no-approvals");
    const session = await createChat(config, { title: "plain" });

    const rows = listChatSessions(config);
    const row = rows.find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });

  test("counts a pending Authorization linked to one of the session's tasks", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-auth-pending");
    const session = await createChat(config, { title: "needs auth" });
    await seedTask(config, session.id, "task_auth_1");
    await seedAuthorization(config, { id: "authz_1", taskId: "task_auth_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(1);
  });

  test("counts a pending SetupRequest linked to one of the session's tasks", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-setup-pending");
    const session = await createChat(config, { title: "needs setup" });
    await seedTask(config, session.id, "task_setup_1");
    await seedSetupRequest(config, { id: "setup_1", taskId: "task_setup_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(1);
  });

  test("sums pending Authorizations and SetupRequests on the same session", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-both-pending");
    const session = await createChat(config, { title: "needs both" });
    await seedTask(config, session.id, "task_both_1");
    await seedTask(config, session.id, "task_both_2");
    await seedAuthorization(config, { id: "authz_a", taskId: "task_both_1", status: "pending" });
    await seedAuthorization(config, { id: "authz_b", taskId: "task_both_2", status: "pending" });
    await seedSetupRequest(config, { id: "setup_a", taskId: "task_both_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(3);
  });

  test("ignores resolved Authorizations and SetupRequests", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-resolved");
    const session = await createChat(config, { title: "resolved" });
    await seedTask(config, session.id, "task_resolved_1");
    await seedAuthorization(config, { id: "authz_approved", taskId: "task_resolved_1", status: "approved" });
    await seedAuthorization(config, { id: "authz_denied", taskId: "task_resolved_1", status: "denied" });
    await seedSetupRequest(config, { id: "setup_completed", taskId: "task_resolved_1", status: "completed" });
    await seedSetupRequest(config, { id: "setup_cancelled", taskId: "task_resolved_1", status: "cancelled" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });

  test("ignores approvals whose taskId is not in the session's taskIds", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-other-session");
    const target = await createChat(config, { title: "target" });
    const other = await createChat(config, { title: "other" });
    await seedTask(config, other.id, "task_other_1");
    await seedAuthorization(config, { id: "authz_other", taskId: "task_other_1", status: "pending" });
    await seedSetupRequest(config, { id: "setup_other", taskId: "task_other_1", status: "pending" });

    const rows = listChatSessions(config);
    expect(rows.find((s) => s.id === target.id)?.pendingApprovalCount).toBe(0);
    expect(rows.find((s) => s.id === other.id)?.pendingApprovalCount).toBe(2);
  });

  test("truncates lastMessagePreview when the latest block exceeds the cap", async () => {
    // Sibling-branch coverage for the existing preview-truncation ternary
    // — exercises the long-text path that runs alongside the new
    // pendingApprovalCount enrichment in the same map().
    const config = buildConfig(workspaceRoot, "chat-list-long-preview");
    const session = await createChat(config, { title: "long preview" });
    const longText = "x".repeat(300);
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: session.id,
      text: longText,
      agentId: null
    });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.lastMessagePreview).toBeTruthy();
    expect(row?.lastMessagePreview?.endsWith("…")).toBe(true);
    expect(row?.lastMessagePreview?.length).toBeLessThan(longText.length);
  });

  test("ignores approvals with no taskId", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-no-task-link");
    const session = await createChat(config, { title: "untargeted" });
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.authorizations.push({
        id: "authz_no_task",
        instance: state.instance,
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "out.txt",
        risk: "low",
        reason: "no task linkage",
        payload: {}
      });
      state.setupRequests.push({
        id: "setup_no_task",
        instance: state.instance,
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        reason: "no task linkage",
        payload: {}
      });
    });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });
});
