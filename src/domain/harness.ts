import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { snapshotsDir } from "../paths";
import { providerHealth } from "../provider";
import { addAudit, createSnapshotRecord, mutateState, readState, readTrace, writeState } from "../state";
import { status } from "./runtime";

export function createEvidenceBundle(config: RuntimeConfig) {
  const state = readState(config.lane);
  const taskIds = state.tasks.map((task) => task.id);
  const traces = Object.fromEntries(taskIds.map((taskId) => [taskId, readTrace(config.lane, taskId)]));
  const bundle = {
    createdAt: new Date().toISOString(),
    lane: config.lane,
    config: {
      port: config.port,
      stateRoot: config.stateRoot,
      logRoot: config.logRoot,
      workspaceRoot: config.workspaceRoot,
      provider: providerHealth(config)
    },
    status: status(config),
    state,
    traces
  };
  const outDir = join(config.stateRoot, "evidence");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `bundle-${Date.now()}.json`);
  writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return { ok: true, path: outPath, taskCount: taskIds.length, auditEvents: state.audit.length, improvements: state.improvements.length };
}

export async function createSnapshot(config: RuntimeConfig, reason: string) {
  mkdirSync(snapshotsDir(config.lane), { recursive: true });
  let snapshotPath = "";
  const record = await mutateState(config.lane, (state) => {
    snapshotPath = join(snapshotsDir(config.lane), `snapshot-${Date.now()}.json`);
    return createSnapshotRecord(state, { path: snapshotPath, reason });
  });
  const state = readState(config.lane);
  writeFileSync(snapshotPath, `${JSON.stringify({ createdAt: new Date().toISOString(), lane: config.lane, reason, state }, null, 2)}\n`);
  return { ok: true, snapshotId: record.id, path: snapshotPath, reason };
}

export async function restoreSnapshot(config: RuntimeConfig, snapshotId: string) {
  const current = readState(config.lane);
  const record = current.snapshots.find((item) => item.id === snapshotId);
  if (!record) throw new Error(`Snapshot not found: ${snapshotId}`);
  if (!existsSync(record.path)) throw new Error(`Snapshot file missing: ${record.path}`);
  const parsed = JSON.parse(readFileSync(record.path, "utf8")) as { lane: string; state: ReturnType<typeof readState> };
  if (parsed.lane !== config.lane || parsed.state.lane !== config.lane) {
    throw new Error(`Snapshot lane mismatch: expected ${config.lane}`);
  }
  writeState(config.lane, parsed.state);
  await mutateState(config.lane, (state) => {
    addAudit(state, {
      actor: "user",
      action: "snapshot.restored",
      target: snapshotId,
      risk: "high",
      evidence: { path: record.path }
    });
  });
  return { ok: true, restored: snapshotId, lane: config.lane };
}
