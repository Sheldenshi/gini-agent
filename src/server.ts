import { createHandler, writePid } from "./http";
import { runDueJobs } from "./domain/jobs";
import { install } from "./domain/runtime";
import { loadConfig, parseLane } from "./paths";
import { appendLog } from "./state";

const lane = parseLane();
const config = loadConfig(lane);
install(config);
writePid(config);

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
