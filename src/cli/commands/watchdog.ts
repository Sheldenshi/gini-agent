// `gini watchdog --instance <name>` — periodic health probe (the launchd
// watchdog job's StartInterval one-shot).
//
// Runs every ~30s under launchd (see src/cli/autostart.ts watchdog plist).
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
//   4. If web is dead/hung -> capture the web log tails, build + write a crash
//      report, spawn a DETACHED `gini report-crash` (which gates on launchd +
//      dedupes + rate-limits), THEN kickstart -k the web service.
//
// Always exits 0: it's a periodic probe, and a non-zero exit muddies launchd's
// StartInterval bookkeeping. Every external dependency (fetch, the launchctl
// kickstart runner, spawn, the clock) is injectable so tests never bind real
// ports, call real launchctl, or spawn real processes.

import { spawn as nodeSpawn, type spawn as SpawnType } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../context";
import { logDir, runtimePortPath, webPortPath } from "../../paths";
import { kickstart, supervisor, type LaunchctlResult, type PlistKind } from "../../integrations/launchd";
import { isSupervisedWebChild } from "../../runtime/health-probe";
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
  // Spawn the detached report-crash child. Defaults to node's spawn.
  spawnImpl?: typeof SpawnType;
  // Report whether we're under launchd. Defaults to supervisor(). The actual
  // filing gate lives in report-crash; this is only used to skip spawning a
  // no-op child when we already know it won't file.
  supervisorImpl?: () => "launchd" | null;
  clock?: () => Date;
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

export async function watchdog(ctx: CliContext, deps: WatchdogDeps = {}): Promise<void> {
  const instance = ctx.config.instance;
  const probeRuntime = deps.probeRuntime ?? defaultProbeRuntime;
  const probeWeb = deps.probeWeb ?? isSupervisedWebChild;
  const kickstartImpl = deps.kickstartImpl ?? kickstart;
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  const clock = deps.clock ?? (() => new Date());

  const runtimePort = readPort(runtimePortPath(instance));
  const webPort = readPort(webPortPath(instance));

  // A missing port file means the service never recorded a port (not booted /
  // stopped). We can't health-probe it, so treat it as down — kickstart will
  // (re)launch it if it's enabled, and is a graceful no-op otherwise.
  const runtimeOk = runtimePort !== null ? await probeRuntime(runtimePort) : false;
  const webOk = webPort !== null ? await probeWeb(instance, webPort) : false;

  const actions: string[] = [];

  // Runtime dead/hung -> kickstart the gateway. KeepAlive should already
  // respawn it, but macOS 26 frequently defers that; the explicit kick forces
  // a stop+start. No crash report here: an in-process uncaughtException already
  // files via the runtime crash handler, and a hung-but-not-crashed runtime
  // has no error to attribute.
  if (!runtimeOk) {
    kickstartImpl(instance, "gateway");
    actions.push("kickstart:gateway");
  }

  // Web dead/hung -> build a crash report from the web log tails, write it, fire
  // a detached report-crash, then kickstart the web service. The web has no
  // in-process crash handler (decision: web crash coverage is the watchdog), so
  // this is the only place a web outage gets reported.
  if (!webOk) {
    try {
      const logTail = [
        ...readWebLogTail(instance, "web-launchd.err.log"),
        ...readWebLogTail(instance, "web.log")
      ];
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
        clock
      });
      const reportPath = writeCrashReportFile(report);

      // Only spawn the filing child when we're under launchd — report-crash
      // itself gates on this, so spawning when not supervised would just exit
      // 0 as a no-op. Detached + unref'd so it outlives this short tick.
      if (supervisorImpl() === "launchd") {
        try {
          const child = spawnImpl(
            process.execPath,
            ["run", "gini", "report-crash", "--instance", instance, "--report", reportPath],
            { detached: true, stdio: "ignore", env: { ...process.env, GINI_INSTANCE: instance } }
          );
          if (typeof child.unref === "function") child.unref();
        } catch {
          // Best-effort: a failed spawn must not block the kickstart below.
        }
      }
    } catch {
      // Building/writing the report must never stop us from reviving web.
    }
    kickstartImpl(instance, "web");
    actions.push("kickstart:web");
  }

  appendLog(instance, "watchdog.tick", { webOk, runtimeOk, actions });

  // Periodic probe: always succeed so launchd's StartInterval bookkeeping
  // stays clean. Recovery actions are recorded above, not signaled via exit.
  process.exitCode = 0;
}
