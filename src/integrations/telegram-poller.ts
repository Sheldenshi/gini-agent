// Inbound Telegram poller.
//
// Each configured Telegram bridge owns one long-poll loop against
// api.telegram.org's getUpdates. The supervisor reconciles the set of
// running loops against state every few seconds — new bridges start a
// loop, disabled or deleted bridges stop theirs. Loops are cancellable
// via AbortController so SIGTERM doesn't have to wait out the long-poll
// timeout.

import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { MessagingBridgeRecord, MessagingMessageMedia, RuntimeConfig } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { instanceRoot } from "../paths";
import {
  authorizeTelegramChat,
  findTelegramChatSession,
  hasActivePairingCode,
  readBridgeBotToken,
  receiveMessagingInput,
  recordDeniedChatAttempt,
  sendMessagingOutput,
  tryClaimPairingCode
} from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import {
  createTelegramClient,
  extractIncomingPayload,
  type IncomingPayload,
  type TelegramClient
} from "./telegram";

// Telegram caps the long-poll timeout at 50s. 25s is a comfortable middle
// ground — long enough to amortize HTTP overhead, short enough that a
// dropped connection recovers within half a minute.
const LONG_POLL_SECONDS = 25;

// Backoff after an error so a flaky network or a revoked token doesn't
// hammer the API.
const ERROR_BACKOFF_MS = 5000;

// Telegram chat actions auto-clear after ~5 seconds. We refresh just under
// that so the "is typing…" stays visible continuously until the task
// settles, without piling on requests.
const TYPING_REFRESH_MS = 4000;

export interface PollerDeps {
  clientFactory?: (token: string) => TelegramClient;
}

interface RunningLoop {
  controller: AbortController;
  done: Promise<void>;
}

export interface PollerSupervisor {
  // Snapshot the current state and start/stop loops to match.
  reconcile(): void;
  // Cancel every running loop and await their exits.
  stopAll(): Promise<void>;
  // Number of live loops. Exposed for tests + diagnostics.
  size(): number;
}

export function createTelegramPollerSupervisor(
  config: RuntimeConfig,
  deps: PollerDeps = {}
): PollerSupervisor {
  const loops = new Map<string, RunningLoop>();
  const factory = deps.clientFactory ?? ((token: string) => createTelegramClient(token));
  let stopped = false;

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "telegram") return false;
    if (bridge.status !== "configured") return false;
    return Boolean(bridge.secretRefs?.some((ref) => ref.purpose === "bot-token"));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(config, bridgeId, controller.signal, factory).finally(() => {
      loops.delete(bridgeId);
    });
    loops.set(bridgeId, { controller, done });
  }

  function stopLoop(bridgeId: string): void {
    const loop = loops.get(bridgeId);
    if (!loop) return;
    loop.controller.abort();
  }

  return {
    reconcile() {
      if (stopped) return;
      const bridges = readState(config.instance).messagingBridges;
      const desired = new Set<string>();
      for (const bridge of bridges) {
        if (shouldRun(bridge)) desired.add(bridge.id);
      }
      for (const id of desired) {
        if (!loops.has(id)) startLoop(id);
      }
      for (const id of loops.keys()) {
        if (!desired.has(id)) stopLoop(id);
      }
    },
    async stopAll() {
      stopped = true;
      for (const loop of loops.values()) loop.controller.abort();
      await Promise.all(Array.from(loops.values()).map((loop) => loop.done.catch(() => {})));
    },
    size() {
      return loops.size;
    }
  };
}

async function runLoop(
  config: RuntimeConfig,
  bridgeId: string,
  signal: AbortSignal,
  factory: (token: string) => TelegramClient
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "telegram" || bridge.status !== "configured") return;
    const token = readBridgeBotToken(config, bridge);
    if (!token) return;

    const offset = readLastOffset(bridge);
    let client: TelegramClient;
    try {
      client = factory(token);
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.client_error", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      continue;
    }

    let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
    try {
      updates = await client.getUpdates(offset, LONG_POLL_SECONDS, signal);
    } catch (error) {
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.telegram.poll_error", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      continue;
    }

    if (updates.length === 0) continue;

    const botUsername =
      typeof bridge.metadata?.botUsername === "string" ? bridge.metadata.botUsername : undefined;

    for (const update of updates) {
      if (signal.aborted) return;
      const incoming = extractIncomingPayload(update, { botUsername });
      if (incoming) {
        // Allowlist gate: every chat — including the operator's first
        // DM — is denied until explicitly enrolled. A private chat can
        // also enroll itself by sending the bridge's pairing code as
        // its first message; that's the only shortcut around the
        // explicit `allow` call. Denied updates are dropped silently
        // (no acknowledgement to strangers), but the attempt lands on
        // `bridge.metadata.recentDeniedChats` so the operator can
        // discover their chat_id via `gini messaging chats <bridge>`
        // without tailing the log. The offset still advances so the
        // same denied update doesn't get re-fetched on the next poll.
        const allowed = await authorizeTelegramChat(config, bridgeId, incoming.chatId);
        if (!allowed) {
          const paired = await tryClaimPairingCode(config, bridgeId, {
            chatId: incoming.chatId,
            chatType: incoming.chatType,
            text: incoming.text
          });
          if (paired) {
            appendLog(config.instance, "messaging.telegram.chat_paired", {
              bridgeId,
              chatId: incoming.chatId,
              senderHandle: incoming.senderHandle
            });
            // Confirm the pair back to the user. The pairing message
            // itself is consumed (not turned into a task) so the
            // operator's first "real" turn comes next.
            try {
              await sendMessagingOutput(config, bridgeId, {
                text: "Paired. You can chat with the bot now.",
                target: String(incoming.chatId)
              });
            } catch (error) {
              appendLog(config.instance, "messaging.telegram.pair_confirm_error", {
                bridgeId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
            await advanceOffset(config, bridgeId, update.update_id);
            continue;
          }
          appendLog(config.instance, "messaging.telegram.chat_denied", {
            bridgeId,
            chatId: incoming.chatId,
            chatType: incoming.chatType,
            senderHandle: incoming.senderHandle
          });
          await recordDeniedChatAttempt(config, bridgeId, {
            chatId: incoming.chatId,
            chatType: incoming.chatType,
            sender: incoming.senderHandle
          });
          // Hint reply during an active pairing window: a denied
          // private DM is most likely the operator typing "hi" before
          // they noticed the pairing code, so a one-line nudge saves
          // them from staring at silence. Outside the window — or for
          // groups — we stay dark so strangers don't get confirmation
          // the bot exists.
          if (incoming.chatType === "private" && hasActivePairingCode(config, bridgeId)) {
            try {
              await sendMessagingOutput(config, bridgeId, {
                text: "Please send your pairing code to enroll this chat.",
                target: String(incoming.chatId)
              });
            } catch (error) {
              appendLog(config.instance, "messaging.telegram.pair_hint_error", {
                bridgeId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
          await advanceOffset(config, bridgeId, update.update_id);
          continue;
        }
        // Resolve photo bytes to a local file before submitting the
        // task. A download failure logs and continues with whatever
        // text/caption we already have so a transient network blip
        // doesn't drop the message entirely.
        const downloaded = incoming.photo
          ? await downloadIncomingPhoto(config, bridgeId, update.update_id, incoming, client).catch((error) => {
              appendLog(config.instance, "messaging.telegram.photo_download_error", {
                bridgeId,
                fileId: incoming.photo?.file_id,
                error: error instanceof Error ? error.message : String(error)
              });
              return undefined;
            })
          : undefined;
        try {
          const taskInput = buildTaskInput(incoming, downloaded?.path);
          const record = await receiveMessagingInput(config, bridgeId, {
            text: taskInput,
            target: String(incoming.chatId),
            media: downloaded?.media
          });
          // Surface a "typing…" indicator while the agent works, and
          // once the task settles mirror the assistant reply back to
          // the originating chat. The pulse is best-effort and runs
          // detached so a slow chat_action call doesn't block the
          // next update.
          if (record.taskId) {
            void maintainTypingAndMirrorReply(
              config,
              bridgeId,
              record.taskId,
              incoming.chatId,
              client,
              signal,
              incoming.messageId
            ).catch((error) => {
              appendLog(config.instance, "messaging.telegram.typing_error", {
                bridgeId,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
        } catch (error) {
          appendLog(config.instance, "messaging.telegram.receive_error", {
            bridgeId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await advanceOffset(config, bridgeId, update.update_id);
    }
  }
}

// Persist the offset *after* each update so a crash mid-batch doesn't
// replay messages that already produced tasks. Telegram's contract is
// "next offset = highest update_id + 1". The denied-chat branch calls
// this directly so silently-dropped updates don't accumulate.
async function advanceOffset(config: RuntimeConfig, bridgeId: string, updateId: number): Promise<void> {
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridgeId);
    if (!live) return;
    live.metadata = { ...(live.metadata ?? {}), lastOffset: updateId + 1 };
    live.updatedAt = now();
  });
}

function readLastOffset(bridge: MessagingBridgeRecord): number | undefined {
  const raw = bridge.metadata?.lastOffset;
  return typeof raw === "number" ? raw : undefined;
}

// Combined typing pulse + reply mirror. While the task is non-terminal
// we refresh sendChatAction("typing") on a ~4s cadence so the chat
// shows "is typing…". Once the task settles we sync the assistant
// message into the chat session (the web UI's sync path) and dispatch
// the resulting text back to Telegram via sendMessagingOutput, which
// applies the MarkdownV2 transform and records an outbound message.
async function maintainTypingAndMirrorReply(
  config: RuntimeConfig,
  bridgeId: string,
  taskId: string,
  chatId: number,
  client: TelegramClient,
  signal: AbortSignal,
  replyToMessageId?: number
): Promise<void> {
  await maintainTypingIndicator(config, taskId, chatId, client, signal);
  if (signal.aborted) return;

  // Resolve the chat session for this (bridge, chat) so we can land
  // the assistant message and look up the dispatch target. The session
  // exists because receiveMessagingInput went through the chat path.
  const session = findTelegramChatSession(config, bridgeId, chatId);
  if (!session || !session.source || session.source.kind !== "telegram") return;

  let replyText: string | undefined;
  try {
    const message = await syncChatTaskResult(config, session.id, taskId);
    if (message && message.role === "assistant") replyText = message.content;
  } catch (error) {
    appendLog(config.instance, "messaging.telegram.sync_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // Empty replies or [SILENT]-suppressed messages produce nothing to
  // dispatch — leave the inbound record in place but stay quiet.
  if (!replyText || replyText.trim().length === 0) return;

  try {
    await sendMessagingOutput(config, bridgeId, {
      text: replyText,
      target: session.source.target,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {})
    });
  } catch (error) {
    appendLog(config.instance, "messaging.telegram.reply_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Refresh sendChatAction("typing") on a ~4s cadence for as long as the
// originating task is in a non-terminal state. The first action fires
// immediately so the user sees "is typing…" the moment they finish
// sending. Errors halt the pulse — a revoked chat (`chat not found`) or
// a network blip shouldn't keep us looping forever.
async function maintainTypingIndicator(
  config: RuntimeConfig,
  taskId: string,
  chatId: number,
  client: TelegramClient,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) return;
    try {
      await client.sendChatAction(chatId, "typing");
    } catch {
      return;
    }
    await sleepUnlessAborted(TYPING_REFRESH_MS, signal);
  }
}

// Resolve an inbound photo's file_id to a local path under the instance
// inbound directory. The path is stable across restarts (keyed on
// bridge + update_id + file_id), and the media descriptor records both
// the local path and the Telegram file_id so the agent can re-fetch via
// sendPhoto if it needs to echo the image back.
async function downloadIncomingPhoto(
  config: RuntimeConfig,
  bridgeId: string,
  updateId: number,
  incoming: IncomingPayload,
  client: TelegramClient
): Promise<{ path: string; media: MessagingMessageMedia } | undefined> {
  if (!incoming.photo) return undefined;
  const file = await client.getFile(incoming.photo.file_id);
  if (!file.file_path) {
    throw new Error("Telegram returned no file_path (file may exceed the 20MB Bot API limit)");
  }
  const bytes = await client.downloadFile(file.file_path);
  const ext = (extname(file.file_path) || ".jpg").toLowerCase();
  const dir = join(instanceRoot(config.instance), "inbound", bridgeId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${updateId}-${incoming.photo.file_id}${ext}`);
  await Bun.write(path, bytes);
  return {
    path,
    media: { kind: "photo", path, fileId: incoming.photo.file_id }
  };
}

// Compose the input string handed to submitTask. Two prefixes can land
// on the message before the body:
//   - `[photo: <path>]` when an inbound photo was captured to disk, so
//     the agent's file toolset can inspect the attachment without any
//     changes to how task inputs flow through the runtime.
//   - `<sender>:` for group/supergroup chats where multiple people can
//     speak. The agent needs to know whose turn it is so it can address
//     the right person (and not confuse one user's question with
//     another's reply).
function buildTaskInput(incoming: IncomingPayload, savedPath: string | undefined): string {
  const parts: string[] = [];
  if (savedPath) parts.push(`[photo: ${savedPath}]`);
  const isGroupChat = incoming.chatType === "group" || incoming.chatType === "supergroup";
  const body = isGroupChat && incoming.senderHandle
    ? `${incoming.senderHandle}: ${incoming.text}`
    : incoming.text;
  if (body) parts.push(body);
  return parts.join("\n");
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
