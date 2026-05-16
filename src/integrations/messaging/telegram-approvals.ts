// Telegram approval prompt emitter.
//
// Called from chat-task.ts when the loop pauses with pending approvals.
// For each pending approval we look up whether the owning task was
// driven by an inbound Telegram message. If yes, we post an inline-
// keyboard message ([Approve] / [Deny]) into the same chat session, with
// approvalId stamped on the outbound MessagingMessageRecord so the
// callback_query handler can route the button press back to
// decideApproval. See ADR telegram-messaging-channel.md.
//
// Best-effort: a Telegram HTTP failure here doesn't fail the task.
// The user can still resolve the approval via the web UI / CLI.

import type { Approval, RuntimeConfig } from "../../types";
import {
  addAudit,
  appendLog,
  createMessagingMessageRecord,
  mutateState,
  readState
} from "../../state";
import { dispatchOutboundMessage } from "./telegram-stream";
import type { TelegramInlineKeyboardMarkup } from "./telegram-transport";

export interface PendingApprovalLike {
  approvalId: string;
  toolName?: string;
}

export async function emitTelegramApprovalPromptsForTask(
  config: RuntimeConfig,
  taskId: string,
  pending: ReadonlyArray<PendingApprovalLike>
): Promise<void> {
  if (pending.length === 0) return;
  const state = readState(config.instance);
  const inbound = state.messagingMessages.find(
    (m) => m.taskId === taskId && m.direction === "inbound"
  );
  if (!inbound) return;
  const bridge = state.messagingBridges.find((b) => b.id === inbound.bridgeId);
  if (!bridge || bridge.kind !== "telegram") return;
  if (bridge.status !== "configured") return;

  for (const entry of pending) {
    const approval = state.approvals.find((a) => a.id === entry.approvalId);
    if (!approval) continue;
    try {
      await emitOneApprovalPrompt(config, bridge.id, inbound.target, inbound.chatSessionId, approval);
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.approval.prompt_error", {
        bridgeId: bridge.id,
        approvalId: entry.approvalId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function emitOneApprovalPrompt(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: string,
  chatSessionId: string | undefined,
  approval: Approval
): Promise<void> {
  // Idempotency: skip if we already emitted a prompt row for this
  // approval. The poller's callback handler reads MessagingMessageRecord
  // rows by approvalId to enforce cross-user routing, so duplicates
  // would also confuse that lookup.
  const state = readState(config.instance);
  const existing = state.messagingMessages.find(
    (m) => m.bridgeId === bridgeId && m.approvalId === approval.id && m.direction === "outbound"
  );
  if (existing) return;

  const text = formatApprovalPrompt(approval);
  const replyMarkup: TelegramInlineKeyboardMarkup = {
    inline_keyboard: [[
      { text: "Approve", callback_data: `appr:${approval.id}` },
      { text: "Deny", callback_data: `deny:${approval.id}` }
    ]]
  };

  // Record the outbound row first; dispatchOutboundMessage updates
  // status / externalId in-place via mutateState.
  const message = await mutateState(config.instance, (s) =>
    createMessagingMessageRecord(s, {
      bridgeId,
      direction: "outbound",
      status: "queued",
      target: chatId,
      text,
      approvalId: approval.id,
      chatSessionId,
      taskId: approval.taskId
    })
  );

  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  await dispatchOutboundMessage(config, bridge, message, { replyMarkup });
  await mutateState(config.instance, (s) => {
    addAudit(s, {
      actor: "runtime",
      action: "messaging.telegram.approval_prompt_sent",
      target: bridgeId,
      risk: "low",
      taskId: approval.taskId,
      evidence: {
        bridgeId,
        approvalId: approval.id,
        chatId,
        chatSessionId
      }
    });
  });
}

function formatApprovalPrompt(approval: Approval): string {
  const action = approval.action || "approval";
  const target = approval.target || "(no target)";
  const reason = approval.reason ? `\n${approval.reason}` : "";
  return `Approval required: ${action}\nTarget: ${target}${reason}`;
}
