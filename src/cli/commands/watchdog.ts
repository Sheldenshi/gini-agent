// `gini watchdog --instance <name>` — the supervision safety net. A
// long-lived probe LOOP under a launchd KeepAlive job (see
// src/cli/autostart.ts watchdog plist); `--once` runs a single tick for
// manual/diagnostic use.
//
// It used to be a StartInterval one-shot (launchd respawned it every 30s).
// That made the safety net subject to the exact failure it guards against:
// on macOS 26 launchd defers pended spawns, so during a gateway
// respawn-deferral window the watchdog's own ticks were deferred alongside it
// (observed tick gaps of 50-99s against the 30s interval, while the gateway
// sat dead). A long-lived loop only asks launchd to spawn once —
// the steady-state cadence is our own timer, immune to spawn deferral.
//
// Each tick:
//   1. Probe the gateway runtime at /api/status (any HTTP response means the
//      runtime is alive — /api/status returns 401 without auth, which still
//      proves the process is up and answering).
//   2. Probe the web (Next.js) child at /api/runtime/__healthz via
//      isSupervisedWebChild (verifies service:"gini-web" + matching instance,
//      so we don't mistake some other local process on the port for ours).
//   3. If the runtime is dead/hung -> `launchctl kickstart -k` the gateway.
//      KeepAlive should respawn it, but on macOS 26 launchd frequently defers
//      the auto-respawn indefinitely; the explicit kickstart forces it.
//   4. If web is dead/hung -> capture the web log tails, build + write a
//      redacted crash report into the pending/ queue, THEN kickstart -k the web
//      service. The report is offered to the user on the next restart and filed
//      only on consent — the watchdog never files anything itself.
//
// A tick never throws and the loop never exits on its own; exitCode stays 0 so
// a `--once` run (or a killed loop) reads as a clean probe to launchd. Every
// external dependency (fetch, the launchctl kickstart runner, the clock, the
// inter-tick sleep) is injectable so tests never bind real ports, call real
// launchctl, or sleep real time.

import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../context";
import { hasFlag } from "../args";
import { logDir, runtimePortPath, webPortPath } from "../../paths";
import { isLoaded, kickstart, supervisor, type LaunchctlResult, type PlistKind } from "../../integrations/launchd";
import { isSupervisedWebChild } from "../../runtime/health-probe";
import { enable } from "./autostart";
import { secretsEnvPath } from "../../state/secrets-env";
import { appendLog } from "../../state/trace";
import {
  buildCrashReport,
  writeCrashReportFile,
  type RuntimeLogLine
} from "../../runtime/crash-report";

// Per-probe network timeout. A hung gateway/web that accepts the connection
// but never responds must not stall the whole tick — 2s is generous for a
// localhost health endpoint while keeping the watchdog snappy.
const PROBE_TIMEOUT_MS = 2000;
// Steady-state pause between probe ticks. 10s bounds dead-gateway detection
// latency (tick + 2s probe timeout keeps revival well under 30s) without
// spinning the CPU on localhost probes.
export const WATCHDOG_TICK_INTERVAL_MS = 10_000;
// How many trailing lines of each web log to carry into the crash report.
// Bounded so a long log doesn't bloat the report.
const WEB_LOG_TAIL_LINES = 50;

export interface WatchdogDeps {
  // Probe the runtime at the given port. Resolves true when ANY HTTP response
  // comes back (alive), false on connection refused / timeout (dead/hung).
  // Defaults to a localhost fetch of /api/status.
  probeRuntime?: (port: number) => Promise<boolean>;
  // Probe the supervised web child. Defaults to isSupervisedWebChild.
  probeWeb?: (instance: string, port: number) => Promise<boolean>;
  // Force a launchctl `kickstart -k` of the given service kind. Defaults to
  // the real kickstart shellout.
  kickstartImpl?: (instance: string, kind: PlistKind) => LaunchctlResult;
  // Report whether launchd still has the service registered. Defaults to
  // isLoaded. When false, the service is deregistered and kickstart can't
  // revive it — we re-bootstrap instead.
  isLoadedImpl?: (instance: string, kind: PlistKind) => boolean;
  // Re-bootstrap (re-enable) a deregistered service. Defaults to a wrapper
  // around `autostart enable`. Resolves true when the re-enable succeeded.
  reenableImpl?: (instance: string, kind: PlistKind) => Promise<boolean>;
  // Report whether we're under launchd. Defaults to supervisor(). Stamped onto
  // the queued report so the restart-ask can gate on supervision later.
  supervisorImpl?: () => "launchd" | null;
  clock?: () => Date;
  // Loop controls. `maxTicks` bounds the loop for tests (and is forced to 1 by
  // `--once`); `sleep`/`intervalMs` make the inter-tick pause virtual in tests.
  maxTicks?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Default inter-tick sleep. Real time; tests inject a virtual clock.
function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Read a recorded port file. Returns null when absent or unparseable — a
// missing port file means the service hasn't booted (or was stopped), which
// the caller treats as "can't probe" rather than crashing the tick.
function readPort(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// Default runtime probe: any HTTP response (including 401) proves the runtime
// process is up. Connection refused / timeout / network error -> dead/hung.
async function defaultProbeRuntime(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return true;
  } catch {
    return false;
  }
}

// Read the last N lines of a web log file as report log lines. Best-effort:
// a missing/unreadable log yields no lines rather than throwing in the probe
// path. Web logs are plain text, so each line is carried as `message` (the
// report drops any `data` payload regardless).
function readWebLogTail(instance: string, filename: string): RuntimeLogLine[] {
  try {
    const path = join(logDir(instance), filename);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-WEB_LOG_TAIL_LINES).map((line) => ({ message: line }));
  } catch {
    return [];
  }
}

// Best-effort literal-redaction inputs for the report. Sourcing these must
// never stop us from reviving web, so any read failure yields undefined — the
// report's pattern-based redaction still runs regardless.
function readRedactionLiterals(): {
  secretsEnvBody?: string;
} {
  let secretsEnvBody: string | undefined;
  try {
    const path = secretsEnvPath();
    if (existsSync(path)) secretsEnvBody = readFileSync(path, "utf8");
  } catch {
    secretsEnvBody = undefined;
  }
  return { secretsEnvBody };
}

export async function watchdog(ctx: CliContext, deps: WatchdogDeps = {}): Promise<void> {
  const instance = ctx.config.instance;
  const probeRuntime = deps.probeRuntime ?? defaultProbeRuntime;
  const probeWeb = deps.probeWeb ?? isSupervisedWebChild;
  const kickstartImpl = deps.kickstartImpl ?? kickstart;
  const isLoadedImpl = deps.isLoadedImpl ?? isLoaded;
  const reenableImpl =
    deps.reenableImpl ?? (async (inst: string, kind: PlistKind) => (await enable({ instance: inst, kinds: [kind] })).ok);
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.intervalMs ?? WATCHDOG_TICK_INTERVAL_MS;
  const maxTicks = hasFlag(ctx.cliArgs, "--once") ? 1 : deps.maxTicks ?? Number.POSITIVE_INFINITY;

  // A kickstart shellout (or an injected one) that throws must not flip the
  // tick to a non-zero exit. Swallow it here — the next tick retries, and the
  // tick's job is to be a clean periodic probe.
  const safeKickstart = (kind: PlistKind): void => {
    try {
      kickstartImpl(instance, kind);
    } catch {
      // Best-effort revive; a failed kickstart is retried next tick.
    }
  };

  // Revive a down core service and return the action string.
  //
  // If launchd still has the service registered, a `kickstart -k` forces a
  // stop+start (registered-but-dead/hung is the common case). But kickstart
  // NO-OPS on a service launchd has deregistered ("Could not find service"),
  // and KeepAlive can't respawn a service it no longer knows about — so a
  // deregistered service stays down forever. That happens when an
  // `autostart enable` boots the old service out successfully but its
  // re-bootstrap loses the launchd "Input/output error" race (e.g. during a
  // self-update with concurrent launchctl churn). For that case we
  // re-bootstrap via `autostart enable`, but only under launchd: a manual
  // foreground `gini watchdog` must not start creating launchd plists. A
  // failed/throwing re-enable is swallowed and retried on the next tick.
  const reviveService = async (kind: PlistKind): Promise<string> => {
    if (isLoadedImpl(instance, kind)) {
      safeKickstart(kind);
      return `kickstart:${kind}`;
    }
    if (supervisorImpl() !== "launchd") return `down:${kind}`;
    try {
      return (await reenableImpl(instance, kind)) ? `reenable:${kind}` : `reenable-failed:${kind}`;
    } catch {
      return `reenable-failed:${kind}`;
    }
  };

  // One queued report per web outage episode, not per tick. The loop probes
  // every 10s, the pending/ queue never collides filenames, and nothing
  // prunes it — so an unguarded per-tick write during a sustained web-only
  // outage floods the queue (and the boot-time listPendingReports parse)
  // with thousands of identical reports. Set on a successful write, cleared
  // when the web probe passes again, so a recovery + fresh outage still
  // queues a new report.
  let webOutageReported = false;

  // One probe tick. Runs under try/finally so process.exitCode = 0 always
  // executes even if a probe, kickstart, or log call throws — the watchdog
  // must read as a clean probe regardless.
  const tick = async (): Promise<void> => {
    try {
      const runtimePort = readPort(runtimePortPath(instance));
      const webPort = readPort(webPortPath(instance));

      // A missing port file means the service never recorded a port (not booted /
      // stopped). We can't health-probe it, so treat it as down — kickstart will
      // (re)launch it if it's enabled, and is a graceful no-op otherwise.
      const runtimeOk = runtimePort !== null ? await probeRuntime(runtimePort) : false;
      // Track whether the web probe actually RAN and FAILED, separate from a
      // missing port. A missing port is a boot race (or a stopped service), not a
      // crash — we still kickstart, but we must not file an issue for it.
      const webProbeFailed = webPort !== null ? !(await probeWeb(instance, webPort)) : false;
      const webOk = webPort !== null && !webProbeFailed;

      const actions: string[] = [];

      // Runtime dead/hung -> kickstart the gateway. KeepAlive should already
      // respawn it, but macOS 26 frequently defers that; the explicit kick forces
      // a stop+start. No crash report here: an in-process uncaughtException already
      // queues a report via the runtime crash handler, and a hung-but-not-crashed
      // runtime has no error to attribute.
      if (!runtimeOk) {
        actions.push(await reviveService("gateway"));
      }

      // A web crash report is only warranted for a GENUINE web-specific failure:
      // the web port was recorded (so it had booted), the probe actually failed,
      // AND the runtime is healthy. A missing port is a boot race; a failed probe
      // while the runtime is also down is just the symptom of a runtime outage
      // (the BFF can't reach a dead gateway). Filing in either case produces a
      // false-positive issue. We still kickstart web below regardless.
      const shouldReportWebCrash = webPort !== null && webProbeFailed && runtimeOk;

      // A healthy web probe ends the outage episode — the next failure is a
      // new episode and may queue a new report.
      if (webOk) webOutageReported = false;

      // Web dead/hung -> build a crash report from the web log tails, queue it into
      // pending/, then kickstart the web service. The web has no in-process crash
      // handler (decision: web crash coverage is the watchdog), so this is the only
      // place a web outage gets captured. The queued report is offered to the user
      // on the next restart and filed only on consent — nothing is filed here.
      if (!webOk) {
        if (shouldReportWebCrash && !webOutageReported) {
          try {
            const logTail = [
              ...readWebLogTail(instance, "web-launchd.err.log"),
              ...readWebLogTail(instance, "web.log")
            ];
            const { secretsEnvBody } = readRedactionLiterals();
            const report = buildCrashReport({
              instance,
              supervisor: supervisorImpl(),
              // No JS Error object for a web outage — synthesize one so the report's
              // fingerprint/dedup still works. The message is stable so recurrences
              // collapse to a single issue.
              error: new Error("web service health probe failed (dead or hung)"),
              source: "web",
              logTail,
              sysInfo: { platform: platform(), arch: arch(), nodeVersion: process.version },
              clock,
              secretsEnvBody
            });
            writeCrashReportFile(report);
            webOutageReported = true;
            actions.push("report:web");
          } catch {
            // Building/writing the report must never stop us from reviving web.
          }
        }
        actions.push(await reviveService("web"));
      }

      // Best-effort log line; a logging failure must not flip the tick's exit.
      try {
        appendLog(instance, "watchdog.tick", { webOk, runtimeOk, webProbeFailed, shouldReportWebCrash, actions });
      } catch {
        // Logging is observability, not control flow — swallow.
      }
    } catch (err) {
      // A thrown/rejected probe (probeRuntime/probeWeb) or any other tick failure
      // must NOT reject out of the loop — the CLI top-level would then exit(1)
      // and take the whole safety net down with it. Swallow it (logged
      // best-effort) and let the next tick retry.
      try {
        appendLog(instance, "watchdog.error", { error: String(err) });
      } catch {
        // Logging is observability, not control flow — swallow.
      }
    } finally {
      // The watchdog always reads as a clean probe — recovery actions are
      // recorded in the tick log, not signaled via exit code.
      process.exitCode = 0;
    }
  };

  // The probe loop. Ticks immediately on start (launchd just spawned us — the
  // first health answer should not wait an interval), then paces itself with
  // its own timer. KeepAlive only has to spawn this process once, so launchd's
  // spawn-deferral can't gap the cadence the way StartInterval respawns could.
  for (let ranTicks = 1; ; ranTicks += 1) {
    await tick();
    if (ranTicks >= maxTicks) break;
    await sleep(intervalMs);
  }
}
