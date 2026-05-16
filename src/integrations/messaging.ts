import type { ConnectorSecretRef, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { submitTask } from "../agent";
import { addAudit, createMessagingBridgeRecord, createMessagingMessageRecord, mutateState, now, readState } from "../state";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../state/secrets";
import { resolveEffectiveContext } from "../execution/effective-context";
import { createTelegramClient, type TelegramClient, type TelegramClientOptions } from "./telegram";

// Namespace used when storing per-bridge secrets through the connector
// secret store. Keeping it stable lets `deleteConnectorSecrets` find every
// secret a bridge owns even if the bridge's secretRefs list ever drifts.
function bridgeSecretNamespace(bridgeId: string): string {
  return `messaging.${bridgeId}`;
}

// Test seam: production code calls Telegram for real, but tests inject a
// stubbed client so we can exercise send/health/poll without network IO.
export interface MessagingDeps {
  telegramClientFactory?: (token: string) => TelegramClient;
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

export function readBridgeBotToken(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  const ref = bridge.secretRefs?.find((candidate) => candidate.purpose === "bot-token");
  if (!ref) return undefined;
  return readSecret(config.instance, ref);
}

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");

  // Telegram needs a bot token. The credential travels in on the create
  // payload exactly once and is immediately handed to the encrypted secret
  // store; the plaintext never lands on the bridge record or in audit
  // evidence.
  const botToken = kind === "telegram" && typeof input.botToken === "string" ? input.botToken.trim() : "";
  if (kind === "telegram" && !botToken) {
    throw new Error("Telegram bridges require a botToken in the create payload.");
  }

  const bridge = await mutateState(config.instance, (state) => createMessagingBridgeRecord(state, {
    name,
    kind,
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
  }));

  if (kind === "telegram") {
    const ref = writeSecret(config.instance, bridgeSecretNamespace(bridge.id), "bot-token", botToken);
    return mutateState(config.instance, (state) => attachSecretRef(state.messagingBridges, bridge.id, ref));
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

  // Telegram health is a real getMe() round-trip. We do the network call
  // *outside* mutateState so the lock isn't held for the duration of the
  // request, then fold the outcome back in.
  let nextStatus: MessagingBridgeRecord["status"] = "configured";
  let nextMessage: string;
  const nextMetadata: Record<string, unknown> = { ...(bridge.metadata ?? {}) };

  if (bridge.kind === "telegram") {
    const token = readBridgeBotToken(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Telegram bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await telegramClientFor(token).getMe();
        nextMetadata.botUsername = me.username;
        nextMetadata.botId = me.id;
        nextMessage = me.username
          ? `Connected as @${me.username}.`
          : `Connected as bot ${me.id}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = error instanceof Error ? error.message : String(error);
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
    live.status = nextStatus;
    live.message = nextMessage;
    live.metadata = nextMetadata;
    live.updatedAt = live.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "messaging.health",
      target: live.id,
      risk: "low",
      evidence: { kind: live.kind, status: live.status }
    });
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
  if (!text) throw new Error("Inbound message text is required.");
  const target = String(input.target ?? "local");
  const task = await submitTask(config, text);
  return mutateState(config.instance, (state) => createMessagingMessageRecord(state, {
    bridgeId: bridge.id,
    direction: "inbound",
    status: "received",
    target,
    text,
    taskId: task.id
  }));
}

export async function sendMessagingOutput(config: RuntimeConfig, idOrName: string, input: Record<string, unknown>) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("Outbound message text is required.");

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
    const token = readBridgeBotToken(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Telegram bot token is missing.";
    } else {
      try {
        await telegramClientFor(token).sendMessage(target, text);
      } catch (error) {
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return mutateState(config.instance, (live) => {
    const message = createMessagingMessageRecord(live, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      error: errorMessage
    });
    addAudit(live, {
      actor: "runtime",
      action: "messaging.sent",
      target: bridge.id,
      risk: "low",
      evidence: { messageId: message.id, status, target }
    });
    return message;
  });
}

export async function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.status = "disabled";
    live.updatedAt = now();
    addAudit(state, { actor: "user", action: "messaging.disabled", target: live.id, risk: "medium" });
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
