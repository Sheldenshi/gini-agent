// Process-singleton registry of running telegram pollers.
//
// One poller per configured telegram bridge. The registry owns the
// AbortController for each poller so the bridge lifecycle and the
// server shutdown drain can stop a poller without reaching into the
// poller module directly. Idempotent: starting an already-running
// poller is a no-op; stopping an unknown bridge is a no-op.

import type { RuntimeConfig } from "../../types";
import { startTelegramPoller, type TelegramPollerHandle } from "./telegram-poller";
import { appendLog, readState } from "../../state";

const POLLERS = new Map<string, TelegramPollerHandle>();

export function isPollerRunning(bridgeId: string): boolean {
  return POLLERS.has(bridgeId);
}

export function startPoller(config: RuntimeConfig, bridgeId: string): void {
  if (POLLERS.has(bridgeId)) return;
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  if (bridge.kind !== "telegram") return;
  if (bridge.status !== "configured") return;
  if (!bridge.connectorId) return;
  const handle = startTelegramPoller(config, bridgeId);
  POLLERS.set(bridgeId, handle);
  appendLog(config.instance, "messaging.telegram.poller.started", { bridgeId });
}

export async function stopPoller(bridgeId: string): Promise<void> {
  const handle = POLLERS.get(bridgeId);
  if (!handle) return;
  POLLERS.delete(bridgeId);
  handle.stop();
  try {
    await handle.done;
  } catch {
    // Drain errors are logged inside the poller itself; the stop path
    // shouldn't fail loudly.
  }
}

export async function restartPoller(config: RuntimeConfig, bridgeId: string): Promise<void> {
  await stopPoller(bridgeId);
  startPoller(config, bridgeId);
}

export async function stopAllPollers(): Promise<void> {
  const handles = Array.from(POLLERS.entries());
  POLLERS.clear();
  for (const [, handle] of handles) {
    handle.stop();
  }
  await Promise.allSettled(handles.map(([, handle]) => handle.done));
}

// Boot-time hook: walk the persisted bridges and start every configured
// telegram bridge's poller. Called from server.ts after install() so the
// poller subscribes to the shutdown drain alongside the scheduler.
export function startConfiguredTelegramPollers(config: RuntimeConfig): void {
  const bridges = readState(config.instance).messagingBridges;
  for (const bridge of bridges) {
    if (bridge.kind !== "telegram") continue;
    if (bridge.status !== "configured") continue;
    if (!bridge.connectorId) continue;
    startPoller(config, bridge.id);
  }
}
