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
//   4. If web is dead/hung -> capture the web log tails, build + write a
//      redacted crash report into the pending/ queue, THEN kickstart -k the web
//      service. The report is offered to the user on the next restart and filed
//      only on consent — the watchdog never files anything itself.
//
// Always exits 0: it's a periodic probe, and a non-zero exit muddies launchd's
// StartInterval bookkeeping. Every external dependency (fetch, the launchctl
// kickstart runner, the clock) is injectable so tests never bind real ports or
// call real launchctl.

import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../context";
import { logDir, runtimePortPath, webPortPath } from "../../paths";
import { kickstart, supervisor, type LaunchctlResult, type PlistKind } from "../../integrations/launchd";
import { isSupervisedWebChild } from "../../runtime/health-probe";
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
  // Report whether we're under launchd. Defaults to supervisor(). Stamped onto
  // the queued report so the restart-ask can gate on supervision later.
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
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  const clock = deps.clock ?? (() => new Date());

  // A kickstart shellout (or an injected one) that throws must not flip the
  // tick to a non-zero exit. Swallow it here — launchd will retry on the next
  // StartInterval, and the tick's job is to be a clean periodic probe.
  const safeKickstart = (kind: PlistKind): void => {
    try {
      kickstartImpl(instance, kind);
    } catch {
      // Best-effort revive; a failed kickstart is retried next tick.
    }
  };

  // The whole tick runs under try/finally so process.exitCode = 0 always
  // executes even if a probe, kickstart, or log call throws — a periodic
  // launchd probe must report success regardless.
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
      safeKickstart("gateway");
      actions.push("kickstart:gateway");
    }

    // A web crash report is only warranted for a GENUINE web-specific failure:
    // the web port was recorded (so it had booted), the probe actually failed,
    // AND the runtime is healthy. A missing port is a boot race; a failed probe
    // while the runtime is also down is just the symptom of a runtime outage
    // (the BFF can't reach a dead gateway). Filing in either case produces a
    // false-positive issue. We still kickstart web below regardless.
    const shouldReportWebCrash = webPort !== null && webProbeFailed && runtimeOk;

    // Web dead/hung -> build a crash report from the web log tails, queue it into
    // pending/, then kickstart the web service. The web has no in-process crash
    // handler (decision: web crash coverage is the watchdog), so this is the only
    // place a web outage gets captured. The queued report is offered to the user
    // on the next restart and filed only on consent — nothing is filed here.
    if (!webOk) {
      if (shouldReportWebCrash) {
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
          actions.push("report:web");
        } catch {
          // Building/writing the report must never stop us from reviving web.
        }
      }
      safeKickstart("web");
      actions.push("kickstart:web");
    }

    // Best-effort log line; a logging failure must not flip the tick's exit.
    try {
      appendLog(instance, "watchdog.tick", { webOk, runtimeOk, webProbeFailed, shouldReportWebCrash, actions });
    } catch {
      // Logging is observability, not control flow — swallow.
    }
  } catch (err) {
    // A thrown/rejected probe (probeRuntime/probeWeb) or any other tick failure
    // must NOT reject out of watchdog — the CLI top-level would then exit(1),
    // muddying launchd's StartInterval bookkeeping. Swallow it (logged
    // best-effort) and let the finally below resolve the tick with exitCode 0.
    try {
      appendLog(instance, "watchdog.error", { error: String(err) });
    } catch {
      // Logging is observability, not control flow — swallow.
    }
  } finally {
    // Periodic probe: always succeed so launchd's StartInterval bookkeeping
    // stays clean. Recovery actions are recorded above, not signaled via exit.
    process.exitCode = 0;
  }
}
