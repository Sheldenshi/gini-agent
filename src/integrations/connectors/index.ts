import type { ConnectorRecord, ConnectorSecretRef, RuntimeConfig, RuntimeState, SkillRecord } from "../../types";
import { addAudit, appendLog, id, mutateState, now, readState, updateConnectorHealth } from "../../state";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../../state/secrets";
import { syncProviderMcpServers } from "../mcp-sync";
import { redactSecretsInText } from "../mcp-http";
import { getProvider, listProviders } from "./registry";

export interface CreateConnectorInput {
  name: string;
  provider: string;
  // Credential type. When supplied, the record is stamped with it so skills
  // and MCP rows can resolve the credential by name. Optional — presence-only
  // and un-typed legacy records omit it. The hard "provider must be a
  // registered module" requirement is relaxed for typed credentials in a
  // later commit; commit 1 only threads the field through.
  type?: ConnectorRecord["type"];
  scopes?: string[];
  secrets?: Record<string, string>;
  // Free-form metadata for the `generic` provider. Stored verbatim on the
  // record under `metadata.fields` so the Add Connector dialog can render
  // dynamic non-secret fields (base URLs, account ids) without provider-
  // specific code. Typed credentials also persist `mcp`/`envMap` here.
  metadata?: ConnectorRecord["metadata"];
}

// CRUD-created connectors always carry `source: "user"`. The detection
// job creates `source: "auto"` records directly on the state slab without
// going through this helper so the auto-create path keeps its own audit
// signal (`connector.auto_create`).

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
      ...(input.type ? { type: input.type } : {}),
      status: "configured",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      secretRefs,
      createdAt: at,
      updatedAt: at,
      health: "unknown",
      metadata: input.metadata,
      source: "user"
    };
    state.connectors.unshift(connector);
    // For providers without a probe (demo, generic, claude-code, codex)
    // there is no remote check that could refute the configured-status
    // assumption, so the synchronous health-set is honest. For probe-based
    // providers (linear), seeding `healthy` from `status === "configured"`
    // would lie until the next reprobe — leave them at `health: "unknown"`
    // so the activation gate (which treats unknown-with-probe as inactive)
    // waits for the first real probe before surfacing dependent skills.
    if (!module.probe) {
      updateConnectorHealth(connector);
    }
    // Connectors live at the instance level — they're shared across
    // every agent, so the create row isn't per-agent activity.
    addAudit(
      state,
      {
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
      },
      { system: true }
    );
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
    addAudit(
      state,
      {
        actor: "user",
        action: wroteRefs.length > 0 ? "connector.rotate" : "connector.update",
        target: connector.id,
        risk: "medium",
        evidence: {
          provider: connector.provider,
          rotatedPurposes: wroteRefs.map((ref) => ref.purpose)
        }
      },
      { system: true }
    );
    return connector;
  });
}

export async function deleteConnector(config: RuntimeConfig, connectorId: string): Promise<{ id: string; tombstoned?: boolean }> {
  // Read the source up-front so we can decide whether to physically wipe
  // the encrypted secrets. Auto-source connectors don't carry secrets
  // today (claude-code/codex are presence-only), but the wipe is still
  // safe to skip — the tombstone path leaves the record in place so a
  // future "rotate" or "edit" could rebuild it.
  const initial = readState(config.instance).connectors.find((c) => c.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);
  const isAuto = initial.source === "auto";

  if (!isAuto) {
    deleteConnectorSecrets(config.instance, connectorId);
  }

  return mutateState(config.instance, (state) => {
    const index = state.connectors.findIndex((candidate) => candidate.id === connectorId);
    if (index < 0) throw new Error(`Connector not found: ${connectorId}`);
    if (isAuto) {
      // Tombstone — keep the record around with `status: "disabled"` so
      // the detection job (which skips disabled rows) doesn't immediately
      // re-create the connector after the user explicitly disconnected it.
      const connector = state.connectors[index]!;
      connector.status = "disabled";
      connector.health = "unknown";
      connector.message = undefined;
      connector.updatedAt = now();
      addAudit(
        state,
        {
          actor: "user",
          action: "connector.disable",
          target: connectorId,
          risk: "medium",
          evidence: { provider: connector.provider, name: connector.name, source: connector.source }
        },
        { system: true }
      );
      return { id: connectorId, tombstoned: true };
    }
    const [connector] = state.connectors.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.delete",
        target: connectorId,
        risk: "medium",
        evidence: { provider: connector?.provider, name: connector?.name }
      },
      { system: true }
    );
    return { id: connectorId };
  });
}

// Resolve a single secret value for a connector, emitting an audit event
// that records the purpose and whether resolution succeeded — never the
// value itself. Callers that need to pass a secret into a subprocess
// should fetch it through here so the audit trail is consistent.
// When `taskId` is supplied, the resolution audit attributes to the
// owning agent of that task; callers without a task context (health
// probes, management UI) fall through to a system-level audit.
export async function resolveConnectorSecret(
  config: RuntimeConfig,
  connectorId: string,
  purpose: string,
  taskId?: string
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
      addAudit(
        mutating,
        {
          actor: "runtime",
          action: "connector.secret.use",
          target: connectorId,
          risk: "low",
          taskId,
          evidence: { provider: connector.provider, purpose, resolved: ok }
        },
        taskId ? { taskId } : { system: true }
      );
    });
  }
  return value;
}

// Per-provider health probe dispatch. Probes are optional per ADR connector-provider-spec-compliance.md: a
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

  const result = await mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    connector.lastHealthAt = now();
    connector.health = probeHealth;
    connector.message = probeMessage;
    connector.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "connector.health",
        target: connectorId,
        risk: "low",
        evidence: { provider: connector.provider, health: connector.health, probed }
      },
      { system: true }
    );
    return connector;
  });
  // After a successful health write, materialize any provider-declared
  // MCP server record so `mcp_call(server: "<provider>")` resolves. Safe
  // to call on every probe — the sync is idempotent and skips providers
  // whose MCP entry already exists.
  if (result.health === "healthy") {
    try {
      await syncProviderMcpServers(config);
    } catch (error) {
      // Best-effort. A failure here doesn't unwind the health update —
      // the connector is still usable for env-based flows. But we MUST
      // make the failure observable so a regression isn't silent:
      // operators see `mcp.auto_register_failed` in the audit log and
      // can diagnose without re-running the probe locally.
      const message = redactSecretsInText(error instanceof Error ? error.message : String(error));
      appendLog(config.instance, "mcp.auto_register.error", {
        connectorId,
        provider: result.provider,
        error: message
      });
      await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "mcp.auto_register_failed",
            target: connectorId,
            risk: "low",
            evidence: { provider: result.provider, error: message }
          },
          { system: true }
        );
      });
    }
  }
  return result;
}

// A skill is active iff every required connector is satisfied by a
// configured + healthy ConnectorRecord of the matching provider. The agent
// loop filters inactive skills out of its available-skills set; the UI
// still shows them so users can see what's missing.
//
// Both branches require `status === "configured"`. A `disabled` connector
// is one the user explicitly turned off — even if a stale health probe
// still says "healthy", we should not let it satisfy a skill. An `error`
// status means setup failed and the connector isn't usable.
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
      if (candidate.status !== "configured") return false;
      if (candidate.health === "healthy") return true;
      if (!hasProbe && candidate.health === "unknown") return true;
      return false;
    });
    if (!match) return false;
  }
  return true;
}

// Derive env var → (provider, purpose) mappings at runtime from each
// registered provider's `envBindings`. This replaces the pre-ADR-connector-provider-spec-compliance.md
// hardcoded global map. Callers can ask "which env vars do these providers
// expose, and which purpose holds the secret for each?" without
// per-provider knowledge.
export function envBindingsForProviders(providers: string[]): Record<string, { provider: string; purpose: string }> {
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

// NOTE: connector env enters a process through exactly one path —
// `skill_run`, which calls `resolveSkillEnv` for the named skill. The old
// aggregate-across-every-active-skill helper (`resolveActiveSkillsEnv`) and
// the per-name terminal_exec resolver (`resolveSkillEnvByName`) are both
// gone: terminal commands always run with a clean env. See
// docs/adr/skill-env-containment.md.

export async function resolveSkillEnv(
  config: RuntimeConfig,
  skill: SkillRecord,
  taskId?: string
): Promise<Record<string, string>> {
  const envNames = skill.prerequisites?.env ?? [];
  if (envNames.length === 0) return {};
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return {};
  const providers = required.map((r) => r.provider);
  const requiresGeneric = providers.includes("generic");
  const bindings = envBindingsForProviders(providers);
  const state = readState(config.instance);
  // Per-(skill, connector) consent gate (ADR skill-connector-consent.md). A
  // provider contributes env only when the skill is bundled (first-party,
  // auto-granted) or the user has explicitly granted that provider to this
  // skill. Without this, any installed+enabled skill that merely DECLARES a
  // credentialed connector would receive its secret — the prompt-injection
  // hole. The bundled short-circuit means bundled skills never need a written
  // grant.
  const bundled = (skill.source ?? "user") === "bundled";
  const providerGranted = (provider: string): boolean =>
    bundled || (skill.grantedConnectors?.includes(provider) ?? false);
  const out: Record<string, string> = {};
  for (const envName of envNames) {
    const binding = bindings[envName];
    if (binding) {
      if (!providerGranted(binding.provider)) continue;
      // Same status guard as isSkillActive: a `disabled` or `error` record
      // with a stale `health: "healthy"` from a prior probe must not leak
      // its secret into the spawn env.
      const connector = state.connectors.find(
        (candidate) =>
          candidate.provider === binding.provider
          && candidate.status === "configured"
          && candidate.health === "healthy"
      );
      if (!connector) continue;
      const value = await resolveConnectorSecret(config, connector.id, binding.purpose, taskId);
      if (value) out[envName] = value;
      continue;
    }
    // The `generic` provider has no static `envBindings`, so a user-supplied
    // key never resolves through the native path above. Treat each generic
    // connector's secret field name as its own env binding: a declared env
    // name resolves from a configured+healthy generic connector that stores
    // a secret whose `purpose` matches the name verbatim (the field name the
    // user gave the secret == the declared `prerequisites.env` name). Same
    // status/health guard as native providers.
    if (!requiresGeneric) continue;
    if (!providerGranted("generic")) continue;
    // Fail safe on ambiguity: if two configured+healthy generic connectors
    // both store a secret field named `envName`, we cannot know which the user
    // meant, so inject NOTHING for that var rather than guessing the wrong
    // credential.
    const matches = state.connectors.filter(
      (candidate) =>
        candidate.provider === "generic"
        && candidate.status === "configured"
        && candidate.health === "healthy"
        && candidate.secretRefs.some((ref) => ref.purpose === envName)
    );
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      appendLog(config.instance, "connector.generic.ambiguous_env", {
        envName,
        connectorIds: matches.map((c) => c.id)
      });
      continue;
    }
    const value = await resolveConnectorSecret(config, matches[0].id, envName, taskId);
    if (value) out[envName] = value;
  }
  return out;
}
