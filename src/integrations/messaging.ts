import { randomBytes } from "node:crypto";
import type { ChatSessionRecord, ConnectorSecretRef, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { submitTask } from "../agent";
import {
  addAudit,
  appendLog,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  findOrCreateDiscordChatSession,
  findOrCreateTelegramChatSession,
  mutateState,
  now,
  readState
} from "../state";
import { submitChatMessage } from "../execution/chat";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../state/secrets";
import { resolveEffectiveContext } from "../execution/effective-context";
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramClientOptions,
  type TelegramPhotoSource
} from "./telegram";
import {
  createDiscordClient,
  type DiscordClient,
  type DiscordClientOptions
} from "./discord";
import { formatTelegramMarkdownV2 } from "./telegram-format";
import type { MessagingMessageMedia } from "../types";

// Namespace used when storing per-bridge secrets through the connector
// secret store. Keeping it stable lets `deleteConnectorSecrets` find every
// secret a bridge owns even if the bridge's secretRefs list ever drifts.
function bridgeSecretNamespace(bridgeId: string): string {
  return `messaging.${bridgeId}`;
}

// Validate that a bot token is safe to embed in an HTTP request line —
// printable ASCII only, no whitespace, no control characters. Without
// this, a token containing a newline or control char would be rejected
// at fetch time and the resulting error message includes the full
// `Authorization: Bot <token>` header value, which then lands in
// `bridge.message` / `MessagingMessageRecord.error` and leaks via
// `GET /api/messaging`. Rejecting at create time stops the leak at
// the source.
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;
export function assertHeaderSafeToken(kind: string, raw: string): void {
  if (!HEADER_SAFE_TOKEN.test(raw)) {
    throw new Error(
      `${kind === "telegram" ? "Telegram" : "Discord"} bot token contains invalid characters — header-safe printable ASCII only.`
    );
  }
}

// Re-export the shared sanitizer so existing call sites in this file
// stay readable. The helper covers Discord auth-header tokens,
// Telegram URL-path tokens, and filesystem paths under <root>/secrets/
// — see messaging-poller-helpers.ts for the full pattern list.
import { sanitizeBridgeStatusMessage as sanitizeBridgeError } from "./messaging-poller-helpers";

// Test seam: production code calls Telegram / Discord for real, but tests
// inject stubbed clients so we can exercise send/health/poll without
// network IO. Each provider gets its own factory so a test can swap one
// without disturbing the other.
export interface MessagingDeps {
  telegramClientFactory?: (token: string) => TelegramClient;
  discordClientFactory?: (token: string) => DiscordClient;
}

let injectedDeps: MessagingDeps = {};
export function setMessagingDeps(deps: MessagingDeps): void {
  injectedDeps = deps;
}
export function resetMessagingDeps(): void {
  injectedDeps = {};
}

function telegramClientFor(token: string, options?: TelegramClientOptions): TelegramClient {
  if (injectedDeps.telegramClientFactory) return injectedDeps.telegramClientFactory(token);
  return createTelegramClient(token, options);
}

function discordClientFor(token: string, options?: DiscordClientOptions): DiscordClient {
  if (injectedDeps.discordClientFactory) return injectedDeps.discordClientFactory(token);
  return createDiscordClient(token, options);
}

// Translate the caller's photo input into a TelegramPhotoSource. Returns
// undefined when no photo is supplied. We accept url/fileId/path on a
// nested `photo` object; bytes uploads aren't reachable from the HTTP
// surface today (no multipart inbound) and are reserved for in-process
// callers like the agent's tool dispatcher.
function parsePhotoInput(raw: unknown): TelegramPhotoSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const photo = raw as { url?: unknown; fileId?: unknown; path?: unknown; filename?: unknown; contentType?: unknown };
  if (typeof photo.url === "string" && photo.url) return { kind: "url", url: photo.url };
  if (typeof photo.fileId === "string" && photo.fileId) return { kind: "fileId", fileId: photo.fileId };
  if (typeof photo.path === "string" && photo.path) {
    return {
      kind: "path",
      path: photo.path,
      filename: typeof photo.filename === "string" ? photo.filename : undefined,
      contentType: typeof photo.contentType === "string" ? photo.contentType : undefined
    };
  }
  return undefined;
}

function mediaRecordForOutbound(source: TelegramPhotoSource | undefined): MessagingMessageMedia | undefined {
  if (!source) return undefined;
  if (source.kind === "url") return { kind: "photo", url: source.url };
  if (source.kind === "fileId") return { kind: "photo", fileId: source.fileId };
  if (source.kind === "path") return { kind: "photo", path: source.path };
  return { kind: "photo" };
}

// The bot-token secret used to be stored under purpose "token" before a
// rename to "bot-token". Existing on-disk state from older bridges still
// references the old purpose string; the encrypted file lives under
// secrets/<bridge>.token.json. Accept either purpose so a bridge created
// pre-rename keeps polling without forcing the operator to recreate it.
const BOT_TOKEN_PURPOSES = ["bot-token", "token"] as const;
export function isBotTokenRef(ref: { purpose: string }): boolean {
  return (BOT_TOKEN_PURPOSES as readonly string[]).includes(ref.purpose);
}

export function readBridgeBotToken(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  const ref = bridge.secretRefs?.find(isBotTokenRef);
  if (!ref) return undefined;
  return readSecret(config.instance, ref);
}

// Read the bot token without 500ing the API on a secret-read
// failure. Both ENOENT and other read failures (corrupt JSON, AES
// auth tag mismatch, permission denied) collapse to undefined so
// the per-kind branches in checkMessagingBridge / sendMessagingOutput
// produce a typed "missing token" bridge error instead of a stack
// trace. Non-ENOENT errors get a runtime log entry with the raw
// (sanitized) message so the underlying cause stays diagnosable
// from runtime.jsonl even though the API surface shows "missing".
// The poller path uses the throwing readBridgeBotToken + markBridgeError
// so it surfaces the real reason on bridge.message directly.
function readBridgeBotTokenQuiet(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  try {
    return readBridgeBotToken(config, bridge);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(config.instance, "messaging.secret_read_error", {
        bridgeId: bridge.id,
        kind: bridge.kind,
        error: sanitizeBridgeError(message)
      });
    }
    return undefined;
  }
}

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");

  // Telegram and Discord both need a bot token. The credential travels
  // in on the create payload exactly once and is immediately handed to
  // the encrypted secret store; the plaintext never lands on the bridge
  // record or in audit evidence.
  const requiresToken = kind === "telegram" || kind === "discord";
  const botToken = requiresToken && typeof input.botToken === "string" ? input.botToken.trim() : "";
  if (requiresToken && !botToken) {
    throw new Error(`${kind === "telegram" ? "Telegram" : "Discord"} bridges require a botToken in the create payload.`);
  }
  if (requiresToken) {
    // Reject malformed tokens at create time. Without this, a token
    // containing a control character would be accepted, persisted to
    // the encrypted secret store, and then leak via the eventual
    // fetch error (Bun's HTTP layer echoes the auth header value in
    // its rejection message, which we persist to bridge.message).
    assertHeaderSafeToken(kind, botToken);
  }

  const bridge = await mutateState(config.instance, (state) => createMessagingBridgeRecord(state, {
    name,
    kind,
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
  }));

  if (requiresToken) {
    const ref = writeSecret(config.instance, bridgeSecretNamespace(bridge.id), "bot-token", botToken);
    await mutateState(config.instance, (state) => attachSecretRef(state.messagingBridges, bridge.id, ref));
    if (kind === "telegram") {
      // Auto-mint a pairing code so the operator can DM the bot and
      // enroll their chat in one paste, without ever needing to look
      // up their own chat_id. The whitelist remains the source of
      // truth — pairing just consumes a one-shot token to populate
      // it. Telegram-only: Discord uses channel-as-auth (see ADR
      // discord-bridge.md) and has no pairing flow to feed.
      return mutateState(config.instance, (state) => regeneratePairingCodeInState(state.messagingBridges, bridge.id));
    }
    // Discord bridges need the token but skip pairing — the bridge
    // record returned from createMessagingBridgeRecord already carries
    // the secretRef attachment via the mutate above.
    const refreshed = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    return refreshed ?? bridge;
  }

  return bridge;
}

function attachSecretRef(
  bridges: MessagingBridgeRecord[],
  bridgeId: string,
  ref: ConnectorSecretRef
): MessagingBridgeRecord {
  const bridge = bridges.find((item) => item.id === bridgeId);
  if (!bridge) throw new Error(`Messaging bridge not found: ${bridgeId}`);
  const existing = bridge.secretRefs ?? [];
  const filtered = existing.filter((candidate) => candidate.purpose !== ref.purpose);
  bridge.secretRefs = [...filtered, ref];
  bridge.updatedAt = now();
  return bridge;
}

export async function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  // Disabled bridges short-circuit the entire health check — no
  // network call, no metadata mutation, no audit row. The user
  // explicitly turned this bridge off; a health probe shouldn't
  // touch its state at all.
  if (bridge.status === "disabled") return bridge;

  // Per-kind health round-trip. We do the network call *outside*
  // mutateState so the lock isn't held for the duration of the
  // request, then fold the outcome back in. Only fields we actually
  // refresh (botUsername, botId) land in `metadataPatch` — the final
  // mutateState merges them into the live bridge so concurrent
  // metadata writes (the inbound poller advancing watermarks, etc.)
  // don't get clobbered by a stale snapshot.
  let nextStatus: MessagingBridgeRecord["status"] = "configured";
  let nextMessage: string;
  const metadataPatch: Record<string, unknown> = {};

  if (bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Telegram bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await telegramClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        nextMessage = me.username
          ? `Connected as @${me.username}.`
          : `Connected as bot ${me.id}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Discord bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await discordClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        // Set explicitly to null when the API returns no
        // global_name (older bots, removed display name), so the
        // metadata merge clears any stale value instead of
        // preserving it indefinitely.
        metadataPatch.globalName = typeof me.global_name === "string" && me.global_name.length > 0
          ? me.global_name
          : null;
        // Newer Discord accounts return discriminator "0" and surface
        // the handle via global_name; older bots keep username#discriminator.
        const handle = me.global_name && me.global_name.length > 0
          ? me.global_name
          : me.discriminator && me.discriminator !== "0"
            ? `${me.username}#${me.discriminator}`
            : me.username;
        nextMessage = `Connected as ${handle}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "demo") {
    nextMessage = "Demo messaging bridge is available for local inbound/outbound task messages.";
  } else {
    nextMessage = `${bridge.kind} bridge is configured with local Gini task routing.`;
  }

  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.lastHealthAt = now();
    // Disable race: a user-initiated disableMessagingBridge can land
    // while we were awaiting getMe(). Don't stamp the snapshotted
    // status/message back over "disabled" — preserve the user's
    // explicit intent. Metadata still merges so any concurrent
    // poller writes survive regardless.
    if (live.status !== "disabled") {
      live.status = nextStatus;
      live.message = nextMessage;
    }
    // Merge into the live metadata instead of overwriting from the
    // pre-await snapshot — concurrent poller writes to
    // metadata.lastInboundExternalIds / lastOffset must survive.
    live.metadata = { ...(live.metadata ?? {}), ...metadataPatch };
    live.updatedAt = live.lastHealthAt;
    // Bridge health probes are instance-level — the bridge serves every
    // agent, so the row doesn't belong to any one of them.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "messaging.health",
        target: live.id,
        risk: "low",
        evidence: { kind: live.kind, status: live.status }
      },
      { system: true }
    );
    return live;
  });
}

export function listMessagingMessages(config: RuntimeConfig, bridgeId?: string) {
  const messages = readState(config.instance).messagingMessages;
  return bridgeId ? messages.filter((message) => message.bridgeId === bridgeId) : messages;
}

export async function receiveMessagingInput(config: RuntimeConfig, idOrName: string, input: Record<string, unknown>) {
  const bridge = readState(config.instance).messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  if (bridge.status !== "configured") throw new Error(`Messaging bridge is not configured: ${idOrName}`);
  const text = String(input.text ?? "").trim();
  const media = parseInboundMedia(input.media);
  if (!text && !media) throw new Error("Inbound message text or media is required.");

  // Target validation is per-kind. Don't coerce a missing target to
  // "local" before the kind branches — that would mask required-target
  // guards (e.g. Discord's channel id). Each branch decides whether
  // the target is optional and what default applies. We accept
  // strings and finite numbers (JSON clients commonly send Telegram
  // chat_ids as numbers); everything else collapses to the empty
  // string which the per-kind guards reject.
  const rawTarget = typeof input.target === "string"
    ? input.target
    : typeof input.target === "number" && Number.isFinite(input.target)
      ? String(input.target)
      : "";

  // Telegram + Discord inbound run through the chat-task path so each
  // chat / channel gets a persistent conversation — same surface as the
  // web chat UI. The session carries a `source` descriptor so the
  // runtime can mirror assistant replies back out to the originating
  // chat. demo / generic bridges keep the standalone-task path for
  // tests and CLI parity.
  let taskId: string;
  let target: string;
  if (bridge.kind === "telegram") {
    // Strict integer parse: `Number.parseInt("123abc", 10)` returns 123
    // (the leading-numeric prefix), which would silently route a
    // malformed target to chat 123. Require the entire string to be a
    // signed integer with no trailing garbage.
    if (!/^-?\d+$/.test(rawTarget)) {
      throw new Error(`Telegram inbound target must be a numeric chat_id (got '${rawTarget}').`);
    }
    const chatId = Number.parseInt(rawTarget, 10);
    if (!Number.isFinite(chatId) || !Number.isSafeInteger(chatId)) {
      throw new Error(`Telegram inbound target must be a numeric chat_id (got '${rawTarget}').`);
    }
    target = String(chatId);
    const inboundMessageId = typeof input.messageId === "number" && Number.isFinite(input.messageId)
      ? (input.messageId as number)
      : undefined;
    const session = await mutateState(config.instance, (state) => {
      const sess = findOrCreateTelegramChatSession(state, bridge.id, chatId);
      // Stamp the originating message id on the source so scheduled-job
      // replies that fire later (after the inbound poll cycle moves on)
      // can thread back onto the original message via Telegram's
      // reply_to_message_id. Only stamp when the poller supplied one
      // so the HTTP /receive path doesn't blank it out.
      if (sess.source?.kind === "telegram" && inboundMessageId !== undefined) {
        sess.source.lastInboundMessageId = inboundMessageId;
      }
      return sess;
    });
    const result = await submitChatMessage(config, session.id, { content: text });
    taskId = result.taskId;
  } else if (bridge.kind === "discord") {
    const channelId = rawTarget.trim();
    if (!channelId) {
      throw new Error("Discord inbound target (channel id) is required.");
    }
    target = channelId;
    const inboundMessageId = typeof input.messageId === "string" && input.messageId.length > 0
      ? input.messageId
      : undefined;
    const session = await mutateState(config.instance, (state) => {
      const sess = findOrCreateDiscordChatSession(state, bridge.id, channelId);
      // See Telegram branch — same rationale for the source-level
      // message id stamp.
      if (sess.source?.kind === "discord" && inboundMessageId !== undefined) {
        sess.source.lastInboundMessageId = inboundMessageId;
      }
      return sess;
    });
    const result = await submitChatMessage(config, session.id, { content: text });
    taskId = result.taskId;
  } else {
    target = rawTarget || "local";
    const task = await submitTask(config, text);
    taskId = task.id;
  }

  // Note: the chat session id is intentionally NOT persisted on the
  // MessagingMessageRecord. Callers that need it look it up via the
  // task's session linkage (or via findTelegram/DiscordChatSession on
  // the bridge + chat coordinate).
  return mutateState(config.instance, (state) =>
    createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "inbound",
      status: "received",
      target,
      text,
      taskId,
      media
    })
  );
}

// Resolve a telegram-sourced chat session from a (bridge, chat_id)
// pair. The reply-mirror loop calls this to find where to land the
// assistant message and where to dispatch the outbound reply.
export function findTelegramChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: number
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "telegram" &&
      session.source.bridgeId === bridgeId &&
      session.source.chatId === chatId
  );
}

// Same shape, Discord side: resolve the chat session bound to a
// (bridge, channel) pair so the reply-mirror in the discord poller can
// look up the dispatch target without re-querying Discord.
export function findDiscordChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "discord" &&
      session.source.bridgeId === bridgeId &&
      session.source.channelId === channelId
  );
}

// Chat allowlist + explicit enrollment.
//
// Telegram bots are addressable by anyone who finds the @username, so
// without an allowlist a stranger can add the bot to their group and
// drive the runtime — burning the owner's provider tokens and
// potentially reaching workspace tools. The bridge stores a list of
// permitted chat_ids on `metadata.allowedChatIds`; the poller silently
// drops updates from anyone not on the list. There is NO trust-on-
// first-use: even the first DM from the bridge owner is denied until
// they explicitly run `gini messaging allow <bridge> <chat-id>` on
// their own machine.
//
// To make chat-id discovery painless (the owner doesn't typically
// know their own Telegram user_id off the top of their head), the
// poller records the last few denied attempts on
// `metadata.recentDeniedChats`. The owner runs `gini messaging chats
// <bridge>` and sees both the allowlist and a list of pending
// attempts, including their own — they pick out the right chat_id and
// enroll it. The list is bounded so a flood of stranger pings can't
// blow up the state record.

const MAX_RECENT_DENIED_CHATS = 10;

// Pairing code parameters. Telegram chat_ids are not visible in the
// Telegram UI, so a fresh operator can't easily run `allow <chat-id>`
// without first discovering their own id. The pairing code is a one-
// shot, time-bounded token printed only on the runtime's local stdout
// when the bridge is created. The operator pastes it into Telegram as
// their first DM; the poller validates it, enrolls the originating
// chat, and consumes the code. Codes are scoped to private chats
// only — groups always require explicit `allow` so a stranger who
// adds the bot to their group can never accidentally trip pairing.
const PAIRING_CODE_BYTES = 4; // 32 bits → 4.3B combos, plenty against the 15-min window
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
const PAIRING_CODE_PREFIX = "pair-";

export interface DeniedChatAttempt {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel" | string;
  // Telegram @handle when available, otherwise first_name. Omitted if
  // the update carried no `from` field (rare — typically channel posts).
  sender?: string;
  // Last time we saw an attempt from this chat. Newer attempts from
  // the same chat just bump the timestamp instead of stacking entries.
  lastAttemptAt: string;
}

export interface ChatAllowlistView {
  allowedChatIds: number[];
  ownerChatId?: number;
  recentDeniedChats: DeniedChatAttempt[];
}

function readAllowedChatIds(bridge: MessagingBridgeRecord): number[] {
  const raw = bridge.metadata?.allowedChatIds;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => Number(value)).filter((n) => Number.isFinite(n));
}

function readOwnerChatId(bridge: MessagingBridgeRecord): number | undefined {
  const raw = bridge.metadata?.ownerChatId;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function isChatAllowed(bridge: MessagingBridgeRecord, chatId: number): boolean {
  return readAllowedChatIds(bridge).includes(chatId);
}

// Atomically check whether an inbound chat is on the bridge's
// allowlist. Returns `true` when the message should be processed,
// `false` when the poller should drop it silently. No trust-on-first-
// use: every chat (including the owner's first DM) starts denied,
// and the owner enrolls themselves via `gini messaging allow` after
// finding their chat_id in the recent-denied list.
export async function authorizeTelegramChat(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: number
): Promise<boolean> {
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return false;
  return isChatAllowed(bridge, chatId);
}

// Record a denied chat attempt on the bridge so the owner can find
// their own chat_id via `gini messaging chats <bridge>` without
// tailing the runtime log. Dedupes by chatId — repeated attempts from
// the same stranger just refresh the timestamp instead of stacking
// entries. Bounded at MAX_RECENT_DENIED_CHATS to keep the state record
// small if a public-known bridge gets pinged at scale.
export async function recordDeniedChatAttempt(
  config: RuntimeConfig,
  bridgeId: string,
  attempt: { chatId: number; chatType: string; sender?: string }
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!live) return;
    const meta = { ...(live.metadata ?? {}) };
    const existing = readRecentDeniedChats(live).filter((entry) => entry.chatId !== attempt.chatId);
    const entry: DeniedChatAttempt = {
      chatId: attempt.chatId,
      chatType: attempt.chatType,
      ...(attempt.sender ? { sender: attempt.sender } : {}),
      lastAttemptAt: now()
    };
    // Newest first; cap at MAX so an attacker pinging in a loop can't
    // bloat the state record.
    meta.recentDeniedChats = [entry, ...existing].slice(0, MAX_RECENT_DENIED_CHATS);
    live.metadata = meta;
    live.updatedAt = entry.lastAttemptAt;
  });
}

function readRecentDeniedChats(bridge: MessagingBridgeRecord): DeniedChatAttempt[] {
  const raw = bridge.metadata?.recentDeniedChats;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as DeniedChatAttempt)
    .filter((entry) => entry && typeof entry.chatId === "number");
}

function generatePairingCode(): string {
  return PAIRING_CODE_PREFIX + randomBytes(PAIRING_CODE_BYTES).toString("hex");
}

// Mint (or rotate) a pairing code on the bridge. Called from
// addMessagingBridge so a freshly-created telegram bridge already has
// a valid code, and from pairMessagingBridge when the operator wants
// a new window after the previous code expired. Also exported under
// `mintTelegramPairingCodeInState` so the openclaw migrator can mint
// a code on a migrated bridge that came across with no allowlist —
// otherwise the poller silently denies every inbound and the bridge
// looks "configured" but does nothing.
function regeneratePairingCodeInState(
  bridges: MessagingBridgeRecord[],
  bridgeId: string
): MessagingBridgeRecord {
  const live = bridges.find((b) => b.id === bridgeId);
  if (!live) throw new Error(`Messaging bridge not found: ${bridgeId}`);
  const meta = { ...(live.metadata ?? {}) };
  meta.pairingCode = generatePairingCode();
  meta.pairingCodeExpiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  live.metadata = meta;
  live.updatedAt = now();
  return live;
}

export const mintTelegramPairingCodeInState = regeneratePairingCodeInState;

export async function pairMessagingBridge(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      throw new Error(`Pairing codes only apply to telegram bridges (got '${live.kind}').`);
    }
    const refreshed = regeneratePairingCodeInState(state.messagingBridges, live.id);
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.pairing.minted",
        target: refreshed.id,
        risk: "medium",
        evidence: { expiresAt: refreshed.metadata?.pairingCodeExpiresAt }
      },
      { system: true }
    );
    return refreshed;
  });
}

// True when the bridge currently has a valid (non-expired) pairing
// code. The poller calls this to decide whether to nudge a denied
// chat with a "send your pairing code" hint instead of going silent —
// outside a pairing window the bot stays dark so strangers don't get
// confirmation that it's running.
export function hasActivePairingCode(config: RuntimeConfig, bridgeId: string): boolean {
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return false;
  const meta = bridge.metadata;
  if (!meta) return false;
  if (typeof meta.pairingCode !== "string") return false;
  const expiresRaw = typeof meta.pairingCodeExpiresAt === "string" ? meta.pairingCodeExpiresAt : undefined;
  if (!expiresRaw) return false;
  const expiresAt = Date.parse(expiresRaw);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

// Atomically validate and consume a pairing attempt. Returns true when
// the message text matches the bridge's active pairing code AND the
// chat is private AND the code hasn't expired — in which case the
// originating chat is enrolled (as if `allow` were called) and the
// code is cleared. Wrong codes / expired codes / group chats return
// false; the poller's normal deny path takes over from there.
export async function tryClaimPairingCode(
  config: RuntimeConfig,
  bridgeId: string,
  payload: { chatId: number; chatType: string; text: string }
): Promise<boolean> {
  if (payload.chatType !== "private") return false;
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!live) return false;
    const meta = { ...(live.metadata ?? {}) };
    const code = typeof meta.pairingCode === "string" ? meta.pairingCode : undefined;
    const expiresRaw = typeof meta.pairingCodeExpiresAt === "string" ? meta.pairingCodeExpiresAt : undefined;
    if (!code || !expiresRaw) return false;
    const expiresAt = Date.parse(expiresRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      // Stale code — clear it so the field doesn't linger on metadata
      // and the operator can re-mint cleanly.
      delete meta.pairingCode;
      delete meta.pairingCodeExpiresAt;
      live.metadata = meta;
      live.updatedAt = now();
      return false;
    }
    if (payload.text.trim().toLowerCase() !== code.toLowerCase()) return false;

    // Code matched — consume it and enroll the chat. The whitelist is
    // still the source of truth; we just populated it via pairing
    // instead of a direct CLI call.
    delete meta.pairingCode;
    delete meta.pairingCodeExpiresAt;
    const allowed = readAllowedChatIds(live);
    if (!allowed.includes(payload.chatId)) allowed.push(payload.chatId);
    meta.allowedChatIds = allowed;
    if (readOwnerChatId(live) === undefined) meta.ownerChatId = payload.chatId;
    meta.recentDeniedChats = readRecentDeniedChats(live).filter((entry) => entry.chatId !== payload.chatId);
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "messaging.pairing.claimed",
        target: live.id,
        risk: "medium",
        evidence: { chatId: payload.chatId }
      },
      { system: true }
    );
    return true;
  });
}

export async function allowChat(config: RuntimeConfig, idOrName: string, chatId: number) {
  if (!Number.isFinite(chatId)) throw new Error("chatId must be a finite number.");
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      throw new Error(`Chat allowlist only applies to telegram bridges (got '${live.kind}').`);
    }
    const meta = { ...(live.metadata ?? {}) };
    const allowed = readAllowedChatIds(live);
    if (!allowed.includes(chatId)) allowed.push(chatId);
    meta.allowedChatIds = allowed;
    // First enrollment also becomes the recorded owner. After that the
    // field stays stable — `allow` of additional chats doesn't change
    // who originally claimed the bridge.
    if (readOwnerChatId(live) === undefined) {
      meta.ownerChatId = chatId;
    }
    // Drop the enrolled chat from the pending-attempts list so the
    // owner's view stays clean.
    meta.recentDeniedChats = readRecentDeniedChats(live).filter((entry) => entry.chatId !== chatId);
    // An explicit allow closes any active pairing window — the
    // operator just established trust through the CLI, so the
    // pairing-window hint becomes noise. They can mint a fresh code
    // with `gini messaging pair` whenever they want to onboard a
    // new chat via the shortcut path.
    delete meta.pairingCode;
    delete meta.pairingCodeExpiresAt;
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.chat.allowed",
        target: live.id,
        risk: "medium",
        evidence: { chatId }
      },
      { system: true }
    );
    return chatAllowlistView(live);
  });
}

export async function denyChat(config: RuntimeConfig, idOrName: string, chatId: number) {
  if (!Number.isFinite(chatId)) throw new Error("chatId must be a finite number.");
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      throw new Error(`Chat allowlist only applies to telegram bridges (got '${live.kind}').`);
    }
    const meta = { ...(live.metadata ?? {}) };
    const allowed = readAllowedChatIds(live).filter((id) => id !== chatId);
    meta.allowedChatIds = allowed;
    // Removing the owner chat doesn't clear ownerChatId — keep the
    // historical record so an audit reader can see who originally
    // paired the bridge. The bridge stops responding to that chat
    // either way because it's no longer on the allowlist.
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.chat.denied",
        target: live.id,
        risk: "medium",
        evidence: { chatId }
      },
      { system: true }
    );
    return chatAllowlistView(live);
  });
}

export function listAllowedChats(config: RuntimeConfig, idOrName: string): ChatAllowlistView {
  const bridge = readState(config.instance).messagingBridges.find(
    (b) => b.id === idOrName || b.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  if (bridge.kind !== "telegram") {
    throw new Error(`Chat allowlist only applies to telegram bridges (got '${bridge.kind}').`);
  }
  return chatAllowlistView(bridge);
}

function chatAllowlistView(bridge: MessagingBridgeRecord): ChatAllowlistView {
  const owner = readOwnerChatId(bridge);
  return {
    allowedChatIds: readAllowedChatIds(bridge),
    ...(owner !== undefined ? { ownerChatId: owner } : {}),
    recentDeniedChats: readRecentDeniedChats(bridge)
  };
}

function parseInboundMedia(raw: unknown): MessagingMessageMedia | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as MessagingMessageMedia;
  if (value.kind !== "photo") return undefined;
  return {
    kind: "photo",
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fileId === "string" ? { fileId: value.fileId } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {})
  };
}

// In-process options that don't travel over HTTP. Today this carries
// only an AbortSignal so the supervisor's stopAll can cancel an
// in-flight Discord POST instead of waiting it out. HTTP callers
// (POST /api/messaging/:id/send) pass undefined; internal callers
// (the poller's detached reply mirror) pass the loop's signal.
export interface SendMessagingOptions {
  signal?: AbortSignal;
}

export async function sendMessagingOutput(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>,
  options: SendMessagingOptions = {}
) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  // Reject sends against disabled / errored bridges up front instead
  // of doing the photo-parse + agent-filter work and then hitting a
  // missing-secret failure (or worse: completing a send on the
  // already-disabled bridge's last cached token). This is the
  // outbound counterpart of the supervisor's shouldRun gate on the
  // poll loop; it closes most of the disable-vs-send race window
  // (the tiny gap between this check and the actual fetch is
  // unavoidable without bridge-level abort, but the check rejects
  // every case where disable has already landed by the time the
  // dispatcher fires).
  if (bridge.status !== "configured") {
    throw new Error(`Invalid input: Messaging bridge '${idOrName}' is not configured (status: ${bridge.status}).`);
  }

  // Photo input variants. Callers supply at most one of url/fileId/path
  // on `input.photo`. When present, `text` becomes the optional caption;
  // a caption-only send still requires non-empty text-or-photo somewhere.
  const photoSource = parsePhotoInput(input.photo);
  const text = String(input.text ?? "").trim();
  if (!text && !photoSource) throw new Error("Outbound message requires text or a photo.");

  // Active-agent messaging-target whitelist. When the caller supplies an
  // explicit target outside the filter we reject loudly so a misrouted
  // message can't sneak past the agent's policy. When the caller doesn't
  // specify a target we pick the first bridge.deliveryTarget that's
  // permitted; if none are permitted we fall back to the bridge's
  // first target so messaging never silently fails on a fresh instance
  // with no agent restriction.
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  const requested = typeof input.target === "string" && input.target.length > 0 ? input.target : undefined;
  let target: string;
  if (requested !== undefined) {
    if (effective.messagingTargetFilter && !effective.messagingTargetFilter.has(requested)) {
      const agentLabel = effective.agentId ?? "active agent";
      throw new Error(`Target '${requested}' not permitted by active agent '${agentLabel}'`);
    }
    target = requested;
  } else if (effective.messagingTargetFilter) {
    const permitted = bridge.deliveryTargets.find((t) => effective.messagingTargetFilter!.has(t));
    target = permitted ?? bridge.deliveryTargets[0] ?? "local";
  } else {
    target = bridge.deliveryTargets[0] ?? "local";
  }

  let status: "sent" | "failed" = bridge.status === "configured" ? "sent" : "failed";
  let errorMessage: string | undefined =
    status === "failed" ? `Bridge is ${bridge.status}` : undefined;

  if (status === "sent" && bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Telegram bot token is missing.";
    } else {
      // Default: render the body as MarkdownV2 so the common agent
      // outputs (bold, inline code, fenced blocks) survive instead of
      // arriving as plain text. Callers that already speak Telegram's
      // dialect (or want a literal payload) can pass `parseMode: "none"`
      // to skip the converter and send the raw string.
      const parseModeRaw = typeof input.parseMode === "string" ? input.parseMode : undefined;
      const useMdv2 = parseModeRaw !== "none";
      const formatted = useMdv2 ? formatTelegramMarkdownV2(text) : text;
      // Thread the reply onto a specific inbound message when supplied
      // (group chats use this so the bot's response visually attaches to
      // the user's question). The Telegram client pairs the field with
      // `allow_sending_without_reply: true` whenever it's set, so a
      // deleted-mid-task original silently falls back to an unthreaded
      // send instead of failing the whole call.
      const replyToMessageId =
        typeof input.replyToMessageId === "number" ? input.replyToMessageId : undefined;
      try {
        const client = telegramClientFor(token);
        if (photoSource) {
          await client.sendPhoto(target, photoSource, {
            caption: formatted || undefined,
            parseMode: useMdv2 && formatted ? "MarkdownV2" : undefined,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(options.signal ? { signal: options.signal } : {})
          });
        } else {
          const sendOpts: import("./telegram").SendMessageOptions = {};
          if (useMdv2) sendOpts.parseMode = "MarkdownV2";
          if (replyToMessageId !== undefined) sendOpts.replyToMessageId = replyToMessageId;
          if (options.signal) sendOpts.signal = options.signal;
          await client.sendMessage(
            target,
            formatted,
            Object.keys(sendOpts).length > 0 ? sendOpts : undefined
          );
        }
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (status === "sent" && bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Discord bot token is missing.";
    } else if (photoSource) {
      // Photo uploads are a follow-up — Discord requires multipart
      // attachments with a different payload shape. Fail loudly so the
      // outbound record records the reason instead of silently dropping.
      status = "failed";
      errorMessage = "Discord bridge does not support photo sends yet.";
    } else if (!text) {
      // Discord rejects content-less messages with HTTP 400. We
      // intercept before the network call so the audit row carries a
      // useful reason.
      status = "failed";
      errorMessage = "Discord messages require non-empty text.";
    } else {
      try {
        // Discord uses snowflake strings for message ids. The poller
        // forwards the inbound message id via input.replyToMessageId so
        // the agent's reply threads onto the originating message
        // (`message_reference`); the client also pairs that with
        // `fail_if_not_exists: false` so a deleted-mid-task original
        // falls back to an unthreaded send instead of failing.
        const replyToMessageId =
          typeof input.replyToMessageId === "string" || typeof input.replyToMessageId === "number"
            ? String(input.replyToMessageId)
            : undefined;
        await discordClientFor(token).sendMessage(target, text, {
          signal: options.signal,
          ...(replyToMessageId ? { replyToMessageId } : {})
        });
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const media = mediaRecordForOutbound(photoSource);

  // When the caller threads a taskId on the input (e.g. the chat-sync
  // mirror in src/integrations/telegram-poller.ts) the outbound row and
  // its audit attribute to the originating task. Otherwise — pairing
  // confirmations, denial hints, ad-hoc operator pings — the send is
  // instance-level and unattributed.
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  return mutateState(config.instance, (live) => {
    const message = createMessagingMessageRecord(live, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      taskId,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      error: errorMessage,
      media
    });
    addAudit(
      live,
      {
        actor: "runtime",
        action: "messaging.sent",
        target: bridge.id,
        risk: "low",
        taskId,
        evidence: { messageId: message.id, status, target }
      },
      taskId ? { taskId } : { system: true }
    );
    return message;
  });
}

export async function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.status = "disabled";
    live.updatedAt = now();
    addAudit(
      state,
      { actor: "user", action: "messaging.disabled", target: live.id, risk: "medium" },
      { system: true }
    );
    return live;
  });
  // Drop the on-disk encrypted secret files. We do this after the state
  // mutation so a crash mid-disable leaves the bridge marked disabled even
  // if the file cleanup fails — the inbound poller skips disabled bridges
  // so a stranded token can't be used.
  deleteConnectorSecrets(config.instance, bridgeSecretNamespace(bridge.id));
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (live) live.secretRefs = [];
    return live;
  });
  return bridge;
}
