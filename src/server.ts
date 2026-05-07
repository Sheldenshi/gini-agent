import { createHandler, writePid } from "./http";
import { runDueJobs } from "./domain/jobs";
import { install } from "./domain/runtime";
import { migrateIfNeeded } from "./domain/memory";
import { loadConfig, parseLane } from "./paths";
import { appendLog } from "./state";

const lane = parseLane();
const config = loadConfig(lane);
install(config);
writePid(config);

// Hindsight phase 6: opportunistic legacy migration. Runs once per server
// start; subsequent starts are no-ops because each migrated record carries
// metadata.migratedToUnitId. Failures are logged but do not block startup —
// `gini doctor` surfaces the count of unmigrated rows.
migrateIfNeeded(config)
  .then((report) => {
    if (!report) return;
    appendLog(config.lane, "memory.migrated", {
      total: report.total,
      migrated: report.migrated,
      skipped: report.skipped,
      failed: report.failed
    });
  })
  .catch((error) => {
    appendLog(config.lane, "memory.migrate.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: createHandler(config)
});

appendLog(config.lane, "runtime.started", { port: server.port, pid: process.pid });
console.log(`Gini runtime listening on http://127.0.0.1:${server.port} lane=${config.lane}`);

setInterval(() => {
  runDueJobs(config).catch((error) => {
    appendLog(config.lane, "scheduler.error", { error: error instanceof Error ? error.message : String(error) });
  });
}, 1000);

process.on("SIGTERM", () => {
  appendLog(config.lane, "runtime.stopped", { signal: "SIGTERM" });
  server.stop(true);
  process.exit(0);
});
