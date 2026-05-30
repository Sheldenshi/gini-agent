import { writeFileSync } from "node:fs";
import { createHandler, writePid } from "./http";
import { tunnelManager } from "./runtime/tunnel";
import { readTunnelConfig } from "./runtime/tunnel/config-store";
import { isSupervisedWebChild } from "./runtime/health-probe";
import { webPortPath } from "./paths";
import { existsSync as fileExists, readFileSync as readFileSyncFs } from "node:fs";
import { runDueJobs } from "./jobs";
import { runConnectorReprobe } from "./jobs/connector-reprobe";
import { runConnectorDetection } from "./jobs/connector-detection";
import { syncProviderMcpServers } from "./integrations/mcp-sync";
import { install } from "./runtime";
import { migrateIfNeeded } from "./memory";
import { loadConfig, parseInstance, runtimePortPath } from "./paths";
import { appendLog, mutateState, readState } from "./state";
import { loadSkillsFromDisk } from "./capabilities/skill-loader";
import { consumeAutostartRefresh } from "./runtime/autostart-refresh";
import { installCrashHandlers } from "./runtime/crash-handlers";
import { maybeAskAboutCrashes } from "./runtime/crash-recovery";
import { closeAll as closeBrowserSessions, setBrowserInstance } from "./tools/browser";
import { createTelegramPollerSupervisor } from "./integrations/telegram-poller";
import { createDiscordPollerSupervisor } from "./integrations/discord-poller";
import { createApnsDispatcher } from "./integrations/apns/dispatcher";
import { fireCacheWarmerProbe } from "./runtime/cache-warmer";

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
// Install crash handlers before any runtime work so an uncaughtException or
// unhandledRejection thrown during boot is still captured. The handler queues a
// redacted report; nothing is filed here — the on-restart consent flow
// (maybeAskAboutCrashes) asks the user before any report is published.
installCrashHandlers({ instance, source: "runtime" });
await install(config);
writePid(config);

// Eagerly construct the tunnel manager so the 192-bit secret is generated on
// first boot (whether or not tunnel.enabled is true) and the redaction set
// is populated before any request lands. See
// docs/adr/tunnel-and-mobile-access.md "Architecture (summary)".
tunnelManager(config);

// Process-wide shutdown sentinel. Set by the SIGTERM handler at the bottom
// of this file; the boot-reconcile poll polls this between awaits so it
// never spawns a fresh cloudflared after `stopForShutdown()` has run.
let bootReconcileAbort = false;

// Boot-time reconciliation: if config.json persists `tunnel.enabled: true`,
// the operator's expectation is that the tunnel comes back up after a restart
// (with a new rotating hostname). The web port isn't known yet — the CLI
// writes it once Next.js reports healthy — so we poll the sibling
// `web.port` file. The persisted flag is re-read inside the loop so a
// `gini tunnel disable` issued before web.port appears does NOT re-enable
// when the port lands. A `__healthz` probe runs before the cloudflared
// spawn so we never expose a stale or squatted port to the public URL.
// The poll also checks `bootReconcileAbort` after every await so a SIGTERM
// landing during a probe / sleep cancels the reconcile cleanly.
// Bounded by a 60_000 ms ceiling on web-port discovery — see
// docs/adr/tunnel-and-mobile-access.md "Architecture (summary)".
{
  const initial = readTunnelConfig(config.instance);
  if (initial.enabled) {
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      while (Date.now() < deadline) {
        if (bootReconcileAbort) {
          appendLog(config.instance, "tunnel.boot-reconcile.aborted", { reason: "shutdown" });
          return;
        }
        // Re-read the persisted state on every tick. If the operator runs
        // `gini tunnel disable` while we're polling, the next check
        // observes enabled=false and aborts the reconcile.
        const persisted = readTunnelConfig(config.instance);
        if (!persisted.enabled) {
          appendLog(config.instance, "tunnel.boot-reconcile.aborted", { reason: "disabled-during-poll" });
          return;
        }
        const portFile = webPortPath(config.instance);
        if (fileExists(portFile)) {
          const portRaw = readFileSyncFs(portFile, "utf8").trim();
          const port = Number(portRaw);
          if (Number.isFinite(port) && port > 0) {
            // Verify the port is actually our supervised Next.js child by
            // probing the BFF-side healthz endpoint. A 200 with the
            // expected JSON shape proves the port isn't a stale-file or
            // port-squat scenario.
            const healthy = await isSupervisedWebChild(config.instance, port).catch(() => false);
            if (bootReconcileAbort) {
              appendLog(config.instance, "tunnel.boot-reconcile.aborted", { reason: "shutdown" });
              return;
            }
            if (!healthy) {
              await Bun.sleep(500);
              continue;
            }
            // Re-check the persisted state AFTER the probe — the 1500ms
            // probe window is long enough that a disable can race in
            // between the prior check and the actual enable() call.
            const stillEnabled = readTunnelConfig(config.instance).enabled;
            if (!stillEnabled) {
              appendLog(config.instance, "tunnel.boot-reconcile.aborted", { reason: "disabled-after-probe" });
              return;
            }
            if (bootReconcileAbort) {
              appendLog(config.instance, "tunnel.boot-reconcile.aborted", { reason: "shutdown" });
              return;
            }
            const result = await tunnelManager(config).enable(port, { reconcileOnly: true });
            appendLog(config.instance, "tunnel.boot-reconcile", { ok: result.ok });
            return;
          }
        }
        await Bun.sleep(500);
      }
      appendLog(config.instance, "tunnel.boot-reconcile.timeout", {});
    };
    void poll();
  }
}

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

// Legacy Hindsight-migration opportunistic seam. The
// state.memories surface was retired in the memory-surface
// consolidation; the install-time migration in
// `migrate-pinned-to-user-md.ts` now drains every active pinned row into
// USER.md. `migrateIfNeeded` is kept as a no-op so older external
// callers don't break, but the report is always `null` — nothing to log.
// See ADR runtime-identity-files.md.
migrateIfNeeded(config).catch((error) => {
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

// Back-fill MCP server registrations for any connectors that were already
// healthy before the connector↔MCP bridge shipped. Idempotent and
// best-effort: errors are absorbed so a malformed provider descriptor
// can't block startup.
syncProviderMcpServers(config)
  .then((created) => {
    if (created.length > 0) {
      appendLog(config.instance, "mcp.auto_register.startup", { created });
    }
  })
  .catch((error) => {
    appendLog(config.instance, "mcp.auto_register.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// APNs push dispatcher. Subscribes to the instance-wide chat-blocks
// stream and fans `approval_requested` events out to every registered
// iOS device. The dispatcher itself no-ops when APNS_* env vars are
// unset, so dev installs without push creds are unaffected.
const apnsDispatcher = createApnsDispatcher(config.instance);

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  // Bun.serve defaults to a 10s idleTimeout. Several handlers can legitimately
  // exceed that — approval resolution for browser.connect does teardown+relaunch
  // of Chromium AND awaits resumeChatTask (which blocks on the agent's next
  // model turn); model calls themselves can run minutes for reasoning models.
  // 255s is the per-request ceiling (Bun's max), high enough that operations
  // complete and low enough that genuinely hung sockets still get reaped.
  idleTimeout: 255,
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

// If crashes were captured while we were down, offer (default + launchd only)
// to file them — best-effort, never blocks or crashes boot.
maybeAskAboutCrashes(config).catch((err) =>
  appendLog(config.instance, "crash.recovery.error", { error: String(err) })
);

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

// Messaging inbound supervisor cadence. Shared across every bridge
// supervisor (Telegram long-poll reconcile + Discord REST-poll
// reconcile). A bridge added at runtime is picked up within one
// reconcile interval without restarting the runtime. The
// GINI_TELEGRAM_RECONCILE_MS env var is kept for backwards
// compatibility with the original Telegram-only knob.
const MESSAGING_RECONCILE_INTERVAL_MS = Number(
  process.env.GINI_MESSAGING_RECONCILE_MS ?? process.env.GINI_TELEGRAM_RECONCILE_MS ?? 5000
);

// Telegram inbound poller. The supervisor reconciles per-bridge long-poll
// loops against state every few seconds. Each loop streams updates
// from api.telegram.org and funnels them through receiveMessagingInput,
// which submits a task per inbound message.
const telegramSupervisor = createTelegramPollerSupervisor(config);
let telegramStopped = false;
const telegramDone: Promise<void> = (async function telegramReconcileLoop(): Promise<void> {
  while (!telegramStopped) {
    try {
      telegramSupervisor.reconcile();
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.supervisor_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (telegramStopped) break;
    await Bun.sleep(MESSAGING_RECONCILE_INTERVAL_MS);
  }
})();

// Discord inbound poller. Same supervisor shape as Telegram. Discord
// has no long-poll, so each loop polls every configured delivery target
// on a short cadence and advances a per-channel snowflake watermark in
// bridge.metadata.lastInboundExternalIds.
const discordSupervisor = createDiscordPollerSupervisor(config);
let discordStopped = false;
const discordDone: Promise<void> = (async function discordReconcileLoop(): Promise<void> {
  while (!discordStopped) {
    try {
      discordSupervisor.reconcile();
    } catch (error) {
      appendLog(config.instance, "messaging.discord.supervisor_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (discordStopped) break;
    await Bun.sleep(MESSAGING_RECONCILE_INTERVAL_MS);
  }
})();

// Cache warmer loop. Reads config.cacheWarmerMinutes on every iteration
// so a POST /api/settings/cache-warmer takes effect without restart or
// pub/sub. When the value is 0 (or undefined) the loop polls every 30s
// to pick up future enables. When > 0 it sleeps for minutes × 54_000 ms
// (= minutes × 0.9 × 60 × 1000) and then fires one probe via the
// existing provider dispatch path. Errors are logged and the next tick
// retries; we never swallow them silently because that would mask real
// provider auth/transport failures.
const CACHE_WARMER_IDLE_TICK_MS = 30_000;
let cacheWarmerStopped = false;
const cacheWarmerDone: Promise<void> = (async function cacheWarmerLoop(): Promise<void> {
  while (!cacheWarmerStopped) {
    const minutes = config.cacheWarmerMinutes ?? 0;
    if (minutes > 0) {
      await Bun.sleep(minutes * 54_000);
      if (cacheWarmerStopped) break;
      try {
        await fireCacheWarmerProbe(config);
        appendLog(config.instance, "cache_warmer.probe.ok", { minutes });
      } catch (error) {
        appendLog(config.instance, "cache_warmer.probe.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      await Bun.sleep(CACHE_WARMER_IDLE_TICK_MS);
    }
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
  // Tell the boot-reconcile poll to bail out before its next enqueue/await
  // wakes up. Without this the poll can call `tunnelManager.enable(port)`
  // AFTER `stopForShutdown()` has cleaned up, spawning an orphan
  // cloudflared the drain never awaits.
  bootReconcileAbort = true;
  appendLog(config.instance, "runtime.stopped", { signal: "SIGTERM" });
  schedulerStopped = true;
  reprobeStopped = true;
  telegramStopped = true;
  discordStopped = true;
  cacheWarmerStopped = true;
  // Tear down the chat-blocks subscription so the dispatcher stops
  // emitting pushes during drain. The APNs HTTP/2 client owns its own
  // session and will close lazily when garbage-collected.
  try { apnsDispatcher.stop(); } catch { /* swallow — shutdown must continue */ }
  // Abort all in-flight Telegram long-polls so they don't keep us alive
  // waiting out their 25s timeout, and abort every Discord poll cycle
  // so the runtime exits promptly even if a fetch is in-flight. The
  // .catch below swallows the abort rejection — it's expected.
  void telegramSupervisor.stopAll().catch(() => {});
  void discordSupervisor.stopAll().catch(() => {});
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
      telegramDone.catch(() => {}),
      telegramSupervisor.stopAll().catch(() => {}),
      discordDone.catch(() => {}),
      discordSupervisor.stopAll().catch(() => {}),
      cacheWarmerDone.catch(() => {}),
      // Close any live headless browser contexts so Chromium child
      // processes exit cleanly with the runtime instead of being reaped
      // by the OS at the very end. Errors are swallowed — a stuck
      // close shouldn't block runtime shutdown.
      closeBrowserSessions().catch(() => {}),
      // Tunnel: stop cloudflared so the public URL stops accepting traffic
      // within the SIGKILL hard-cap. Configured to swallow errors — a stuck
      // cloudflared shouldn't keep the runtime alive forever.
      (async () => {
        const { tunnelManager } = await import("./runtime/tunnel");
        await tunnelManager(config).stopForShutdown();
      })().catch(() => {})
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
