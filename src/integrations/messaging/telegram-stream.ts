// Streaming reply manager + outbound dispatch for telegram messaging.
//
// The poller drives inbound; this module handles the reply leg:
//   - ensureChatSessionForUser: lazily binds a per-user Gini chat
//     session to a Telegram allowlist entry, persisting the session id
//     onto the entry so subsequent messages keep landing in the same
//     session.
//   - dispatchOutboundMessage: branches on bridge kind. For telegram it
//     resolves the connector secret and posts (or edits) via the Bot
//     API; failures flip the message row to "failed" with the error
//     captured.
//
// Streaming (editMessageText every <=1s) lives behind
// streamPartialReply, kept simple for v1: a per-task last-edit timestamp
// throttles edits. The brief flags that a fancier debounce is a
// follow-up.

import type {
  MessagingBridgeRecord,
  MessagingMessageRecord,
  RuntimeConfig,
  TelegramAllowlistEntry
} from "../../types";
import {
  addAudit,
  createChatSession,
  mutateState,
  now,
  readState
} from "../../state";
import { resolveConnectorSecret } from "../connectors";
import {
  editMessageText,
  sendMessage,
  TELEGRAM_MAX_MESSAGE_CHARS,
  type TelegramInlineKeyboardMarkup,
  type TelegramSendResult
} from "./telegram-transport";

// Bind an allowlist entry to a chat session, creating one on first use.
// We mutate the bridge's allowlist row to cache the session id so the
// next inbound from the same user routes into the same chat without
// touching this code path.
export async function ensureChatSessionForUser(
  config: RuntimeConfig,
  bridgeId: string,
  entry: TelegramAllowlistEntry
): Promise<string> {
  // Fast path: if the entry already carries a session id, just return
  // it. We do a quick `readState` rather than holding the lock for the
  // common case.
  if (entry.chatSessionId) {
    const state = readState(config.instance);
    const exists = state.chatSessions.some((s) => s.id === entry.chatSessionId);
    if (exists) return entry.chatSessionId;
  }
  // Slow path: create a fresh chat session and persist the id back onto
  // the allowlist entry within a single mutateState write so concurrent
  // inbound messages from the same user don't race-create two sessions.
  return mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!bridge?.telegram) {
      throw new Error(`Telegram bridge missing config: ${bridgeId}`);
    }
    const liveEntry = bridge.telegram.allowlist.find((a) => a.telegramUserId === entry.telegramUserId);
    if (!liveEntry) {
      throw new Error(`Allowlist entry vanished while creating session for telegramUserId=${entry.telegramUserId}`);
    }
    if (liveEntry.chatSessionId) {
      const exists = state.chatSessions.some((s) => s.id === liveEntry.chatSessionId);
      if (exists) return liveEntry.chatSessionId!;
    }
    const title = liveEntry.telegramUsername
      ? `Telegram @${liveEntry.telegramUsername}`
      : `Telegram ${liveEntry.telegramUserId}`;
    const session = createChatSession(state, title);
    liveEntry.chatSessionId = session.id;
    bridge.updatedAt = now();
    return session.id;
  });
}

// Outbound dispatch entry point. Branches on bridge kind so the
// existing `demo` flow is unchanged and the telegram path resolves
// the connector secret per-call.
//
// `replyMarkup` is the optional inline keyboard payload used for
// approval prompts; non-approval messages omit it.
export async function dispatchOutboundMessage(
  config: RuntimeConfig,
  bridge: MessagingBridgeRecord,
  message: MessagingMessageRecord,
  options: { replyMarkup?: TelegramInlineKeyboardMarkup } = {}
): Promise<MessagingMessageRecord> {
  if (bridge.kind !== "telegram") return message;
  if (!bridge.connectorId) {
    return markMessageFailed(config, message.id, "Telegram bridge missing connectorId.");
  }
  const token = await resolveConnectorSecret(config, bridge.connectorId, "token");
  if (!token) {
    return markMessageFailed(config, message.id, "Telegram bot token could not be resolved.");
  }
  const chatId = message.target;
  // Pre-split oversized text so callers can rely on full delivery; the
  // first chunk becomes the message we record and stamp externalId on,
  // additional chunks fan out as plain follow-ups (best-effort).
  const chunks = splitForTelegram(message.text);
  const head = chunks[0] ?? "";
  let result: TelegramSendResult;
  if (message.externalId) {
    // Edit path: the streaming reply manager set externalId on the
    // placeholder. We always operate on the head chunk for edits; any
    // overflow chunks go out as new messages below.
    result = await editMessageText(token, chatId, Number(message.externalId), head, {
      replyMarkup: options.replyMarkup
    });
  } else {
    result = await sendMessage(token, chatId, head, { replyMarkup: options.replyMarkup });
  }
  if (!result.ok) {
    return markMessageFailed(config, message.id, result.error, result.status);
  }
  const sentMessageId = result.messageId;
  // Stamp externalId + status onto the message row so the streaming
  // reply manager can find this message back for future edits.
  await mutateState(config.instance, (state) => {
    const row = state.messagingMessages.find((m) => m.id === message.id);
    if (!row) return;
    row.status = "sent";
    row.externalId = String(sentMessageId);
    row.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.sent",
      target: bridge.id,
      risk: "low",
      taskId: row.taskId,
      evidence: {
        bridgeId: bridge.id,
        messageId: row.id,
        chatId,
        approvalId: row.approvalId
      }
    });
  });

  // Fan-out follow-ups for overflow chunks. We don't store these as
  // separate MessagingMessageRecord rows for v1 — the head row carries
  // the user-visible status and the overflow is best-effort. If a
  // follow-up fails we still surface an audit row so the operator can
  // see the partial delivery.
  for (let i = 1; i < chunks.length; i += 1) {
    const tailResult = await sendMessage(token, chatId, chunks[i] ?? "");
    if (!tailResult.ok) {
      await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "messaging.telegram.send_overflow_failed",
          target: bridge.id,
          risk: "low",
          evidence: { bridgeId: bridge.id, chatId, error: tailResult.error, status: tailResult.status }
        });
      });
    }
  }

  return readState(config.instance).messagingMessages.find((m) => m.id === message.id) ?? message;
}

// Throttle map: bridgeId|externalId → last edit ts (ms). Streaming
// edits beyond this rate get coalesced into the final edit emitted by
// the messaging-finalize hook. The map is per-process; a runtime
// restart drops it harmlessly because the placeholder either already
// shows the final text (because finalize wrote it) or will be edited
// to the final text on first finalize after restart.
const lastEditAt = new Map<string, number>();
const STREAM_EDIT_MIN_INTERVAL_MS = 1000;

export function shouldStreamEdit(bridgeId: string, externalId: string): boolean {
  const key = `${bridgeId}|${externalId}`;
  const at = Date.now();
  const last = lastEditAt.get(key) ?? 0;
  if (at - last < STREAM_EDIT_MIN_INTERVAL_MS) return false;
  lastEditAt.set(key, at);
  return true;
}

export function clearStreamEdit(bridgeId: string, externalId: string): void {
  lastEditAt.delete(`${bridgeId}|${externalId}`);
}

async function markMessageFailed(
  config: RuntimeConfig,
  messageId: string,
  error: string,
  status?: number
): Promise<MessagingMessageRecord> {
  return mutateState(config.instance, (state) => {
    const row = state.messagingMessages.find((m) => m.id === messageId);
    if (!row) throw new Error(`Message not found: ${messageId}`);
    row.status = "failed";
    row.error = error;
    row.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.send_failed",
      target: row.bridgeId,
      risk: "low",
      taskId: row.taskId,
      evidence: { messageId: row.id, error, status }
    });
    return row;
  });
}

// Split a string into chunks no larger than Telegram's 4096-char cap,
// preferring newlines as split points to avoid breaking mid-word. The
// last chunk doesn't carry a "[continued]" marker; callers can render
// that themselves if they want.
export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_CHARS);
    if (cut <= 0) cut = TELEGRAM_MAX_MESSAGE_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
