import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { snapshotsDir } from "../paths";
import { providerHealth } from "../provider";
import { addAudit, createSnapshotRecord, mutateState, readState, readTrace, writeState } from "../state";
import { status } from "./index";

export function createEvidenceBundle(config: RuntimeConfig) {
  const state = readState(config.instance);
  const taskIds = state.tasks.map((task) => task.id);
  const traces = Object.fromEntries(taskIds.map((taskId) => [taskId, readTrace(config.instance, taskId)]));
  const bundle = {
    createdAt: new Date().toISOString(),
    instance: config.instance,
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
  mkdirSync(snapshotsDir(config.instance), { recursive: true });
  let snapshotPath = "";
  const record = await mutateState(config.instance, (state) => {
    snapshotPath = join(snapshotsDir(config.instance), `snapshot-${Date.now()}.json`);
    return createSnapshotRecord(state, { path: snapshotPath, reason });
  });
  const state = readState(config.instance);
  writeFileSync(snapshotPath, `${JSON.stringify({ createdAt: new Date().toISOString(), instance: config.instance, reason, state }, null, 2)}\n`);
  return { ok: true, snapshotId: record.id, path: snapshotPath, reason };
}

export async function restoreSnapshot(config: RuntimeConfig, snapshotId: string) {
  const current = readState(config.instance);
  const record = current.snapshots.find((item) => item.id === snapshotId);
  if (!record) throw new Error(`Snapshot not found: ${snapshotId}`);
  if (!existsSync(record.path)) throw new Error(`Snapshot file missing: ${record.path}`);
  const parsed = JSON.parse(readFileSync(record.path, "utf8")) as { instance: string; state: ReturnType<typeof readState> };
  if (parsed.instance !== config.instance || parsed.state.instance !== config.instance) {
    throw new Error(`Snapshot instance mismatch: expected ${config.instance}`);
  }
  writeState(config.instance, parsed.state);
  await mutateState(config.instance, (state) => {
    // Snapshot restore rewrites the entire instance — it predates and
    // overwrites every agent's view, so it cannot belong to one.
    addAudit(
      state,
      {
        actor: "user",
        action: "snapshot.restored",
        target: snapshotId,
        risk: "high",
        evidence: { path: record.path }
      },
      { system: true }
    );
  });
  return { ok: true, restored: snapshotId, instance: config.instance };
}
