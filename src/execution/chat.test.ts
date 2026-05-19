// Integration tests for chat session behavior:
//   - waiting_approval renders as an ephemeral assistant placeholder until
//     the task reaches a terminal state.
//   - default-titled chats are renamed only after enough user turns.
//   - scheduled-job delivery chats keep their dedicated job title.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { decideApproval } from "../agent";
import { createJob, mutateState, readState } from "../state";
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

async function submitAndSync(config: RuntimeConfig, sessionId: string, content: string) {
  const submission = await submitChatMessage(config, sessionId, { content });
  await waitForStatus(config, submission.taskId, (t) => t.status === "completed");
  await syncChatTaskResult(config, sessionId, submission.taskId);
  return getChatSession(config, sessionId);
}

describe("chat session behavior", () => {
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
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
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

  test("auto-renames a default-titled chat after the second user turn", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-rename");
    const session = await createChat(config, { title: "" });

    let detail = await submitAndSync(config, session.id, "plan a small garden");
    expect(detail.title).toBe("Untitled chat");

    detail = await submitAndSync(config, session.id, "make it lower maintenance");

    expect(detail.title).toBe("Plan a small garden make it lower maintenance");
  });

  test("does not auto-rename manually titled chats", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-rename-manual");
    const session = await createChat(config, { title: "Garden notes" });

    await submitAndSync(config, session.id, "plan a small garden");
    const detail = await submitAndSync(config, session.id, "make it lower maintenance");

    expect(detail.title).toBe("Garden notes");
  });

  test("does not auto-rename chats used for scheduled-job delivery", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-rename-job-delivery");
    const session = await createChat(config, { title: "" });
    await mutateState(config.instance, (state) => createJob(state, {
      name: "Daily garden report",
      prompt: "Send the daily garden report.",
      intervalSeconds: 60,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryTargets: [],
      context: [],
      retryLimit: 0,
      timeoutSeconds: 600,
      chatSessionId: session.id
    }));

    await submitAndSync(config, session.id, "plan a small garden");
    const detail = await submitAndSync(config, session.id, "make it lower maintenance");

    expect(detail.title).toBe("Untitled chat");
  });
});
