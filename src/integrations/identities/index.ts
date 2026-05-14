import type { IdentityRecord, IdentitySecretRef, RuntimeConfig, RuntimeState, SkillRecord } from "../../types";
import { addAudit, id, mutateState, now, readState, updateIdentityHealth } from "../../state";
import { deleteIdentitySecrets, deleteSecret, readSecret, writeSecret } from "../../state/secrets";

export interface CreateIdentityInput {
  name: string;
  kind: string;
  scopes?: string[];
  secrets?: Record<string, string>;
}

export interface UpdateIdentityInput {
  name?: string;
  scopes?: string[];
  status?: "configured" | "disabled" | "error";
  secrets?: Record<string, string>;
}

export async function createIdentity(config: RuntimeConfig, input: CreateIdentityInput): Promise<IdentityRecord> {
  const kind = String(input.kind || "").trim();
  const name = String(input.name || "").trim();
  if (!kind) throw new Error("Invalid input: kind is required.");
  if (!name) throw new Error("Invalid input: name is required.");
  const identityId = id("id");
  const secretRefs: IdentitySecretRef[] = [];
  for (const [purpose, value] of Object.entries(input.secrets ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    secretRefs.push(writeSecret(config.instance, identityId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const at = now();
    const identity: IdentityRecord = {
      id: identityId,
      instance: state.instance,
      name,
      kind,
      status: "configured",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      secretRefs,
      createdAt: at,
      updatedAt: at,
      health: "unknown"
    };
    state.identities.unshift(identity);
    updateIdentityHealth(identity);
    addAudit(state, {
      actor: "user",
      action: "identity.create",
      target: identity.id,
      risk: "medium",
      evidence: {
        kind: identity.kind,
        name: identity.name,
        scopes: identity.scopes,
        purposes: secretRefs.map((ref) => ref.purpose)
      }
    });
    return identity;
  });
}

export async function updateIdentity(
  config: RuntimeConfig,
  identityId: string,
  input: UpdateIdentityInput
): Promise<IdentityRecord> {
  const newSecrets = input.secrets ?? {};
  const wroteRefs: IdentitySecretRef[] = [];
  for (const [purpose, value] of Object.entries(newSecrets)) {
    if (typeof value !== "string" || value.length === 0) continue;
    wroteRefs.push(writeSecret(config.instance, identityId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const identity = state.identities.find((candidate) => candidate.id === identityId);
    if (!identity) throw new Error(`Identity not found: ${identityId}`);
    if (typeof input.name === "string") identity.name = input.name.trim() || identity.name;
    if (Array.isArray(input.scopes)) identity.scopes = input.scopes.map(String);
    if (input.status) identity.status = input.status;
    for (const ref of wroteRefs) {
      const existing = identity.secretRefs.find((candidate) => candidate.purpose === ref.purpose);
      if (existing) existing.path = ref.path;
      else identity.secretRefs.push(ref);
    }
    identity.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: wroteRefs.length > 0 ? "identity.rotate" : "identity.update",
      target: identity.id,
      risk: "medium",
      evidence: {
        kind: identity.kind,
        rotatedPurposes: wroteRefs.map((ref) => ref.purpose)
      }
    });
    return identity;
  });
}

export async function deleteIdentity(config: RuntimeConfig, identityId: string): Promise<{ id: string }> {
  deleteIdentitySecrets(config.instance, identityId);
  return mutateState(config.instance, (state) => {
    const index = state.identities.findIndex((candidate) => candidate.id === identityId);
    if (index < 0) throw new Error(`Identity not found: ${identityId}`);
    const [identity] = state.identities.splice(index, 1);
    addAudit(state, {
      actor: "user",
      action: "identity.delete",
      target: identityId,
      risk: "medium",
      evidence: { kind: identity?.kind, name: identity?.name }
    });
    return { id: identityId };
  });
}

// Resolve a single secret value for an identity, emitting an audit event
// that records the purpose and whether resolution succeeded — never the
// value itself. Callers that need to pass a secret into a subprocess
// should fetch it through here so the audit trail is consistent.
export async function resolveIdentitySecret(
  config: RuntimeConfig,
  identityId: string,
  purpose: string
): Promise<string | undefined> {
  const state = readState(config.instance);
  const identity = state.identities.find((candidate) => candidate.id === identityId);
  if (!identity) throw new Error(`Identity not found: ${identityId}`);
  const ref = identity.secretRefs.find((candidate) => candidate.purpose === purpose);
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
        action: "identity.secret.use",
        target: identityId,
        risk: "low",
        evidence: { kind: identity.kind, purpose, resolved: ok }
      });
    });
  }
  return value;
}

// Per-kind health probe dispatch. The demo kind keeps its no-op behavior
// (status flip + demo message); real kinds (e.g. linear) live in their
// own files under this folder and register via this dispatch.
export async function checkIdentity(config: RuntimeConfig, identityId: string): Promise<IdentityRecord> {
  const initial = readState(config.instance).identities.find((candidate) => candidate.id === identityId);
  if (!initial) throw new Error(`Identity not found: ${identityId}`);

  let probeMessage: string | undefined;
  let probeHealth: "healthy" | "unhealthy" | "unknown" = "unknown";
  if (initial.kind === "demo") {
    probeHealth = initial.status === "configured" ? "healthy" : "unhealthy";
  } else if (initial.kind === "linear") {
    const { probeLinear } = await import("./linear");
    const token = await resolveIdentitySecret(config, identityId, "token");
    if (!token) {
      probeHealth = "unhealthy";
      probeMessage = "Missing token secret.";
    } else {
      const result = await probeLinear(token);
      probeHealth = result.ok ? "healthy" : "unhealthy";
      probeMessage = result.ok ? `Authenticated as ${result.viewer.name}` : result.error;
    }
  } else {
    probeMessage = "Health probe not implemented for this kind.";
  }

  return mutateState(config.instance, (state) => {
    const identity = state.identities.find((candidate) => candidate.id === identityId);
    if (!identity) throw new Error(`Identity not found: ${identityId}`);
    if (identity.kind === "demo") {
      updateIdentityHealth(identity);
    } else {
      identity.lastHealthAt = now();
      identity.health = probeHealth;
      identity.message = probeMessage;
      identity.updatedAt = now();
    }
    addAudit(state, {
      actor: "runtime",
      action: "identity.health",
      target: identityId,
      risk: "low",
      evidence: { kind: identity.kind, health: identity.health }
    });
    return identity;
  });
}

// A skill is active iff every required identity is satisfied by a
// healthy IdentityRecord of the matching kind. The agent loop filters
// inactive skills out of its available-skills set; the UI still shows
// them so users can see what's missing.
export function isSkillActive(state: RuntimeState, skill: SkillRecord): boolean {
  const required = skill.requiredIdentities ?? [];
  if (required.length === 0) return true;
  for (const requirement of required) {
    const match = state.identities.find(
      (candidate) => candidate.kind === requirement.kind && candidate.health === "healthy"
    );
    if (!match) return false;
  }
  return true;
}

// Returns the env var bindings a skill should receive when its scripts
// run, based on `prerequisites.env` + `requires.identities`. We
// resolve each declared env name from the secrets of the first healthy
// identity that has a matching purpose. Purpose names mirror env var
// names lowercased and stripped of the kind prefix
// (e.g. LINEAR_API_KEY → token for kind: linear). For now we encode a
// small kind→purpose map; new identity kinds extend it.
const ENV_TO_PURPOSE: Record<string, string> = {
  LINEAR_API_KEY: "token"
};

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
  const required = skill.requiredIdentities ?? [];
  if (required.length === 0) return {};
  const state = readState(config.instance);
  const out: Record<string, string> = {};
  for (const envName of envNames) {
    const purpose = ENV_TO_PURPOSE[envName];
    if (!purpose) continue;
    for (const requirement of required) {
      const identity = state.identities.find(
        (candidate) => candidate.kind === requirement.kind && candidate.health === "healthy"
      );
      if (!identity) continue;
      const value = await resolveIdentitySecret(config, identity.id, purpose);
      if (value) {
        out[envName] = value;
        break;
      }
    }
  }
  return out;
}
