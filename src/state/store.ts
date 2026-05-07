import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Lane, PairingStatus, RuntimeState } from "../types";
import { ensureDir, laneRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultProfile, defaultTools, defaultToolsets } from "./defaults";

export function createEmptyState(lane: Lane): RuntimeState {
  const at = now();
  return {
    version: 1,
    lane,
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
        lane,
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
    tools: defaultTools(lane, at),
    toolsets: defaultToolsets(lane, at),
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    profiles: [defaultProfile(lane, at)],
    activeProfileId: "profile_default",
    relays: [],
    notifications: [],
    events: [],
    jobRuns: [],
    chatSessions: [],
    chatMessages: [],
    messagingMessages: []
  };
}

export function readState(lane: Lane): RuntimeState {
  ensureDir(laneRoot(lane));
  const path = statePath(lane);
  if (!existsSync(path)) {
    const state = createEmptyState(lane);
    writeState(lane, state);
    return state;
  }
  const state = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
  return normalizeState(lane, state);
}

export function writeState(lane: Lane, state: RuntimeState): void {
  ensureDir(laneRoot(lane));
  state.updatedAt = now();
  const path = statePath(lane);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, path);
}

// Per-lane serialization queue. mutateState is async so concurrent callers
// from independent async tasks (HTTP handlers, scheduler ticks, subagents,
// messaging bridges) never interleave their read-modify-write windows on the
// same lane. Single-process per-lane is the deployment model, so an
// in-process promise chain is sufficient — no file lock or semaphore needed.
//
// Reads (readState) stay lock-free because the file is written atomically
// (writeFileSync to .tmp + renameSync) so a reader either sees the prior
// state or the next state, never a torn write.
const laneLocks = new Map<Lane, Promise<unknown>>();

export async function mutateState<T>(lane: Lane, fn: (state: RuntimeState) => T): Promise<T> {
  const previous = laneLocks.get(lane) ?? Promise.resolve();
  const next = previous.then(() => {
    const state = readState(lane);
    const result = fn(state);
    writeState(lane, state);
    return result;
  });
  // Store a chained promise that swallows errors so a failed mutation does
  // not poison the queue for subsequent callers; the original error still
  // propagates to the caller via the returned `next`.
  laneLocks.set(lane, next.catch(() => undefined));
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

export function normalizeState(lane: Lane, state: RuntimeState): RuntimeState {
  state.lane = lane;
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
  state.tools ??= defaultTools(lane, now());
  state.toolsets ??= defaultToolsets(lane, now());
  state.subagents ??= [];
  state.mcpServers ??= [];
  state.messagingBridges ??= [];
  state.messagingMessages ??= [];
  state.importReports ??= [];
  state.profiles ??= [defaultProfile(lane, now())];
  state.activeProfileId ??= state.profiles.find((item) => item.status === "active")?.id ?? state.profiles[0]?.id;
  state.relays ??= [];
  state.notifications ??= [];
  state.events ??= [];
  state.jobRuns ??= [];
  state.chatSessions ??= [];
  state.chatMessages ??= [];
  for (const skill of state.skills) {
    skill.tests ??= [];
    skill.successCount ??= 0;
    skill.failureCount ??= 0;
    skill.previousVersions ??= [];
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
