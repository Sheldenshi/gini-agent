import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Instance, PairingStatus, RuntimeState } from "../types";
import { ensureDir, instanceRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultProfile, defaultTools, defaultToolsets } from "./defaults";

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
    profiles: [defaultProfile(instance, at)],
    activeProfileId: "profile_default",
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
    "profiles",
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

export function normalizeState(instance: Instance, state: RuntimeState): RuntimeState {
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
  state.profiles ??= [defaultProfile(instance, now())];
  state.activeProfileId ??= state.profiles.find((item) => item.status === "active")?.id ?? state.profiles[0]?.id;
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
