import { createHandler, writePid } from "./http";
import { runDueJobs } from "./jobs";
import { install } from "./runtime";
import { migrateIfNeeded } from "./memory";
import { loadConfig, parseInstance } from "./paths";
import { appendLog } from "./state";
import { loadSkillsFromDisk } from "./capabilities/skill-loader";

const instance = parseInstance();
const config = loadConfig(instance);
install(config);
writePid(config);

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

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: createHandler(config)
});

appendLog(config.instance, "runtime.started", { port: server.port, pid: process.pid });
console.log(`Gini runtime listening on http://127.0.0.1:${server.port} instance=${config.instance}`);

setInterval(() => {
  runDueJobs(config).catch((error) => {
    appendLog(config.instance, "scheduler.error", { error: error instanceof Error ? error.message : String(error) });
  });
}, 1000);

process.on("SIGTERM", () => {
  appendLog(config.instance, "runtime.stopped", { signal: "SIGTERM" });
  server.stop(true);
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
  process.stdout.write(`Gini runtime shutting down (SIGTERM) instance=${config.instance}\n`, () => {
    process.exit(0);
  });
});
