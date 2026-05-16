// Telegram long-poll worker.
//
// One worker per configured telegram bridge. Runs an unbounded loop:
//   1. Call getUpdates(offset, timeout=30s) with an AbortSignal so the
//      shutdown drain can wake the poller without waiting the full
//      timeout window.
//   2. Dispatch each update by kind (message / callback_query). Any
//      other update kind is dropped with an audit row.
//   3. Persist `bridge.telegram.updateOffset = max(processedUpdateId) + 1`
//      so the offset advances even if some downstream handlers fail.
//      A runtime restart resumes from the same offset.
//   4. On 401 from getUpdates: flip the bridge to status:"error",
//      record a clear message, and stop the worker. The connector
//      probe is the path to revive (rotate the token + re-probe).
//   5. On other failures: exponential backoff (1, 2, 4, 8, capped 30s),
//      log + audit and retry. AbortError (shutdown) exits cleanly.
//
// The poller is intentionally stateless apart from the bridge row's
// offset; multi-instance / clustered deployments are out of scope per
// ADR local-runtime-architecture.md.

import type { RuntimeConfig } from "../../types";
import { addAudit, appendLog, mutateState, now, readState } from "../../state";
import { resolveConnectorSecret } from "../connectors";
import { getUpdates, type TelegramUpdate } from "./telegram-transport";
import { handleCallbackQuery, handleInboundMessage } from "./telegram-handlers";

export interface TelegramPollerHandle {
  // Resolves when the loop has exited.
  done: Promise<void>;
  // Aborts the in-flight long poll and stops the loop after the current
  // dispatch returns.
  stop(): void;
}

const LONG_POLL_TIMEOUT_SECONDS = 30;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export function startTelegramPoller(config: RuntimeConfig, bridgeId: string): TelegramPollerHandle {
  const controller = new AbortController();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
  const done = runLoop(config, bridgeId, controller.signal, () => stopped).catch((error) => {
    appendLog(config.instance, "messaging.telegram.poller.crashed", {
      bridgeId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return { done, stop };
}

async function runLoop(
  config: RuntimeConfig,
  bridgeId: string,
  signal: AbortSignal,
  isStopped: () => boolean
): Promise<void> {
  let backoff = BACKOFF_INITIAL_MS;
  while (!isStopped()) {
    const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
    if (!bridge || bridge.kind !== "telegram") return;
    if (bridge.status !== "configured") {
      // The bridge transitioned out from under us (disabled / error
      // flipped externally). Exit cleanly; the registry handles restart.
      return;
    }
    if (!bridge.connectorId) {
      await flipBridgeToError(config, bridgeId, "Telegram bridge missing connectorId.");
      return;
    }
    const token = await resolveConnectorSecret(config, bridge.connectorId, "token");
    if (!token) {
      await flipBridgeToError(config, bridgeId, "Telegram bot token could not be resolved; rotate via connectors.");
      return;
    }

    const offset = bridge.telegram?.updateOffset ?? 0;
    const result = await getUpdates(token, offset, LONG_POLL_TIMEOUT_SECONDS, signal);
    if (!result.ok) {
      if (result.error === "aborted" || signal.aborted) return;
      if (result.status === 401) {
        await flipBridgeToError(
          config,
          bridgeId,
          "Bot token rejected; rotate via connectors."
        );
        return;
      }
      appendLog(config.instance, "messaging.telegram.poll.error", {
        bridgeId,
        error: result.error,
        status: result.status
      });
      await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "messaging.telegram.poll_error",
          target: bridgeId,
          risk: "low",
          evidence: { bridgeId, error: result.error, status: result.status }
        });
      });
      await sleepWithAbort(backoff, signal);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
      continue;
    }

    // Successful poll: reset backoff.
    backoff = BACKOFF_INITIAL_MS;

    const updates = result.updates;
    if (updates.length === 0) {
      // Long-poll timeout with no new updates. Loop again immediately;
      // the next getUpdates blocks for up to LONG_POLL_TIMEOUT_SECONDS.
      continue;
    }

    // Track the max processed update_id so the offset advances even if
    // a downstream dispatch throws. We bump after each dispatch
    // attempt; Telegram guarantees update_ids are monotonically
    // increasing within a bot.
    let maxProcessed = offset - 1;
    for (const update of updates) {
      try {
        await dispatchUpdate(config, bridgeId, update);
      } catch (error) {
        appendLog(config.instance, "messaging.telegram.dispatch.error", {
          bridgeId,
          updateId: update.update_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (update.update_id > maxProcessed) maxProcessed = update.update_id;
    }

    // Advance the bridge's persisted offset to max+1 so a restart
    // resumes after the last dispatched update.
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridgeId);
      if (!live?.telegram) return;
      live.telegram.updateOffset = maxProcessed + 1;
      live.updatedAt = now();
    });
  }
}

async function dispatchUpdate(
  config: RuntimeConfig,
  bridgeId: string,
  update: TelegramUpdate
): Promise<void> {
  if (update.message) {
    await handleInboundMessage(config, bridgeId, update.message);
    return;
  }
  if (update.callback_query) {
    await handleCallbackQuery(config, bridgeId, update.callback_query);
    return;
  }
  // Anything else is best-effort logged so we have forensics; we don't
  // dispatch channel posts, edited messages, chat-member updates,
  // shipping queries, etc. for v1.
  const kinds = Object.keys(update).filter((k) => k !== "update_id");
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.unsupported_update",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, updateId: update.update_id, kinds }
    });
  });
}

async function flipBridgeToError(
  config: RuntimeConfig,
  bridgeId: string,
  message: string
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!bridge) return;
    bridge.status = "error";
    bridge.message = message;
    bridge.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.bridge_error",
      target: bridgeId,
      risk: "medium",
      evidence: { bridgeId, message }
    });
  });
}

// Promise-based sleep that resolves early on abort. We bind the
// AbortSignal so the shutdown drain unblocks the backoff window
// alongside the in-flight getUpdates.
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise.finally(() => signal.removeEventListener("abort", onAbort));
}
