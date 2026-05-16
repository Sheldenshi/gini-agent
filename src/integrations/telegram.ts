// Telegram Bot API client used by the messaging bridge runtime.
//
// We talk to api.telegram.org directly over fetch — no SDK dependency.
// Outbound calls are short request/response (sendMessage, getMe).
// Inbound uses long-polling (getUpdates with a long `timeout`) so a local
// Gini instance with no public webhook URL can still receive messages.

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

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  sendMessage(chatId: string | number, text: string): Promise<TelegramMessage>;
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
    sendMessage: (chatId, text) => call<TelegramMessage>("sendMessage", { chat_id: chatId, text }),
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
