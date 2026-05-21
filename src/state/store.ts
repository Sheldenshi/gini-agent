import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Instance, PairingStatus, ProviderConfig, RuntimeConfig, RuntimeState, TaskStatus } from "../types";
import { ensureDir, instanceRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultAgent, defaultTools, defaultToolsets } from "./defaults";
import { addAudit } from "./audit";
import { getMemoryDb, memoryDbPath } from "./memory-db";

// Shared terminal-status predicate. Every site that mutates
// `task.status` should check this before flipping so a cancelled /
// failed / completed task isn't resurrected by a stale in-flight
// code path. Returns `true` for the three terminal states in the
// TaskStatus union.
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

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
    connectors: [
      {
        id: "id_demo",
        instance,
        name: "Demo Connector",
        provider: "demo",
        status: "configured",
        scopes: ["demo:read"],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "unknown",
        source: "user"
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
    "connectors",
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

// ADR connector-provider-spec-compliance.md renamed `state.identities` → `state.connectors` and each
// record's `kind` → `provider`. State files written before that rename
// still carry the old keys; rewrite them in-place so mutateState persists
// the new shape on the next write. No back-compat shim is exposed outside
// this normalizer.
function migrateIdentitiesToConnectors(state: RuntimeState): void {
  const stateAny = state as unknown as { connectors?: unknown; identities?: unknown };
  if (stateAny.identities !== undefined && stateAny.connectors === undefined) {
    stateAny.connectors = stateAny.identities;
  }
  delete stateAny.identities;
  if (Array.isArray(state.connectors)) {
    for (const connector of state.connectors) {
      const rec = connector as unknown as { kind?: unknown; provider?: unknown; secretRefs?: unknown };
      if (rec.kind !== undefined && rec.provider === undefined) {
        rec.provider = rec.kind;
      }
      delete rec.kind;
      connector.secretRefs ??= [];
      // Auto-detection landed after the original ConnectorRecord shape;
      // pre-existing records were all created via the user-driven CRUD
      // path, so default `source: "user"`. The detection job stamps
      // "auto" when it materializes a new record.
      connector.source ??= "user";
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
    // Migration housekeeping at instance load — no agent context yet.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "memory.scope.dropped",
        target: "state.memories",
        risk: "low",
        evidence: { stripped: scopesStripped }
      },
      { system: true }
    );
  }
  if (memoryScopesStripped > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "agent.memoryscopes.dropped",
        target: "state.agents",
        risk: "low",
        evidence: { stripped: memoryScopesStripped }
      },
      { system: true }
    );
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
  // Treat stale agentIds (pointing at a deleted/unknown agent) the same as
  // missing — leaving them stamped to a dead id strands the memory under
  // an unselectable bucket in the UI. Mirrors the predicate in
  // migrateRecordAgentIds.
  const validAgentIds = new Set(state.agents.map((agent) => agent.id));
  let stamped = 0;
  for (const memory of state.memories) {
    if (memory.agentId && validAgentIds.has(memory.agentId)) continue;
    memory.agentId = defaultAgentId;
    stamped += 1;
  }
  if (stamped > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "memory.agentid.backfill",
        target: defaultAgentId,
        risk: "low",
        evidence: { stamped, agentId: defaultAgentId }
      },
      { agentId: defaultAgentId }
    );
  }
}

// Backfill Task.chatSessionId from the chatMessages join for records that
// pre-date the field. The Tasks page reads task.chatSessionId directly so it
// no longer has to pull /state for the chatMessages list — but state files
// older than this field must still resolve correctly. Idempotent: only
// stamps tasks where the field is missing AND a matching user-role message
// exists. No audit row — this is purely derived data, not a new fact.
function migrateTaskChatSessionId(state: RuntimeState): void {
  if (!Array.isArray(state.tasks) || state.tasks.length === 0) return;
  if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) return;
  for (const task of state.tasks) {
    if (task.chatSessionId) continue;
    const message = state.chatMessages.find(
      (candidate) => candidate.taskId === task.id && candidate.role === "user"
    );
    if (message) task.chatSessionId = message.sessionId;
  }
}

// Stamp the active-at-migration-time agent onto records that pre-date the
// per-agent isolation field. Mirrors migrateMemoryAgentId — idempotent and
// audit-emitting. Covers Task, ChatSessionRecord, JobRecord, JobRunRecord,
// SubagentRecord, Approval in one pass so the backfill audit doesn't fan
// out into six separate rows. RuntimeEvent and AuditEvent are deliberately
// excluded — see the comment at the stamp loop below.
function migrateRecordAgentIds(state: RuntimeState): void {
  // When the state file has no agents at all (e.g. a hand-edited or
  // partially-restored file that lost both the seed pass and the
  // pre-seed defaults), skip the backfill entirely. Stamping records
  // with a literal "agent_default" id that no AgentRecord owns would
  // leave them attributed to a nonexistent agent. The seeding step in
  // normalizeState above ensures we never reach this branch in
  // normal operation. Defense in depth against a stale `activeAgentId`
  // that the upstream repair missed: only honor it when it points at an
  // existing agent; otherwise fall back to the first active / first
  // existing agent rather than the dead id.
  const knownActive = state.agents.some((agent) => agent.id === state.activeAgentId)
    ? state.activeAgentId
    : undefined;
  const defaultAgentId =
    knownActive
    ?? state.agents.find((agent) => agent.status === "active")?.id
    ?? state.agents[0]?.id;
  if (!defaultAgentId) return;
  const validAgentIds = new Set(state.agents.map((agent) => agent.id));
  const counts: Record<string, number> = {};
  // Re-stamp rows whose agentId is missing OR points at an agent that no
  // longer exists (deleted agent, stale id from an old import). The latter
  // would otherwise leave records stranded under an unselectable id and
  // invisible to the UI which filters by `state.agents`. Idempotent: once
  // every row resolves to a valid id, subsequent runs are no-ops.
  const stamp = <T extends { agentId?: string }>(rows: T[] | undefined, label: string) => {
    if (!Array.isArray(rows)) return;
    let n = 0;
    for (const row of rows) {
      if (row.agentId && validAgentIds.has(row.agentId)) continue;
      row.agentId = defaultAgentId;
      n += 1;
    }
    if (n > 0) counts[label] = n;
  };
  stamp(state.tasks, "tasks");
  stamp(state.chatSessions, "chatSessions");
  stamp(state.jobs, "jobs");
  stamp(state.jobRuns, "jobRuns");
  stamp(state.subagents, "subagents");
  stamp(state.approvals, "approvals");
  // Events and audits are deliberately NOT backfilled here. After the
  // AgentContext refactor, a missing agentId on an event/audit is a
  // first-class signal that the row is system-attributed (instance boot,
  // agent-lifecycle, instance-level config). Stamping those legacy-style
  // would erase that distinction and re-pollute every read with a
  // backfill audit row. Legacy events from before agentId existed simply
  // stay unattributed — the UI's "All agents" view shows them; per-agent
  // filters skip them, which matches the system-event contract.
  if (Object.keys(counts).length > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "records.agentid.backfill",
        target: defaultAgentId,
        risk: "low",
        evidence: { stamped: counts, agentId: defaultAgentId }
      },
      { agentId: defaultAgentId }
    );
  }
}

// Backfill `messaging` and `mcp` onto the default agent's toolsets
// whitelist when the agent still carries the prior default set exactly
// (`["file","terminal","memory","session_search","delegation"]`). Without
// this, an instance created before the messaging+mcp toolsets joined the
// default whitelist keeps gating `send_message` out via the per-agent
// intersection even after the operator enables those toolsets. The
// exact-match heuristic catches the common case (the user never
// customized the list) without overriding intentional removals — any
// customization (added or removed entries) leaves the agent alone.
// Idempotent: a state file already on the new shape (the union already
// includes both names, OR the user has customized the list) is a no-op.
const PRIOR_DEFAULT_AGENT_TOOLSETS = [
  "file",
  "terminal",
  "memory",
  "session_search",
  "delegation"
] as const;
function backfillDefaultAgentToolsets(state: RuntimeState): void {
  // Defensive: iterate every agent_default row in case a corrupt state
  // file ended up with duplicates. The id uniqueness invariant should
  // hold, but if it doesn't, migrating one and leaving the rest stale
  // would be the worst outcome.
  const candidates = state.agents.filter((candidate) => candidate.id === "agent_default");
  for (const agent of candidates) {
    const current = agent.toolsets ?? [];
    // Order-insensitive exact match against the prior default. A set
    // comparison catches reorders and matches the "user never customized"
    // signal without depending on the historical write order.
    if (current.length !== PRIOR_DEFAULT_AGENT_TOOLSETS.length) continue;
    const currentSet = new Set(current);
    let matches = true;
    for (const name of PRIOR_DEFAULT_AGENT_TOOLSETS) {
      if (!currentSet.has(name)) { matches = false; break; }
    }
    if (!matches) continue;
    // Match. Union in `messaging` and `mcp` so the operator's later
    // toolset-enable lands at a fully-resolved per-agent whitelist.
    agent.toolsets = [...current, "messaging", "mcp"];
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "agent.toolsets.backfilled",
        target: agent.id,
        risk: "low",
        evidence: { added: ["messaging", "mcp"], agentId: agent.id }
      },
      { agentId: agent.id }
    );
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
      addAudit(
        state,
        {
          actor: "runtime",
          action: "hindsight.agentid.backfill",
          target: defaultAgentId,
          risk: "low",
          evidence: { units: stampedUnits, banks: stampedBanks, agentId: defaultAgentId }
        },
        { agentId: defaultAgentId }
      );
    }
  } catch {
    // SQLite open failures are surfaced through `gini doctor`'s probe; the
    // normalizeState path stays best-effort so a corrupted DB doesn't block
    // every read of state.json.
  }
}

// Union the desired default-agent toolsets list into existing
// `agent_default` (and the legacy `profile_default`) records on disk.
// Without this, an instance created before a new default toolset (e.g.
// `browser`) was added still carries the old toolsets array, and
// `resolveEffectiveContext` filters the tool catalog by that stale list —
// so even though the toolset row itself is enabled by the global
// backfill, the agent's whitelist still excludes the new tool family.
//
// Only touches the default agent records. User-authored agents keep
// whatever toolsets they have; they were explicit picks.
// Historical snapshots of the default-agent toolsets list. The migration
// only fires when the agent's current toolsets exactly matches one of
// these — that's the "user never customized" signal. If the user removed
// or rearranged anything, we leave the list alone (they made an
// explicit pick). Each snapshot represents a stable point in the
// default's evolution before a new toolset was added.
const HISTORICAL_DEFAULT_AGENT_TOOLSETS: ReadonlyArray<ReadonlyArray<string>> = [
  // Pre-delegation, pre-messaging/mcp, pre-browser.
  ["file", "terminal", "memory", "session_search"],
  // Pre-messaging/mcp, pre-browser (handled by backfillDefaultAgentToolsets above).
  ["file", "terminal", "memory", "session_search", "delegation"],
  // Post-messaging/mcp, pre-browser. This is what backfillDefaultAgentToolsets
  // produces when it fires on the prior-default snapshot.
  ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp"]
];

function migrateDefaultAgentToolsets(state: RuntimeState, instance: Instance): void {
  if (!Array.isArray(state.agents) || state.agents.length === 0) return;
  const at = now();
  const desired = defaultAgent(instance, at).toolsets;
  if (!Array.isArray(desired) || desired.length === 0) return;
  for (const agent of state.agents) {
    if (agent.id !== "agent_default" && agent.id !== "profile_default") continue;
    const existing = Array.isArray(agent.toolsets) ? agent.toolsets : null;
    if (existing === null) {
      agent.toolsets = [...desired];
      agent.updatedAt = at;
      continue;
    }
    // `profile_default` is the legacy agent id (renamed to
    // `agent_default`). Anyone still on it has a stale config — always
    // migrate it up to the current default without the customization
    // check applied to `agent_default`.
    const isLegacyDefault = agent.id === "profile_default";
    const existingSet = new Set(existing);
    if (!isLegacyDefault) {
      // For `agent_default`, only union when the current toolsets exactly
      // matches one of the historical snapshots OR the current desired
      // default. Any divergence (user added/removed something) is treated
      // as customization and left alone.
      const matchesSnapshot = (snapshot: ReadonlyArray<string>): boolean => {
        if (snapshot.length !== existing.length) return false;
        for (const name of snapshot) {
          if (!existingSet.has(name)) return false;
        }
        return true;
      };
      const isHistorical = HISTORICAL_DEFAULT_AGENT_TOOLSETS.some(matchesSnapshot);
      const isCurrent = matchesSnapshot(desired);
      if (!isHistorical && !isCurrent) continue;
    }
    let mutated = false;
    for (const name of desired) {
      if (!existingSet.has(name)) {
        existing.push(name);
        existingSet.add(name);
        mutated = true;
      }
    }
    if (mutated) {
      agent.updatedAt = at;
    }
  }
}

export function normalizeState(instance: Instance, state: RuntimeState): RuntimeState {
  migrateProfileFieldsToAgent(state);
  migrateLaneFieldToInstance(state);
  migrateIdentitiesToConnectors(state);
  state.instance = instance;
  state.improvements ??= [];
  state.connectors ??= [];
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
  // Seed a default agent when the state file is either missing the field or
  // carries an empty array. Without the empty-array branch,
  // migrateRecordAgentIds would fall through its `"agent_default"` literal
  // and stamp records with an id no AgentRecord actually owns.
  if (!Array.isArray(state.agents) || state.agents.length === 0) {
    state.agents = [defaultAgent(instance, now())];
  }
  state.activeAgentId ??= state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
  // Repair: if `activeAgentId` references an agent the state file no longer
  // contains (hand-edited file, partial restore, deleted-default edge), it
  // would propagate the dead id through migrateRecordAgentIds. Re-anchor it
  // to the first active / first existing agent so downstream readers and
  // backfills see a real id.
  if (!state.agents.some((agent) => agent.id === state.activeAgentId)) {
    state.activeAgentId = state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
  }
  // Backfill the default agent's toolsets whitelist with `messaging` and
  // `mcp` when the agent still carries the prior default set exactly.
  // Runs after the default-agent seed branch above so the migration sees
  // a real `agent_default` row when one was just synthesized. Idempotent.
  backfillDefaultAgentToolsets(state);
  // Union new default toolsets (e.g. `browser` after Phase 2) into the
  // existing `agent_default` record. Runs after agents are populated;
  // idempotent.
  migrateDefaultAgentToolsets(state, instance);
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
  // Per-agent isolation backfill for record types other than memory. Runs
  // after every list default above so we never touch undefined arrays.
  // Idempotent — only stamps rows missing `agentId`.
  migrateRecordAgentIds(state);
  // Backfill Task.chatSessionId so the Tasks page can resolve task -> chat
  // session without a /state round-trip. Runs after chatMessages is
  // defaulted (above) so the join scan never sees undefined.
  migrateTaskChatSessionId(state);
  for (const session of state.chatSessions) {
    session.runIds ??= [];
  }
  for (const run of state.runs) {
    run.planStepIds ??= [];
    run.childRunIds ??= [];
    run.approvalIds ??= [];
  }
  for (const skill of state.skills) {
    const legacyStatus = (skill as unknown as { status?: string }).status;
    // Compatibility only: older state files used pre-enablement skill statuses.
    if (legacyStatus === "trusted") skill.status = "enabled";
    else if (legacyStatus === "draft" || legacyStatus === "untrusted") skill.status = "disabled";
    else if (!legacyStatus) skill.status = "disabled";
    skill.tests ??= [];
    skill.successCount ??= 0;
    skill.failureCount ??= 0;
    skill.previousVersions ??= [];
    // Filesystem skill loader (Slice 2) introduced these fields. Records
    // persisted before the loader landed don't carry them — backfill with
    // safe defaults so consumers can rely on `body` being a string.
    skill.body ??= "";
    // Skill records carry an explicit `source` so bundled and user-instance
    // skills with the same name coexist as separate rows. Legacy records
    // default to "user" — bundled records get re-tagged on the next
    // loadSkillsFromDisk pass.
    skill.source ??= "user";
    // ADR connector-provider-spec-compliance.md renamed SkillRecord.requiredIdentities (with `kind` keys) to
    // requiredConnectors (with `provider` keys). Rewrite in-place so the
    // record uses the new vocabulary; the loader will overwrite from disk
    // on the next reload anyway.
    const legacy = skill as unknown as { requiredIdentities?: unknown };
    if (Array.isArray(legacy.requiredIdentities) && !skill.requiredConnectors) {
      skill.requiredConnectors = legacy.requiredIdentities
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const provider = typeof item.kind === "string" ? item.kind : typeof item.provider === "string" ? item.provider : "";
          if (!provider) return null;
          const scopes = Array.isArray(item.scopes) ? item.scopes.map(String) : undefined;
          return scopes ? { provider, scopes } : { provider };
        })
        .filter((entry): entry is { provider: string; scopes?: string[] } => entry !== null);
    }
    delete legacy.requiredIdentities;
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
    job.timeoutSeconds ??= 600;
    job.runIds ??= [];
    // Drop the legacy `intervalSeconds: 0` sentinel on cron-driven jobs.
    // Earlier versions stored 0 on a cron-driven JobRecord so the field
    // stayed a `number`; we made `intervalSeconds` optional and cron jobs
    // now carry no interval at all. Idempotent: a state file already on
    // the new shape (intervalSeconds undefined) passes through untouched,
    // and an interval-driven legacy record with `intervalSeconds: 0` and
    // no cronExpression stays as-is so the next mutate-time guard surfaces
    // the bogus shape (which can't have been produced by current code).
    if (job.cronExpression && job.intervalSeconds === 0) {
      job.intervalSeconds = undefined;
    }
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

// One-shot migration for telegram bridges created before the chat
// allowlist + pairing-code surface landed. Without this, a legacy
// bridge upgrades into `metadata.allowedChatIds === undefined`, the
// poller's `authorizeTelegramChat` denies every inbound, and the
// operator sees total silence on a bridge that previously worked.
// The mint gives them a pairing code they can DM the bot with to
// re-enroll without recreating the bridge.
//
// Lives OUTSIDE normalizeState by design. normalizeState runs on every
// read, including pure inspections like `gini messaging chats`. If the
// backfill ran there, each read would mint a different random code on
// a legacy bridge until something persisted via mutateState — operators
// running pre-runtime CLI inspections could see a code that's never
// actually live. Callers explicitly invoke this from a write path
// (server startup), so the mint happens exactly once and the code is
// durable from the first observation onward.
//
// Idempotent: only fires when the bridge has NO allowlist AND NO
// pairing code at all (active or expired). After one mint the second
// branch sees a present pairingCode and skips.
const LEGACY_PAIRING_CODE_BYTES = 4;
const LEGACY_PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
const LEGACY_PAIRING_CODE_PREFIX = "pair-";
export function applyLegacyTelegramPairingMigration(state: RuntimeState): boolean {
  let migrated = false;
  for (const bridge of state.messagingBridges ?? []) {
    if (bridge.kind !== "telegram") continue;
    const meta = (bridge.metadata ?? {}) as Record<string, unknown>;
    // Treat ANY present allowlist array as "already migrated", even if
    // it's empty. An explicit `allowedChatIds: []` is the operator
    // saying "I disabled every chat on purpose" (via `gini messaging
    // deny` on each one). Reopening the pairing window on such a
    // bridge would surprise the operator and could undo a deliberate
    // lockout. Only a fully-absent `allowedChatIds` indicates the
    // pre-allowlist schema we're migrating from.
    const allowed = meta.allowedChatIds;
    const hasAllowlist = Array.isArray(allowed);
    const hasAnyCode = typeof meta.pairingCode === "string";
    if (hasAllowlist || hasAnyCode) continue;
    // The migration only targets bridges that ACTUALLY polled before
    // the allowlist landed — those have `lastOffset` set on metadata
    // from their pre-allowlist runtime. A bridge with no `lastOffset`
    // is either brand-new (addMessagingBridge already minted a code
    // for it) or one whose code was deliberately cleared by
    // tryClaimPairingCode after a failed/expired claim; in either
    // case minting another code would be surprising. The strict
    // `typeof === "number"` guard also avoids ambiguity from a
    // legacy `0` sentinel or a malformed serialization.
    const lastOffset = meta.lastOffset;
    if (typeof lastOffset !== "number") continue;
    const code = LEGACY_PAIRING_CODE_PREFIX + randomBytes(LEGACY_PAIRING_CODE_BYTES).toString("hex");
    bridge.metadata = {
      ...meta,
      pairingCode: code,
      pairingCodeExpiresAt: new Date(Date.now() + LEGACY_PAIRING_CODE_TTL_MS).toISOString()
    };
    bridge.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "messaging.pairing.migrated",
        target: bridge.id,
        risk: "low",
        evidence: { reason: "legacy-bridge-allowlist-backfill" }
      },
      // Messaging bridge is an instance-shared resource — not bound to any agent.
      { system: true }
    );
    migrated = true;
  }
  return migrated;
}
