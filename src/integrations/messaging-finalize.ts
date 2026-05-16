// Messaging finalize hook. Sibling of src/jobs/finalize.ts.
//
// Whenever a Task that originated from an inbound messaging message
// reaches a terminal status, we look up the bridge + chat session +
// final assistant text and post the reply through the same outbound
// dispatch the messaging API uses. Wrapped in try/catch at the call
// site so a vanished bridge can't break the agent's terminal hook for
// non-messaging tasks.
//
// Idempotent: if we already posted a reply for this task (the row
// carries `taskId` and `direction === "outbound"`), do nothing.

import type {
  MessagingMessageRecord,
  RuntimeConfig,
  Task
} from "../types";
import {
  addAudit,
  appendLog,
  createMessagingMessageRecord,
  isTerminalTaskStatus,
  mutateState,
  readState
} from "../state";
import { dispatchOutboundMessage } from "./messaging/telegram-stream";

export async function replyToMessagingFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!isTerminalTaskStatus(task.status)) return;

  const state = readState(config.instance);

  const inbound = state.messagingMessages.find(
    (m) => m.taskId === task.id && m.direction === "inbound"
  );
  if (!inbound) return;
  const bridge = state.messagingBridges.find((b) => b.id === inbound.bridgeId);
  if (!bridge) return;
  // Only the telegram bridge carries reply logic in v1. Demo and other
  // bridges still get the messaging row but no remote dispatch.
  if (bridge.kind !== "telegram") return;

  // Idempotency: if a non-approval outbound reply already exists for
  // this task, skip. Approval prompts (which carry `approvalId`) don't
  // count as the "reply" — those are emitted by the approval site.
  const existingReply = state.messagingMessages.find(
    (m) => m.taskId === task.id && m.direction === "outbound" && !m.approvalId
  );
  if (existingReply) return;

  // Build the reply body. Prefer the assistant chat message synced by
  // syncChatTaskResult so the reply matches what the web UI shows; fall
  // back to task.summary, then task.error, then a curt status string.
  let body: string | undefined;
  if (inbound.chatSessionId) {
    const assistantMessage = state.chatMessages.find(
      (m) => m.taskId === task.id && m.role === "assistant"
    );
    if (assistantMessage) body = assistantMessage.content;
  }
  if (!body) {
    body = task.status === "completed"
      ? task.summary ?? "Task completed."
      : task.error ?? task.currentStep ?? `Task is ${task.status}.`;
  }
  // [SILENT] sentinel parity with syncChatTaskResult — drop the reply
  // when a job/agent explicitly chose to stay quiet.
  if (task.status === "completed" && body.trim() === "[SILENT]") {
    await mutateState(config.instance, (s) => {
      addAudit(s, {
        actor: "runtime",
        action: "messaging.telegram.silent_skipped",
        target: bridge.id,
        risk: "low",
        taskId: task.id,
        evidence: { bridgeId: bridge.id, chatId: inbound.target }
      });
    });
    return;
  }

  const target = inbound.target;
  let message: MessagingMessageRecord | undefined;
  try {
    message = await mutateState(config.instance, (s) =>
      createMessagingMessageRecord(s, {
        bridgeId: bridge.id,
        direction: "outbound",
        status: "queued",
        target,
        text: body!,
        taskId: task.id,
        chatSessionId: inbound.chatSessionId
      })
    );
    await dispatchOutboundMessage(config, bridge, message);
  } catch (error) {
    appendLog(config.instance, "messaging.telegram.reply.error", {
      bridgeId: bridge.id,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
