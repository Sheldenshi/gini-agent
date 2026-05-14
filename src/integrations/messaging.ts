import type { RuntimeConfig } from "../types";
import { submitTask } from "../agent";
import { addAudit, createMessagingBridgeRecord, createMessagingMessageRecord, mutateState, now, readState } from "../state";
import { resolveEffectiveContext } from "../execution/effective-context";

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");
  return mutateState(config.instance, (state) => createMessagingBridgeRecord(state, {
    name,
    kind,
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
  }));
}

export async function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.lastHealthAt = now();
    if (bridge.kind === "telegram" && !process.env.TELEGRAM_BOT_TOKEN) {
      bridge.status = "error";
      bridge.message = "Set TELEGRAM_BOT_TOKEN to enable Telegram delivery.";
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
      evidence: { kind: bridge.kind, status: bridge.status }
    });
    return bridge;
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
  return mutateState(config.instance, (state) => {
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
    const status = bridge.status === "configured" ? "sent" : "failed";
    const message = createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      error: status === "failed" ? `Bridge is ${bridge.status}` : undefined
    });
    addAudit(state, {
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
  return mutateState(config.instance, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.status = "disabled";
    bridge.updatedAt = now();
    addAudit(state, { actor: "user", action: "messaging.disabled", target: bridge.id, risk: "medium" });
    return bridge;
  });
}
