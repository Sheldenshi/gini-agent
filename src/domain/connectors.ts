import type { RuntimeConfig } from "../types";
import { addAudit, mutateState, updateConnectorHealth } from "../state";

export async function checkConnector(config: RuntimeConfig, connectorId: string) {
  return mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    updateConnectorHealth(connector);
    addAudit(state, {
      actor: "runtime",
      action: "connector.health",
      target: connectorId,
      risk: "low",
      evidence: { health: connector.health }
    });
    return connector;
  });
}
