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
import { resolveTelegramConnector } from "./telegram-connector";
import { getUpdates, isValidTelegramUpdate, type TelegramUpdate } from "./telegram-transport";
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

export function startTelegramPoller(
  config: RuntimeConfig,
  bridgeId: string,
  onExit?: (handle: TelegramPollerHandle) => void
): TelegramPollerHandle {
  const controller = new AbortController();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
  // We need to pass the handle to onExit, but it's only assembled after
  // the runLoop call. The closure captures `handle` so the .finally branch
  // can self-deregister on every exit path (normal stop, abort, 401,
  // missing config, thrown error) without leaving a stale entry in the
  // registry that would block a future restart.
  const handle: TelegramPollerHandle = { done: Promise.resolve(), stop };
  const done = runLoop(config, bridgeId, controller.signal, () => stopped)
    .catch((error) => {
      appendLog(config.instance, "messaging.telegram.poller.crashed", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      if (onExit) onExit(handle);
    });
  handle.done = done;
  return handle;
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
    // Provider guard. A connector whose provider isn't "telegram" must not
    // be used to drive the Bot API; flip the bridge to error and exit so
    // the token doesn't reach api.telegram.org under the wrong provider.
    try {
      resolveTelegramConnector(readState(config.instance), bridge.connectorId);
    } catch (error) {
      await flipBridgeToError(
        config,
        bridgeId,
        error instanceof Error ? error.message : String(error)
      );
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

    // Per-update dispatch. The handlers each advance
    // `bridge.telegram.updateOffset` inside the same `mutateState` they
    // use to record the durable inbound / audit row, so the offset
    // never runs ahead of the side-effect commit. Malformed updates
    // (validated by isValidTelegramUpdate) emit a dedicated audit row
    // and bump the offset past their update_id if present, or past the
    // previously-known last id if the update_id itself is unparseable,
    // so a single bad payload can't wedge the bridge.
    let lastValidOffset = offset - 1;
    for (const rawUpdate of updates) {
      if (!isValidTelegramUpdate(rawUpdate)) {
        const raw = rawUpdate as { update_id?: unknown };
        const parsedId = typeof raw.update_id === "number" && Number.isFinite(raw.update_id)
          ? raw.update_id
          : lastValidOffset + 1;
        await emitMalformedAudit(config, bridgeId, parsedId, rawUpdate);
        if (parsedId > lastValidOffset) lastValidOffset = parsedId;
        continue;
      }
      try {
        await dispatchUpdate(config, bridgeId, rawUpdate);
      } catch (error) {
        appendLog(config.instance, "messaging.telegram.dispatch.error", {
          bridgeId,
          updateId: rawUpdate.update_id,
          error: error instanceof Error ? error.message : String(error)
        });
        // Per-update offset advancement still has to happen on throw —
        // the handler's mutateState may not have landed. Bump here so
        // a thrown dispatch doesn't wedge progress.
        await mutateState(config.instance, (state) => {
          const live = state.messagingBridges.find((b) => b.id === bridgeId);
          if (!live?.telegram) return;
          const next = rawUpdate.update_id + 1;
          if (next > (live.telegram.updateOffset ?? 0)) {
            live.telegram.updateOffset = next;
            live.updatedAt = now();
          }
        });
      }
      if (rawUpdate.update_id > lastValidOffset) lastValidOffset = rawUpdate.update_id;
    }
  }
}

async function dispatchUpdate(
  config: RuntimeConfig,
  bridgeId: string,
  update: TelegramUpdate
): Promise<void> {
  if (update.message) {
    await handleInboundMessage(config, bridgeId, update.message, update.update_id);
    return;
  }
  if (update.callback_query) {
    await handleCallbackQuery(config, bridgeId, update.callback_query, update.update_id);
    return;
  }
  // Anything else is best-effort logged so we have forensics; we don't
  // dispatch channel posts, edited messages, chat-member updates,
  // shipping queries, etc. for v1. Advance offset in the same mutate so
  // the unsupported update doesn't get re-delivered.
  const kinds = Object.keys(update).filter((k) => k !== "update_id");
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.unsupported_update",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, updateId: update.update_id, kinds }
    });
    const live = state.messagingBridges.find((b) => b.id === bridgeId);
    if (live?.telegram) {
      const next = update.update_id + 1;
      if (next > (live.telegram.updateOffset ?? 0)) {
        live.telegram.updateOffset = next;
        live.updatedAt = now();
      }
    }
  });
}

// Audit row for a payload that failed schema validation. We truncate
// the JSON serialization to keep the audit row a sane size and never
// leak the bot token (the payload comes from getUpdates so it has no
// token anyway, but the cap is defensive).
const MALFORMED_PAYLOAD_LIMIT = 512;
async function emitMalformedAudit(
  config: RuntimeConfig,
  bridgeId: string,
  parsedUpdateId: number,
  payload: unknown
): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "";
  } catch {
    serialized = "(unserializable)";
  }
  if (serialized.length > MALFORMED_PAYLOAD_LIMIT) {
    serialized = `${serialized.slice(0, MALFORMED_PAYLOAD_LIMIT)}…`;
  }
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.malformed_update",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, parsedUpdateId, payload: serialized }
    });
    const live = state.messagingBridges.find((b) => b.id === bridgeId);
    if (live?.telegram) {
      const next = parsedUpdateId + 1;
      if (next > (live.telegram.updateOffset ?? 0)) {
        live.telegram.updateOffset = next;
        live.updatedAt = now();
      }
    }
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
