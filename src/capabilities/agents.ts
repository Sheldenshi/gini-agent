import type { RuntimeConfig } from "../types";
import { activateAgent, createAgentRecord, ensureAgentBank, mutateState, readState } from "../state";

export function listAgents(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeAgentId: state.activeAgentId, agents: state.agents };
}

export async function createAgent(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("Agent name is required.");
  const record = await mutateState(config.instance, (state) => {
    // Config (provider, toolsets, memory scopes, messaging targets) is
    // copied from the default agent when the caller doesn't supply it.
    // The CLI doesn't pass these — without this fallback, new agents
    // ended up with undefined provider fields and silently fell through
    // to config.provider at runtime, contradicting the "agent owns
    // provider" design.
    //
    // Memory and hindsight content is NOT copied: agents start empty.
    // Only the *config* is inherited from the default agent.
    const defaultAgent = state.agents.find((agent) => agent.id === "agent_default");
    return createAgentRecord(state, {
      name,
      providerName: typeof input.providerName === "string"
        ? input.providerName as never
        : defaultAgent?.providerName,
      model: typeof input.model === "string"
        ? input.model
        : defaultAgent?.model,
      toolsets: Array.isArray(input.toolsets)
        ? input.toolsets.map(String)
        : (defaultAgent?.toolsets ?? ["file", "terminal", "memory", "session_search"]),
      messagingTargets: Array.isArray(input.messagingTargets)
        ? input.messagingTargets.map(String)
        : (defaultAgent?.messagingTargets ?? [])
    });
  });
  // Phase C — eagerly create the per-agent bank so the new agent starts
  // with an *empty* memory pool. Config copied at creation, content NOT:
  // there's no copying of memories or hindsight units from the default
  // agent or any other agent.
  ensureAgentBank(config.instance, record.id);
  return record;
}

export async function useAgent(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => activateAgent(state, idOrName));
}
