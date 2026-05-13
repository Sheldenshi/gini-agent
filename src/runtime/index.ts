import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Instance, RuntimeConfig } from "../types";
import { configPath, ensureDir, instanceRoot, instancesRoot } from "../paths";
import { readState, taskCounts } from "../state";
import { closeMemoryDb, getMemoryDb, memoryDbPath } from "../state/memory-db";
import { providerHealth } from "../provider";

export function status(config: RuntimeConfig) {
  const state = readState(config.instance);
  const missedJobs = state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() + job.intervalSeconds * 1000 < Date.now()).length;
  // Memory DB probe is best-effort: a fresh instance will have 0 units. We don't
  // open the DB here unless one already exists on disk to avoid creating an
  // empty memory.db side-effect from a read-only status call.
  const memoryUnits = countMemoryUnitsIfPresent(config);
  return {
    ok: true,
    instance: config.instance,
    port: config.port,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    pid: process.pid,
    taskCounts: taskCounts(state.tasks),
    pendingApprovals: state.approvals.filter((approval) => approval.status === "pending").length,
    activeJobs: state.jobs.filter((job) => job.status === "active").length,
    missedJobs,
    identities: state.identities.length,
    memoryUnits,
    provider: providerHealth(config)
  };
}

function countMemoryUnitsIfPresent(config: RuntimeConfig): number {
  // Skip the open if no DB exists yet — a fresh instance reports 0 units without
  // creating an empty memory.db as a side effect of a read-only status call.
  // Returning 0 on any error keeps `gini status` resilient; doctor surfaces
  // deeper diagnostics via probeMemoryDb.
  try {
    if (!existsSync(memoryDbPath(config.instance))) return 0;
    const db = getMemoryDb(config.instance);
    const row = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units")
      .get();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function install(config: RuntimeConfig): void {
  // After resetInstance removes the instance root, the directory is gone. Ensure it
  // before writing the config so reinstall is a clean idempotent operation.
  ensureDir(instanceRoot(config.instance));
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  readState(config.instance);
}

export function resetInstance(config: RuntimeConfig): void {
  // Close the cached memory DB handle (if any) before removing the state
  // root so we release the WAL/SHM file descriptors. Without this, the
  // physical files would still be unlinked but a subsequent getMemoryDb()
  // could hand back the closed handle from the cache.
  closeMemoryDb(config.instance);
  rmSync(config.stateRoot, { recursive: true, force: true });
  install(config);
}

export function uninstallInstance(config: RuntimeConfig): void {
  closeMemoryDb(config.instance);
  rmSync(config.stateRoot, { recursive: true, force: true });
  rmSync(config.logRoot, { recursive: true, force: true });
}

export interface UninstallAllOptions {
  deleteInstances: boolean;
  // Caller-injected stop. Runtime can't import from src/cli/process.ts without
  // creating a layering loop, so the CLI hands us a closure that wraps
  // stopRuntime(loadConfig(name)). Best-effort: any thrown error is swallowed
  // so one stuck instance doesn't block the rest of the uninstall.
  stopInstance?: (instance: Instance) => Promise<void> | void;
}

export interface UninstallAllResult {
  instances: Instance[];
  stopped: Instance[];
  stopErrors: Array<{ instance: Instance; error: string }>;
  deletedInstances: boolean;
}

export async function uninstallAll(options: UninstallAllOptions): Promise<UninstallAllResult> {
  const root = instancesRoot();
  const instances: Instance[] = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const stopped: Instance[] = [];
  const stopErrors: Array<{ instance: Instance; error: string }> = [];
  for (const name of instances) {
    if (!options.stopInstance) break;
    try {
      await options.stopInstance(name);
      stopped.push(name);
    } catch (error) {
      stopErrors.push({ instance: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (options.deleteInstances) {
    for (const name of instances) closeMemoryDb(name);
    rmSync(root, { recursive: true, force: true });
  }
  return { instances, stopped, stopErrors, deletedInstances: options.deleteInstances };
}

// Updates the auto-approve command allowlist on the live config object
// (mutated in place so the HTTP handler closure picks it up immediately)
// and persists the new list to disk so it survives restarts. Patterns
// are filtered through trim() to drop accidental whitespace and empties
// from the UI text input. Returns the updated list so callers can
// confirm the new state.
export function updateAutoApproveCommands(config: RuntimeConfig, patterns: string[]): string[] {
  const cleaned = patterns.map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p.length > 0);
  config.autoApproveCommands = cleaned;
  ensureDir(instanceRoot(config.instance));
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  return cleaned;
}
