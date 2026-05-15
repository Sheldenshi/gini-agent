import { writeFileSync } from "node:fs";
import { createHandler, writePid } from "./http";
import { runDueJobs } from "./jobs";
import { runConnectorReprobe } from "./jobs/connector-reprobe";
import { runConnectorDetection } from "./jobs/connector-detection";
import { install } from "./runtime";
import { migrateIfNeeded } from "./memory";
import { loadConfig, parseInstance, runtimePortPath } from "./paths";
import { appendLog, mutateState, readState } from "./state";
import { loadSkillsFromDisk } from "./capabilities/skill-loader";
import { consumeAutostartRefresh } from "./runtime/autostart-refresh";
import { closeAll as closeBrowserSessions, setBrowserInstance } from "./tools/browser";

// Shutdown drain budgets. Centralized so both timeouts are visible in one
// place — each guards a different unwind step on SIGTERM.
//
// SERVER_DRAIN_TIMEOUT_MS: how long we wait for in-flight HTTP responses
// (server.stop(false)) to finish writing before tearing the process down.
// A single stalled client (broken pipe) shouldn't block shutdown forever;
// 5s is a comfortable bound for normal local HTTP latencies.
//
// SCHEDULER_DRAIN_TIMEOUT_MS: bounds the wait for the in-flight scheduler
// tick to unwind. A hung tick (e.g. a script job blocking on stdio)
// shouldn't keep the runtime alive forever — the OS reaps the child
// process tree on exit anyway.
const SERVER_DRAIN_TIMEOUT_MS = 5000;
const SCHEDULER_DRAIN_TIMEOUT_MS = 5000;

const instance = parseInstance();
const config = loadConfig(instance);
install(config);
writePid(config);

// Inform the browser session manager which instance to consult for the
// optional CDP connection record. Without this the manager falls back to
// the headless launch path (which is fine for unit tests that import the
// tools directly).
setBrowserInstance(config.instance);

// Clear any stale browser connection record on startup. A managed record
// only describes a Chrome window the runtime previously opened — that
// window is gone after a restart, so the record is misleading: GET
// /api/browser would report `connected: true` and the next agent tool call
// would relaunch a visible Chrome window unprompted (because the session
// manager reads state.browser and takes the headed persistent branch).
// The on-disk persistent profile is independent of this record and stays
// put — only the "user wants a visible window NOW" signal resets. The user
// hits Connect again when they want the window back.
{
  const existing = readState(config.instance).browser ?? null;
  if (existing) {
    void mutateState(config.instance, (state) => {
      state.browser = null;
    })
      .then(() => {
        appendLog(config.instance, "browser.stale-record-cleared", { mode: existing.mode });
      })
      .catch((error) => {
        appendLog(config.instance, "browser.stale-record-clear-error", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }
}

// Hindsight phase 6: opportunistic legacy migration. Runs once per server
// start; subsequent starts are no-ops because each migrated record carries
// metadata.migratedToUnitId. Failures are logged but do not block startup —
// `gini doctor` surfaces the count of unmigrated rows.
migrateIfNeeded(config)
  .then((report) => {
    if (!report) return;
    appendLog(config.instance, "memory.migrated", {
      total: report.total,
      migrated: report.migrated,
      skipped: report.skipped,
      failed: report.failed
    });
  })
  .catch((error) => {
    appendLog(config.instance, "memory.migrate.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// Slice 2: load filesystem-backed skills (bundled + user) at boot. Errors
// are absorbed into the audit/log so a malformed SKILL.md can never block
// startup; doctor/reload surface follow-up diagnostics.
loadSkillsFromDisk(config)
  .then((report) => {
    appendLog(config.instance, "skills.loaded", {
      added: report.added.length,
      updated: report.updated.length,
      skipped: report.skipped.length
    });
  })
  .catch((error) => {
    appendLog(config.instance, "skills.load.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// Auto-detect connectors with `source: "auto"` for any provider that
// declares a `detect()` (today claude-code and codex). Idempotent: skips
// providers that already have a record or a disabled tombstone. Errors
// are absorbed so a flaky `which` lookup can't block startup.
runConnectorDetection(config)
  .then((report) => {
    appendLog(config.instance, "connector.detection.startup", {
      considered: report.considered,
      created: report.created.length,
      skipped: report.skipped.length
    });
  })
  .catch((error) => {
    appendLog(config.instance, "connector.detection.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: createHandler(config)
});

// Record the live port so clients (CLI status, autostart web shim, BFF
// lazy-read in web/src/lib/runtime.ts) can discover it without having to
// hash the instance name or read GINI_PORT. `gini start` also writes
// this file in process.ts, but the autostart flow execs us directly and
// bypasses that helper — so we must write it here too. Cleaned up on
// SIGTERM below.
writeFileSync(runtimePortPath(config.instance), String(server.port));

appendLog(config.instance, "runtime.started", { port: server.port, pid: process.pid });
console.log(`Gini runtime listening on http://127.0.0.1:${server.port} instance=${config.instance}`);

// Self-rescheduling scheduler loop. We await runDueJobs(config) before
// scheduling the next tick so a slow tick (e.g. spawning N script jobs
// inline) can never overlap with itself. Cadence is the 1000ms gap
// *between completions*, which means a fast tick still polls roughly
// once a second; a slow tick just slides the next tick later. Bun.sleep
// is used in lieu of setTimeout to keep the loop awaitable and to match
// the project's preference (CLAUDE.md).
//
// We retain the loop's promise (`schedulerDone`) so SIGTERM can await
// the in-flight tick before exiting — without that, a SIGTERM landing
// mid-tick would kill an in-progress dispatch and leave its
// JobRunRecord stuck "running" forever.
let schedulerStopped = false;
const schedulerDone: Promise<void> = (async function schedulerLoop(): Promise<void> {
  while (!schedulerStopped) {
    try {
      await runDueJobs(config);
    } catch (error) {
      appendLog(config.instance, "scheduler.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (schedulerStopped) break;
    await Bun.sleep(1000);
  }
})();

// Periodic connector re-probe loop (ADR connector-provider-spec-compliance.md § Probe contract). Runs
// alongside the scheduler so connector health reflects reality without
// the user manually clicking "Check health". Cadence: every minute we
// look at every connector and dispatch its provider probe iff the
// provider declares one AND the per-provider interval has elapsed
// (default 30 minutes). Probes that fail close the health to
// "unhealthy"; transitions emit an audit event.
const REPROBE_TICK_INTERVAL_MS = Number(process.env.GINI_REPROBE_TICK_MS ?? 60_000);
let reprobeStopped = false;
const reprobeDone: Promise<void> = (async function reprobeLoop(): Promise<void> {
  while (!reprobeStopped) {
    try {
      const report = await runConnectorReprobe(config);
      if (report.transitioned.length > 0) {
        appendLog(config.instance, "connector.reprobe.transitions", {
          transitions: report.transitioned
        });
      }
    } catch (error) {
      appendLog(config.instance, "connector.reprobe.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (reprobeStopped) break;
    await Bun.sleep(REPROBE_TICK_INTERVAL_MS);
  }
})();

// Guard against concurrent SIGTERMs. launchctl bootout, `kill`, and our
// own self-signal from src/runtime/autostart-refresh.ts can all arrive
// in quick succession; we only want to drain + consume the refresh
// marker once. Without this flag, two SIGTERMs racing the same drain
// would call `server.stop(false)` twice and then run the marker-consume
// twice — best case a wasted spawn, worst case a double-bootstrap that
// confuses launchd.
let shutdownStarted = false;

process.on("SIGTERM", async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  appendLog(config.instance, "runtime.stopped", { signal: "SIGTERM" });
  schedulerStopped = true;
  reprobeStopped = true;
  // Drain in-flight HTTP responses BEFORE we start tearing the process
  // down. `server.stop(false)` returns a promise that resolves when
  // active requests have completed writing — without this, a setup POST
  // that triggered the SIGTERM (see src/runtime/autostart-refresh.ts)
  // could have its response body cut mid-stream when the process exits.
  //
  // Bun's server.stop(true) FORCE-closes connections (per
  // node_modules/bun-types/docs/runtime/http/server.mdx:251-258). We
  // want stop(false) — the polite "wait for in-flight" variant.
  //
  // Failsafe: if a single connection is hung (stalled client, broken
  // pipe), don't block shutdown indefinitely. Race the drain against
  // SERVER_DRAIN_TIMEOUT_MS; on timeout, log and proceed (a force-stop
  // happens implicitly on process.exit).
  try {
    await Promise.race([
      server.stop(false),
      Bun.sleep(SERVER_DRAIN_TIMEOUT_MS).then(() => {
        appendLog(config.instance, "runtime.stop.timeout", {
          waited_ms: SERVER_DRAIN_TIMEOUT_MS
        });
      })
    ]);
  } catch (error) {
    appendLog(config.instance, "runtime.stop.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // Wait for the in-flight tick before exiting so we don't kill a job
  // mid-execution and leave its JobRunRecord stuck "running". The tick
  // catches its own errors, so schedulerDone shouldn't reject — but we
  // attach a no-op .catch() defensively (any error already landed in
  // appendLog from the loop itself).
  //
  // Bound the wait at SCHEDULER_DRAIN_TIMEOUT_MS: a hung tick (e.g. a
  // script job that spawned a child blocking on stdio) shouldn't block
  // shutdown forever. After the timeout we proceed even if the tick
  // hasn't unwound — the OS will reap the child process tree on exit.
  const drained = Promise.race([
    Promise.all([
      schedulerDone.catch(() => {}),
      reprobeDone.catch(() => {}),
      // Close any live headless browser contexts so Chromium child
      // processes exit cleanly with the runtime instead of being reaped
      // by the OS at the very end. Errors are swallowed — a stuck
      // close shouldn't block runtime shutdown.
      closeBrowserSessions().catch(() => {})
    ]),
    Bun.sleep(SCHEDULER_DRAIN_TIMEOUT_MS)
  ]);
  // Print a stable shutdown marker so the foreground log capture (and any
  // human tailing the file) can see that the runtime is going down. Without
  // this, the SIGTERM path emits no stdio at all and observability of clean
  // shutdowns rests entirely on the structured runtime.jsonl event stream.
  // This is also the marker run.test.ts asserts on to guard the
  // `awaitForegroundLogFlush()` call in admin.ts:runForeground.
  //
  // Use process.stdout.write with the exit-in-callback pattern so that when
  // stdout is a pipe (foreground mode pipes child stdout into the parent for
  // tee-ing), the write completes before we exit. console.log is async on
  // pipes and process.exit doesn't wait for pending writes — that race would
  // drop the shutdown marker.
  drained.finally(() => {
    // Browser-driven autostart refresh: if /api/setup/provider just
    // wrote a refresh marker for this instance, consume it and spawn
    // the detached `gini autostart enable --kind gateway` child. The
    // drain above guarantees the response to that POST has been
    // fully flushed before we get here — `server.stop(false)` waits
    // for all in-flight responses to finish writing. The marker →
    // spawn step is the LAST thing we do before exiting, so the
    // connection has closed and the client has the response in hand
    // by the time launchctl bootstrap fires in the child.
    try {
      consumeAutostartRefresh(config.instance);
    } catch (error) {
      appendLog(config.instance, "autostart.refresh.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    process.stdout.write(`Gini runtime shutting down (SIGTERM) instance=${config.instance}\n`, () => {
      process.exit(0);
    });
  });
});
