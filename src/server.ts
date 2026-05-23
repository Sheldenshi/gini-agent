import { readFileSync, writeFileSync } from "node:fs";
import { createHandler, writePid } from "./http";
import { runDueJobs } from "./jobs";
import { runConnectorReprobe } from "./jobs/connector-reprobe";
import { runConnectorDetection } from "./jobs/connector-detection";
import { install } from "./runtime";
import { migrateIfNeeded } from "./memory";
import { configPath, loadConfig, parseInstance, runtimePortPath, tunnelLogPath, webPortPath, writeConfigAtomic } from "./paths";
import { appendLog, mutateState, readState } from "./state";
import { applyLegacyTelegramPairingMigration } from "./state/store";
import { loadSkillsFromDisk } from "./capabilities/skill-loader";
import { consumeAutostartRefresh } from "./runtime/autostart-refresh";
import { closeAll as closeBrowserSessions, setBrowserInstance } from "./tools/browser";
import { createTelegramPollerSupervisor } from "./integrations/telegram-poller";
import { createDiscordPollerSupervisor } from "./integrations/discord-poller";
import { resolveTunnelConfig, TunnelManager } from "./integrations/tunnel";
import type { PersistedTunnelConfig } from "./types";

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

// One-shot migration for legacy telegram bridges (pre-allowlist). Runs
// once per server start; the migration helper is idempotent so a
// second run is a no-op. Done inside mutateState so the minted
// pairing code lands on disk immediately — minting in a read-only
// path (normalizeState) would create ephemeral codes on every
// inspection.
void mutateState(config.instance, (state) => {
  const migrated = applyLegacyTelegramPairingMigration(state);
  if (migrated) {
    appendLog(config.instance, "messaging.pairing.migrated.applied", { instance: config.instance });
  }
}).catch((error) => {
  appendLog(config.instance, "messaging.pairing.migration.error", {
    error: error instanceof Error ? error.message : String(error)
  });
});

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

// Resolve tunnel config + persist a freshly-generated secret. The secret
// stays stable across restarts so the URL prefix the user bookmarks (or
// saves in Apple Notes) keeps working; only the cloudflared hostname
// rotates. `enabled` defaults to false — operators opt in via
// `gini tunnel enable` (or by editing config.json directly).
const tunnelResolved = resolveTunnelConfig(config);
if (tunnelResolved.mutated) {
  // Persist the resolved tunnel state BOTH to disk and into the
  // in-memory `config` object. Other handlers (e.g.
  // updateAutoApproveSettings in src/runtime/index.ts) write the
  // in-memory config back to disk wholesale on settings changes; if we
  // skipped the in-memory copy here, the next such write would
  // overwrite the disk file's `tunnel.secret` with `undefined` and
  // break every bookmarked URL prefix.
  //
  // We write the FULL resolved shape (secret + enabled + appleNotes),
  // not just the secret. `mutated` is set both for a freshly-minted
  // secret AND when GINI_TUNNEL flipped enabled from default-off to
  // on. The BFF (web/src/lib/runtime.ts:runtimeTunnelState) reads
  // config.json exclusively — it has no view of the runtime's env —
  // so without persisting the env-derived enabled flag the proxy
  // would 404 every tunneled request even though cloudflared is up.
  config.tunnel = {
    ...(config.tunnel ?? {}),
    secret: tunnelResolved.config.secret,
    enabled: tunnelResolved.config.enabled,
    appleNotes: tunnelResolved.config.appleNotes
  };
  try {
    const onDisk = JSON.parse(readFileSync(configPath(config.instance), "utf8")) as Record<string, unknown>;
    const existingTunnel = (onDisk.tunnel ?? {}) as Record<string, unknown>;
    onDisk.tunnel = {
      ...existingTunnel,
      secret: tunnelResolved.config.secret,
      enabled: tunnelResolved.config.enabled,
      appleNotes: tunnelResolved.config.appleNotes
    };
    writeConfigAtomic(config.instance, onDisk);
  } catch (error) {
    appendLog(config.instance, "tunnel.secret.persist.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Target the Next.js web app (not the raw runtime API). The web app
// already proxies /api/* to the runtime via the BFF and serves the full
// settings/chat/etc. UI; tunneling the web port lets a phone scan the
// QR and land on a real product surface. The web port is written by
// the child process after the runtime boots, so we resolve it lazily:
// the manager polls webPortPath() until a port appears, with a 60s
// ceiling that covers a cold Next.js compile.
const tunnelManager = new TunnelManager({
  instance: config.instance,
  config: tunnelResolved.config,
  targetUrl: `http://127.0.0.1:${config.port}`, // placeholder; replaced by resolveWebTarget() below
  logPath: tunnelLogPath(config.instance)
});

async function resolveWebTarget(): Promise<string> {
  const path = webPortPath(config.instance);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let port: number | null = null;
    try {
      const raw = readFileSync(path, "utf8").trim();
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) port = parsed;
    } catch { /* file not yet written */ }
    if (port !== null) {
      // Trust-but-verify the port file. A stale file from a crashed
      // prior run, or a fresh file written by Next.js spawn before
      // `waitForWebHealthz` confirms the server is serving, would
      // otherwise route cloudflared at a dead or half-booted bundle.
      // Hit the runtime's own marker endpoint and only accept the
      // port when it answers with the matching service + instance.
      const url = `http://127.0.0.1:${port}`;
      if (await probeWebHealthy(url)) return url;
    }
    await Bun.sleep(250);
  }
  throw new Error("web port did not appear within 60s — the Next.js server may have failed to start");
}

async function probeWebHealthy(webUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${webUrl}/api/runtime/__healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as
      | { ok?: boolean; service?: string; instance?: string }
      | null;
    return Boolean(
      body && body.ok === true && body.service === "gini-web" && body.instance === config.instance
    );
  } catch {
    return false;
  }
}

// Serializes /api/tunnel PATCH calls. Each new applyConfig invocation
// `.then()`s off this promise so the second caller runs against the
// first caller's post-mutation `tunnelResolved.config.enabled` — without
// it the becameEnabled/becameDisabled diff was racing on the shared
// state and could leave cloudflared running while the persisted config
// said disabled. Caller-visible errors still propagate; the chain itself
// swallows rejections so one failed PATCH cannot poison every subsequent
// PATCH.
let pendingApply: Promise<void> = Promise.resolve();

// Guards both the SIGTERM handler (against concurrent signals) and the
// PATCH-enable path (against spawning cloudflared after shutdown has
// begun). A PATCH that's sitting in `await resolveWebTarget()` when
// SIGTERM arrives must NOT proceed to manager.start() afterwards —
// the drain handler called manager.stop() already, found nothing to
// stop, and would now leak a child past the shutdown deadline.
let shutdownStarted = false;

async function runApplyConfig(
  update: { enabled?: boolean; appleNotes?: { enabled?: boolean } }
): Promise<ReturnType<typeof tunnelManager.getSnapshot>> {
  // Persist BEFORE mutating in-memory state so a write failure (disk
  // full, perms, torn JSON on read-back) aborts the PATCH with a real
  // 5xx instead of returning success + losing the toggle on next
  // restart. Atomic tmp+rename means a reader sees either the prior
  // or next state, never both.
  //
  // Critical: `next` is computed by merging onto the on-disk tunnel
  // slot, NOT onto the runtime's in-memory `config.tunnel`. The
  // in-memory copy was loaded at boot and never refreshes from disk,
  // so `gini tunnel rotate-secret` (which writes the new secret to
  // disk while the runtime is alive) leaves `config.tunnel.secret`
  // stale. If we built `next` from the in-memory copy and persisted
  // it back, PATCH enable would silently overwrite the rotated
  // secret with the boot-time value.
  let next: PersistedTunnelConfig;
  try {
    const onDisk = JSON.parse(readFileSync(configPath(config.instance), "utf8")) as Record<string, unknown>;
    const existingTunnel = (onDisk.tunnel ?? {}) as PersistedTunnelConfig;
    next = { ...existingTunnel };
    if (typeof update.enabled === "boolean") next.enabled = update.enabled;
    if (update.appleNotes) {
      next.appleNotes = { ...(next.appleNotes ?? {}), ...update.appleNotes };
    }
    onDisk.tunnel = next;
    writeConfigAtomic(config.instance, onDisk);
  } catch (error) {
    appendLog(config.instance, "tunnel.config.persist.error", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
  config.tunnel = next;
  // Update the live manager. Two paths:
  //  - Just-enabled: spin cloudflared up now.
  //  - Just-disabled: tear it down.
  //  - Enabled + appleNotes flipped: nothing process-level to do.
  // Also re-spawn cloudflared if config says enabled but no live URL
  // exists (e.g., the previous start() failed, cloudflared crashed
  // and the manager's exit monitor nulled the handle, or the boot-
  // time start aborted from the shutdown guard and the runtime is
  // now back up). Without this, a re-PATCH of `enabled: true` is a
  // no-op and the operator has no UI path to recover short of
  // restarting the runtime.
  const liveHandleMissing = tunnelManager.getSnapshot().publicUrl === null;
  const becameEnabled =
    next.enabled === true
    && (tunnelResolved.config.enabled !== true || liveHandleMissing);
  const becameDisabled = next.enabled === false && tunnelResolved.config.enabled === true;
  // Detect Apple Notes mirror flipping ON. If the tunnel was already
  // running, a flip from false→true via PATCH must immediately push
  // the current URL to the note — otherwise the user toggles "Enable"
  // in the UI and the note stays empty until the next URL rotation
  // (i.e. the next runtime restart). The `becameEnabled` branch
  // already triggers a refresh via TunnelManager.startInner's fire-
  // and-forget, so we only need this branch for the
  // tunnel-already-up case.
  const becameNotesEnabled = update.appleNotes?.enabled === true
    && tunnelResolved.config.appleNotes.enabled !== true;
  tunnelResolved.config = {
    ...tunnelResolved.config,
    enabled: next.enabled ?? tunnelResolved.config.enabled,
    appleNotes: { ...tunnelResolved.config.appleNotes, ...(next.appleNotes ?? {}) }
  };
  // Pull the secret from disk in case `gini tunnel rotate-secret`
  // wrote a new value while the runtime was alive. Without this,
  // manager.start() would build publicUrl with the stale boot-time
  // secret while the BFF (which reads config.json per request)
  // demands the new value — every QR/Notes URL would 404. `next`
  // was sourced from a fresh on-disk read above, so it carries the
  // rotated value.
  tunnelResolved.config = { ...tunnelResolved.config, secret: next.secret ?? tunnelResolved.config.secret };
  tunnelManager.updateConfig({
    enabled: tunnelResolved.config.enabled,
    secret: tunnelResolved.config.secret,
    appleNotes: tunnelResolved.config.appleNotes
  });
  if (becameEnabled) {
    // Resolve the live web port BEFORE spawning cloudflared so the
    // tunnel targets the Next.js UI (full settings/chat surface)
    // rather than the placeholder runtime port (raw /api/* + the
    // bare landing). If resolution fails we MUST NOT fall through
    // to start() — the manager's targetUrl still holds the
    // constructor-time placeholder pointing at the runtime gateway,
    // and spawning cloudflared against that exposes /api/* over the
    // public internet without the BFF's cookie auth, redaction, or
    // proxy.ts secret gate.
    let resolvedTarget: string | null = null;
    let resolveError: Error | null = null;
    try {
      resolvedTarget = await resolveWebTarget();
      tunnelManager.setTargetUrl(resolvedTarget);
    } catch (error) {
      resolveError = error instanceof Error ? error : new Error(String(error));
      appendLog(config.instance, "tunnel.start.error", {
        error: resolveError.message,
        reason: "web target unresolved — refusing to spawn cloudflared against the raw runtime port"
      });
    }
    if (resolvedTarget !== null) {
      if (shutdownStarted) {
        // The SIGTERM drain landed while we were polling
        // resolveWebTarget. Spawning cloudflared now would leak a
        // child past the drain deadline (manager.stop() ran earlier
        // and found nothing because start() hadn't been called yet).
        // Abort the apply silently; the on-disk enabled=true the
        // PATCH already persisted will pick up cloudflared at the
        // next boot, which is the correct semantics.
        appendLog(config.instance, "tunnel.start.aborted", {
          reason: "shutdown in progress"
        });
      } else {
        await tunnelManager.start().catch((error) => {
          appendLog(config.instance, "tunnel.start.error", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    } else if (resolveError !== null) {
      // Propagate the target-resolution failure to the PATCH caller so
      // the client gets a real error (500) with a useful message
      // instead of a misleading 200 + "tunnel enabled" toast for a
      // tunnel that never actually came up. The persisted enabled=true
      // is intentional — the operator's intent is recorded so the next
      // restart attempts again — but the response signals the
      // immediate failure.
      throw new Error(`Failed to bring tunnel up: ${resolveError.message}`);
    }
  }
  if (becameDisabled) {
    await tunnelManager.stop();
  }
  // Notes-enabled-while-tunnel-up: refresh now so the note carries the
  // current URL without waiting for a rotation. Fire-and-forget — the
  // operator's PATCH response shouldn't wait for an osascript pipeline,
  // and refresh errors are surfaced in `appleNotes.lastError` on the
  // next GET. Skip when becameEnabled is also true: the manager's
  // startInner already fires its own refresh after cloudflared comes up.
  if (becameNotesEnabled && !becameEnabled && tunnelResolved.config.enabled) {
    void tunnelManager.refreshAppleNote().catch((error) => {
      appendLog(config.instance, "tunnel.notes.refresh.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return tunnelManager.getSnapshot();
}

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
  fetch: createHandler(config, {
    tunnel: {
      // Only honor the secret-path bypass when the tunnel is actively
      // configured to expose the gateway. The secret itself is persisted
      // on first boot regardless of `enabled` (so flipping the flag later
      // keeps the URL prefix stable), but that persistence must never
      // create an authorization path on a runtime the operator hasn't
      // opted into exposing publicly. Without this gate, anyone who can
      // read `config.json` on the host could reach `/api/*` over
      // localhost by appending the persisted secret, bypassing the
      // bearer-token check the rest of the gateway relies on.
      getSecret: () => (tunnelResolved.config.enabled ? tunnelResolved.config.secret : null),
      // Always return the snapshot — the snapshot carries `enabled` so
      // the UI can render "Off" vs "Live" without having to guess from
      // missing fields. Sensitive content (secret + publicUrl) is still
      // stripped by the BFF redactor before reaching the browser.
      getSnapshot: () => tunnelManager.getSnapshot(),
      // Wire the refresh hook unconditionally so the gateway can re-run
      // the Apple Notes write the moment the operator flips the tunnel
      // ON via the web UI — without this, the hook captured at boot
      // would stay `undefined` for the rest of the process lifetime
      // and GET /api/tunnel would never trigger the documented re-sync
      // path until the next restart. Disabled-state gating moved
      // inside the closure so it consults the live config object that
      // applyConfig mutates.
      refreshAppleNote: () => tunnelResolved.config.enabled
        ? tunnelManager.refreshAppleNote()
        : Promise.resolve(tunnelManager.getSnapshot()),
      // PATCH /api/tunnel routes here. Persists the change to config.json
      // and starts/stops cloudflared accordingly so the UI's toggle
      // takes effect without requiring a runtime restart.
      //
      // Serialized through `pendingApply`: concurrent PATCHes (the UI
      // optimistically fires two toggles in quick succession, or the
      // operator runs `gini tunnel disable` while the web UI is mid-
      // enable) used to race the `becameEnabled` / `becameDisabled`
      // diff against `tunnelResolved.config.enabled`. Both branches read
      // the same shared state pre-mutation, both wrote, and whichever
      // happened to await `resolveWebTarget()` longest won — leaving
      // cloudflared and the persisted config out of sync. Funnelling
      // each call through a chained promise forces the second caller to
      // see the FIRST caller's post-mutation state before computing its
      // own diff.
      applyConfig: (update) => {
        const next = pendingApply.then(() => runApplyConfig(update));
        pendingApply = next.then(() => undefined, () => undefined);
        return next;
      }
    }
  })
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

// Fire-and-forget tunnel bring-up. We don't block listen-readiness on
// cloudflared because the local gateway is already serving and the tunnel
// is a convenience layer. Errors are logged and surfaced through the
// snapshot. The manager is told to stay quiet when the user hasn't
// opted in.
if (tunnelResolved.config.enabled) {
  void (async () => {
    try {
      const target = await resolveWebTarget();
      // Race protection: if applyConfig flipped `enabled` to false while
      // we were waiting for the web port, don't resurrect the tunnel. The
      // user-visible state already says "off" — silently respawning here
      // would put the snapshot back into a live state that contradicts
      // the config and prevents the next disable-toggle from working.
      if (!tunnelResolved.config.enabled) return;
      // Same shutdown guard the PATCH path uses. If SIGTERM arrived
      // while resolveWebTarget was polling, the drain handler already
      // ran tunnelManager.stop() finding nothing to stop; spawning
      // here would leak a child past the drain deadline.
      if (shutdownStarted) {
        appendLog(config.instance, "tunnel.start.aborted", {
          reason: "shutdown in progress (boot path)"
        });
        return;
      }
      tunnelManager.setTargetUrl(target);
      await tunnelManager.start();
    } catch (error) {
      appendLog(config.instance, "tunnel.start.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
}

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

// shutdownStarted is hoisted earlier in the file so runApplyConfig
// can also consult it before spawning cloudflared. Two SIGTERMs in
// rapid succession (launchctl bootout, kill, autostart-refresh self-
// signal) would otherwise race the drain and consume the marker
// twice — best case a wasted spawn, worst case a double-bootstrap.

process.on("SIGTERM", async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  appendLog(config.instance, "runtime.stopped", { signal: "SIGTERM" });
  schedulerStopped = true;
  reprobeStopped = true;
  telegramStopped = true;
  discordStopped = true;
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
      // Close any live headless browser contexts so Chromium child
      // processes exit cleanly with the runtime instead of being reaped
      // by the OS at the very end. Errors are swallowed — a stuck
      // close shouldn't block runtime shutdown.
      closeBrowserSessions().catch(() => {}),
      // Tear down the cloudflared subprocess. The manager swallows its own
      // errors; we still wrap the await defensively so a slow kill can't
      // keep the runtime from exiting.
      tunnelManager.stop().catch(() => {})
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
