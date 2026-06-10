// Default-model selection (see ADR model-first-selection.md).
//
// "Default model" is what a new chat starts with: new agents copy the
// default agent's provider/model pair at creation, and the default agent's
// own chat is the first thing a fresh install talks to. Writing only
// RuntimeConfig.provider is not enough — seedDefaultAgentFromConfig
// (src/state/store.ts) fills agent_default's override on boot, and that
// override shadows config.provider in resolveEffectiveContext forever
// after. So this write path updates BOTH layers:
//
//   1. config.provider via setSetupProvider — the instance fallback that
//      embeddings/reranker read. The partial { provider, model } payload
//      preserves stored transport config (baseUrl/apiKeyEnv/awsRegion/
//      extraBody/Azure routing) on a same-provider save.
//   2. agent_default's providerName/model via setAgentProvider — the
//      override the default chat actually resolves through (audited as
//      agent.provider_set).
//
// Existing agents are snapshots, never live links: changing the default
// must not rewrite the model an agent already runs on. An agent carrying an
// override is untouched, and an agent WITHOUT one — which resolves through
// config.provider live — gets pinned to the pair it was resolving to before
// the change. Adopting a newer default is always an explicit act (the chat
// tab's "Use default model" copies the current default as a new pin).

import { setAgentProvider } from "../capabilities/agents";
import { readState } from "../state";
import { setSetupProvider, type SetSetupProviderResult } from "./setup-api";
import type { RuntimeConfig } from "../types";

// The default agent's id is "agent_default" on current instances and the
// pre-rename "profile_default" on legacy ones — the same pair of ids
// seedDefaultAgentFromConfig targets. Resolve id-first in that order.
const DEFAULT_AGENT_IDS = ["agent_default", "profile_default"] as const;

export async function setDefaultModel(
  config: RuntimeConfig,
  payload: Record<string, unknown>
): Promise<SetSetupProviderResult> {
  // What override-less agents were resolving to, captured before the save
  // mutates config.provider in place.
  const previousDefault = config.provider?.name && config.provider.model
    ? { providerName: config.provider.name, model: config.provider.model }
    : undefined;
  // Forward only the selection pair. This endpoint is selection-only;
  // credential/transport writes stay on POST /api/setup/provider.
  const result = await setSetupProvider(config, {
    provider: payload.provider,
    model: payload.model
  });
  if (!result.ok) return result;
  const agents = readState(config.instance).agents;
  const defaultAgent = DEFAULT_AGENT_IDS
    .map((id) => agents.find((agent) => agent.id === id))
    .find(Boolean);
  // Detach before the new default can leak: an override-less agent follows
  // config.provider live, so pin it to the pair it was using.
  if (previousDefault) {
    for (const agent of agents) {
      if (agent.id === defaultAgent?.id) continue;
      if (agent.providerName && agent.model) continue;
      await setAgentProvider(config, agent.id, previousDefault);
    }
  }
  // setSetupProvider normalized and persisted the pair onto config.provider
  // (an omitted/blank model resolves to the provider's default there), so
  // mirror the persisted values rather than the raw payload. An instance
  // with no default agent row has nothing shadowing config.provider — skip.
  if (defaultAgent) {
    await setAgentProvider(config, defaultAgent.id, {
      providerName: config.provider.name,
      model: config.provider.model
    });
  }
  return result;
}
