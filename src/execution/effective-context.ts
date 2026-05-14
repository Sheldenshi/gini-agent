// Effective execution context.
//
// Resolves the active agent's overrides on top of the instance-level
// RuntimeConfig and returns a small bundle the rest of the runtime can
// consult without re-deriving the same intersection logic in every call
// site. Today the bundle covers:
//   - provider override (agent-owned name/model wins over config.provider
//     when both fields are set; otherwise falls back to config.provider)
//   - toolset filter (an opt-in whitelist of toolset names — empty/absent
//     means "no agent-level restriction")
//   - messaging target filter (same shape, applied to bridge delivery)
//   - warnings: best-effort diagnostics for IDs the agent references but
//     state doesn't currently have (or has disabled). The filter still
//     includes those IDs so that re-enabling the toolset later is
//     transparent — warnings are purely informational.
//
// Memory namespacing (Phase C) deliberately lives outside this module for
// now: per-agent memory isolation will introduce its own helper that
// composes with the bundle returned here.

import type { ProviderConfig, RuntimeConfig, RuntimeState } from "../types";
import { normalizeProvider } from "../provider";
import { readState } from "../state";

export interface EffectiveContext {
  agentId?: string;
  // Phase C — per-agent memory isolation key. Defined whenever agentId is
  // (so chat-task can pass it through to recall/retain without re-checking
  // optionality). Currently identical to agentId; surfaced as a distinct
  // field so future work can re-namespace memory (e.g. shared pools) without
  // breaking the rest of the contract.
  memoryNamespace?: string;
  provider: ProviderConfig;
  providerSource: "agent" | "instance";
  toolsetFilter?: Set<string>;
  messagingTargetFilter?: Set<string>;
  warnings: string[];
}

export function resolveEffectiveContext(state: RuntimeState, config: RuntimeConfig): EffectiveContext {
  const agent = state.agents.find((candidate) => candidate.id === state.activeAgentId);
  if (!agent) {
    return {
      provider: config.provider,
      providerSource: "instance",
      warnings: []
    };
  }

  const warnings: string[] = [];

  // Provider: agent wins when both name + model are populated. Otherwise we
  // fall back to the instance config so a partially-configured agent doesn't
  // break inference.
  let provider: ProviderConfig;
  let providerSource: "agent" | "instance";
  if (agent.providerName && agent.model) {
    provider = normalizeProvider({
      ...config.provider,
      name: agent.providerName as ProviderConfig["name"],
      model: agent.model
    });
    providerSource = "agent";
  } else {
    provider = config.provider;
    providerSource = "instance";
  }

  // Toolset intersection. The agent stores toolset names (e.g. "file"),
  // which match ToolsetRecord.name. Validate against state and surface
  // unknown/disabled references as warnings — but keep them in the filter
  // so re-enabling later "just works".
  let toolsetFilter: Set<string> | undefined;
  if (agent.toolsets && agent.toolsets.length > 0) {
    toolsetFilter = new Set(agent.toolsets);
    const byName = new Map(state.toolsets.map((row) => [row.name, row] as const));
    for (const name of agent.toolsets) {
      const row = byName.get(name);
      if (!row) {
        warnings.push(`agent references unknown toolset '${name}'`);
        continue;
      }
      if (row.status === "disabled") {
        warnings.push(`agent references disabled toolset '${name}'`);
      }
    }
  }

  // Messaging target intersection. We validate against known bridges'
  // deliveryTargets. A target is "known" when at least one configured
  // bridge advertises it.
  let messagingTargetFilter: Set<string> | undefined;
  if (agent.messagingTargets && agent.messagingTargets.length > 0) {
    messagingTargetFilter = new Set(agent.messagingTargets);
    const known = new Set<string>();
    for (const bridge of state.messagingBridges) {
      for (const target of bridge.deliveryTargets) known.add(target);
    }
    for (const target of agent.messagingTargets) {
      if (!known.has(target)) {
        warnings.push(`agent references unknown messaging target '${target}'`);
      }
    }
  }

  return {
    agentId: agent.id,
    memoryNamespace: agent.id,
    provider,
    providerSource,
    toolsetFilter,
    messagingTargetFilter,
    warnings
  };
}

// Convenience: read the current state and return the agent's provider override
// (only when sourced from the agent). Used by memory pipelines (retain,
// reflect, reinforce) so a single LLM call follows the agent's provider
// without those modules each rebuilding the resolve/source check.
//
// Embeddings and the reranker do NOT use this — they continue to read
// config.provider directly so semantic recall stays stable across agent
// switches (see ADR 0006).
export function providerOverrideForRuntime(config: RuntimeConfig): ProviderConfig | undefined {
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  return effective.providerSource === "agent" ? effective.provider : undefined;
}
