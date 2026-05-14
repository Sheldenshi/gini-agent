import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Instance, PairingStatus, ProviderConfig, RuntimeConfig, RuntimeState } from "../types";
import { ensureDir, instanceRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultAgent, defaultTools, defaultToolsets } from "./defaults";
import { addAudit } from "./audit";
import { getMemoryDb, memoryDbPath } from "./memory-db";

export function createEmptyState(instance: Instance): RuntimeState {
  const at = now();
  return {
    version: 1,
    instance,
    createdAt: at,
    updatedAt: at,
    tasks: [],
    approvals: [],
    audit: [],
    memories: [],
    skills: [],
    jobs: [],
    identities: [
      {
        id: "id_demo",
        instance,
        name: "Demo Identity",
        kind: "demo",
        status: "configured",
        scopes: ["demo:read"],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "unknown"
      }
    ],
    improvements: [],
    pairingCodes: [],
    devices: [],
    promotions: [],
    snapshots: [],
    tools: defaultTools(instance, at),
    toolsets: defaultToolsets(instance, at),
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    agents: [defaultAgent(instance, at)],
    activeAgentId: "agent_default",
    relays: [],
    notifications: [],
    events: [],
    jobRuns: [],
    chatSessions: [],
    chatMessages: [],
    messagingMessages: [],
    runs: [],
    planSteps: []
  };
}

export function readState(instance: Instance): RuntimeState {
  ensureDir(instanceRoot(instance));
  const path = statePath(instance);
  if (!existsSync(path)) {
    const state = createEmptyState(instance);
    writeState(instance, state);
    return state;
  }
  const state = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
  return normalizeState(instance, state);
}

export function writeState(instance: Instance, state: RuntimeState): void {
  ensureDir(instanceRoot(instance));
  state.updatedAt = now();
  const path = statePath(instance);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, path);
}

// Per-instance serialization queue. mutateState is async so concurrent callers
// from independent async tasks (HTTP handlers, scheduler ticks, subagents,
// messaging bridges) never interleave their read-modify-write windows on the
// same instance. Single-process per-instance is the deployment model, so an
// in-process promise chain is sufficient — no file lock or semaphore needed.
//
// Reads (readState) stay lock-free because the file is written atomically
// (writeFileSync to .tmp + renameSync) so a reader either sees the prior
// state or the next state, never a torn write.
const instanceLocks = new Map<Instance, Promise<unknown>>();

// Public seed/migration entrypoint. Called at boot from `install()` so the
// default agent picks up `gini run --provider X` on fresh instances and
// migrates legacy davao-style instances away from the leaked echo
// defaults. Idempotent — calling it twice with the same inputs is a no-op.
// Writes back to disk only when something actually changed.
export async function seedDefaultAgentFromRuntimeConfig(config: RuntimeConfig): Promise<void> {
  await mutateState(config.instance, (state) => {
    seedDefaultAgentFromConfig(state, config.provider);
  });
}

export async function mutateState<T>(instance: Instance, fn: (state: RuntimeState) => T): Promise<T> {
  const previous = instanceLocks.get(instance) ?? Promise.resolve();
  const next = previous.then(() => {
    const state = readState(instance);
    const result = fn(state);
    writeState(instance, state);
    return result;
  });
  // Store a chained promise that swallows errors so a failed mutation does
  // not poison the queue for subsequent callers; the original error still
  // propagates to the caller via the returned `next`.
  instanceLocks.set(instance, next.catch(() => undefined));
  return next;
}

export function expirePairingCodes(state: RuntimeState): void {
  const at = Date.now();
  for (const pairing of state.pairingCodes) {
    if (pairing.status === "pending" && new Date(pairing.expiresAt).getTime() <= at) {
      pairing.status = "expired" satisfies PairingStatus;
    }
  }
}

// Pre-rename state files persisted a `lane` field on every record (top-level
// state.lane plus a lane field on every Task/Audit/Memory/Skill/etc.). After
// the lane→instance rename these files still exist on disk; we rewrite them
// in-place when first read. mutateState's read-modify-write cycle persists
// the cleaned shape on the next mutation. Idempotent: records that already
// carry an `instance` field are left alone.
function migrateLaneFieldToInstance(state: RuntimeState): void {
  const stateAny = state as unknown as { lane?: unknown; instance?: unknown };
  if (stateAny.lane !== undefined && stateAny.instance === undefined) {
    stateAny.instance = stateAny.lane;
  }
  delete stateAny.lane;

  const collectionKeys: Array<keyof RuntimeState> = [
    "tasks",
    "approvals",
    "audit",
    "memories",
    "skills",
    "jobs",
    "identities",
    "improvements",
    "pairingCodes",
    "devices",
    "promotions",
    "snapshots",
    "tools",
    "toolsets",
    "subagents",
    "mcpServers",
    "messagingBridges",
    "importReports",
    "agents",
    "relays",
    "notifications",
    "events",
    "jobRuns",
    "chatSessions",
    "chatMessages",
    "messagingMessages",
    "runs",
    "planSteps"
  ];
  for (const key of collectionKeys) {
    const records = state[key] as unknown;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const rec = record as { lane?: unknown; instance?: unknown };
      if (rec.lane !== undefined && rec.instance === undefined) {
        rec.instance = rec.lane;
      }
      delete rec.lane;
    }
  }
}

// Pre-ADR-0009 state files persist a `connectors` array. Rename to
// `identities` in-place; mutateState rewrites the file on the next mutation.
// Also backfill the new `secretRefs` field so callers can rely on it being
// an array.
function migrateConnectorsToIdentities(state: RuntimeState): void {
  const stateAny = state as unknown as { connectors?: unknown; identities?: unknown };
  if (stateAny.connectors !== undefined && stateAny.identities === undefined) {
    stateAny.identities = stateAny.connectors;
  }
  delete stateAny.connectors;
  if (Array.isArray(state.identities)) {
    for (const identity of state.identities) {
      identity.secretRefs ??= [];
    }
  }
}

// Seed the default agent's provider fields from RuntimeConfig.provider when:
//   1. The agent has never been configured (providerName/model undefined), OR
//   2. The agent still carries the legacy hardcoded echo defaults AND the
//      instance config points at a different provider — this corrects
//      pre-Phase-B instances where the default leaked echo regardless of
//      the user's `gini run --provider X` choice.
// Idempotent: a second pass with the same inputs is a no-op. Touches only
// the default agent (id === "agent_default" or the legacy "profile_default")
// because non-default agents are user-authored and we don't want to clobber
// their explicit picks.
function seedDefaultAgentFromConfig(state: RuntimeState, provider: ProviderConfig): boolean {
  const defaults = state.agents.filter((agent) => agent.id === "agent_default" || agent.id === "profile_default");
  let mutated = false;
  for (const agent of defaults) {
    const needsSeed = !agent.providerName || !agent.model;
    const legacyEcho = agent.providerName === "echo"
      && agent.model === "gini-echo-v0"
      && (provider.name !== "echo" || provider.model !== "gini-echo-v0");
    if (!needsSeed && !legacyEcho) continue;
    agent.providerName = provider.name;
    agent.model = provider.model;
    agent.updatedAt = now();
    mutated = true;
  }
  return mutated;
}

// Pre-rename state files persisted `state.profiles` / `state.activeProfileId`.
// After the profile→agent rename these fields still exist on disk; we rewrite
// them in-place when first read. mutateState's read-modify-write cycle persists
// the cleaned shape on the next mutation. Idempotent: when `agents` already
// exists, the legacy `profiles` field is just dropped.
function migrateProfileFieldsToAgent(state: RuntimeState): void {
  const stateAny = state as unknown as {
    profiles?: unknown;
    agents?: unknown;
    activeProfileId?: unknown;
    activeAgentId?: unknown;
  };
  if (stateAny.profiles !== undefined && stateAny.agents === undefined) {
    stateAny.agents = stateAny.profiles;
  }
  delete stateAny.profiles;
  if (stateAny.activeProfileId !== undefined && stateAny.activeAgentId === undefined) {
    stateAny.activeAgentId = stateAny.activeProfileId;
  }
  delete stateAny.activeProfileId;
}

// Drop the dead `MemoryRecord.scope` and `AgentRecord.memoryScopes` fields
// from persisted state. Neither was consulted at runtime after Phase C —
// `agentId` is the only memory isolation boundary. Idempotent: a second
// pass over an already-cleaned state file matches no rows. Emits one
// summary audit event per collection when something was stripped so the
// cleanup shows up in `gini doctor` / /api/audit.
function migrateDropDeadMemoryFields(state: RuntimeState): void {
  let scopesStripped = 0;
  if (Array.isArray(state.memories)) {
    for (const memory of state.memories) {
      const rec = memory as unknown as { scope?: unknown };
      if (rec.scope !== undefined) {
        delete rec.scope;
        scopesStripped += 1;
      }
    }
  }
  let memoryScopesStripped = 0;
  if (Array.isArray(state.agents)) {
    for (const agent of state.agents) {
      const rec = agent as unknown as { memoryScopes?: unknown };
      if (rec.memoryScopes !== undefined) {
        delete rec.memoryScopes;
        memoryScopesStripped += 1;
      }
    }
  }
  if (scopesStripped > 0) {
    addAudit(state, {
      actor: "runtime",
      action: "memory.scope.dropped",
      target: "state.memories",
      risk: "low",
      evidence: { stripped: scopesStripped }
    });
  }
  if (memoryScopesStripped > 0) {
    addAudit(state, {
      actor: "runtime",
      action: "agent.memoryscopes.dropped",
      target: "state.agents",
      risk: "low",
      evidence: { stripped: memoryScopesStripped }
    });
  }
}

// Phase C — per-agent memory isolation backfill for the legacy
// MemoryRecord store. Walks state.memories and stamps `agentId` on rows
// that pre-date Phase C, bundling all of them under whichever agent was
// active at migration time (typically the default agent on davao-style
// instances). Idempotent: rows already carrying `agentId` are skipped.
// Audits the count so the rebucketing shows up in `gini doctor` /
// /api/audit. Hindsight unit/bank backfill lives in
// migrateHindsightAgentIdColumns (runs against SQLite, not JSON state).
function migrateMemoryAgentId(state: RuntimeState): void {
  if (!Array.isArray(state.memories) || state.memories.length === 0) return;
  const defaultAgentId =
    state.activeAgentId
    ?? state.agents.find((agent) => agent.status === "active")?.id
    ?? state.agents[0]?.id
    ?? "agent_default";
  let stamped = 0;
  for (const memory of state.memories) {
    if (memory.agentId) continue;
    memory.agentId = defaultAgentId;
    stamped += 1;
  }
  if (stamped > 0) {
    addAudit(state, {
      actor: "runtime",
      action: "memory.agentid.backfill",
      target: defaultAgentId,
      risk: "low",
      evidence: { stamped, agentId: defaultAgentId }
    });
  }
}

// Phase C — per-agent backfill on the SQLite hindsight store. Pre-Phase-C
// rows have a NULL agent_id (default value from the ALTER TABLE). Walk the
// DB once and stamp them with the migration-time active agent, mirroring
// the JSON MemoryRecord backfill. Bank rows get the same treatment so
// their `agentId` field is non-null going forward. Idempotent — only
// touches NULL rows.
function migrateHindsightAgentIdColumns(instance: Instance, state: RuntimeState): void {
  // Skip if no memory.db has been created yet — first-boot instances will
  // pick up the column from CREATE TABLE and won't need the backfill.
  if (!existsSync(memoryDbPath(instance))) return;
  const defaultAgentId =
    state.activeAgentId
    ?? state.agents.find((agent) => agent.status === "active")?.id
    ?? state.agents[0]?.id
    ?? "agent_default";
  try {
    const db = getMemoryDb(instance);
    const stampedUnits = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memory_units WHERE agent_id IS NULL"
      )
      .get()?.c ?? 0;
    if (stampedUnits > 0) {
      db.run("UPDATE memory_units SET agent_id = ? WHERE agent_id IS NULL", [defaultAgentId]);
    }
    const stampedBanks = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memory_banks WHERE agent_id IS NULL AND id != 'bank_default'"
      )
      .get()?.c ?? 0;
    if (stampedBanks > 0) {
      // The legacy `bank_default` row stays untagged so existing code that
      // reads from it (ensureDefaultBank) keeps working; per-agent banks
      // created by ensureAgentBank carry a non-null agent_id from inception.
      db.run(
        "UPDATE memory_banks SET agent_id = ? WHERE agent_id IS NULL AND id != 'bank_default'",
        [defaultAgentId]
      );
    }
    if (stampedUnits > 0 || stampedBanks > 0) {
      addAudit(state, {
        actor: "runtime",
        action: "hindsight.agentid.backfill",
        target: defaultAgentId,
        risk: "low",
        evidence: { units: stampedUnits, banks: stampedBanks, agentId: defaultAgentId }
      });
    }
  } catch {
    // SQLite open failures are surfaced through `gini doctor`'s probe; the
    // normalizeState path stays best-effort so a corrupted DB doesn't block
    // every read of state.json.
  }
}

export function normalizeState(instance: Instance, state: RuntimeState): RuntimeState {
  migrateProfileFieldsToAgent(state);
  migrateLaneFieldToInstance(state);
  migrateConnectorsToIdentities(state);
  state.instance = instance;
  state.improvements ??= [];
  state.identities ??= [];
  state.tasks ??= [];
  state.approvals ??= [];
  state.audit ??= [];
  state.memories ??= [];
  state.skills ??= [];
  state.jobs ??= [];
  state.pairingCodes ??= [];
  state.devices ??= [];
  state.promotions ??= [];
  state.snapshots ??= [];
  state.tools ??= defaultTools(instance, now());
  state.toolsets ??= defaultToolsets(instance, now());
  // Backfill any toolsets/tools that were added to defaults after this
  // instance was first created. Without this, an existing instance that
  // already has a `state.toolsets` array silently misses new toolsets
  // (e.g. browser) and `/api/toolsets/<name>/enable` returns "Toolset
  // not found". Match by name so user-renamed entries are left alone.
  const at = now();
  const desiredToolsets = defaultToolsets(instance, at);
  const desiredTools = defaultTools(instance, at);
  for (const ts of desiredToolsets) {
    if (!state.toolsets!.some((existing) => existing.name === ts.name)) {
      state.toolsets!.push(ts);
    }
  }
  // For each defaults-known toolset, union its desired tool names into
  // the (possibly pre-existing) state row, and synthesize matching tool
  // rows whose status reflects the EXISTING toolset's status. This runs
  // before the catch-all "add missing tools" pass below so a tool that
  // belongs to an already-enabled toolset comes up "available" rather
  // than inheriting the defaults' "disabled" status. Without this an
  // older instance whose `browser` row is enabled but whose tool rows
  // pre-date browser.vision et al. would render the new entries as
  // disabled even though the toolset itself is on.
  for (const desired of desiredToolsets) {
    const existing = state.toolsets!.find((t) => t.name === desired.name);
    if (!existing) continue;
    // Union toolNames preserving the existing row's order; append any
    // names that aren't already present.
    const known = new Set(existing.toolNames);
    for (const name of desired.toolNames) {
      if (!known.has(name)) {
        existing.toolNames.push(name);
        known.add(name);
      }
    }
    const existingStatus = existing.status;
    for (const desiredTool of desiredTools) {
      if (desiredTool.toolset !== desired.name) continue;
      if (state.tools!.some((t) => t.name === desiredTool.name)) continue;
      state.tools!.push({
        ...desiredTool,
        status: existingStatus === "enabled" ? "available" : "disabled"
      });
    }
  }
  // Catch-all final pass: tools whose toolset wasn't in the defaults
  // (or matched by name above) but that ship in defaultTools. We use
  // the desired tool's own status here since there's no existing
  // toolset row to consult.
  for (const tool of desiredTools) {
    if (!state.tools!.some((existing) => existing.name === tool.name)) {
      state.tools!.push(tool);
    }
  }
  state.subagents ??= [];
  state.mcpServers ??= [];
  state.messagingBridges ??= [];
  state.messagingMessages ??= [];
  state.importReports ??= [];
  state.agents ??= [defaultAgent(instance, now())];
  state.activeAgentId ??= state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
  // Phase C — per-agent memory isolation backfill. Runs after agents are
  // present so the migration can stamp the right id. Both helpers are
  // idempotent so a re-read of an already-migrated state file is a no-op.
  migrateMemoryAgentId(state);
  migrateHindsightAgentIdColumns(instance, state);
  // Drop dead MemoryRecord.scope / AgentRecord.memoryScopes fields from
  // legacy state files. Runs after agents are populated so the audit
  // event can land on a valid state.
  migrateDropDeadMemoryFields(state);
  state.relays ??= [];
  state.notifications ??= [];
  state.events ??= [];
  state.jobRuns ??= [];
  state.chatSessions ??= [];
  state.chatMessages ??= [];
  state.runs ??= [];
  state.planSteps ??= [];
  for (const session of state.chatSessions) {
    session.runIds ??= [];
  }
  for (const run of state.runs) {
    run.planStepIds ??= [];
    run.childRunIds ??= [];
    run.approvalIds ??= [];
  }
  for (const skill of state.skills) {
    skill.tests ??= [];
    skill.successCount ??= 0;
    skill.failureCount ??= 0;
    skill.previousVersions ??= [];
    // Filesystem skill loader (Slice 2) introduced these fields. Records
    // persisted before the loader landed don't carry them — backfill with
    // safe defaults so consumers can rely on `body` being a string.
    skill.body ??= "";
    // Trust-hijack fix: skill records now carry an explicit `source` so
    // bundled and user-instance skills with the same name coexist as
    // separate rows. Legacy records (pre-fix) default to "user" — bundled
    // records get re-tagged on the next loadSkillsFromDisk pass.
    skill.source ??= "user";
  }
  for (const subagent of state.subagents) {
    // Slice 4 introduced `systemPrompt` (always present) and optional
    // toolsetIds/skillNames/resultSummary/resultError. Records persisted
    // before Slice 4 landed don't carry these — backfill `systemPrompt`
    // with an empty string so callers can rely on the field being a
    // string. The optional fields stay undefined for legacy rows.
    subagent.systemPrompt ??= "";
  }
  for (const job of state.jobs) {
    job.deliveryTargets ??= [];
    job.context ??= [];
    job.retryLimit ??= 0;
    job.timeoutSeconds ??= 30;
    job.runIds ??= [];
  }
  // Browser connection record is purely opt-in — feature added after the
  // initial state shape. Normalize obviously bad shapes to null so a
  // hand-edited state file can't crash downstream consumers; valid records
  // pass through untouched.
  if (state.browser !== undefined && state.browser !== null) {
    const candidate = state.browser as Partial<typeof state.browser> & { cdpUrl?: unknown; mode?: unknown };
    if (
      typeof candidate !== "object" ||
      typeof candidate.cdpUrl !== "string" ||
      (candidate.mode !== "managed" && candidate.mode !== "cdp")
    ) {
      state.browser = null;
    }
  }
  expirePairingCodes(state);
  return state;
}
