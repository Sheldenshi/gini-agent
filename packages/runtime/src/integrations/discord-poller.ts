// Inbound Discord poller.
//
// Mirrors the Telegram poller's lifecycle: a supervisor reconciles
// per-bridge loops against state, each loop pulls new messages for
// every delivery target, and the runtime aborts every loop on SIGTERM
// via AbortController.
//
// The transport differs from Telegram. Discord exposes no long-poll —
// the runtime uses REST history with `?after=<snowflake>` and the
// per-target watermark lives on `bridge.metadata.lastInboundExternalIds`.
// First contact on a non-empty channel seeds the watermark from a
// wall-clock-derived snowflake (DISCORD_EPOCH-shifted Date.now() minus
// a small safety margin) rather than the newest observed snowflake, so
// a fresh bridge doesn't backfill history AND doesn't race with a
// user who posts during the very first fetch (the previous "seed to
// newest observed" path could pin a mid-fetch message as the
// watermark and silently drop it). Empty channels seed to the "0"
// sentinel via the same one-shot path.
//
// Alongside the REST poll loop the runtime opens a Gateway WebSocket
// (`./discord-gateway.ts`) for presence + push-driven poll wake: a
// MESSAGE_CREATE event collapses the next REST sleep to ~0ms via a
// per-iteration wake controller. REST polling stays the source of
// truth for content, watermark, dedupe, and pagination — a missed
// wake just degrades to the periodic-tick baseline.
//
// Typing indicators piggy-back on Discord's `POST /channels/:id/typing`
// which auto-clears after ~10 seconds; the pulse refreshes on a
// tighter cadence so long-running tasks stay visible without piling
// up requests.

import type { MessagingBridgeRecord, RuntimeConfig, TaskStatus } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { findDiscordChatSession, isBotTokenRef, readBridgeBotToken, receiveMessagingInput, sendMessagingOutput } from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import {
  awaitTerminalTask,
  createDetachedTracker,
  markBridgeError,
  sleepUnlessAborted,
  sleepUnlessAbortedOrWoken
} from "./messaging-poller-helpers";
import {
  createDiscordClient,
  extractIncomingPayload,
  type DiscordClient,
  type DiscordMessage
} from "./discord";
import { connectDiscordGateway, type DiscordGatewayHandle } from "./discord-gateway";

// Cadence for the per-target REST poll. Discord's global rate limit is
// generous (~50 req/s), but per-channel limits are tighter; 3s leaves
// plenty of headroom for a handful of bridges polling a handful of
// channels each.
const POLL_INTERVAL_MS = 3000;

// Backoff after an error so a flaky network or a revoked token doesn't
// hammer the API on every tick.
const ERROR_BACKOFF_MS = 5000;

// Discord typing indicators auto-clear after ~10 seconds. Refresh just
// under that so the "Gini is typing…" stays continuous for as long as
// the agent task is running.
const TYPING_REFRESH_MS = 7000;

// Max messages to fetch per single REST call. Discord caps `limit`
// at 100; the poller uses a smaller window because a steady-state
// bridge should only see one or two new messages per tick. When a
// burst lands (>FETCH_BATCH_LIMIT messages between polls) the
// pagination loop in pollChannel keeps catching up.
const FETCH_BATCH_LIMIT = 50;

// Safety cap on the per-tick pagination loop. Discord's REST `after`
// returns the NEWEST N messages above the cursor, NOT the oldest N
// — so a burst of >FETCH_BATCH_LIMIT messages requires multiple
// calls to fully catch up. The cap bounds a runaway channel from
// starving sibling channels on the same bridge; remaining messages
// land on the next poll tick.
const MAX_PAGES_PER_TICK = 10;

// Sentinel watermark for an empty channel on first contact. Discord
// snowflakes start at ~10^18 (the epoch is 2015-01-01), so any
// single-digit decimal string is strictly less than every real
// snowflake. The named constant keeps the intent visible at the
// call site and surfaces the digit-length assumption if a future
// boundary ever shifts.
const EMPTY_CHANNEL_SEED_SNOWFLAKE = "0";

// Discord snowflake encoding: `((ms_since_epoch) - DISCORD_EPOCH) << 22`
// where DISCORD_EPOCH is 2015-01-01 00:00:00 UTC. We synthesize a
// "snowflake as of now-minus-margin" for first-contact seeding on a
// non-empty channel so we don't seize a mid-fetch user message as the
// watermark (the previous "seed to newest observed" path had a race
// where a message arriving during the first poll's request window
// landed in the response, got pinned as the seed, and was never
// routed). The 5s safety margin absorbs typical clock skew between
// the local box and Discord's servers — any real "now" message is
// strictly newer than (now - 5s) so it routes on the next poll, and
// any historical message older than 5s before bridge start stays
// uncodified as history.
const DISCORD_EPOCH_MS = 1420070400000n;
const FIRST_CONTACT_SAFETY_MARGIN_MS = 5000n;
function snowflakeFromNow(): string {
  const ms = BigInt(Date.now()) - FIRST_CONTACT_SAFETY_MARGIN_MS - DISCORD_EPOCH_MS;
  return (ms << 22n).toString();
}

export interface PollerDeps {
  clientFactory?: (token: string) => DiscordClient;
  // Per-target polling cadence override (ms). Production leaves this
  // undefined and falls back to POLL_INTERVAL_MS; tests dial it down
  // to step the loop without waiting on real seconds.
  pollIntervalMs?: number;
  // Typing-indicator refresh cadence override (ms). Same story — the
  // 7s production default keeps the indicator continuous; tests crank
  // it down to verify the pulse fires while the task is running.
  typingRefreshMs?: number;
  // Override the gateway connector for tests. Production leaves it
  // undefined and we open a real WebSocket to gateway.discord.gg;
  // tests pass a no-op so they don't spawn live sockets every time
  // they bring up a supervisor. `onMessageCreate` is the push hook
  // the poller wires to its wake controller — tests can capture it
  // to fire a synthetic MESSAGE_CREATE and prove the wake path.
  gatewayConnector?: (options: {
    token: string;
    instance: string;
    bridgeId: string;
    onMessageCreate?: (event: { channelId: string }) => void;
  }) => DiscordGatewayHandle;
}

interface RunningLoop {
  controller: AbortController;
  done: Promise<void>;
}

export interface PollerSupervisor {
  reconcile(): void;
  stopAll(): Promise<void>;
  size(): number;
}

export function createDiscordPollerSupervisor(
  config: RuntimeConfig,
  deps: PollerDeps = {}
): PollerSupervisor {
  const loops = new Map<string, RunningLoop>();
  const factory = deps.clientFactory ?? ((token: string) => createDiscordClient(token));
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const typingRefreshMs = deps.typingRefreshMs ?? TYPING_REFRESH_MS;
  const gatewayConnector = deps.gatewayConnector ?? ((options) => connectDiscordGateway(options));
  let stopped = false;
  // Shared detached-worker tracker. See messaging-poller-helpers.ts:
  // workers are stopAll-awaited with a bounded timeout so a hung
  // send can't deadlock shutdown.
  const detached = createDetachedTracker(config, "messaging.discord.detached_drain_timeout");

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "discord") return false;
    if (bridge.status !== "configured") return false;
    if (bridge.deliveryTargets.length === 0) return false;
    return Boolean(bridge.secretRefs?.some(isBotTokenRef));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(
      config,
      bridgeId,
      controller.signal,
      factory,
      pollIntervalMs,
      typingRefreshMs,
      detached.track,
      gatewayConnector
    ).finally(() => {
      // Always abort the controller when the loop exits, even for
      // natural returns (bridge disabled, token rotated, status
      // flipped). Detached typing pulses + reply mirrors captured
      // this signal — without an abort here they keep firing
      // triggerTypingIndicator against the now-orphaned client
      // until the underlying task settles.
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
      // Drain detached workers with a bounded timeout so a hung send
      // can't deadlock shutdown.
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
  factory: (token: string) => DiscordClient,
  pollIntervalMs: number,
  typingRefreshMs: number,
  trackDetached: (work: Promise<void>) => void,
  gatewayConnector: (options: {
    token: string;
    instance: string;
    bridgeId: string;
    onMessageCreate?: (event: { channelId: string }) => void;
  }) => DiscordGatewayHandle
): Promise<void> {
  // The Gateway connection serves two roles:
  //   1. Presence — makes the bot show up as "Online" in Discord's
  //      UI whenever gini is running.
  //   2. Push-driven poll wake — when Discord emits MESSAGE_CREATE
  //      for any channel in the bridge's deliveryTargets, the
  //      gateway pokes `wake()` and the next REST-poll sleep
  //      collapses to ~0ms instead of waiting out POLL_INTERVAL_MS.
  //      REST polling stays the source of truth for content +
  //      watermark + dedupe, so a missed wake (or the gateway
  //      flapping entirely) just degrades to the 3s baseline — no
  //      messages get lost.
  //
  // The connection outlives a single poll tick (we don't reconnect
  // on every iteration) and is torn down in `finally` when the loop
  // exits — SIGTERM, bridge disable, status flip, missing-secret
  // error all funnel through this finally so the gateway drops
  // cleanly instead of holding the bot Online after the bridge is
  // supposed to be gone.
  let gateway: DiscordGatewayHandle | undefined;
  let gatewayToken: string | undefined;
  // `wakeController` is reset each iteration so an earlier wake
  // doesn't trip the next sleep before the gateway sees a new event.
  // `targetSet` is the snapshot of allowed deliveryTargets — the
  // gateway callback reads it (not `bridge`) so a mid-cycle bridge
  // mutation doesn't change the comparison set out from under us.
  let wakeController = new AbortController();
  let targetSet = new Set<string>();
  const onMessageCreate = (event: { channelId: string }) => {
    if (!targetSet.has(event.channelId)) return;
    wakeController.abort();
  };
  try {
    while (!signal.aborted) {
      const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
      if (!bridge || bridge.kind !== "discord" || bridge.status !== "configured") return;
      // readBridgeBotToken throws ENOENT when the encrypted secret file
      // is missing under the secretRef path (rotation in progress,
      // manual deletion, corruption). Without a catch the rejection
      // propagates out of the loop, the supervisor reconcile sees the
      // bridge still matches shouldRun (it only checks secretRefs, not
      // the on-disk file), and restarts the loop every reconcile tick.
      // Flip the bridge to "error" so shouldRun stops returning true
      // and the supervisor drops the broken bridge until the user
      // re-supplies the token.
      let token: string | undefined;
      try {
        token = readBridgeBotToken(config, bridge);
      } catch (error) {
        await markBridgeError(
          config,
          bridgeId,
          "messaging.discord.token_error",
          "messaging.discord.mark_error_failed",
          error
        );
        return;
      }
      if (!token) {
        await markBridgeError(
          config,
          bridgeId,
          "messaging.discord.token_error",
          "messaging.discord.mark_error_failed",
          new Error("Discord bot token secret is missing.")
        );
        return;
      }

      // Refresh the per-iteration deliveryTarget snapshot the gateway
      // callback compares against. Done every tick so adding a target
      // to the bridge takes effect within one reconcile interval.
      targetSet = new Set(bridge.deliveryTargets);

      // Start (or rotate) the Gateway connection. Re-use the existing
      // connection unless the token rotated — token rotation is rare
      // (operator recreates the bridge or pastes a new secret) and
      // reconnecting on rotation is cheaper than tearing down on
      // every tick.
      if (!gateway || gatewayToken !== token) {
        if (gateway) gateway.close();
        gatewayToken = token;
        gateway = gatewayConnector({
          token,
          instance: config.instance,
          bridgeId,
          onMessageCreate
        });
      }

      let client: DiscordClient;
      try {
        client = factory(token);
      } catch (error) {
        appendLog(config.instance, "messaging.discord.client_error", {
          bridgeId,
          error: error instanceof Error ? error.message : String(error)
        });
        await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
        continue;
      }

      for (const channelId of bridge.deliveryTargets) {
        if (signal.aborted) return;
        await pollChannel(config, bridgeId, channelId, client, signal, typingRefreshMs, trackDetached);
      }

      // Sleep until the next periodic tick OR a Gateway push wakes
      // us. Resetting the wake controller AFTER the sleep means a
      // wake that fires while we were inside pollChannel (rare —
      // poll is ~100-200ms vs the multi-second sleep) collapses
      // the very next sleep to zero so we never lose an event
      // because of an unlucky timing.
      await sleepUnlessAbortedOrWoken(pollIntervalMs, signal, wakeController.signal);
      if (wakeController.signal.aborted) wakeController = new AbortController();
    }
  } finally {
    // Always reap the gateway, even on a thrown exception out of the
    // loop body. Without this an unexpected throw would leave the
    // bot Online forever even though the loop is gone.
    if (gateway) gateway.close();
  }
}

async function pollChannel(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  const initialWatermark = readChannelWatermark(config, bridgeId, channelId);

  // Capture the wall-clock seed snowflake BEFORE issuing the first
  // fetch. If we computed it after the fetch returned (as we used to
  // briefly), a multi-second Discord REST latency could consume the
  // 5s safety margin: a user message arriving during the fetch could
  // be older than (response_time - 5s) and silently drop. Capturing
  // pre-fetch keeps the margin doing what it was sized for —
  // absorbing clock skew, not server latency.
  const firstContactSeed = initialWatermark === undefined ? snowflakeFromNow() : undefined;

  // Pagination loop. Discord's `after=X&limit=N` returns the NEWEST N
  // messages with id > X (sorted newest-first), NOT the oldest N. A
  // burst of >FETCH_BATCH_LIMIT messages between polls would silently
  // drop the older ones if we just re-queried with `after=<newest seen>`
  // — the newest-seen is already above the gap, so the next call
  // returns empty. Catching up requires paging BACKWARDS with `before`:
  //
  //   page 1: after = initialWatermark   → newest 50 above watermark
  //   page 2: before = oldest of page 1  → next 50 below page 1's
  //                                         oldest (still above
  //                                         initialWatermark)
  //   page 3: before = oldest of page 2  → and so on
  //
  // Loop terminates when a partial batch lands (caught up), the
  // oldest message in a page is <= initialWatermark (already
  // processed), or the per-tick safety cap fires. The cap exists to
  // bound a runaway channel from starving sibling channels on the
  // same bridge — when it fires we emit a `pagination_cap_fired`
  // log row and STILL process the collected newest window so the
  // bridge keeps making forward progress. Messages older than the
  // oldest-collected (i.e. between initialWatermark and beforeCursor)
  // are dropped on a sustained flood — a documented limitation in
  // the Discord-bridge ADR. A future change can layer a backfill
  // secondary cursor to recover those without duplicating the
  // happy-path processing.
  const collected: DiscordMessage[] = [];
  let beforeCursor: string | undefined;
  let page = 0;
  for (; page < MAX_PAGES_PER_TICK; page += 1) {
    if (signal.aborted) return;
    let batch: DiscordMessage[];
    try {
      batch = await client.fetchChannelMessages(channelId, {
        // Only the first page uses `after`; subsequent pages page
        // backwards with `before` to catch the gap.
        ...(beforeCursor === undefined
          ? { afterId: initialWatermark }
          : { beforeId: beforeCursor }),
        limit: FETCH_BATCH_LIMIT,
        signal
      });
    } catch (error) {
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.discord.poll_error", {
        bridgeId,
        channelId,
        page,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      return;
    }
    if (batch.length === 0) break;
    // Filter out anything at-or-below the initial watermark — the
    // backward paging can dip into already-processed territory once
    // we reach the bottom of the new range.
    const fresh = initialWatermark === undefined
      ? batch
      : batch.filter((m) => snowflakeCompare(m.id, initialWatermark) > 0);
    collected.push(...fresh);
    // Stop if any of the messages in this page were already
    // processed (oldest of page <= watermark) — there's nothing
    // newer below it that we haven't seen.
    if (fresh.length < batch.length) break;
    // Stop on a partial batch — there are no more messages in the
    // gap.
    if (batch.length < FETCH_BATCH_LIMIT) break;
    // Walk `before` cursor backwards to the OLDEST snowflake we
    // just saw. Discord returns newest-first, so the oldest is the
    // last element in the array.
    let oldestSeen = batch[batch.length - 1]!.id;
    for (const m of batch) {
      if (snowflakeCompare(m.id, oldestSeen) < 0) oldestSeen = m.id;
    }
    beforeCursor = oldestSeen;
  }
  if (page >= MAX_PAGES_PER_TICK) {
    // The cap fired and the inner `break` never tripped — sustained
    // flood. Log a visible row so operators can see they're missing
    // messages older than the oldest-collected snowflake. Processing
    // continues with the collected newest window; the older range
    // is a known-limitation drop documented in the Discord-bridge
    // ADR. The richer payload (initialWatermark + oldest/newest of
    // collected) tells the operator the exact range the bridge
    // landed and the lower bound of what was missed, so a backfill
    // tool could re-query [initialWatermark, oldestCollected) to
    // recover the dropped window.
    let oldestCollected: string | undefined;
    let newestCollected: string | undefined;
    for (const m of collected) {
      if (!oldestCollected || snowflakeCompare(m.id, oldestCollected) < 0) oldestCollected = m.id;
      if (!newestCollected || snowflakeCompare(m.id, newestCollected) > 0) newestCollected = m.id;
    }
    appendLog(config.instance, "messaging.discord.pagination_cap_fired", {
      bridgeId,
      channelId,
      pages: MAX_PAGES_PER_TICK,
      collected: collected.length,
      initialWatermark,
      oldestCollected,
      newestCollected
    });
  }

  // First-contact seeding. We have to pin a watermark on the very
  // first poll even when the channel is empty — otherwise a user
  // typing between this empty poll and the next non-empty poll lands
  // their first message in the seeding branch, where it would be
  // consumed as the seed and never routed. EMPTY_CHANNEL_SEED_SNOWFLAKE
  // is strictly less than every real Discord snowflake (which start
  // at ~10^18), so the next poll with afterId=<sentinel> correctly
  // fetches the user's message.
  if (collected.length === 0) {
    if (initialWatermark === undefined) {
      await advanceWatermark(config, bridgeId, channelId, EMPTY_CHANNEL_SEED_SNOWFLAKE);
    }
    return;
  }


  // Process oldest-first so the watermark advances monotonically and
  // we don't reply to messages out of order. Sort by BigInt-comparable
  // snowflake (decimal strings of mixed length sort wrong lexically
  // — "999" sorts after "1000" — so a future digit-length boundary
  // would mis-order without this).
  const ordered = [...collected].sort((a, b) => snowflakeCompare(a.id, b.id));

  // Non-empty first poll: pin the watermark to the snowflake we
  // captured pre-fetch so any real-time message that arrived during
  // the fetch is strictly newer than the seed and routes on the
  // next poll. See the firstContactSeed comment at the top of
  // pollChannel for why capturing pre-fetch matters.
  if (initialWatermark === undefined) {
    await advanceWatermark(config, bridgeId, channelId, firstContactSeed!);
    return;
  }

  for (const raw of ordered) {
    if (signal.aborted) return;
    const incoming = extractIncomingPayload(raw);
    if (!incoming || incoming.authorIsBot) {
      // Bot-authored messages (including our own replies) and
      // attachment-only / empty messages advance the watermark without
      // spawning a task — they're accounted for but not routed.
      await advanceWatermark(config, bridgeId, channelId, raw.id);
      continue;
    }

    try {
      // Prefix the message with the author handle so multi-user
      // channels don't blend turns together. Discord channels are
      // explicitly multi-user (per ADR discord-bridge.md): every
      // non-bot poster in a configured channel can submit, so the
      // agent needs sender attribution to address the right person
      // and not confuse one user's question with another's reply.
      // This mirrors Telegram's `buildTaskInput` for group/supergroup
      // chats. Unconditional prefixing keeps the contract simple —
      // even a single-author DM-like channel gets the prefix, which
      // is harmless context.
      const decoratedText = incoming.authorHandle
        ? `${incoming.authorHandle}: ${incoming.text}`
        : incoming.text;
      const record = await receiveMessagingInput(config, bridgeId, {
        text: decoratedText,
        target: incoming.channelId,
        // Stamp the inbound snowflake on the chat session source so
        // scheduled-job replies that fire later can thread back onto
        // this message via Discord's message_reference object.
        messageId: raw.id
      });
      if (record.taskId) {
        // Typing pulse + reply mirror runs detached so a slow
        // sendMessage call can't stall the next poll cycle. Errors
        // land on the runtime log; the inbound record stays. The
        // worker is tracked so stopAll can await it — without that
        // a worker mid-state-write at shutdown would land its write
        // against a torn-down runtime (or in tests against a stale
        // GINI_STATE_ROOT after the next test rebinds it).
        const work = maintainTypingAndMirrorReply(
          config,
          bridgeId,
          record.taskId,
          incoming.channelId,
          client,
          signal,
          typingRefreshMs,
          raw.id
        ).catch((error) => {
          appendLog(config.instance, "messaging.discord.typing_error", {
            bridgeId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        trackDetached(work);
      }
    } catch (error) {
      appendLog(config.instance, "messaging.discord.receive_error", {
        bridgeId,
        channelId,
        externalId: raw.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Advance the watermark after the receive call regardless of
    // success — a poison message must not block the queue forever. The
    // audit row from receiveMessagingInput (or the error log above)
    // preserves the message id for manual replay.
    await advanceWatermark(config, bridgeId, channelId, raw.id);
  }
}

// Typing pulse + reply mirror, identical to the Telegram poller in
// spirit. While the task is non-terminal we refresh the typing
// indicator on a ~7s cadence; once the task settles we sync the
// assistant message into the chat session and dispatch the text back
// via sendMessagingOutput, which records an outbound MessagingMessageRecord.
//
// The reply mirror is decoupled from the typing pulse: if the
// indicator request errors (revoked channel, network blip), we still
// keep waiting for the task to settle and dispatch the reply.
// Tying the two together would let a single typing failure drop the
// assistant's response entirely.
async function maintainTypingAndMirrorReply(
  config: RuntimeConfig,
  bridgeId: string,
  taskId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number,
  // Inbound message snowflake — when set, the reply mirror threads the
  // outbound onto this message via Discord's `message_reference` so the
  // bot's reply visually attaches to the user's question. Optional so
  // the test seam (__internalsForTests) doesn't need to fabricate one.
  inboundMessageId?: string
): Promise<void> {
  // Typing pulse runs concurrent with the terminal-wait so a typing
  // failure (revoked channel, network blip) doesn't gate the reply,
  // and a non-terminal task can't keep the pulse alive past the
  // shared MAX_TASK_WAIT_MS deadline. Without this concurrency,
  // awaitTerminalTask was unreachable for any task whose typing
  // calls kept succeeding — the loop would spin forever.
  //
  // The typing pulse runs on a dedicated child controller so we can
  // stop it the moment awaitTerminalTask returns, even when the task
  // is still non-terminal (timeout). Without the child controller a
  // stuck task whose typing keeps succeeding would leave the pulse
  // running past the cap and the `await typingDone` below would
  // never resolve — the reply_skip_non_terminal log line would never
  // fire and the tracked worker would never settle.
  const typingController = new AbortController();
  const propagateAbort = () => typingController.abort();
  if (signal.aborted) typingController.abort();
  else signal.addEventListener("abort", propagateAbort, { once: true });

  try {
    const typingDone = maintainTypingIndicator(
      config,
      taskId,
      channelId,
      client,
      typingController.signal,
      typingRefreshMs
    ).catch((error) => {
      // Errors are already logged inside maintainTypingIndicator;
      // the catch here just prevents an unhandled rejection from
      // the detached await below.
      void error;
    });

    let terminalStatus: TaskStatus | undefined;
    try {
      // Gate the reply on the task actually reaching terminal state.
      // awaitTerminalTask returns the (possibly non-terminal) status
      // on timeout — if we get a non-terminal status back, the task
      // is stuck and we skip the sync to avoid a noisy sync_error
      // log row.
      terminalStatus = await awaitTerminalTask(
        config,
        taskId,
        signal,
        "messaging.discord.task_wait_timeout"
      );
    } finally {
      // Always tear down the typing pulse before reaping it. The
      // pulse exits on its own in the happy path (task observed
      // terminal); on the timeout path we have to push the abort
      // through ourselves so the loop bails on its next signal check
      // (or — for Discord — its in-flight POST cancels because the
      // typing signal is the same controller that just aborted).
      typingController.abort();
      await typingDone;
    }

    if (signal.aborted) return;

    if (terminalStatus === undefined || !isTerminalTaskStatus(terminalStatus)) {
      appendLog(config.instance, "messaging.discord.reply_skip_non_terminal", {
        bridgeId,
        taskId,
        status: terminalStatus
      });
      return;
    }

    const session = findDiscordChatSession(config, bridgeId, channelId);
    if (!session || !session.source || session.source.kind !== "discord") return;

    let replyText: string | undefined;
    try {
      const message = await syncChatTaskResult(config, session.id, taskId);
      if (message && message.role === "assistant") replyText = message.content;
    } catch (error) {
      appendLog(config.instance, "messaging.discord.sync_error", {
        bridgeId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!replyText || replyText.trim().length === 0) return;

    // Re-check abort just before dispatch. The signal is also threaded
    // into sendMessagingOutput so a hung Discord POST gets cancelled on
    // shutdown — without that, stopAll (which awaits this worker)
    // would block forever on a stuck send.
    if (signal.aborted) return;
    try {
      await sendMessagingOutput(
        config,
        bridgeId,
        {
          text: replyText,
          target: session.source.target,
          ...(inboundMessageId ? { replyToMessageId: inboundMessageId } : {})
        },
        { signal }
      );
    } catch (error) {
      appendLog(config.instance, "messaging.discord.reply_error", {
        bridgeId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    // Drop the abort listener regardless of how we exited so we don't
    // leak per-call subscribers onto the supervisor signal across long
    // sessions.
    signal.removeEventListener("abort", propagateAbort);
  }
}

// Test seam: exposes the reply mirror so the timeout + cleanup
// invariants can be exercised in isolation without spinning up a real
// chat task. Production callers go through the supervisor path.
export const __internalsForTests = {
  maintainTypingAndMirrorReply
};

async function maintainTypingIndicator(
  config: RuntimeConfig,
  taskId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number
): Promise<void> {
  while (!signal.aborted) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) return;
    try {
      // Pass the loop's signal so a hung typing POST gets cancelled
      // on bridge disable / shutdown and on the per-call
      // typingController abort that the reply mirror raises before
      // returning — without this thread the await could keep the
      // detached pulse worker pinned past the supervisor drain
      // window even after the mirror has already returned.
      await client.triggerTypingIndicator(channelId, signal);
    } catch (error) {
      // A revoked channel or network blip shouldn't keep us looping
      // forever — log once and abandon the pulse so the reply
      // mirror still attempts to land the eventual message. Aborts
      // are expected on shutdown and stay quiet.
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.discord.typing_pulse_error", {
        channelId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    await sleepUnlessAborted(typingRefreshMs, signal);
  }
}

function readChannelWatermark(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string
): string | undefined {
  const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
  if (!bridge) return undefined;
  const raw = bridge.metadata?.lastInboundExternalIds;
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>)[channelId];
  return typeof value === "string" ? value : undefined;
}

async function advanceWatermark(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string,
  externalId: string
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridgeId);
    if (!live) return;
    const previous = (live.metadata?.lastInboundExternalIds ?? {}) as Record<string, unknown>;
    const current = previous[channelId];
    const currentStr = typeof current === "string" ? current : undefined;
    // Snowflake compare via BigInt — decimal strings of different
    // lengths sort wrong lexically. Today's snowflakes are all 19
    // digits, but the "0" sentinel used for empty-channel seeding is
    // length 1, so a naïve string compare would refuse to advance
    // past it.
    if (currentStr && snowflakeCompare(currentStr, externalId) >= 0) return;
    live.metadata = {
      ...(live.metadata ?? {}),
      lastInboundExternalIds: { ...previous, [channelId]: externalId }
    };
    live.updatedAt = now();
  });
}

// Compare two Discord snowflake-shaped decimal strings as integers.
// Returns negative if a < b, 0 if equal, positive if a > b. Falls
// back to lexicographic compare for non-decimal inputs so an unknown
// metadata value can't crash the poller — that branch is dead under
// normal operation since we only write digit strings.
function snowflakeCompare(a: string, b: string): number {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const ai = BigInt(a);
  const bi = BigInt(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
