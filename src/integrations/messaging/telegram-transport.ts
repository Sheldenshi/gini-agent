// Pure HTTP wrappers around the Telegram Bot API. No state, no caching,
// no audit emission — the callers (poller, handlers, output dispatcher)
// own those concerns. Every call accepts an AbortSignal so the shutdown
// drain in src/server.ts can tear pollers down cleanly.
//
// The token is passed in by the caller (resolved per-call from the
// connector secret store) so this module never reads from process.env
// and never persists the token anywhere — matching ADR
// connector-secret-storage.md.

import { telegramApiUrl } from "../connectors/telegram";

// Telegram message_id is a 32-bit signed int per the public Bot API
// reference. We use `number` throughout the codebase but document the
// constraint here so any future audit/log code doesn't get tempted to
// truncate it.
export interface TelegramSendOk {
  ok: true;
  messageId: number;
}

export interface TelegramSendFail {
  ok: false;
  error: string;
  // Optional HTTP status / Telegram error code so callers can branch
  // (e.g. status === 401 means token is gone and the poller should
  // flip the bridge to error).
  status?: number;
}

export type TelegramSendResult = TelegramSendOk | TelegramSendFail;

export interface TelegramUpdate {
  // Telegram update_id is monotonically increasing per-bot; we persist
  // last_id + 1 as the bridge's updateOffset so the next getUpdates
  // call resumes after the last dispatched update across restarts.
  update_id: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
  // Updates we don't dispatch (channel_post, chat_member, …) flow
  // through as best-effort `unsupported_update` audit rows.
  [key: string]: unknown;
}

export interface TelegramIncomingMessage {
  message_id: number;
  // Auth key: only the numeric user id is stable across handle renames
  // and shared bot/group memberships. Never use `chat.id` for auth.
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  chat: { id: number; type: string; title?: string; username?: string };
  date: number;
  text?: string;
  // We intentionally don't surface entities / reply_to_message / etc.
  // here — the handlers only care about text routing for v1. Future
  // work that adds file/voice support can re-extend this shape.
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TelegramIncomingMessage;
  data?: string;
}

export interface TelegramGetUpdatesOk {
  ok: true;
  updates: TelegramUpdate[];
}

export interface TelegramGetUpdatesFail {
  ok: false;
  error: string;
  status?: number;
}

export type TelegramGetUpdatesResult = TelegramGetUpdatesOk | TelegramGetUpdatesFail;

// Inline-keyboard shape we send for approval prompts. Telegram accepts
// a richer set of fields; we pin to the subset we actually use so the
// type can't drift away from what handlers parse.
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

// JSON helper. Telegram returns either { ok: true, result: ... } or
// { ok: false, description: ..., error_code: ... } — we centralize the
// parse so callers branch on the discriminated union, not on the raw
// shape.
async function postJson(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ ok: true; result: unknown } | { ok: false; description: string; status: number }> {
  // Wrap fetch in try/catch so transport-level rejections (DNS failure,
  // ECONNREFUSED, TLS errors, AbortError) flow through the same
  // discriminated-union failure branch that Telegram-shaped errors take.
  // Without this the throw propagates past callers' "row → failed" code,
  // leaving the outbound MessagingMessageRecord stuck at status:"queued"
  // even though the network call never reached the server.
  let response: Response;
  try {
    response = await fetch(telegramApiUrl(token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, description: message, status: 0 };
  }
  const status = response.status;
  let payload: { ok?: boolean; result?: unknown; description?: string };
  try {
    payload = await response.json();
  } catch {
    return { ok: false, description: `Telegram API ${method} returned non-JSON (HTTP ${status})`, status };
  }
  if (!payload.ok) {
    return {
      ok: false,
      description: payload.description ?? `Telegram API ${method} failed (HTTP ${status})`,
      status
    };
  }
  return { ok: true, result: payload.result };
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  options: { replyMarkup?: TelegramInlineKeyboardMarkup; signal?: AbortSignal } = {}
): Promise<TelegramSendResult> {
  // Telegram caps a single sendMessage at 4096 characters. Callers that
  // expect long bodies (the streaming reply manager) split before we get
  // here; anything that arrives oversized is truncated to the cap and
  // a marker is appended so the model output isn't silently dropped.
  const body: Record<string, unknown> = { chat_id: chatId, text: clampForTelegram(text) };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  const result = await postJson(token, "sendMessage", body, options.signal);
  if (!result.ok) return { ok: false, error: result.description, status: result.status };
  const message = result.result as { message_id?: number };
  if (typeof message.message_id !== "number") {
    return { ok: false, error: "Telegram sendMessage returned no message_id." };
  }
  return { ok: true, messageId: message.message_id };
}

export async function editMessageText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  options: { replyMarkup?: TelegramInlineKeyboardMarkup; signal?: AbortSignal } = {}
): Promise<TelegramSendResult> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: clampForTelegram(text)
  };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  const result = await postJson(token, "editMessageText", body, options.signal);
  if (!result.ok) return { ok: false, error: result.description, status: result.status };
  // editMessageText returns either the edited Message (when text differs)
  // or the literal `true` (when the new text equals the old — Telegram
  // treats that as a no-op). Both are success for our purposes; we keep
  // the original messageId on the no-op branch so the caller's
  // bookkeeping stays stable.
  const message = result.result as { message_id?: number } | true;
  const returnedId = typeof message === "object" && message && typeof message.message_id === "number"
    ? message.message_id
    : messageId;
  return { ok: true, messageId: returnedId };
}

export async function answerCallbackQuery(
  token: string,
  queryId: string,
  text: string | undefined,
  options: { signal?: AbortSignal } = {}
): Promise<{ ok: true } | TelegramSendFail> {
  const body: Record<string, unknown> = { callback_query_id: queryId };
  if (text) body.text = text;
  const result = await postJson(token, "answerCallbackQuery", body, options.signal);
  if (!result.ok) return { ok: false, error: result.description, status: result.status };
  return { ok: true };
}

export async function sendChatAction(
  token: string,
  chatId: number | string,
  action: "typing" | "upload_photo" | "record_audio",
  options: { signal?: AbortSignal } = {}
): Promise<{ ok: true } | TelegramSendFail> {
  const result = await postJson(token, "sendChatAction", { chat_id: chatId, action }, options.signal);
  if (!result.ok) return { ok: false, error: result.description, status: result.status };
  return { ok: true };
}

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
  signal?: AbortSignal
): Promise<TelegramGetUpdatesResult> {
  // GET so the request body stays small even on a long timeout window.
  // We deliberately pass timeout via query string to match the Telegram
  // long-polling examples; the same fetch carries the AbortSignal so a
  // shutdown drain unblocks the inflight call within the next event-loop
  // tick instead of waiting for the full timeoutSeconds to elapse.
  const url = `${telegramApiUrl(token, "getUpdates")}?offset=${encodeURIComponent(String(offset))}&timeout=${encodeURIComponent(String(timeoutSeconds))}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const status = response.status;
  let payload: { ok?: boolean; result?: TelegramUpdate[]; description?: string };
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: `Telegram getUpdates returned non-JSON (HTTP ${status})`, status };
  }
  if (!payload.ok || !Array.isArray(payload.result)) {
    return {
      ok: false,
      error: payload.description ?? `Telegram getUpdates failed (HTTP ${status})`,
      status
    };
  }
  return { ok: true, updates: payload.result };
}

// Runtime type guard for a single TelegramUpdate. The transport returns
// `payload.result as TelegramUpdate[]` without per-element validation; this
// guard is the missing per-element shape check the poller applies before
// dispatch so malformed payloads (a non-numeric update_id, a message with
// no chat, a callback_query with no from.id) don't throw inside the
// dispatch handler or wedge the offset advancement.
export function isValidTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  if (typeof u.update_id !== "number" || !Number.isFinite(u.update_id)) return false;
  if (u.message !== undefined) {
    const m = u.message as Record<string, unknown> | null;
    if (!m || typeof m !== "object") return false;
    const chat = (m as { chat?: unknown }).chat as Record<string, unknown> | undefined;
    if (!chat || typeof chat !== "object") return false;
    if (typeof (chat as { id?: unknown }).id !== "number") return false;
  }
  if (u.callback_query !== undefined) {
    const cq = u.callback_query as Record<string, unknown> | null;
    if (!cq || typeof cq !== "object") return false;
    if (typeof (cq as { id?: unknown }).id !== "string") return false;
    const from = (cq as { from?: unknown }).from as Record<string, unknown> | undefined;
    if (!from || typeof from !== "object") return false;
    if (typeof (from as { id?: unknown }).id !== "number") return false;
  }
  return true;
}

// Telegram's hard limit. Exported so the streaming reply manager and
// tests can split against the same constant.
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

// Truncates oversized text and appends a marker so the model output
// isn't silently lost. Split-into-multiple-messages is the caller's job
// (see telegram-stream.ts); this is the last-resort guard.
function clampForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return text;
  const marker = "\n…[truncated]";
  return `${text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - marker.length)}${marker}`;
}
