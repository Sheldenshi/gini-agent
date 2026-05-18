// Telegram Bot API client used by the messaging bridge runtime.
//
// We talk to api.telegram.org directly over fetch — no SDK dependency.
// Outbound calls are short request/response (sendMessage, getMe).
// Inbound uses long-polling (getUpdates with a long `timeout`) so a local
// Gini instance with no public webhook URL can still receive messages.

import { basename } from "node:path";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

// Telegram's documented chat-action set. We expose them as a union so
// callers can't typo "typing" and silently no-op.
export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export type TelegramParseMode = "MarkdownV2" | "Markdown" | "HTML";

export interface SendMessageOptions {
  parseMode?: TelegramParseMode;
  disableWebPagePreview?: boolean;
}

// Photo source variants. The first two go out as JSON; `bytes` and
// `path` go out as multipart/form-data so the bot can upload local
// files (e.g. agent-produced screenshots) without staging them behind a
// public URL.
export type TelegramPhotoSource =
  | { kind: "url"; url: string }
  | { kind: "fileId"; fileId: string }
  | { kind: "bytes"; bytes: ArrayBuffer | Uint8Array | Blob; filename?: string; contentType?: string }
  | { kind: "path"; path: string; filename?: string; contentType?: string };

export interface SendPhotoOptions {
  caption?: string;
  parseMode?: TelegramParseMode;
}

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  sendMessage(chatId: string | number, text: string, options?: SendMessageOptions): Promise<TelegramMessage>;
  sendPhoto(chatId: string | number, source: TelegramPhotoSource, options?: SendPhotoOptions): Promise<TelegramMessage>;
  sendChatAction(chatId: string | number, action: TelegramChatAction): Promise<true>;
  getUpdates(offset: number | undefined, longPollSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

// Optional dependency-injection hook for tests. Production callers leave it
// undefined and the client uses the global fetch.
export type TelegramFetch = typeof fetch;

export interface TelegramClientOptions {
  fetchImpl?: TelegramFetch;
  apiBase?: string;
}

export function createTelegramClient(token: string, options: TelegramClientOptions = {}): TelegramClient {
  if (!token) throw new Error("Telegram bot token is required.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/$/, "");

  async function call<T>(method: string, payload: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<T> {
    const url = `${base}/bot${token}/${method}`;
    const init: RequestInit = { method: "POST", signal };
    if (payload !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(payload);
    }
    const response = await fetchImpl(url, init);
    return parseTelegramResponse<T>(response, method);
  }

  // Multipart variant used for binary uploads (sendPhoto with bytes or a
  // local file path). FormData must NOT set its own content-type header
  // — letting fetch generate the multipart boundary is the only way it
  // gets the boundary right.
  async function callMultipart<T>(method: string, form: FormData): Promise<T> {
    const url = `${base}/bot${token}/${method}`;
    const response = await fetchImpl(url, { method: "POST", body: form });
    return parseTelegramResponse<T>(response, method);
  }

  async function parseTelegramResponse<T>(response: Response, method: string): Promise<T> {
    let body: TelegramResponse<T>;
    try {
      body = (await response.json()) as TelegramResponse<T>;
    } catch {
      throw new Error(`Telegram ${method} failed: HTTP ${response.status} (non-JSON body)`);
    }
    if (!response.ok || !body.ok || body.result === undefined) {
      const reason = body.description ?? `HTTP ${response.status}`;
      throw new Error(`Telegram ${method} failed: ${reason}`);
    }
    return body.result;
  }

  return {
    getMe: () => call<TelegramUser>("getMe", {}),
    sendMessage: (chatId, text, opts) =>
      call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
        ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts?.disableWebPagePreview ? { disable_web_page_preview: true } : {})
      }),
    sendChatAction: (chatId, action) => call<true>("sendChatAction", { chat_id: chatId, action }),
    sendPhoto: async (chatId, source, opts) => {
      const captionFields = {
        ...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
        ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {})
      };
      if (source.kind === "url") {
        return call<TelegramMessage>("sendPhoto", { chat_id: chatId, photo: source.url, ...captionFields });
      }
      if (source.kind === "fileId") {
        return call<TelegramMessage>("sendPhoto", { chat_id: chatId, photo: source.fileId, ...captionFields });
      }
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (captionFields.caption !== undefined) form.append("caption", captionFields.caption);
      if (captionFields.parse_mode) form.append("parse_mode", captionFields.parse_mode);
      if (source.kind === "bytes") {
        const blob =
          source.bytes instanceof Blob
            ? source.bytes
            : new Blob([source.bytes as ArrayBuffer], { type: source.contentType ?? "application/octet-stream" });
        form.append("photo", blob, source.filename ?? "photo");
      } else {
        // kind === "path": Bun.file gives us a Blob without buffering the
        // whole file into memory.
        const file = Bun.file(source.path);
        form.append("photo", file, source.filename ?? basename(source.path));
      }
      return callMultipart<TelegramMessage>("sendPhoto", form);
    },
    getUpdates: (offset, longPollSeconds, signal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        {
          // Telegram skips updates with id <= offset−1, so we pass the next
          // expected id (highest seen + 1) to acknowledge processed messages.
          ...(offset !== undefined ? { offset } : {}),
          timeout: longPollSeconds,
          // We only care about text-message updates today; restricting the
          // allowed_updates list keeps the response small and avoids surfacing
          // callback queries / inline events we haven't wired up yet.
          allowed_updates: ["message"]
        },
        signal
      )
  };
}

// Extract the user-visible text from an update, if any. Returns undefined for
// updates that don't carry a chat message we can route (joins, edits without
// text, etc.).
export function extractIncomingText(update: TelegramUpdate): { chatId: number; text: string } | undefined {
  const message = update.message ?? update.edited_message;
  if (!message || !message.text) return undefined;
  return { chatId: message.chat.id, text: message.text };
}
