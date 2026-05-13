import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Instance, PairingStatus, ProviderConfig, RuntimeConfig, RuntimeState } from "../types";
import { ensureDir, instanceRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultAgent, defaultTools, defaultToolsets } from "./defaults";

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
        id: "conn_demo",
        instance,
        name: "Demo Connector",
        kind: "demo",
        status: "configured",
        scopes: ["demo:read"],
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

export function normalizeState(instance: Instance, state: RuntimeState): RuntimeState {
  migrateProfileFieldsToAgent(state);
  migrateLaneFieldToInstance(state);
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
  state.subagents ??= [];
  state.mcpServers ??= [];
  state.messagingBridges ??= [];
  state.messagingMessages ??= [];
  state.importReports ??= [];
  state.agents ??= [defaultAgent(instance, now())];
  state.activeAgentId ??= state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
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
  expirePairingCodes(state);
  return state;
}
