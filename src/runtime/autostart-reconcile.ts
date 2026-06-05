// Startup reconcile of installed launchd plists against the current
// supervision template.
//
// Why this exists: the ONLY thing that used to regenerate an installed plist
// was the provider-setup refresh flow. A runtime version update never
// regenerated them — so a supervision-template change (a new env marker, a
// KeepAlive shape switch, a watchdog addition, a bun-path move) shipped in
// fresh installs but left existing installs running a STALE plist. A stale
// plist whose env is missing the supervisor marker drives the gateway down
// the foreground auto-update path while launchd's own KeepAlive respawns it,
// which collides on the port (EADDRINUSE) in a crash loop.
//
// This module closes that gap generically. At gateway startup, for a
// launchd-managed instance, it fingerprints the plist the current code WOULD
// generate (computePlistStamp over the stable supervision subset) and
// compares it to the stamp baked into the on-disk plist (readPlistStamp). If
// they all match it returns immediately — the fast, silent common path. On
// drift it spawns a DETACHED `gini autostart enable`, which regenerates the
// plist files AND reloads them (bootout+bootstrap): the bootout terminates
// THIS gateway and re-bootstraps it from the regenerated plist. We deliberately
// do NOT self-SIGTERM or exit — under always-respawn KeepAlive a clean exit
// would be re-spawned by launchd and race the detached enable; letting the
// child's bootout kill us avoids that race entirely.
//
// We also deliberately do NOT pre-write the plist files here. Writing disk
// alone doesn't reload launchd — it keeps running the def it loaded until a
// bootout+bootstrap — and stamping the file BEFORE the reload actually happens
// would mask drift: the next boot's stamp check would match and never retry,
// even though the stale def is still loaded (e.g. if the detached enable
// failed to spawn or to bootout). Leaving the on-disk plist untouched means a
// failed relaunch keeps the stamp mismatched, so the reconcile re-fires on the
// next gateway (re)start until the reload truly succeeds.
//
// See ADR always-up-supervision.md.

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  plistPathFor,
  platformIsSupported,
  supervisedServices,
  stampForGeneratedPlist,
  readPlistStamp,
  type PlistKind,
  type SupervisedService
} from "../cli/autostart";
import { logDir, projectRoot } from "../paths";
import { appendLog } from "../state";
import type { RuntimeConfig } from "../types";

// Once-per-process guard. The deterministic stamp already guarantees
// convergence (after a reconcile the on-disk plist == what the code
// generates, so the next boot no-ops), but a per-process latch makes it
// impossible to fire twice within a single gateway lifetime regardless.
let reconcileFiredThisProcess = false;

// Test seam: reset the latch between cases. Not part of the public API.
function resetGuard(): void {
  reconcileFiredThisProcess = false;
}

export interface ReconcileOptions {
  // Test seam: inject a spawn recorder instead of the real
  // child_process.spawn so unit tests can assert the detached relaunch
  // without launching anything. Production callers omit it.
  spawnImpl?: typeof spawn;
}

// Reconcile this instance's installed launchd plists to the current
// supervision template. Never throws (the boot path must stay never-crash);
// returns whether a drift relaunch was dispatched (mostly for tests).
export async function reconcileAutostartPlistOnStartup(
  config: RuntimeConfig,
  options: ReconcileOptions = {}
): Promise<boolean> {
  try {
    return reconcileInner(config, options);
  } catch (error) {
    // Boot must never crash on a reconcile fault. Record and move on; the
    // worst case is the same stale plist we started with, healed next boot.
    try {
      appendLog(config.instance, "autostart.reconcile.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      /* swallow — logging must not crash boot either */
    }
    return false;
  }
}

function reconcileInner(config: RuntimeConfig, options: ReconcileOptions): boolean {
  // macOS only — launchd is the only supervisor we manage plists for.
  if (!platformIsSupported()) return false;
  if (reconcileFiredThisProcess) return false;

  const instance = config.instance;
  // No managed plist on disk → not a launchd-supervised install (foreground /
  // `gini run` / conductor instances have no plist). Skip. We gate on the
  // gateway plist's EXISTENCE, not on supervisor()/GINI_SUPERVISOR — that env
  // marker is exactly what is MISSING in the stale case we must heal.
  if (!existsSync(plistPathFor(instance, "gateway"))) return false;

  // Resolve the current supervision specs WITHOUT spawning the login shell
  // (mergeShellPath defaults to false). PATH is excluded from the stamp, so
  // the merge/no-merge difference can't affect the comparison — and skipping
  // the shell keeps the boot path fast and side-effect free.
  const services = supervisedServices({ instance });

  // Compare each kind's current stamp to the on-disk stamp. Any missing or
  // mismatched stamp is drift (a missing stamp means a pre-stamp plist).
  const drifted: PlistKind[] = [];
  for (const svc of services) {
    const current = stampForServiceStamp(instance, svc);
    const onDisk = readPlistStamp(svc.plistPath);
    if (onDisk === null || onDisk !== current) drifted.push(svc.kind);
  }

  // All stamps present and equal → up to date. Fast, silent common path.
  if (drifted.length === 0) return false;

  // Latch BEFORE acting so a re-entrant call can't double-fire.
  reconcileFiredThisProcess = true;

  // Spawn a DETACHED `gini autostart enable` for ALL kinds and let IT own the
  // regenerate + reload. Its bootout terminates THIS gateway and re-bootstraps
  // it from the regenerated plist (the port-free wait inside enable keeps the
  // handoff from double-binding). We never self-SIGTERM or exit — letting the
  // child's bootout kill us sidesteps the always-respawn KeepAlive race. We do
  // not touch the on-disk plist here (see the module header): a failed relaunch
  // must keep the stamp mismatched so the next gateway start retries.
  const dispatched = spawnDetachedEnable(instance, options.spawnImpl);

  try {
    appendLog(instance, "autostart.reconcile.drift", {
      kinds: drifted,
      dispatched
    });
  } catch {
    /* observability is best-effort; never crash boot over a log write */
  }

  return dispatched;
}

// Compute the stamp for a resolved service descriptor, mirroring exactly what
// generatePlist bakes in (via the shared stampForGeneratedPlist).
function stampForServiceStamp(instance: string, svc: SupervisedService): string {
  return stampForGeneratedPlist({
    instance,
    kind: svc.kind,
    spec: svc.spec,
    ...(svc.startIntervalSeconds !== undefined ? { startIntervalSeconds: svc.startIntervalSeconds } : {})
  });
}

// Spawn the detached `gini autostart enable --instance <instance>` (all
// kinds). Mirrors the spawn hygiene in autostart-refresh.consumeAutostartRefresh:
// FD-routed stdio into a per-instance log with a one-line preamble, detached +
// unref'd so it outlives this gateway (whose bootout the child will perform).
function spawnDetachedEnable(instance: string, spawnImpl?: typeof spawn): boolean {
  const logFile = reconcileLogPath(instance);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch {
    /* best-effort: the spawn below still tries; a failed FD open falls back */
  }

  const timestamp = new Date().toISOString();
  try {
    appendFileSync(
      logFile,
      `[${timestamp}] reconcile: spawning \`gini autostart enable --instance ${instance}\` cwd=${projectRoot()}\n`
    );
  } catch {
    /* preamble is nice-to-have; don't fail the spawn over it */
  }

  let outFd: number | null = null;
  let errFd: number | null = null;
  try {
    outFd = openSync(logFile, "a");
    errFd = openSync(logFile, "a");
  } catch (error) {
    try {
      appendFileSync(
        logFile,
        `[${timestamp}] reconcile: failed to open log FDs: ${error instanceof Error ? error.message : String(error)}\n`
      );
    } catch {
      /* swallowed */
    }
  }

  const spawnFn = spawnImpl ?? spawn;
  try {
    const child = spawnFn(process.execPath, [
      "run", "gini", "autostart", "enable",
      "--instance", instance
    ], {
      cwd: projectRoot(),
      detached: true,
      stdio: outFd !== null && errFd !== null ? ["ignore", outFd, errFd] : "ignore",
      env: { ...process.env, GINI_INSTANCE: instance }
    });
    if (typeof child.unref === "function") child.unref();
  } catch (error) {
    try {
      appendFileSync(
        logFile,
        `[${timestamp}] reconcile: spawn failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    } catch {
      /* swallowed */
    }
    return false;
  } finally {
    if (outFd !== null) {
      try { closeSync(outFd); } catch { /* ignore */ }
    }
    if (errFd !== null) {
      try { closeSync(errFd); } catch { /* ignore */ }
    }
  }
  return true;
}

// Per-instance log file for the reconcile relaunch subprocess output. Lives
// alongside the runtime's other logs, matching autostart-refresh's convention.
export function reconcileLogPath(instance: string): string {
  return join(logDir(instance), "autostart-reconcile.log");
}

// Exposed for tests that need to reset the once-per-process latch between cases.
export const __testing = { resetGuard };
