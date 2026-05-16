// Provider guard for telegram bridges.
//
// A messaging bridge of kind "telegram" must point at a connector whose
// provider is also "telegram". Without this guard a Linear / generic /
// other-provider connector with a `token` secret could be silently used as
// a Telegram bot token — either POSTed to api.telegram.org under the wrong
// authentication contract, or sent to the wrong upstream entirely (the
// Linear probe POSTs the connector's authentication header to
// api.linear.app/graphql, exfiltrating the bot token to a Linear log line).
//
// This helper lives in its own module so the poller / outbound dispatch
// can consume it without re-importing src/integrations/messaging.ts and
// closing a require cycle (messaging.ts → telegram-registry.ts →
// telegram-poller.ts).

import type { ConnectorRecord, RuntimeState } from "../../types";

export function resolveTelegramConnector(
  state: RuntimeState,
  connectorId: string
): ConnectorRecord {
  const connector = state.connectors.find((c) => c.id === connectorId);
  if (!connector) throw new Error(`Connector not found: ${connectorId}`);
  if (connector.provider !== "telegram") {
    throw new Error(`Telegram bridge connector must be a telegram provider, got ${connector.provider}.`);
  }
  return connector;
}
