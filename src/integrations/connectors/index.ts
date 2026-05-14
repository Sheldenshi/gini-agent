import type { ConnectorRecord, ConnectorSecretRef, RuntimeConfig, RuntimeState, SkillRecord } from "../../types";
import { addAudit, id, mutateState, now, readState, updateConnectorHealth } from "../../state";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../../state/secrets";
import { getProvider, listProviders } from "./registry";

export interface CreateConnectorInput {
  name: string;
  provider: string;
  scopes?: string[];
  secrets?: Record<string, string>;
  // Free-form metadata for the `generic` provider. Stored verbatim on the
  // record under `metadata.fields` so the Add Connector dialog can render
  // dynamic non-secret fields (base URLs, account ids) without provider-
  // specific code.
  metadata?: Record<string, unknown>;
}

export interface UpdateConnectorInput {
  name?: string;
  scopes?: string[];
  status?: "configured" | "disabled" | "error";
  secrets?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export async function createConnector(config: RuntimeConfig, input: CreateConnectorInput): Promise<ConnectorRecord> {
  const provider = String(input.provider || "").trim();
  const name = String(input.name || "").trim();
  if (!provider) throw new Error("Invalid input: provider is required.");
  if (!name) throw new Error("Invalid input: name is required.");
  const module = getProvider(provider);
  if (!module) throw new Error(`Unknown provider: ${provider}. Use one of ${listProviders().map((p) => p.id).join(", ")} or "generic".`);
  const connectorId = id("id");
  const secretRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(input.secrets ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    secretRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const at = now();
    const connector: ConnectorRecord = {
      id: connectorId,
      instance: state.instance,
      name,
      provider,
      status: "configured",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      secretRefs,
      createdAt: at,
      updatedAt: at,
      health: "unknown",
      metadata: input.metadata
    };
    state.connectors.unshift(connector);
    updateConnectorHealth(connector);
    addAudit(state, {
      actor: "user",
      action: "connector.create",
      target: connector.id,
      risk: "medium",
      evidence: {
        provider: connector.provider,
        name: connector.name,
        scopes: connector.scopes,
        purposes: secretRefs.map((ref) => ref.purpose)
      }
    });
    return connector;
  });
}

export async function updateConnector(
  config: RuntimeConfig,
  connectorId: string,
  input: UpdateConnectorInput
): Promise<ConnectorRecord> {
  const newSecrets = input.secrets ?? {};
  const wroteRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(newSecrets)) {
    if (typeof value !== "string" || value.length === 0) continue;
    wroteRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    if (typeof input.name === "string") connector.name = input.name.trim() || connector.name;
    if (Array.isArray(input.scopes)) connector.scopes = input.scopes.map(String);
    if (input.status) connector.status = input.status;
    if (input.metadata) connector.metadata = { ...(connector.metadata ?? {}), ...input.metadata };
    for (const ref of wroteRefs) {
      const existing = connector.secretRefs.find((candidate) => candidate.purpose === ref.purpose);
      if (existing) existing.path = ref.path;
      else connector.secretRefs.push(ref);
    }
    connector.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: wroteRefs.length > 0 ? "connector.rotate" : "connector.update",
      target: connector.id,
      risk: "medium",
      evidence: {
        provider: connector.provider,
        rotatedPurposes: wroteRefs.map((ref) => ref.purpose)
      }
    });
    return connector;
  });
}

export async function deleteConnector(config: RuntimeConfig, connectorId: string): Promise<{ id: string }> {
  deleteConnectorSecrets(config.instance, connectorId);
  return mutateState(config.instance, (state) => {
    const index = state.connectors.findIndex((candidate) => candidate.id === connectorId);
    if (index < 0) throw new Error(`Connector not found: ${connectorId}`);
    const [connector] = state.connectors.splice(index, 1);
    addAudit(state, {
      actor: "user",
      action: "connector.delete",
      target: connectorId,
      risk: "medium",
      evidence: { provider: connector?.provider, name: connector?.name }
    });
    return { id: connectorId };
  });
}

// Resolve a single secret value for a connector, emitting an audit event
// that records the purpose and whether resolution succeeded — never the
// value itself. Callers that need to pass a secret into a subprocess
// should fetch it through here so the audit trail is consistent.
export async function resolveConnectorSecret(
  config: RuntimeConfig,
  connectorId: string,
  purpose: string
): Promise<string | undefined> {
  const state = readState(config.instance);
  const connector = state.connectors.find((candidate) => candidate.id === connectorId);
  if (!connector) throw new Error(`Connector not found: ${connectorId}`);
  const ref = connector.secretRefs.find((candidate) => candidate.purpose === purpose);
  let value: string | undefined;
  let ok = false;
  try {
    if (ref) {
      value = readSecret(config.instance, ref);
      ok = true;
    }
  } finally {
    await mutateState(config.instance, (mutating) => {
      addAudit(mutating, {
        actor: "runtime",
        action: "connector.secret.use",
        target: connectorId,
        risk: "low",
        evidence: { provider: connector.provider, purpose, resolved: ok }
      });
    });
  }
  return value;
}

// Per-provider health probe dispatch. Probes are optional per ADR 0010: a
// provider without a `probe` falls back to a configured-status check (no
// remote system to query). Connector records that reference an unknown
// provider land at `unhealthy` with a surfaced message so the activation
// gate sees the failure.
export async function checkConnector(config: RuntimeConfig, connectorId: string): Promise<ConnectorRecord> {
  const initial = readState(config.instance).connectors.find((candidate) => candidate.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);

  const module = getProvider(initial.provider);
  let probeMessage: string | undefined;
  let probeHealth: "healthy" | "unhealthy" | "unknown" = initial.health;
  let probed = false;

  if (!module) {
    probeHealth = "unhealthy";
    probeMessage = `Unknown provider: ${initial.provider}.`;
    probed = true;
  } else if (module.probe) {
    probed = true;
    try {
      const result = await module.probe({
        config,
        connectorId,
        resolveSecret: (purpose) => resolveConnectorSecret(config, connectorId, purpose),
        metadata: initial.metadata ?? {}
      });
      probeHealth = result.ok ? "healthy" : "unhealthy";
      probeMessage = result.message;
    } catch (error) {
      probeHealth = "unhealthy";
      probeMessage = error instanceof Error ? error.message : String(error);
    }
  } else {
    // Presence-only provider (e.g. apple-notes, generic with no static check).
    // Default to healthy iff the record is configured — there is no remote
    // system to query.
    probeHealth = initial.status === "configured" ? "healthy" : "unhealthy";
    probeMessage = `Provider ${initial.provider} has no remote probe; presence-only.`;
  }

  return mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    connector.lastHealthAt = now();
    connector.health = probeHealth;
    connector.message = probeMessage;
    connector.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: "connector.health",
      target: connectorId,
      risk: "low",
      evidence: { provider: connector.provider, health: connector.health, probed }
    });
    return connector;
  });
}

// A skill is active iff every required connector is satisfied by a
// healthy ConnectorRecord of the matching provider. The agent loop filters
// inactive skills out of its available-skills set; the UI still shows
// them so users can see what's missing.
//
// `health: "unknown"` is treated as active when the matching provider has
// no probe (we have no failing signal). It's treated as inactive when the
// provider declares a probe but hasn't run yet — to avoid surfacing skills
// before their first probe.
export function isSkillActive(state: RuntimeState, skill: SkillRecord): boolean {
  if (skill.validationStatus === "unsupported") return false;
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return true;
  for (const requirement of required) {
    const module = getProvider(requirement.provider);
    const hasProbe = Boolean(module?.probe);
    const match = state.connectors.find((candidate) => {
      if (candidate.provider !== requirement.provider) return false;
      if (candidate.health === "healthy") return true;
      if (!hasProbe && candidate.health === "unknown" && candidate.status === "configured") return true;
      return false;
    });
    if (!match) return false;
  }
  return true;
}

// Derive env var → (provider, purpose) mappings at runtime from each
// registered provider's `envBindings`. This replaces the pre-ADR-0010
// hardcoded global map. Callers can ask "which env vars do these providers
// expose, and which purpose holds the secret for each?" without
// per-provider knowledge.
function envBindingsForProviders(providers: string[]): Record<string, { provider: string; purpose: string }> {
  const result: Record<string, { provider: string; purpose: string }> = {};
  for (const providerId of providers) {
    const module = getProvider(providerId);
    if (!module?.secrets?.envBindings) continue;
    for (const [envName, purpose] of Object.entries(module.secrets.envBindings)) {
      result[envName] = { provider: providerId, purpose };
    }
  }
  return result;
}

// Aggregate env bindings across every trusted, active skill. Called at
// terminal_exec spawn time so a skill's scripts pick up declared
// credentials regardless of which skill the model chose to follow.
export async function resolveActiveSkillsEnv(config: RuntimeConfig): Promise<Record<string, string>> {
  const state = readState(config.instance);
  const out: Record<string, string> = {};
  for (const skill of state.skills) {
    if (skill.status !== "trusted") continue;
    if (!isSkillActive(state, skill)) continue;
    Object.assign(out, await resolveSkillEnv(config, skill));
  }
  return out;
}

export async function resolveSkillEnv(
  config: RuntimeConfig,
  skill: SkillRecord
): Promise<Record<string, string>> {
  const envNames = skill.prerequisites?.env ?? [];
  if (envNames.length === 0) return {};
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return {};
  const providers = required.map((r) => r.provider);
  const bindings = envBindingsForProviders(providers);
  const state = readState(config.instance);
  const out: Record<string, string> = {};
  for (const envName of envNames) {
    const binding = bindings[envName];
    if (!binding) continue;
    const connector = state.connectors.find(
      (candidate) => candidate.provider === binding.provider && candidate.health === "healthy"
    );
    if (!connector) continue;
    const value = await resolveConnectorSecret(config, connector.id, binding.purpose);
    if (value) out[envName] = value;
  }
  return out;
}
