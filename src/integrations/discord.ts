// Discord Bot API client used by the messaging bridge runtime.
//
// We talk to discord.com/api/v10 directly over fetch — no SDK
// dependency, matching the local-first shape the Telegram bridge
// adopts. Outbound calls are short request/response (sendMessage,
// triggerTypingIndicator, getMe). Inbound is a REST poll
// (fetchChannelMessages with `?after=<snowflake>`) — Discord does not
// expose long-poll, so REST stays the source of truth for inbound
// content, watermark advancement, dedupe, and pagination. The bridge
// also opens a Gateway WebSocket (see `./discord-gateway.ts`) for two
// purposes: presence (flips the bot's Online badge) and push-driven
// poll wake (collapses the next REST sleep to ~0ms on a MESSAGE_CREATE
// event so typical inbound latency drops from 0-3s to one REST round
// trip). REST polling stays in charge of correctness; gateway is a
// pure-latency optimization.

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  // New Discord usernames return discriminator "0" and surface the
  // display name via global_name. Older bots keep their #1234 tag.
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordMessageAuthor {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: DiscordMessageAuthor;
}

interface DiscordError {
  message?: string;
  code?: number;
}

// Options bag for the outbound send. `signal` lets the supervisor's
// stopAll cancel a hung POST instead of waiting it out — without
// this a hung Discord `sendMessage` blocks the detached reply-mirror
// worker, and supervisor.stopAll (which now awaits those workers)
// deadlocks. `replyToMessageId` threads the outbound onto a specific
// inbound message via Discord's `message_reference` object so the
// bot's reply visually attaches to the user's question; pairs with
// `fail_if_not_exists: false` so a user deleting their message
// mid-task lets the reply fall back to an unthreaded send instead of
// failing the whole call.
export interface SendMessageOptions {
  signal?: AbortSignal;
  replyToMessageId?: string;
}

export interface FetchChannelMessagesOptions {
  // Snowflake to fetch strictly newer messages than. Discord returns
  // the NEWEST N messages above this cursor, sorted newest-first.
  afterId?: string;
  // Snowflake to fetch strictly older messages than. Discord returns
  // the NEWEST N messages below this cursor, sorted newest-first.
  // Discord's API allows only one of around/before/after per call —
  // callers pass at most one.
  beforeId?: string;
  // Discord caps `limit` at 100. We default 50 which is comfortable
  // for the polling cadence and keeps the response small.
  limit?: number;
  // Optional abort signal so SIGTERM can cancel an in-flight fetch.
  signal?: AbortSignal;
}

export interface DiscordClient {
  getMe(): Promise<DiscordUser>;
  sendMessage(channelId: string, content: string, options?: SendMessageOptions): Promise<DiscordMessage>;
  // Trigger Discord's typing indicator. The indicator persists for ~10
  // seconds before clearing automatically; the poller refreshes on a
  // shorter cadence so long-running tasks stay visible. The optional
  // signal lets the poller cancel an in-flight typing POST on
  // shutdown or bridge disable so a hung request doesn't block the
  // reply mirror it gates.
  triggerTypingIndicator(channelId: string, signal?: AbortSignal): Promise<true>;
  fetchChannelMessages(channelId: string, options?: FetchChannelMessagesOptions): Promise<DiscordMessage[]>;
}

export type DiscordFetch = typeof fetch;

export interface DiscordClientOptions {
  fetchImpl?: DiscordFetch;
  apiBase?: string;
}

const CONTENT_LIMIT = 2000;

export function createDiscordClient(token: string, options: DiscordClientOptions = {}): DiscordClient {
  if (!token) throw new Error("Discord bot token is required.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.apiBase ?? DISCORD_API_BASE).replace(/\/$/, "");
  const authHeader = `Bot ${token}`;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    payload: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    parseEmpty = false
  ): Promise<T> {
    const init: RequestInit = {
      method,
      signal,
      headers: { authorization: authHeader }
    };
    if (payload !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" } as Record<string, string>;
      init.body = JSON.stringify(payload);
    }
    const response = await fetchImpl(`${base}${path}`, init);
    return parseDiscordResponse<T>(response, path, parseEmpty);
  }

  async function parseDiscordResponse<T>(response: Response, path: string, parseEmpty: boolean): Promise<T> {
    if (!response.ok) {
      const reason = await readErrorReason(response);
      throw new Error(`Discord ${path} failed: ${reason}`);
    }
    // 204 No Content is the success shape for triggerTypingIndicator;
    // callers that opt in get a `true` sentinel so the type stays
    // narrow.
    if (parseEmpty || response.status === 204) return true as unknown as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error(`Discord ${path} returned a non-JSON body (HTTP ${response.status}).`);
    }
  }

  async function readErrorReason(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as DiscordError;
      if (payload?.message) {
        return payload.code !== undefined ? `${payload.message} (code ${payload.code})` : payload.message;
      }
    } catch {
      // Fall through to status-only.
    }
    return `HTTP ${response.status}`;
  }

  return {
    getMe: () => call<DiscordUser>("GET", "/users/@me", undefined),
    sendMessage: (channelId, content, options) => {
      if (!channelId) return Promise.reject(new Error("Discord channel id is required."));
      // Discord caps message content at 2000 chars. We truncate on the
      // client so callers don't have to pre-check; the cap is unlikely
      // to bite for chat-task summaries, but a long stack trace would
      // otherwise 400 the whole send.
      const trimmed = content.length > CONTENT_LIMIT ? content.slice(0, CONTENT_LIMIT) : content;
      const payload: Record<string, unknown> = {
        content: trimmed,
        // Block @everyone / @here / role / user mentions by default.
        // The agent's output is untrusted input from a chat-task
        // model; without this, an "@everyone please help" inside a
        // summary would notify every server member. Callers that
        // legitimately need a mention can lift this restriction
        // explicitly when the runtime grows a mention-aware send
        // path.
        allowed_mentions: { parse: [] }
      };
      if (options?.replyToMessageId) {
        // Thread the reply onto the inbound message. `fail_if_not_exists:
        // false` matches Telegram's allow_sending_without_reply: if the
        // user deletes the original message before the agent's reply
        // lands, Discord drops the reference and sends unthreaded
        // instead of returning 400 and losing the response.
        payload.message_reference = {
          message_id: options.replyToMessageId,
          channel_id: channelId,
          fail_if_not_exists: false
        };
      }
      return call<DiscordMessage>(
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages`,
        payload,
        options?.signal
      );
    },
    triggerTypingIndicator: (channelId, signal) => {
      if (!channelId) return Promise.reject(new Error("Discord channel id is required."));
      return call<true>(
        "POST",
        `/channels/${encodeURIComponent(channelId)}/typing`,
        {},
        signal,
        true
      );
    },
    fetchChannelMessages: (channelId, opts) => {
      if (!channelId) return Promise.reject(new Error("Discord channel id is required."));
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
      const params = new URLSearchParams({ limit: String(limit) });
      // Discord docs: "Only one of around, before, after may be
      // passed" — so we never set both. Prefer `before` when given
      // (the pagination loop uses it for catch-up paging once the
      // first `after` batch comes back full).
      if (opts?.beforeId) params.set("before", opts.beforeId);
      else if (opts?.afterId) params.set("after", opts.afterId);
      return call<DiscordMessage[]>(
        "GET",
        `/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`,
        undefined,
        opts?.signal
      );
    }
  };
}

export interface IncomingPayload {
  externalId: string;
  channelId: string;
  text: string;
  authorHandle: string;
  authorIsBot: boolean;
  createdAt: string;
}

// Translate the raw Discord wire shape into a payload the poller can
// reason about. Returns undefined for messages we can't route today
// (empty content, attachments-only). Discord's REST history returns
// messages newest-first; the poller flips them to oldest-first before
// calling this.
export function extractIncomingPayload(message: DiscordMessage): IncomingPayload | undefined {
  const text = message.content ?? "";
  // Attachment-only / embed-only messages arrive with an empty `content`
  // (Discord doesn't fold them into the text the way Telegram folds
  // captions). We surface them as "nothing to route" today; an
  // attachment-aware follow-up can extend the poller to download files
  // mirroring the Telegram photo path.
  if (text.length === 0) return undefined;
  const handle = message.author.global_name && message.author.global_name.length > 0
    ? message.author.global_name
    : message.author.username;
  return {
    externalId: message.id,
    channelId: message.channel_id,
    text,
    authorHandle: handle,
    authorIsBot: Boolean(message.author.bot),
    createdAt: message.timestamp
  };
}
