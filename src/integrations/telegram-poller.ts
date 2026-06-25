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
import type { MessagingBridgeRecord, MessagingMessageMedia, RuntimeConfig, TaskStatus } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState, uploadPathFor, uploadStat } from "../state";
import { UPLOAD_REF_SCHEME, uploadIdsFromText } from "../lib/upload-ref";
import {
  authorizeTelegramChat,
  deliverVerificationCode,
  findTelegramChatSession,
  isBotTokenRef,
  readBridgeBotToken,
  receiveMessagingInput,
  recordDeniedChatAttempt,
  sendMessagingOutput
} from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import {
  awaitTerminalTask,
  createDetachedTracker,
  markBridgeError,
  sleepUnlessAborted
} from "./messaging-poller-helpers";
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
  // Shared detached-worker tracker. The drain has a bounded timeout
  // so a hung Telegram send can't deadlock shutdown. `sendChatAction`
  // now threads AbortSignal so typing-pulse fetches cancel in-flight;
  // `sendMessage` / `sendPhoto` still don't, so the drain cap remains
  // the upper bound on shutdown latency.
  const detached = createDetachedTracker(config, "messaging.telegram.detached_drain_timeout");

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "telegram") return false;
    if (bridge.status !== "configured") return false;
    return Boolean(bridge.secretRefs?.some(isBotTokenRef));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(config, bridgeId, controller.signal, factory, detached.track).finally(() => {
      // Always abort the controller when the loop exits, so detached
      // children captured this signal observe abort and unwind on
      // natural returns (status flip, missing secret) as well as on
      // stopAll-driven aborts.
      controller.abort();
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
      // Drain detached workers with a bounded timeout. The Telegram
      // client now threads AbortSignal into sendChatAction, but
      // sendMessage / sendPhoto still don't accept one — a hung send
      // on those would otherwise keep stopAll pending forever, so the
      // drain cap is the upper bound on shutdown latency.
      await detached.drain();
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
  factory: (token: string) => TelegramClient,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "telegram" || bridge.status !== "configured") return;
    // readBridgeBotToken throws ENOENT if the encrypted secret file is
    // missing under the secretRef path (rotation, manual deletion,
    // corruption). Without a catch the rejection propagates out of
    // the loop and the supervisor reconcile restarts it on every
    // tick because shouldRun only checks for the secretRef entry,
    // not the file. Flip the bridge to "error" so the supervisor
    // drops it until the user re-supplies the token.
    let token: string | undefined;
    try {
      token = readBridgeBotToken(config, bridge);
    } catch (error) {
      await markBridgeError(
        config,
        bridgeId,
        "messaging.telegram.token_error",
        "messaging.telegram.mark_error_failed",
        error
      );
      return;
    }
    if (!token) {
      await markBridgeError(
        config,
        bridgeId,
        "messaging.telegram.token_error",
        "messaging.telegram.mark_error_failed",
        new Error("Telegram bot token secret is missing.")
      );
      return;
    }

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
        // DM — is denied until explicitly approved from the operator
        // UI (or via `gini messaging allow <bridge> <chat-id>`). For
        // private chats we mint a per-chat verification code and DM
        // it back to the user; the operator sees the same code next
        // to the pending-request row and confirms before clicking
        // Approve. Group chats are recorded silently — no code reply,
        // no acknowledgement — because there's no safe per-user
        // channel to deliver a code through. The offset still
        // advances so the same denied update doesn't get re-fetched
        // on the next poll.
        const allowed = await authorizeTelegramChat(config, bridgeId, incoming.chatId);
        if (!allowed) {
          appendLog(config.instance, "messaging.telegram.chat_denied", {
            bridgeId,
            chatId: incoming.chatId,
            chatType: incoming.chatType,
            senderHandle: incoming.senderHandle
          });
          const entry = await recordDeniedChatAttempt(config, bridgeId, {
            chatId: incoming.chatId,
            chatType: incoming.chatType,
            sender: incoming.senderHandle
          });
          // Deliver the verification code to the user with bounded
          // retries. If Telegram is still unreachable after the
          // backoff window the operator sees a code in their UI that
          // the user never received — they can choose to deny and
          // wait for the user to DM again (which mints a fresh code
          // if the previous one expired in the meantime).
          //
          // Gate the send on `mintedFreshCode`: repeated DMs from the
          // same chat within the 10-minute TTL window reuse the prior
          // code and skip the outbound message. Without this, an
          // attacker spamming the bot's @handle could drive arbitrary
          // Telegram outbound quota burn and inflate the messages /
          // audit tables one row per DM. The user can always reload
          // the original DM to see the same code they were sent.
          if (entry?.verificationCode && entry.mintedFreshCode) {
            // Compose the poller's lifecycle signal with a 10-second
            // timeout so a hung Telegram outbound socket can't pin the
            // per-update loop. Without this, a fetch that's TCP-accepted
            // but never resolves would block the awaited
            // deliverVerificationCode here (and the surrounding
            // for-of loop) until the OS default teardown — pinning
            // shutdown past `await Promise.all(loop.done)` in the
            // supervisor and starving every other update on this bridge.
            const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
            const result = await deliverVerificationCode(config, bridgeId, {
              chatId: incoming.chatId,
              code: entry.verificationCode,
              expiresAt: entry.verificationCodeExpiresAt,
              signal: sendSignal
            });
            if (!result.ok) {
              appendLog(config.instance, "messaging.telegram.verification_send_error", {
                bridgeId,
                chatId: incoming.chatId,
                error: result.error.message
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
            media: downloaded?.media,
            // Stamp the inbound message id on the chat session source
            // so scheduled-job replies that fire later can thread back
            // onto this message via Telegram's reply_to_message_id.
            messageId: incoming.messageId
          });
          // Surface a "typing…" indicator while the agent works, and
          // once the task settles mirror the assistant reply back to
          // the originating chat. The pulse is best-effort and runs
          // detached so a slow chat_action call doesn't block the
          // next update. Tracked via trackDetached so stopAll awaits
          // the in-flight state writes — see the matching shape in
          // src/integrations/discord-poller.ts.
          if (record.taskId) {
            const work = maintainTypingAndMirrorReply(
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
            trackDetached(work);
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
  // Typing pulse runs concurrent with the terminal-wait so a typing
  // failure doesn't gate the reply, and a non-terminal task can't
  // keep the pulse alive past the shared deadline.
  //
  // The pulse runs on a child controller derived from the supervisor
  // signal. We trip the child the moment awaitTerminalTask returns
  // (terminal or not), so:
  //   1. a stuck task whose typing keeps succeeding can't pin the
  //      `await typingDone` below — without this, reply_skip_non_terminal
  //      would never fire and the worker would never settle;
  //   2. the typing fetch itself observes the abort via the threaded
  //      signal on sendChatAction, so it cancels in-flight instead
  //      of dangling past the detached-tracker drain window.
  const typingController = new AbortController();
  const propagateAbort = () => typingController.abort();
  if (signal.aborted) typingController.abort();
  else signal.addEventListener("abort", propagateAbort, { once: true });

  try {
    const typingDone = maintainTypingIndicator(
      config,
      taskId,
      chatId,
      client,
      typingController.signal
    ).catch((error) => {
      // Errors are already logged inside maintainTypingIndicator;
      // the catch here just prevents an unhandled rejection.
      void error;
    });

    let terminalStatus: TaskStatus | undefined;
    try {
      // Gate the reply on terminal state — on timeout we get a
      // non-terminal status back and skip the sync cleanly.
      terminalStatus = await awaitTerminalTask(
        config,
        taskId,
        signal,
        "messaging.telegram.task_wait_timeout"
      );
    } finally {
      typingController.abort();
      await typingDone;
    }

    if (signal.aborted) return;
    if (terminalStatus === undefined || !isTerminalTaskStatus(terminalStatus)) {
      appendLog(config.instance, "messaging.telegram.reply_skip_non_terminal", {
        bridgeId,
        taskId,
        status: terminalStatus
      });
      return;
    }

    // Resolve the chat session for this (bridge, chat) so we can land
    // the assistant message and look up the dispatch target. The
    // session exists because receiveMessagingInput went through the
    // chat path.
    const session = findTelegramChatSession(config, bridgeId, chatId);
    if (!session || !session.source || session.source.kind !== "telegram") return;

    let replyText: string | undefined;
    let suppressed = false;
    try {
      const message = await syncChatTaskResult(config, session.id, taskId);
      // A null result means the reply was suppressed — a [SILENT] sentinel
      // (see src/jobs/silent.ts) or otherwise nothing to deliver. That silence
      // is intentional and must extend to the image: a [SILENT] turn that also
      // took a screenshot must NOT leak the photo to Telegram.
      if (message === null) suppressed = true;
      else if (message.role === "assistant") replyText = message.content;
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.sync_error", {
        bridgeId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    // Respect suppression for the image too — a [SILENT] turn stays fully
    // silent on the bridge (its reply text, which would carry any attachment
    // ref, was suppressed).
    if (suppressed) return;

    // The agent embeds any attachment it produced as a `gini-upload://<id>`
    // markdown ref INSIDE its reply text (so it can land inline, mid-prose, in
    // the web/app chat). Telegram can't render those refs, so: pull the upload
    // ids out of the reply, send each IMAGE upload as its own photo, and rewrite
    // the markdown tags out of the displayed text. Non-image uploads (PDF, CSV,
    // …) aren't sent yet — Telegram sendDocument is deferred (see ADR
    // outbound-chat-attachments.md, alongside the stubbed Discord photo path).
    // Resolve each id to its on-disk path + mime.
    const refIds = replyText ? uploadIdsFromText(replyText) : [];
    const photoSends: Record<string, unknown>[] = [];
    const sentImageIds = new Set<string>();
    for (const id of refIds) {
      const meta = uploadStat(config.instance, id);
      const path = uploadPathFor(config.instance, id);
      if (!meta || !path || !meta.mimeType.startsWith("image/")) continue;
      photoSends.push({ photo: { path, contentType: meta.mimeType } });
      sentImageIds.add(id);
    }

    // Rewrite the upload-ref markdown tags out of the text Telegram displays.
    // For a ref whose image WAS sent as a photo, drop the tag entirely (the
    // photo carries it). For any other ref — a non-image file we don't send, or
    // an image that failed to resolve — keep the visible LABEL (the filename) so
    // the attachment never silently vanishes; only the unusable `gini-upload://`
    // link target is removed. Collapse leftover blank lines.
    const tagRe = new RegExp(`(!?)\\[([^\\]]*)\\]\\(${UPLOAD_REF_SCHEME}([A-Za-z0-9_-]+)\\)`, "g");
    const cleanedText = (replyText ?? "")
      .replace(tagRe, (_full, bang: string, label: string, id: string) =>
        sentImageIds.has(id) ? "" : label
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Nothing to send when the reply is empty AND there is no image to deliver.
    const hasText = cleanedText.length > 0;
    if (!hasText && photoSends.length === 0) return;

    // Send each photo on its own, then the cleaned text as its own message —
    // never a photo+caption (Telegram caps a caption at 1024 MarkdownV2-escaped
    // chars and a failed photo upload would take the caption text down with it).
    // Separate messages guarantee the text always reaches the user.
    const sends: Record<string, unknown>[] = [...photoSends];
    if (hasText) sends.push({ text: cleanedText });

    try {
      // Thread the originating taskId so the outbound row and its
      // messaging.sent audit attribute back to the owning agent rather
      // than landing unattributed at the bridge level. replyToMessageId is
      // only threaded onto the FIRST send so a photo+text split doesn't
      // double-quote the user's original message.
      for (let i = 0; i < sends.length; i++) {
        await sendMessagingOutput(config, bridgeId, {
          ...sends[i],
          target: session.source.target,
          taskId,
          ...(i === 0 && replyToMessageId !== undefined ? { replyToMessageId } : {})
        });
      }
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.reply_error", {
        bridgeId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    signal.removeEventListener("abort", propagateAbort);
  }
}

// Test seam: exposes the reply mirror so the timeout + cleanup
// invariants can be exercised in isolation. Production callers go
// through the supervisor path.
export const __internalsForTests = {
  maintainTypingAndMirrorReply
};

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
      // Thread the typing controller's signal so a hung fetch
      // observes abort instead of leaving a worker pinned past the
      // detached-tracker drain window.
      await client.sendChatAction(chatId, "typing", signal);
    } catch (error) {
      // Match Discord's typing loop: aborts during shutdown / disable
      // stay quiet, anything else lands a single log row so an
      // operator can see why the indicator stopped. The pulse still
      // abandons after one error — the reply mirror is decoupled and
      // will land the assistant message when the task settles.
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.telegram.typing_pulse_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    await sleepUnlessAborted(TYPING_REFRESH_MS, signal);
  }
}

// Resolve an inbound photo's file_id to a local path under the workspace's
// .gini/inbound/ directory. The path is stable across restarts (keyed on
// bridge + update_id + file_id), and the media descriptor records both
// the local path and the Telegram file_id so the agent can re-fetch via
// sendPhoto if it needs to echo the image back. Landing under
// workspaceRoot keeps the file inside the agent's file-tool boundary so
// `[photo: <path>]` in the task input is actually readable.
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
  const dir = join(config.workspaceRoot, ".gini", "inbound", bridgeId);
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
