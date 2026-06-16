import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ApprovalMode, Instance, RuntimeConfig } from "../types";
import { configPath, ensureDir, hasPreFlipMigrationMarker, instanceRoot, instancesRoot, writeRuntimeConfig } from "../paths";
import { mutateState, readState, seedDefaultAgentFromRuntimeConfig, taskCounts } from "../state";
import { addAudit } from "../state/audit";
import { appendLog } from "../state/trace";
import { resolveEffectiveContext } from "../execution/effective-context";
import { closeMemoryDb, getMemoryDb, memoryDbPath } from "../state/memory-db";
import { migratePinnedMemoriesToUserProfile } from "../memory/migrate-pinned-to-user-md";
import { providerHealth } from "../provider";
import { migrateInstructionsIdentityLine, reseedDefaultInstructions, seedAgentSoulFile, scaffoldInstanceIdentityFiles } from "./identity-files";
import { currentVersionInfo } from "./update";

export function status(config: RuntimeConfig) {
  const state = readState(config.instance);
  // A job is "missed" when it's active AND its nextRunAt is far enough in
  // the past that the scheduler should have already fired it. For
  // interval-driven jobs that's `nextRunAt + intervalSeconds` (one full
  // cadence overdue); for cron-driven jobs there's no fixed step, so we
  // fall back to "nextRunAt is in the past" as a coarse approximation —
  // a precise cron-aware comparison would require calling croner here
  // and isn't worth the cycles for a status counter.
  const missedJobs = state.jobs.filter((job) => {
    if (job.status !== "active") return false;
    const dueAt = new Date(job.nextRunAt).getTime();
    if (job.intervalSeconds !== undefined) {
      return dueAt + job.intervalSeconds * 1000 < Date.now();
    }
    // Cron-driven (or hand-edited shape with no schedule): treat any
    // overdue nextRunAt as missed.
    return dueAt < Date.now();
  }).length;
  // Memory DB probe is best-effort: a fresh instance will have 0 units. We don't
  // open the DB here unless one already exists on disk to avoid creating an
  // empty memory.db side-effect from a read-only status call.
  const memoryUnits = countMemoryUnitsIfPresent(config);
  // Surface the active-agent overrides so clients (Settings page, mobile
  // app) can render the resolved provider and any warnings without
  // re-deriving the intersection logic. Omitted when no active agent.
  const effective = resolveEffectiveContext(state, config);
  const activeAgent = effective.agentId
    ? {
        id: effective.agentId,
        name: state.agents.find((a) => a.id === effective.agentId)?.name ?? effective.agentId,
        resolvedProvider: { name: effective.provider.name, model: effective.provider.model },
        providerSource: effective.providerSource,
        toolsetFilter: effective.toolsetFilter ? Array.from(effective.toolsetFilter) : undefined,
        messagingTargetFilter: effective.messagingTargetFilter ? Array.from(effective.messagingTargetFilter) : undefined,
        memoryNamespace: effective.memoryNamespace ?? effective.agentId,
        warnings: effective.warnings
      }
    : undefined;
  return {
    ok: true,
    instance: config.instance,
    port: config.port,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    pid: process.pid,
    taskCounts: taskCounts(state.tasks),
    pendingApprovals:
      state.authorizations.filter((row) => row.status === "pending").length +
      state.setupRequests.filter((row) => row.status === "pending").length,
    activeJobs: state.jobs.filter((job) => job.status === "active").length,
    missedJobs,
    connectors: state.connectors.length,
    memoryUnits,
    version: currentVersionInfo(),
    provider: providerHealth(config),
    // Surfaced for the web fallback banner: set when the selected provider is
    // unconfigured but a configured fallback is transiently serving turns
    // (computed per turn in resolveEffectiveContext; config.provider is never
    // mutated). Omitted when the selected provider dispatches directly.
    ...(effective.providerFallback ? { providerFallback: effective.providerFallback } : {}),
    activeAgent
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

export async function install(config: RuntimeConfig): Promise<void> {
  // After resetInstance removes the instance root, the directory is gone. Ensure it
  // before writing the config so reinstall is a clean idempotent operation.
  ensureDir(instanceRoot(config.instance));
  // Scaffold the two instance-scoped identity files (INSTRUCTIONS.md and
  // USER.md) as zero-byte placeholders. The loaders treat an empty file as
  // absent and fall back to defaults, so this purely surfaces the files in
  // the filesystem for the user to discover. Best-effort: scaffolding never
  // throws on a filesystem error.
  scaffoldInstanceIdentityFiles(config.instance);
  // Existing instances seeded INSTRUCTIONS.md before the preamble went
  // name-free; that on-disk file overrides the bundled default, so rewrite
  // a stale leading "You are Gini, a personal agent." (or the interim
  // framework wording) to the current generic line. The agent's name now
  // lives in its SOUL.md. Idempotent + best-effort.
  migrateInstructionsIdentityLine(config.instance);
  // The seeded INSTRUCTIONS.md shadows the bundled default forever, so an
  // instance created before a defaults change never picks it up on its own.
  // When the on-disk file byte-matches a previously shipped default (incl.
  // the post-identity-line-migration variant of one), replace it with the
  // current bundled default. A user-edited file never hash-matches and is
  // never touched. Idempotent + best-effort.
  reseedDefaultInstructions(config.instance);
  // Approval-mode migration: legacy configs that carry
  // `dangerouslyAutoApprove: true` without an explicit `approvalMode`
  // get aliased to `approvalMode: "yolo"`. Patch the in-memory config
  // BEFORE the initial write so the on-disk shape reflects the upgrade
  // in a single write. The audit row is async / best-effort.
  if (config.approvalMode === undefined && config.dangerouslyAutoApprove === true) {
    config.approvalMode = "yolo";
  }
  // Pre-flip migration: `loadConfig` already stamped the merged
  // default `approvalMode: "auto"` and set a transient marker on
  // the config. The async audit emit below records the one-time
  // `config.migrated` event so the trail captures the silent
  // behavior change from "gate everything" to "auto-approve safe
  // actions" for this instance.
  writeRuntimeConfig(config);
  // One-shot migration: drain `state.memories` (legacy pinned memories) into
  // the instance-scoped USER.md and clear the array. Idempotent via a state
  // marker; best-effort — a failure audits via appendLog and lets the runtime
  // continue. Must run AFTER scaffoldInstanceIdentityFiles (so USER.md is
  // materialized) and BEFORE the SOUL.md backfill loop below — the
  // `normalizeState` path on the next readState consults the marker and
  // strips the dead `state.memories` field, and the SOUL.md backfill should
  // see the post-migration shape rather than racing the file write.
  // See ADR runtime-identity-files.md.
  const migrationReport = await migratePinnedMemoriesToUserProfile(config);
  if (migrationReport.error) {
    try {
      appendLog(config.instance, "memory.pinned.migration.error", {
        error: migrationReport.error
      });
    } catch {
      // Logging itself failing must not crash startup.
    }
  }
  const state = readState(config.instance);
  // Backfill per-agent SOUL.md for every existing agent: any agent whose
  // SOUL is absent or empty/whitespace-only (incl. the legacy zero-byte
  // scaffold) gets seeded `Your name is <name>.` from its AgentRecord.name.
  // `readState` above already ran `normalizeState`, so the default agent is
  // "Gini" by this point. A populated SOUL is never clobbered, so this is
  // idempotent and quiet on no-ops.
  for (const agent of state.agents) {
    seedAgentSoulFile(config.instance, agent.id, agent.name);
  }
  // Audit + side-effects of the migration. Fire-and-forget; the
  // synchronous patch above is what the policy seam actually consults.
  void migrateLegacyApprovalMode(config);
  // Seed the default agent's provider fields from the freshly-written
  // config so `gini run --provider X` (or any CLI install) propagates
  // to the active agent. Fire-and-forget: the mutateState write either
  // settles before any chat task picks it up (typical) or the next
  // resolveEffectiveContext call sees the unseeded agent and falls
  // back to config.provider — both are safe.
  void seedDefaultAgentFromRuntimeConfig(config);
}

export async function resetInstance(config: RuntimeConfig): Promise<void> {
  // Close the cached memory DB handle (if any) before removing the state
  // root so we release the WAL/SHM file descriptors. Without this, the
  // physical files would still be unlinked but a subsequent getMemoryDb()
  // could hand back the closed handle from the cache.
  closeMemoryDb(config.instance);
  rmSync(config.stateRoot, { recursive: true, force: true });
  await install(config);
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

// Update the auto-approve settings on the live config object and
// persist to disk in one write. Any subset of fields can be supplied;
// omitted keys are left alone. Returns the merged effective values so
// callers can confirm. Patterns are filtered through trim() to drop
// accidental whitespace and empties from the UI text input.
//
// `dangerouslyAutoApprove` is accepted as a deprecated alias for
// `approvalMode: "yolo"`. When both are supplied in the same PATCH,
// `approvalMode` is authoritative — the legacy flag is interpreted
// only if `approvalMode` is undefined in the payload.
export function updateAutoApproveSettings(
  config: RuntimeConfig,
  input: {
    patterns?: string[];
    dangerouslyAutoApprove?: boolean;
    approvalMode?: ApprovalMode;
    dangerousTerminalPatterns?: string[];
  }
): {
  patterns: string[];
  dangerouslyAutoApprove: boolean;
  approvalMode: ApprovalMode;
  dangerousTerminalPatterns: string[];
} {
  if (input.patterns !== undefined) {
    const cleaned = input.patterns.map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p.length > 0);
    config.autoApproveCommands = cleaned;
  }
  if (input.approvalMode !== undefined) {
    config.approvalMode = input.approvalMode;
    // Do NOT mirror to `dangerouslyAutoApprove`. The legacy flag is
    // the load-time alias source only; writing it back here would
    // make a fresh PATCH `approvalMode: "yolo"` look like a legacy
    // on-disk config to the migration shim on the next restart and
    // emit a spurious `config.migrated` audit row. Clear any
    // pre-existing legacy field so future restarts also stay clean.
    delete config.dangerouslyAutoApprove;
  } else if (input.dangerouslyAutoApprove !== undefined) {
    // Legacy alias path: PATCH with only the deprecated flag set.
    // Resolves to approvalMode "yolo" or "auto" (the new default).
    // The flag itself is intentionally NOT persisted on this path
    // either — `approvalMode` is the authoritative field going
    // forward.
    config.approvalMode = input.dangerouslyAutoApprove ? "yolo" : "auto";
    delete config.dangerouslyAutoApprove;
  }
  if (input.dangerousTerminalPatterns !== undefined) {
    // Trim before persisting so a padded entry like " docker run " is
    // stored as "docker run". The matcher uses substring semantics —
    // a padded entry would never match a real command (which doesn't
    // include the surrounding whitespace), silently disabling the
    // rule the operator thought they added.
    const cleaned = input.dangerousTerminalPatterns
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0);
    config.dangerousTerminalPatterns = cleaned;
  }
  ensureDir(instanceRoot(config.instance));
  // Safety net: settings PATCH can land on an instance whose identity
  // files were never scaffolded (e.g. an instance bootstrapped on a build
  // that pre-dated the scaffold logic). Idempotent — does nothing if the
  // files already exist.
  scaffoldInstanceIdentityFiles(config.instance);
  writeRuntimeConfig(config);
  const effectiveMode: ApprovalMode = config.approvalMode ?? (config.dangerouslyAutoApprove ? "yolo" : "auto");
  return {
    patterns: config.autoApproveCommands ?? [],
    dangerouslyAutoApprove: effectiveMode === "yolo",
    approvalMode: effectiveMode,
    dangerousTerminalPatterns: config.dangerousTerminalPatterns ?? []
  };
}

// Back-compat shim: kept for callers that only want to mutate the
// allowlist. Delegates to updateAutoApproveSettings so persistence
// stays single-sourced.
export function updateAutoApproveCommands(config: RuntimeConfig, patterns: string[]): string[] {
  return updateAutoApproveSettings(config, { patterns }).patterns;
}

// Back-compat shim for the legacy flag.
export function updateDangerouslyAutoApprove(config: RuntimeConfig, enabled: boolean): boolean {
  return updateAutoApproveSettings(config, { dangerouslyAutoApprove: enabled }).dangerouslyAutoApprove;
}

// Load-time migration shim for approval-mode. Covers two cases:
//
//   1. Legacy `dangerouslyAutoApprove: true` config: aliased
//      synchronously by `install` to `approvalMode: "yolo"`. The
//      audit row records `from: "dangerouslyAutoApprove: true",
//      to: "yolo"`.
//   2. Pre-flip existing instance: on-disk config carried neither
//      `approvalMode` nor `dangerouslyAutoApprove`. The merged
//      default in `loadConfig` stamps `approvalMode: "auto"`, which
//      silently changes that instance's effective behavior from
//      "gate everything" to "auto-approve safe actions". The audit
//      row records `from: "no-approval-mode", to: "auto"` so the
//      trail captures the change. Detected via the transient
//      `PRE_FLIP_MIGRATION_MARKER` symbol stamped by `loadConfig`.
//
// A genuinely fresh install (no prior `config.json`) emits no audit
// row in either branch — there's no behavior to migrate from.
//
// Idempotent — the audit row is only written once per instance.
// Failures are swallowed (startup shouldn't crash because of audit
// persistence), but the in-memory config is already patched
// synchronously by `install` so the policy seam sees a coherent mode
// regardless.
export async function migrateLegacyApprovalMode(config: RuntimeConfig): Promise<void> {
  const legacyYolo =
    config.approvalMode === "yolo" && config.dangerouslyAutoApprove === true;
  const preFlipAuto =
    hasPreFlipMigrationMarker(config) && config.approvalMode === "auto";
  if (!legacyYolo && !preFlipAuto) return;
  const from = legacyYolo ? "dangerouslyAutoApprove: true" : "no-approval-mode";
  const to = legacyYolo ? "yolo" : "auto";
  try {
    await mutateState(config.instance, (state) => {
      // De-dupe: if a `config.migrated` audit already exists for this
      // instance + approvalMode field, skip. Idempotent across restarts.
      const already = state.audit.find(
        (event) =>
          event.action === "config.migrated" &&
          event.target === config.instance &&
          (event.evidence?.field === "approvalMode")
      );
      if (already) return;
      addAudit(
        state,
        {
          actor: "runtime",
          action: "config.migrated",
          target: config.instance,
          risk: "low",
          evidence: {
            field: "approvalMode",
            from,
            to
          }
        },
        // Instance-level config migration — not bound to any one agent.
        { system: true }
      );
    });
  } catch {
    // Best-effort posture — startup must not fail on audit
    // persistence.
  }
}
