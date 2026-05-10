import type { RuntimeConfig } from "../types";
import { activateProfile, createProfileRecord, mutateState, readState } from "../state";

export function listProfiles(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeProfileId: state.activeProfileId, profiles: state.profiles };
}

export async function createProfile(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("Profile name is required.");
  return mutateState(config.instance, (state) => createProfileRecord(state, {
    name,
    providerName: typeof input.providerName === "string" ? input.providerName as never : undefined,
    model: typeof input.model === "string" ? input.model : undefined,
    toolsets: Array.isArray(input.toolsets) ? input.toolsets.map(String) : ["file", "terminal", "memory", "session_search"],
    memoryScopes: Array.isArray(input.memoryScopes) ? input.memoryScopes.filter(isMemoryScope) : ["user", "project"],
    messagingTargets: Array.isArray(input.messagingTargets) ? input.messagingTargets.map(String) : []
  }));
}

export async function useProfile(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => activateProfile(state, idOrName));
}

function isMemoryScope(value: unknown): value is "user" | "project" | "device" | "temporary" {
  return value === "user" || value === "project" || value === "device" || value === "temporary";
}
