import type { RuntimeConfig } from "../types";
import {
  activateAgent,
  bankIdForAgent,
  createAgentRecord,
  deleteBankAndUnits,
  ensureAgentBank,
  mutateState,
  readState
} from "../state";
import { addAudit } from "../state/audit";
import { now } from "../state/ids";
import { renameSeededSoulName, seedAgentSoulFile } from "../runtime/identity-files";
import { DEFAULT_AGENT_TOOLSETS } from "../state/defaults";

export function listAgents(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeAgentId: state.activeAgentId, agents: state.agents };
}

export async function createAgent(config: RuntimeConfig, input: Record<string, unknown>) {
  // The name is seeded into the agent's SOUL.md (`Your name is <name>.`)
  // and surfaced in the runtime-identity block, so collapse every
  // whitespace run (incl. embedded \n/\r/\t) to a single space and trim —
  // this keeps the stored name a clean single-line label and rejects
  // whitespace-only input.
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
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
    // When the caller doesn't supply toolsets, union the current desired
    // default list into whatever the default agent has on disk. This keeps
    // newly-created sibling agents on an old instance (where
    // `agent_default.toolsets` predates a new addition like `browser`)
    // from inheriting the stale list. The migration in
    // `migrateDefaultAgentToolsets` already widens `agent_default` itself
    // on read, but this defends against creation paths that fire before
    // the next normalize.
    // Union the canonical DEFAULT_AGENT_TOOLSETS list into whatever the
    // default agent has on disk. This keeps newly-created sibling agents
    // on an old instance (where `agent_default.toolsets` predates a new
    // addition like `browser`) from inheriting the stale list. The
    // migration in `migrateDefaultAgentToolsets` widens `agent_default`
    // itself on read, but this defends against creation paths that fire
    // before the next normalize.
    const fallbackToolsets = (() => {
      const seed = Array.isArray(defaultAgent?.toolsets) ? [...defaultAgent.toolsets] : [];
      const known = new Set(seed);
      for (const name of DEFAULT_AGENT_TOOLSETS) {
        if (!known.has(name)) {
          seed.push(name);
          known.add(name);
        }
      }
      return seed;
    })();
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
        : fallbackToolsets,
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
  // Seed the per-agent SOUL.md with `Your name is <name>.` so the new
  // agent self-identifies by its own name (INSTRUCTIONS.md is generic).
  // Order matters: state has already been persisted, so a crash here
  // can never leave a SOUL.md for a non-existent agent.
  seedAgentSoulFile(config.instance, record.id, record.name);
  return record;
}

export async function useAgent(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => activateAgent(state, idOrName));
}

// Rename an agent. `AgentRecord.name` is the authoritative label (drives
// the switcher, list, `use_agent <name>`, and the `- agent:` identity
// block). The folder + Hindsight bank are keyed by the stable opaque id,
// so a rename never moves them. After the state write we best-effort sync
// the agent's seeded SOUL.md name line — but only when the SOUL is exactly
// the untouched seed (`renameSeededSoulName`); a customized persona is left
// to the model/user.
export async function renameAgent(
  config: RuntimeConfig,
  idOrName: string,
  rawName: string
) {
  // Collapse every whitespace run to a single space and trim — same
  // hygiene as `createAgent`, so the stored name stays a clean single-line
  // label and a whitespace-only rename is rejected.
  const newName = String(rawName ?? "").replace(/\s+/g, " ").trim();
  if (!newName) throw new Error("New agent name is required.");
  // "default" is the sentinel the `renameDefaultAgentToGini` migration keys
  // on: it flips an `agent_default` row named "default" back to "Gini" on the
  // next state read, which would drift the AgentRecord name away from a SOUL
  // that says "default". Reject it outright rather than let the rename silently
  // un-stick.
  if (newName === "default") throw new Error('"default" is a reserved name.');
  // Resolve id-first, then fall back to name, so an agent whose NAME happens
  // to equal another agent's id can't shadow the intended target.
  const found = readState(config.instance).agents;
  const target = found.find((a) => a.id === idOrName) ?? found.find((a) => a.name === idOrName);
  if (!target) throw new Error(`Agent not found: ${idOrName}`);
  // No-op a rename to the current name: skip the state write, audit, and SOUL
  // sync so an identity rename doesn't bump updatedAt or log a from===to event.
  if (target.name === newName) return target;
  const result = await mutateState(config.instance, (state) => {
    const agent = state.agents.find((a) => a.id === target.id);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    const oldName = agent.name;
    agent.name = newName;
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.renamed",
        target: agent.id,
        risk: "low",
        evidence: { from: oldName, to: newName, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    return { record: agent, oldName };
  });
  // Keep the seeded SOUL.md name line in sync outside the state write.
  // Best-effort: never clobbers a customized SOUL (see renameSeededSoulName).
  renameSeededSoulName(config.instance, result.record.id, result.oldName, newName);
  return result.record;
}

// Hard-deletes an agent and cascades cleanup across its memory pools.
// Guards:
//   - The default agent (`agent_default`) cannot be deleted.
//   - The active agent cannot be deleted — the caller must switch first.
//   - Unknown agent id/name throws (mapped to 404 by the HTTP layer).
// Cascade:
//   - Per-agent Hindsight bank (`bank_${agentId}`) + all units in it.
//   - The agent row is removed from `state.agents`.
// The legacy `state.memories` per-agent purge was removed alongside the
// state.memories consolidation (see ADR runtime-identity-files.md);
// USER.md is instance-scoped (no per-agent purge needed) and SOUL.md
// lives under `agents/<agentId>/SOUL.md` on disk — its filesystem
// cleanup is left to the operator since the file may carry hand-edited
// content worth preserving.
// Returns counts so callers/tests can verify the cascade scope. A single
// audit event records the deletion + cleanup counts.
export async function deleteAgent(
  config: RuntimeConfig,
  idOrName: string
): Promise<{ ok: true; id: string; unitsDeleted: number; bankDeleted: boolean }> {
  const result = await mutateState(config.instance, (state) => {
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (agent.id === "agent_default") {
      throw new Error("Cannot delete the default agent.");
    }
    if (state.activeAgentId === agent.id) {
      throw new Error("Cannot delete the active agent; switch to another agent first.");
    }
    state.agents = state.agents.filter((item) => item.id !== agent.id);
    return { id: agent.id, name: agent.name };
  });

  // Drop the per-agent Hindsight bank + its units outside the JSON state
  // transaction. SQLite is the source of truth for hindsight, so a single
  // BEGIN/COMMIT block there is the only consistency boundary we need.
  const { unitsDeleted, bankDeleted } = deleteBankAndUnits(
    config.instance,
    bankIdForAgent(result.id)
  );

  // Single audit event covering the whole cascade. Routed through a
  // follow-up mutateState so the cleanup counts are visible alongside
  // hindsight bookkeeping; the agent removal itself is already logged by
  // the state mutation above via state.agents membership change.
  await mutateState(config.instance, (state) => {
    // The deleted agent is the subject — attribute the audit to it so the
    // deletion event lands in that agent's own historical inbox rather
    // than the currently-active one.
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.deleted",
        target: result.id,
        risk: "medium",
        evidence: {
          name: result.name,
          unitsDeleted,
          bankDeleted
        }
      },
      { agentId: result.id }
    );
    return result.id;
  });

  return {
    ok: true,
    id: result.id,
    unitsDeleted,
    bankDeleted
  };
}
