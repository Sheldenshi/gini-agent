import type { MessagingBridgeRecord, MessagingMessageRecord, RuntimeConfig, TelegramBridgeConfig } from "../types";
import { submitTask } from "../agent";
import {
  addAudit,
  appendLog,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  mutateState,
  now,
  readState
} from "../state";
import { resolveEffectiveContext } from "../execution/effective-context";
import { checkConnector, resolveConnectorSecret } from "./connectors";
import { dispatchOutboundMessage } from "./messaging/telegram-stream";
import type { TelegramInlineKeyboardMarkup } from "./messaging/telegram-transport";
import { restartPoller, startPoller, stopPoller } from "./messaging/telegram-registry";

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");
  // Telegram bridges MUST point at a telegram connector. The bot token
  // lives in the connector's encrypted secret store per ADR
  // connector-secret-storage.md; the bridge row only carries the
  // reference. Throw a clear error if a caller tries to skip this step.
  const connectorId = typeof input.connectorId === "string" && input.connectorId.length > 0
    ? input.connectorId
    : undefined;
  if (kind === "telegram" && !connectorId) {
    throw new Error("Telegram bridges require connectorId pointing to a telegram connector.");
  }

  let initialTelegram: TelegramBridgeConfig | undefined;
  if (kind === "telegram") {
    const inbound = (input.telegram as Partial<TelegramBridgeConfig> | undefined) ?? undefined;
    initialTelegram = {
      allowlist: Array.isArray(inbound?.allowlist) ? inbound!.allowlist : [],
      botUsername: typeof inbound?.botUsername === "string" ? inbound.botUsername : undefined,
      updateOffset: typeof inbound?.updateOffset === "number" ? inbound.updateOffset : 0
    };
  }

  const bridge = await mutateState(config.instance, (state) =>
    createMessagingBridgeRecord(state, {
      name,
      kind,
      deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : [],
      connectorId,
      telegram: initialTelegram
    })
  );

  // Kick off the poller for telegram bridges that already have a
  // configured connector. The startPoller helper is idempotent and
  // re-reads the bridge state, so it skips the spawn if the bridge
  // status isn't yet configured (the explicit `health` call below or
  // the next probe will start it).
  if (kind === "telegram") {
    startPoller(config, bridge.id);
  }
  return bridge;
}

export async function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  // Telegram health is delegated to the connector probe so the bot
  // token is exercised through the same `connector.health` audit path
  // the connectors CRUD uses. We probe in two stages so we can read the
  // updated connector outside the state mutation.
  const initial = readState(config.instance).messagingBridges.find(
    (b) => b.id === idOrName || b.name === idOrName
  );
  if (!initial) throw new Error(`Messaging bridge not found: ${idOrName}`);

  let probeMessage: string | undefined;
  let probeOk = true;
  let botUsername: string | undefined;
  if (initial.kind === "telegram") {
    if (!initial.connectorId) {
      probeOk = false;
      probeMessage = "Telegram bridge missing connectorId.";
    } else {
      try {
        const connector = await checkConnector(config, initial.connectorId);
        probeOk = connector.health === "healthy";
        probeMessage = connector.message;
        // Extract bot username from the probe message when present.
        // probeTelegram returns "Authenticated as @<username>"; we
        // parse the @-prefixed handle so the bridge can cache it.
        const match = /@([A-Za-z0-9_]+)/.exec(connector.message ?? "");
        if (match) botUsername = match[1];
      } catch (error) {
        probeOk = false;
        probeMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const updated = await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.lastHealthAt = now();
    if (bridge.kind === "telegram") {
      if (probeOk) {
        bridge.status = "configured";
        bridge.message = probeMessage ?? "Telegram bot is authenticated.";
        if (botUsername) {
          bridge.telegram ??= { allowlist: [], updateOffset: 0 };
          bridge.telegram.botUsername = botUsername;
        }
      } else {
        bridge.status = "error";
        bridge.message = probeMessage ?? "Telegram bridge probe failed.";
      }
    } else {
      bridge.status = "configured";
      bridge.message = bridge.kind === "demo"
        ? "Demo messaging bridge is available for local inbound/outbound task messages."
        : `${bridge.kind} bridge is configured with local Gini task routing.`;
    }
    bridge.updatedAt = bridge.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "messaging.health",
      target: bridge.id,
      risk: "low",
      evidence: { kind: bridge.kind, status: bridge.status, connectorId: bridge.connectorId }
    });
    return bridge;
  });

  // Reconcile the poller registry: start the worker when the bridge
  // newly flipped to configured, stop it when the probe failed and the
  // bridge sits in `error`.
  if (updated.kind === "telegram") {
    if (updated.status === "configured") startPoller(config, updated.id);
    else await stopPoller(updated.id);
  }
  return updated;
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
  // Record the row first inside a mutateState; then call the dispatcher
  // outside the lock so we don't hold the per-instance write queue while
  // the Telegram HTTP call is in flight.
  const { bridge, message } = await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
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
    const status = bridge.status === "configured" ? (bridge.kind === "telegram" ? "queued" : "sent") : "failed";
    const message = createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      approvalId: typeof input.approvalId === "string" ? input.approvalId : undefined,
      externalId: typeof input.externalId === "string" ? input.externalId : undefined,
      chatSessionId: typeof input.chatSessionId === "string" ? input.chatSessionId : undefined,
      error: status === "failed" ? `Bridge is ${bridge.status}` : undefined
    });
    addAudit(state, {
      actor: "runtime",
      action: "messaging.sent",
      target: bridge.id,
      risk: "low",
      evidence: { messageId: message.id, status, target, kind: bridge.kind }
    });
    return { bridge, message };
  });

  // Remote dispatch for telegram bridges. For demo/other kinds the row
  // is already marked "sent" and we have nothing else to do — the
  // status reflects the local-only delivery.
  if (bridge.kind === "telegram" && message.status !== "failed") {
    // Pass through optional replyMarkup so callers that emit approval
    // prompts can attach the inline-keyboard buttons.
    const replyMarkup = (input.replyMarkup as TelegramInlineKeyboardMarkup | undefined) ?? undefined;
    try {
      const dispatched = await dispatchOutboundMessage(
        config,
        bridge,
        message,
        replyMarkup ? { replyMarkup } : {}
      );
      return dispatched;
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.dispatch.error", {
        bridgeId: bridge.id,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return message;
    }
  }
  return message;
}

export async function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.status = "disabled";
    bridge.updatedAt = now();
    addAudit(state, { actor: "user", action: "messaging.disabled", target: bridge.id, risk: "medium" });
    return bridge;
  });
  if (bridge.kind === "telegram") await stopPoller(bridge.id);
  return bridge;
}

// Allowlist mutation helpers — exposed via /api/messaging/:id/telegram/allow.
// Restart the poller on every change so a fresh allowlist entry takes
// effect immediately (the poller reads bridge state on each iteration,
// but a restart makes the change observable in unit tests too).

export async function addTelegramAllowlistEntry(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>
): Promise<MessagingBridgeRecord> {
  const telegramUserId = Number(input.telegramUserId);
  const agentId = typeof input.agentId === "string" ? input.agentId : "";
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new Error("telegramUserId must be a positive integer.");
  }
  if (!agentId) throw new Error("agentId is required.");
  const telegramUsername = typeof input.telegramUsername === "string" ? input.telegramUsername : undefined;
  const updated = await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (bridge.kind !== "telegram") throw new Error("Allowlist applies to telegram bridges only.");
    const agent = state.agents.find((a) => a.id === agentId || a.name === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    bridge.telegram ??= { allowlist: [], updateOffset: 0 };
    const existing = bridge.telegram.allowlist.find((e) => e.telegramUserId === telegramUserId);
    if (existing) {
      existing.agentId = agent.id;
      if (telegramUsername) existing.telegramUsername = telegramUsername;
    } else {
      bridge.telegram.allowlist.push({
        telegramUserId,
        telegramUsername,
        agentId: agent.id
      });
    }
    bridge.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "messaging.telegram.allowlist.added",
      target: bridge.id,
      risk: "medium",
      evidence: { bridgeId: bridge.id, telegramUserId, agentId: agent.id }
    });
    return bridge;
  });
  await restartPoller(config, updated.id);
  return updated;
}

export async function removeTelegramAllowlistEntry(
  config: RuntimeConfig,
  idOrName: string,
  telegramUserIdRaw: string
): Promise<MessagingBridgeRecord> {
  const telegramUserId = Number(telegramUserIdRaw);
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new Error("telegramUserId must be a positive integer.");
  }
  const updated = await mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (bridge.kind !== "telegram") throw new Error("Allowlist applies to telegram bridges only.");
    bridge.telegram ??= { allowlist: [], updateOffset: 0 };
    const before = bridge.telegram.allowlist.length;
    bridge.telegram.allowlist = bridge.telegram.allowlist.filter((e) => e.telegramUserId !== telegramUserId);
    if (bridge.telegram.allowlist.length === before) {
      throw new Error(`Allowlist entry not found: telegramUserId=${telegramUserId}`);
    }
    bridge.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "messaging.telegram.allowlist.removed",
      target: bridge.id,
      risk: "medium",
      evidence: { bridgeId: bridge.id, telegramUserId }
    });
    return bridge;
  });
  await restartPoller(config, updated.id);
  return updated;
}

// Re-export the inbound message hook for src/integrations/messaging/
// callers that want to dispatch from a webhook-style entry point. The
// poller talks to telegram-handlers directly.
export { dispatchOutboundMessage };
