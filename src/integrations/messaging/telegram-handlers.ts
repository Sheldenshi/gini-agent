// Telegram update handlers.
//
// The poller dispatches each accepted update (message / callback_query)
// here. These handlers own:
//   - Authorization: lookup the Telegram `user_id` (NEVER `chat.id`) in
//     the bridge's allowlist.
//   - Session routing: bind each allowlisted user to a per-user Gini
//     chat session so multi-turn context survives across messages.
//   - Active-agent activation: each allowlist entry pins an `agentId`;
//     we activate that agent inside the same mutateState that records
//     the inbound message so the subsequent submitTask resolves the
//     intended agent's provider/toolset/memory namespace.
//   - Cross-user approval prevention: a callback_query's
//     `from.id` must match the allowlist entry that owns the chat
//     session the approval was emitted in.
//
// All audit rows here live under `messaging.telegram.*` actions so the
// trace is easy to filter; none of them include the bot token.

import type {
  MessagingBridgeRecord,
  MessagingMessageRecord,
  RuntimeConfig,
  TelegramAllowlistEntry
} from "../../types";
import {
  activateAgent,
  addAudit,
  createChatMessage,
  createChatSession,
  createMessagingMessageRecord,
  mutateState,
  now,
  readState
} from "../../state";
import { submitTask, decideApproval } from "../../agent";
import { createConversationRun, linkRunToTask } from "../../execution/runs";
import { resolveConnectorSecret } from "../connectors";
import {
  answerCallbackQuery,
  sendChatAction,
  type TelegramCallbackQuery,
  type TelegramIncomingMessage
} from "./telegram-transport";
import { dispatchOutboundMessage, ensureChatSessionForUser } from "./telegram-stream";

function findAllowlistEntry(
  bridge: MessagingBridgeRecord,
  telegramUserId: number
): TelegramAllowlistEntry | undefined {
  return bridge.telegram?.allowlist.find((entry) => entry.telegramUserId === telegramUserId);
}

// Inbound message handler. The bridge has already been validated as
// configured and telegram-typed by the poller.
export async function handleInboundMessage(
  config: RuntimeConfig,
  bridgeId: string,
  message: TelegramIncomingMessage
): Promise<void> {
  const fromId = message.from?.id;
  const chatId = message.chat.id;
  // No `from` means a channel post or system message we don't drive
  // agents from; treat as unsupported so the audit row exists for later
  // forensics without dispatching anything.
  if (typeof fromId !== "number") {
    await auditUnsupported(config, bridgeId, "no_from", { chatId, messageId: message.message_id });
    return;
  }
  const text = message.text?.trim() ?? "";
  if (text.length === 0) {
    // Empty / non-text messages (photos, stickers, voice) are out of
    // scope for v1. Drop with an audit row so multi-user setups can see
    // which user is sending what.
    await auditUnsupported(config, bridgeId, "non_text", {
      chatId,
      telegramUserId: fromId,
      messageId: message.message_id
    });
    return;
  }

  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  const entry = findAllowlistEntry(bridge, fromId);
  if (!entry) {
    await auditDropped(config, bridgeId, "unauthorized", {
      chatId,
      telegramUserId: fromId,
      telegramUsername: message.from?.username,
      messageId: message.message_id
    });
    return;
  }

  // Best-effort `typing` indicator. Failure here doesn't change behavior;
  // we just want the user to see the bot is alive while the LLM runs.
  if (bridge.connectorId) {
    const token = await resolveConnectorSecret(config, bridge.connectorId, "token");
    if (token) {
      await sendChatAction(token, chatId, "typing").catch(() => {});
    }
  }

  // Ensure a per-user chat session exists. The allowlist entry caches
  // the session id so subsequent messages from the same user keep
  // landing in the same session (preserving context).
  const sessionId = await ensureChatSessionForUser(config, bridge.id, entry);

  // Activate the agent the allowlist entry pins. We do this in the same
  // mutateState that records the inbound message + user chat message so
  // the subsequent submitTask sees the intended active agent. Concurrent
  // inbound messages from different allowlist entries serialize through
  // mutateState; the per-instance queue means agent switches and the
  // chat-task launch never interleave for the SAME inbound, even if
  // ANOTHER inbound is in flight for a different user. Documented as a
  // known limitation in ADR telegram-messaging-channel.md.
  await mutateState(config.instance, (state) => {
    activateAgent(state, entry.agentId);
  });

  // Create a conversation run + submit the chat task, mirroring
  // submitChatMessage in src/execution/chat.ts so messaging messages
  // produce identical run/task records to web-driven chats.
  const run = await createConversationRun(config, { conversationId: sessionId, input: text });
  const task = await submitTask(config, text, { runId: run.id, mode: "chat" });
  await linkRunToTask(config, run.id, task);

  await mutateState(config.instance, (state) => {
    const chatMessage = createChatMessage(state, {
      sessionId,
      role: "user",
      content: text,
      taskId: task.id,
      runId: run.id
    });
    const runRecord = state.runs.find((r) => r.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = chatMessage.id;
      runRecord.updatedAt = chatMessage.createdAt;
    }

    // Stamp the inbound message row. We persist target = String(chatId)
    // so the messaging-finalize hook can find the chat to reply into
    // when the task settles.
    createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "inbound",
      status: "received",
      target: String(chatId),
      text,
      taskId: task.id,
      chatSessionId: sessionId,
      externalId: String(message.message_id)
    });

    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.inbound_dispatched",
      target: bridge.id,
      risk: "low",
      taskId: task.id,
      evidence: {
        bridgeId: bridge.id,
        telegramUserId: entry.telegramUserId,
        agentId: entry.agentId,
        chatSessionId: sessionId,
        chatId,
        messageId: message.message_id
      }
    });
  });
}

// Callback-query handler (inline-keyboard button press). Used for
// approval routing: a [Approve] or [Deny] tap arrives as a
// callback_query with `data` matching the approval payload we sent.
export async function handleCallbackQuery(
  config: RuntimeConfig,
  bridgeId: string,
  query: TelegramCallbackQuery
): Promise<void> {
  const data = query.data ?? "";
  // We accept `appr:<id>` and `deny:<id>`. Anything else is logged and
  // acknowledged so the Telegram UI's spinner clears even if the data
  // came from an outdated keyboard.
  const match = /^(appr|deny):(.+)$/.exec(data);
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  const token = bridge.connectorId
    ? await resolveConnectorSecret(config, bridge.connectorId, "token")
    : undefined;

  if (!match) {
    await auditUnsupported(config, bridgeId, "callback_data", {
      telegramUserId: query.from.id,
      data
    });
    if (token) await answerCallbackQuery(token, query.id, "Unsupported button.").catch(() => {});
    return;
  }

  const decisionKind = match[1] === "appr" ? "approve" : "deny";
  const approvalId = match[2]!;
  const fromId = query.from.id;
  const entry = findAllowlistEntry(bridge, fromId);
  if (!entry) {
    await auditDropped(config, bridgeId, "unauthorized_callback", {
      telegramUserId: fromId,
      telegramUsername: query.from.username,
      approvalId,
      decisionKind
    });
    if (token) await answerCallbackQuery(token, query.id, "Not authorized.").catch(() => {});
    return;
  }

  // Cross-user approval prevention. The approval prompt we sent carries
  // a stamped MessagingMessageRecord with the approval id and the chat
  // session that owned it. We resolve the session, find the allowlist
  // entry that owns the session, and require the callback's from.id to
  // match. Without this, allowlisted-user-A could resolve allowlisted-
  // user-B's pending action just by tapping the button in their own
  // chat.
  const state = readState(config.instance);
  const outboundPrompt = state.messagingMessages.find(
    (m) => m.bridgeId === bridge.id && m.approvalId === approvalId && m.direction === "outbound"
  );
  // Find the owning allowlist entry via the chat session the prompt was
  // emitted into. This is the strict guard.
  const sessionIdOnPrompt = outboundPrompt?.chatSessionId;
  const owningEntry = sessionIdOnPrompt
    ? bridge.telegram?.allowlist.find((a) => a.chatSessionId === sessionIdOnPrompt)
    : undefined;
  if (!owningEntry || owningEntry.telegramUserId !== fromId) {
    await auditDropped(config, bridgeId, "cross_user_approval", {
      telegramUserId: fromId,
      approvalId,
      decisionKind,
      expectedTelegramUserId: owningEntry?.telegramUserId
    });
    if (token) await answerCallbackQuery(token, query.id, "This approval is for another user.").catch(() => {});
    return;
  }

  try {
    await decideApproval(config, approvalId, decisionKind);
    await mutateState(config.instance, (s) => {
      addAudit(s, {
        actor: "user",
        action: `messaging.telegram.approval_${decisionKind}`,
        target: bridge.id,
        risk: "medium",
        evidence: {
          bridgeId: bridge.id,
          telegramUserId: fromId,
          approvalId,
          decision: decisionKind
        }
      });
    });
    if (token) {
      await answerCallbackQuery(
        token,
        query.id,
        decisionKind === "approve" ? "Approved." : "Denied."
      ).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (s) => {
      addAudit(s, {
        actor: "runtime",
        action: "messaging.telegram.approval_error",
        target: bridge.id,
        risk: "low",
        evidence: { approvalId, decision: decisionKind, error: message }
      });
    });
    if (token) {
      await answerCallbackQuery(token, query.id, "Approval failed.").catch(() => {});
    }
  }
}

async function auditDropped(
  config: RuntimeConfig,
  bridgeId: string,
  reason: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.dropped",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, reason, ...evidence }
    });
  });
}

async function auditUnsupported(
  config: RuntimeConfig,
  bridgeId: string,
  reason: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.unsupported_update",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, reason, ...evidence }
    });
  });
}

// Exported for the messaging-finalize hook: locate the outbound row for
// a task's reply and the chat session, so the finalize hook can edit
// the streaming placeholder instead of posting a fresh message.
export function findInboundMessageForTask(
  config: RuntimeConfig,
  taskId: string
): MessagingMessageRecord | undefined {
  return readState(config.instance).messagingMessages.find(
    (m) => m.taskId === taskId && m.direction === "inbound"
  );
}

// Re-export for src/integrations/messaging.ts which owns outbound
// dispatch routing across all bridge kinds.
export { dispatchOutboundMessage };
