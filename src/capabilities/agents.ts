import type { RuntimeConfig } from "../types";
import { activateAgent, createAgentRecord, ensureAgentBank, mutateState, readState } from "../state";

export function listAgents(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeAgentId: state.activeAgentId, agents: state.agents };
}

export async function createAgent(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("Agent name is required.");
  const record = await mutateState(config.instance, (state) => createAgentRecord(state, {
    name,
    providerName: typeof input.providerName === "string" ? input.providerName as never : undefined,
    model: typeof input.model === "string" ? input.model : undefined,
    toolsets: Array.isArray(input.toolsets) ? input.toolsets.map(String) : ["file", "terminal", "memory", "session_search"],
    memoryScopes: Array.isArray(input.memoryScopes) ? input.memoryScopes.filter(isMemoryScope) : ["user", "project"],
    messagingTargets: Array.isArray(input.messagingTargets) ? input.messagingTargets.map(String) : []
  }));
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

function isMemoryScope(value: unknown): value is "user" | "project" | "device" | "temporary" {
  return value === "user" || value === "project" || value === "device" || value === "temporary";
}
