import type { RuntimeConfig } from "../../types";
import { addAudit, mutateState, updateIdentityHealth } from "../../state";

export async function checkIdentity(config: RuntimeConfig, identityId: string) {
  return mutateState(config.instance, (state) => {
    const identity = state.identities.find((candidate) => candidate.id === identityId);
    if (!identity) throw new Error(`Identity not found: ${identityId}`);
    updateIdentityHealth(identity);
    addAudit(state, {
      actor: "runtime",
      action: "identity.health",
      target: identityId,
      risk: "low",
      evidence: { health: identity.health }
    });
    return identity;
  });
}
