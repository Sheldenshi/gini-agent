import { readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { createHandler, writePid } from "./http";
import { runDueJobs } from "./jobs";
import { runConnectorReprobe } from "./jobs/connector-reprobe";
import { runConnectorDetection } from "./jobs/connector-detection";
import { syncProviderMcpServers } from "./integrations/mcp-sync";
import { install } from "./runtime";
import { migrateIfNeeded } from "./memory";
import { configPath, loadConfig, parseInstance, runtimePortPath, tunnelLogPath, webPortPath, writeConfigAtomic } from "./paths";
import { appendLog, mutateState, readState } from "./state";
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
await install(config);
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
    // Disable preemption: a PATCH {enabled: false} arriving during the
    // poll wants to take effect now, not after the remaining deadline.
    // Throwing here lets the caller's catch surface the abort cleanly;
    // boot/recycle paths translate this into a no-op start.
    if (pendingDisable) {
      throw new Error("tunnel disable requested — aborting web target resolution");
    }
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

// Last resolved web target the tunnel was pointed at. Used by the boot
// path and runRecycle to remember which URL the manager is currently
// pointing at for the audit log and for future feature use.
let currentWebTarget: string | null = null;
let webPortWatcher: FSWatcher | null = null;

// Last raw content we saw in the web.port file. Used by the fs.watch
// callback to dedup APFS rename+change pairs (and any other spurious
// fire) WITHOUT taking the tunnel down: the watcher only enqueues a
// runRecycle when the port file's content actually changed (or the
// tunnel is dead and needs recovery). Moving dedup here, rather than
// inside runRecycle, preserves the stop-before-resolve invariant —
// runRecycle never has to resolveWebTarget() before stopping the
// existing tunnel, so a co-tenant can't squat on the freed port while
// cloudflared is still forwarding to it.
let lastSeenWebPortContent: string | null = null;

// Set when the boot tunnel bring-up's resolveWebTarget polled past its 60s
// ceiling. fs.watch only fires on CHANGES to an already-existing file —
// the ENOENT retry path attaches AFTER the file appears, so the appearance
// itself never produces a callback. Without a periodic retry, a slow web
// boot (Next.js cold compile > 60s) would leave cloudflared dormant
// forever even after the port file lands. startBootRecoveryPolling()
// drives a 5s interval that keeps trying runRecycle until cloudflared
// comes up (cloudflareUrl appears), the operator disables the tunnel,
// or shutdown begins.
let bootFailureRecorded = false;

// Holds the boot-recovery interval handle when bootFailureRecorded is
// true. Cleared to null when (a) recovery succeeds, (b) the operator
// disables the tunnel, or (c) shutdown begins. The poll function below
// is idempotent against concurrent calls — startBootRecoveryPolling()
// short-circuits if an interval is already running.
let bootRecoveryInterval: ReturnType<typeof setInterval> | null = null;

// Single-flight latch for the boot-recovery interval. True from the
// moment the interval enqueues a runRecycle onto pendingApply until that
// recycle settles. Without this, a slow runRecycle (resolveWebTarget
// has a 60s ceiling) lets the 5s interval pile up multiple queued
// recycles in pendingApply. That backlog is harmful in two ways: (1) a
// PATCH /api/tunnel disable arriving while the backlog is queued has
// to wait through every queued recycle before its runApplyConfig runs,
// because applyConfig chains off the same pendingApply — the operator
// sees the API hang for minutes; (2) once recovery succeeds and the
// flag clears, every queued recycle still fires sequentially, each
// stopping/starting cloudflared and rotating the public URL. Skip
// enqueue while a prior recovery recycle is still in-flight; the next
// tick will re-check cloudflareUrl and either confirm recovery (clear
// the flag, stop the interval) or schedule the next attempt.
let bootRecoveryRecycleInFlight = false;

// Synchronous latch the PATCH /api/tunnel handler flips the moment a
// disable arrives, observable from in-flight boot/recycle starts so they
// can bail before spawning cloudflared. Without this, the disable's
// runApplyConfig is queued behind the boot/recycle path in pendingApply
// and only runs after resolveWebTarget (up to 60s) plus
// tunnelManager.start (up to cloudflared's 25s startupTimeoutMs) finish
// — the operator's click sits idle for up to 85s while the tunnel comes
// publicly online for cloudflared's startup window. The latch operates
// OUTSIDE pendingApply: applyConfig sets it synchronously when the
// update body says enabled:false (and clears it on enabled:true), then
// the boot/recycle yield points observe it. runApplyConfig clears it
// after the becameDisabled branch runs so a subsequent enable can
// proceed normally.
let pendingDisable = false;

// Periodic re-probe so a silent Next.js death (no fs.watch event,
// since web.port wasn't rewritten) doesn't leave cloudflared
// forwarding to a freed port that a co-tenant could squat on and
// intercept secret-bearing requests. The fs.watch path only fires on
// web.port changes; an OOM/SIGSEGV/panic in the web child can free
// the port WITHOUT rewriting the marker file, so no recycle is
// triggered and the public tunnel keeps forwarding traffic to
// whatever now answers on that port. The probe re-runs
// probeWebHealthy(currentWebTarget) on a fixed cadence; on
// WEB_HEALTH_FAIL_THRESHOLD consecutive failures (one transient blip
// is allowed) it enqueues a runRecycle through pendingApply. The
// recycle's own stop-before-resolve invariant then takes the public
// tunnel down before re-probing the freed port, so the worst case is
// a brief 502 rather than forwarding to a squatter.
const WEB_HEALTH_INTERVAL_MS = 30_000;
const WEB_HEALTH_FAIL_THRESHOLD = 2;
let webHealthInterval: ReturnType<typeof setInterval> | null = null;
let webHealthFailureStreak = 0;

// Set by the health poll path to tell runRecycle "skip your same-port
// elide on the next iteration." Without this signal, runRecycle's
// cheap elide (which compares the web.port file's content to
// currentWebTarget and the live cloudflareUrl) defeats the entire
// silent-web-death recovery path: a SIGSEGV-ed Next.js doesn't
// rewrite web.port and currentWebTarget still points at the dead
// port, so the elide skips every health-triggered recycle and the
// tunnel keeps forwarding to a freed port that any co-tenant could
// squat. The flag is read-and-cleared at the top of each recycle
// loop iteration so a subsequent file-watcher event (the normal
// path) still benefits from the elide.
let recycleSkipElide = false;

// Single-flight latch for the health-driven recycle. True from the
// moment the health interval enqueues a runRecycle onto pendingApply
// until that recycle settles. Mirrors bootRecoveryRecycleInFlight:
// without it, a recycle that takes longer than the 30s health
// interval lets the next tick's failing probe enqueue a SECOND
// forced recycle (recycleSkipElide is still true from the first
// enqueue) — which would rotate the public cloudflared URL a second
// time despite the first recycle having already landed the recovery.
let healthRecycleInFlight = false;

const startWebHealthPolling = (): void => {
  if (webHealthInterval !== null) return;
  webHealthFailureStreak = 0;
  // Single-flight latch so a probe that runs slower than the
  // interval (1s healthz timeout + scheduling jitter) can't overlap
  // with the next tick's probe. Without this, two concurrent
  // failing probes could each bump the streak past the threshold
  // and double-enqueue a recycle.
  let probeInFlight = false;
  webHealthInterval = setInterval(() => {
    if (shutdownStarted || currentWebTarget === null) {
      stopWebHealthPolling();
      return;
    }
    if (probeInFlight) return;
    // If cloudflared isn't running but the operator's intent is still
    // "enabled", it crashed unexpectedly — the manager's exit monitor
    // cleared the handle/URL but does not auto-restart, and the file-
    // watcher path doesn't fire (web.port unchanged). Hand off to the
    // boot-recovery interval, which polls until cloudflared comes
    // back. Without this hand-off, an unexpected cloudflared death
    // leaves the tunnel down until manual disable/re-enable.
    if (tunnelManager.getSnapshot().cloudflareUrl === null) {
      if (tunnelResolved.config.enabled && !bootFailureRecorded) {
        appendLog(config.instance, "tunnel.unexpected.exit.recovering", {});
        bootFailureRecorded = true;
        startBootRecoveryPolling();
      }
      return;
    }
    probeInFlight = true;
    const target = currentWebTarget;
    probeWebHealthy(target).then((healthy) => {
      probeInFlight = false;
      // Discard the result if the target moved while the probe was
      // in flight (a successful recycle landed a new port between
      // probe start and probe resolve). Acting on a stale failure
      // would trigger an unnecessary recycle of the now-healthy
      // new target; acting on a stale success would suppress a
      // legitimate failure detection for the new target.
      if (currentWebTarget !== target) {
        webHealthFailureStreak = 0;
        return;
      }
      if (healthy) {
        webHealthFailureStreak = 0;
        return;
      }
      webHealthFailureStreak += 1;
      if (webHealthFailureStreak >= WEB_HEALTH_FAIL_THRESHOLD) {
        if (healthRecycleInFlight) {
          // A prior health-driven recycle is still queued or
          // executing. Skip this enqueue; the next tick will re-
          // check probeWebHealthy (which the queued recycle's
          // re-resolve has had a chance to make healthy by then),
          // and only enqueue another forced recycle if the failure
          // persists.
          return;
        }
        appendLog(config.instance, "tunnel.web.unhealthy", {
          target,
          streak: webHealthFailureStreak
        });
        webHealthFailureStreak = 0;
        // Signal to runRecycle that the same-port elide must be
        // bypassed: the port file hasn't changed (silent death
        // leaves it stale) but the tunnel needs to tear down so the
        // next resolveWebTarget can re-probe and either land on the
        // restarted web child or surface a stranded state through
        // the recycle's lastError.
        recycleSkipElide = true;
        healthRecycleInFlight = true;
        pendingApply = pendingApply
          .then(runRecycle, () => undefined)
          .finally(() => { healthRecycleInFlight = false; });
      }
    }).catch(() => { probeInFlight = false; });
  }, WEB_HEALTH_INTERVAL_MS);
  // Detach from the event loop so the interval can't keep the
  // process alive past SIGTERM drain. The SIGTERM handler clears
  // the interval explicitly; unref() is the belt to that suspenders.
  webHealthInterval.unref?.();
};

const stopWebHealthPolling = (): void => {
  if (webHealthInterval !== null) {
    clearInterval(webHealthInterval);
    webHealthInterval = null;
  }
  webHealthFailureStreak = 0;
};

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
    const existingTunnel = (onDisk.tunnel ?? {}) as Record<string, unknown>;
    // Apply the same coercion as resolveTunnelConfig at boot. A
    // hand-edited `tunnel.enabled: "false"` (string) on disk would
    // otherwise slip through into `next` and the in-memory state
    // would diverge from what the BFF's strict `=== true` check
    // produces — cloudflared would run while every tunneled request
    // 404s. Strip non-boolean values from the read so the update
    // overwrites the bad data instead of preserving it.
    next = {};
    if (typeof existingTunnel.enabled === "boolean") next.enabled = existingTunnel.enabled;
    if (typeof existingTunnel.secret === "string") next.secret = existingTunnel.secret;
    const existingNotes = existingTunnel.appleNotes as Record<string, unknown> | undefined;
    if (existingNotes) {
      next.appleNotes = {};
      if (typeof existingNotes.enabled === "boolean") next.appleNotes.enabled = existingNotes.enabled;
      if (typeof existingNotes.folder === "string") next.appleNotes.folder = existingNotes.folder;
      if (typeof existingNotes.noteName === "string") next.appleNotes.noteName = existingNotes.noteName;
      if (typeof existingNotes.account === "string") next.appleNotes.account = existingNotes.account;
    }
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
      // Mirror the boot-path failure surface: record on the snapshot so
      // the UI's 5s refetch sees `lastError` and renders the diagnostic
      // instead of leaving the user on "Connecting…" indefinitely. The
      // optimistic toast that fires off the PATCH throw is overwritten
      // by the next snapshot fetch; without recording here the snapshot
      // would arrive as `enabled: true, lastError: null, cloudflareUrl:
      // null` and the rollback hint is lost.
      tunnelManager.recordStartFailure(resolveError.message);
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
      } else if (pendingDisable) {
        // A disable PATCH arrived while we were sitting in
        // resolveWebTarget's polling loop. resolveWebTarget checks
        // pendingDisable at the top of each iteration but not after
        // probeWebHealthy resolves, so a disable flipping the latch
        // during the probe's await window lets us reach this point
        // with a resolved target. Bail out symmetrically with the
        // boot path's check — the queued runApplyConfig for the
        // disable will run next and reconcile state.
        appendLog(config.instance, "tunnel.start.aborted", {
          reason: "disable requested mid-resolve"
        });
      } else {
        let startError: Error | null = null;
        await tunnelManager.start().catch((error) => {
          startError = error instanceof Error ? error : new Error(String(error));
          appendLog(config.instance, "tunnel.start.error", {
            error: startError.message
          });
        });
        if (startError !== null) {
          // The persisted enabled=true is still correct (operator
          // intent recorded for next boot), but the immediate PATCH
          // response should reflect that cloudflared did not come
          // up — propagating the error makes the toast/CLI surface
          // the actual reason ("cloudflared binary missing",
          // "port in use", etc.) instead of a misleading success.
          throw new Error(`Failed to start cloudflared: ${(startError as Error).message}`);
        }
        currentWebTarget = resolvedTarget;
        // Cancel boot recovery now that PATCH brought the tunnel up.
        // Without this, a recycle the interval enqueued while PATCH
        // was waiting on resolveWebTarget can still be queued in
        // pendingApply behind this applyConfig invocation; once it
        // runs it would tear the freshly-started cloudflared down,
        // rotate the URL the operator just received in the PATCH
        // response, and confuse the snapshot. The interval's own
        // tick eventually clears `bootFailureRecorded` via the
        // cloudflareUrl !== null check, but that tick can land
        // AFTER it already enqueued the harmful recycle. Clearing
        // here, synchronously after start() returned a live URL,
        // guarantees no further interval ticks fire and no stale
        // recycle is in flight (the latch is the second leg of
        // that guarantee: if a recycle is already queued, the
        // latch is true and runRecycle will see a live
        // cloudflareUrl + matching currentWebTarget and elide).
        if (bootRecoveryInterval) {
          clearInterval(bootRecoveryInterval);
          bootRecoveryInterval = null;
        }
        bootFailureRecorded = false;
        // Start the periodic web-health probe now that cloudflared
        // is forwarding to a live target. The probe guards against
        // a silent web death that wouldn't trip the fs.watch
        // recycle path (e.g. OOM/SIGSEGV without a port rewrite).
        startWebHealthPolling();
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
    // Stop the periodic web-health probe BEFORE tearing cloudflared
    // down so a tick mid-disable can't observe a still-live snapshot
    // and enqueue a recycle that races the disable.
    stopWebHealthPolling();
    await tunnelManager.stop();
  }
  // Clear the synchronous preemption latch whenever a disable PATCH
  // settles, regardless of whether it triggered an actual stop. A
  // no-op disable (PATCH {enabled:false} while already disabled) sets
  // the latch in the wrapper but DOES NOT reach the becameDisabled
  // branch — so without this unconditional clear, a subsequent enable
  // PATCH would resolveWebTarget, observe the stale latch, and throw
  // "tunnel disable requested" against an enable the operator just
  // issued.
  if (update?.enabled === false) {
    pendingDisable = false;
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
      // and `POST /api/tunnel/refresh-notes` would never trigger the
      // documented re-sync path until the next restart. Disabled-state
      // gating moved inside the closure so it consults the live config
      // object that applyConfig mutates.
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
        // Flip the synchronous disable latch BEFORE chaining onto
        // pendingApply so in-flight boot/recycle starts can observe it
        // and bail. A subsequent enable PATCH clears the latch so the
        // next boot/recycle isn't preempted by a stale signal.
        if (update?.enabled === false) {
          pendingDisable = true;
          // Fire-and-forget stop OUTSIDE pendingApply to abort an
          // in-flight cloudflared spawn synchronously. Without this,
          // a disable PATCH that arrives while a prior enable's
          // `await tunnelManager.start()` is mid-spawn has to wait for
          // the spawn to settle (up to cloudflared's 25s
          // startupTimeoutMs) before the queued runApplyConfig reaches
          // its becameDisabled branch — and during that window
          // spawnQuickTunnel can advertise a public URL, putting the
          // tunnel publicly online against the operator's wishes.
          // tunnelManager.stop() aborts spawnAbort immediately so the
          // in-flight spawn rejects with "cloudflared spawn aborted"
          // and the child is killed inside the spawn's catch path.
          // stop() is idempotent: the queued runApplyConfig's own
          // becameDisabled stop() call observes a stopped manager and
          // no-ops the second teardown. Errors are logged but not
          // propagated — the queued runApplyConfig is the source of
          // truth for the PATCH response.
          void tunnelManager.stop().catch((error) => {
            appendLog(config.instance, "tunnel.disable.preempt.stop.error", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
        // Don't clear pendingDisable on enable — that's the disable's
        // runApplyConfig job (its becameDisabled branch clears the
        // latch authoritatively). If a disable is queued ahead of this
        // enable in pendingApply, clearing the latch synchronously here
        // would let an EARLIER in-flight start (an enable from before
        // the disable arrived, sitting in resolveWebTarget) resume past
        // its pendingDisable check and spawn cloudflared against the
        // disable signal. The persist-failure catch on the chained
        // promise also clears the latch if the disable's runApplyConfig
        // throws, so a stuck-true latch is recovered through that path
        // rather than swept under by a later enable's wrapper.
        const next = pendingApply.then(() => runApplyConfig(update));
        pendingApply = next.then(() => undefined, () => undefined);
        // Clear pendingDisable on rejection so the latch doesn't stay
        // stuck true after a persist failure. The fire-and-forget
        // stop() above already tore the tunnel down; runApplyConfig
        // hitting writeConfigAtomic and throwing prevents its
        // becameDisabled branch from clearing the latch the success
        // path would. Without this catch, the latch would suppress
        // every subsequent recycle/boot for the rest of the process
        // lifetime (a follow-up enable PATCH would unstick it, but
        // operators don't always reach for that).
        next.catch(() => {
          if (update?.enabled === false) pendingDisable = false;
        });
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
  // Fold the boot bring-up through the same pendingApply chain
  // PATCH /api/tunnel uses. Without this serialization, a PATCH
  // that landed while this IIFE was sitting in resolveWebTarget
  // ran concurrently — manager.start() short-circuits on
  // `this.starting !== null` and returns the boot's in-flight
  // promise, so the PATCH's `setTargetUrl(newPort)` was silently
  // lost (boot's `startInner` captured the old targetUrl
  // synchronously when its frame opened). Chaining boot through
  // pendingApply means the PATCH's runApplyConfig awaits boot's
  // completion before computing its own becameEnabled decision.
  pendingApply = pendingApply.then(async () => {
    try {
      const target = await resolveWebTarget();
      // Race protection: if applyConfig flipped `enabled` to false while
      // we were waiting for the web port, don't resurrect the tunnel. The
      // user-visible state already says "off" — silently respawning here
      // would put the snapshot back into a live state that contradicts
      // the config and prevents the next disable-toggle from working.
      // tunnelResolved.config.enabled can only flip when runApplyConfig
      // runs, and that's queued behind this boot path in pendingApply —
      // it can't have changed yet. pendingDisable (set synchronously by
      // applyConfig) IS observable here, so consult both: the latch
      // catches the in-flight preemption case, the field catches a
      // stale resurrection of an already-disabled config.
      if (!tunnelResolved.config.enabled || pendingDisable) return;
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
      currentWebTarget = target;
      // Start the periodic web-health probe now that cloudflared
      // is forwarding to a live target. Guards against a silent
      // web death that wouldn't trip the fs.watch recycle path.
      startWebHealthPolling();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(config.instance, "tunnel.start.error", { error: message });
      // A pendingDisable-triggered abort is the operator getting what
      // they asked for, not a startup failure to surface. Skip the
      // snapshot lastError + recovery interval so the Settings card
      // doesn't show "Connecting…" + a misleading error after the
      // queued runApplyConfig completes the disable.
      if (pendingDisable) return;
      // Surface the failure on the snapshot so a GET /api/tunnel
      // immediately after boot shows the operator why cloudflared
      // never came up. Previously the error was only in the log
      // file, so the Settings card would sit on "Connecting…"
      // indefinitely with no diagnostic.
      tunnelManager.recordStartFailure(message);
      // Mark and start a periodic retry interval. resolveWebTarget's
      // 60s ceiling can fire on a cold Next.js compile while the web
      // child is still in flight; the interval keeps retrying every
      // 5s until cloudflared comes up, the operator disables the
      // tunnel, or shutdown begins. The interval is self-terminating
      // on each of those conditions (see startBootRecoveryPolling).
      bootFailureRecorded = true;
      startBootRecoveryPolling();
    }
  });
  // The chain itself swallows rejections (it can't; the inner
  // try/catch is exhaustive) so future PATCH .then()s aren't
  // poisoned even on the unlikely case of a thrown-error escape.
  pendingApply = pendingApply.then(() => undefined, () => undefined);
}

// Recycle cloudflared when the web port rebinds. `gini start` can
// relaunch web on a different port while the runtime is still alive;
// without this watcher cloudflared would keep forwarding to the old
// port, exposing whatever process now binds it. fs.watch fires on the
// file replace, we re-resolve the live target, and if it diverges we
// stop+start the manager so the public URL points at the new port.
//
// `gini start` spawns the runtime BEFORE the web child writes
// web.port, so the file doesn't exist yet at this point in boot.
// fs.watch throws ENOENT on a missing path; we retry every 500ms
// until either the file appears (the typical case) or shutdown
// begins.
//
// The handler is serialized through an in-flight flag so two rapid
// `change` events can't race on `stop()` and `start()` — without it,
// the second invocation could observe `currentWebTarget` mid-reset
// and run setTargetUrl + start against a manager whose stop is
// still in flight.
let recycleInFlight = false;
let recyclePending = false;
const runRecycle = async (): Promise<void> => {
  if (shutdownStarted) return;
  if (!tunnelResolved.config.enabled) return;
  // Disable preemption — pendingDisable is the synchronous latch the
  // PATCH path flips before chaining. Honoring it here lets a watcher
  // event that landed in pendingApply ahead of the disable runApplyConfig
  // bail out rather than running a doomed stop/start that the disable
  // would immediately undo. Without this, every queued recycle would
  // wait for resolveWebTarget + spawn to settle.
  if (pendingDisable) return;
  if (recycleInFlight) {
    // A change landed while we were already recycling. Flag the
    // re-run so the in-flight handler picks it up on completion;
    // dropping it would leave the tunnel on a stale target if the
    // last write happened during a cycle. The flag coalesces
    // multiple events into a single follow-up run, which is fine
    // because the only signal we care about is "current port may
    // have moved" — resolveWebTarget always reads the latest.
    recyclePending = true;
    return;
  }
  recycleInFlight = true;
  try {
    do {
      recyclePending = false;
      // Cheap elide: if the file's port matches the URL we already
      // forwarded to AND cloudflared is alive, the queued recycle
      // is stale (a prior recycle or the PATCH path already landed
      // the same target). Skip the stop/start cycle to avoid
      // rotating the public URL for no reason. This is safe to do
      // BEFORE stop because the comparison is a synchronous file
      // read against the port number we already routed to — no
      // resolveWebTarget() call, no healthz poll, no 60s window
      // during which a co-tenant could squat the freed port.
      //
      // The full dedup (skipping recycles when the file content
      // matches what the watcher last saw AND the tunnel is alive)
      // still lives in the fs.watch callback in
      // tryRegisterWebPortWatcher; this elide here covers a
      // different case — a stale recycle queued before the file
      // changed but executed after the current target was already
      // updated by an interleaved PATCH or another recycle.
      // Read-and-clear the health-poll bypass signal so this iteration
      // forces a full stop/resolve/start even when the file content
      // matches the current target. The flag covers the silent web
      // death case (Next.js SIGSEGV without rewriting web.port) — see
      // the recycleSkipElide declaration above.
      const skipElide = recycleSkipElide;
      recycleSkipElide = false;
      try {
        const currentFileContent = readFileSync(webPortPath(config.instance), "utf8").trim();
        const cachedUrl = currentWebTarget;
        if (
          !skipElide
          && cachedUrl !== null
          && cachedUrl === `http://127.0.0.1:${currentFileContent}`
          && tunnelManager.getSnapshot().cloudflareUrl !== null
        ) {
          continue;
        }
      } catch { /* file vanished or unreadable; fall through to recycle */ }
      // Stop BEFORE resolving the new target. The web.port file
      // changed (or the boot-recovery interval is reattempting a
      // failed bring-up), which means the previous web rebound (or
      // another gini start replaced it). The freed port may already
      // have been grabbed by a co-tenant local service; keeping
      // cloudflared forwarding to it while we probe the new port
      // would briefly expose that squatter through the public URL.
      // Stopping first means the worst case is a 502 (tunnel
      // closed) for the resolve+spawn window — much safer than
      // a wrong target.
      //
      // Dedup (skipping the recycle entirely when neither port nor
      // health changed) lives in the fs.watch callback in
      // tryRegisterWebPortWatcher; the elide above covers the
      // queued-stale case without violating the stop-before-resolve
      // invariant because it doesn't call resolveWebTarget().
      await tunnelManager.stop();
      const previousTarget = currentWebTarget;
      currentWebTarget = null;
      if (shutdownStarted || !tunnelResolved.config.enabled || pendingDisable) return;
      const target = await resolveWebTarget();
      appendLog(config.instance, "tunnel.target.changed", {
        from: previousTarget,
        to: target
      });
      if (shutdownStarted || !tunnelResolved.config.enabled || pendingDisable) return;
      tunnelManager.setTargetUrl(target);
      await tunnelManager.start();
      currentWebTarget = target;
      // Restart the periodic web-health probe against the fresh
      // target. A prior probe was reset by stopWebHealthPolling()
      // in the becameDisabled branch (if reached) or is harmlessly
      // idempotent here; either way, ensure the probe is running
      // against the current target after a recycle succeeds.
      startWebHealthPolling();
    } while (recyclePending && !shutdownStarted && tunnelResolved.config.enabled && !pendingDisable);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(config.instance, "tunnel.target.recycle.error", {
      error: message
    });
    // A pendingDisable-triggered abort is the operator getting what
    // they asked for, not a recycle failure. The queued
    // runApplyConfig will complete the disable in its own frame; no
    // need to flag the snapshot or start the recovery interval (which
    // would immediately self-terminate on the disable anyway, but the
    // misleading lastError on the snapshot would linger).
    if (pendingDisable) return;
    // Mirror the boot-failure recovery path. The recycle ran `stop()`
    // before `resolveWebTarget()` to preserve the stop-before-resolve
    // invariant; if resolve (or the subsequent start) threw, the
    // tunnel is now down while config still says `enabled: true`. Without
    // surfacing the error AND scheduling a retry, the operator's
    // Settings card would sit on "Off" with no diagnostic and no path
    // back to a live tunnel short of a manual disable/re-enable.
    //
    // `bootFailureRecorded` is the same latch the boot path sets — the
    // interval's terminal conditions (cloudflareUrl !== null /
    // !enabled / shutdownStarted) all apply equally to a stranded
    // recycle, so reusing the polling loop is correct.
    tunnelManager.recordStartFailure(message);
    bootFailureRecorded = true;
    startBootRecoveryPolling();
  } finally {
    recycleInFlight = false;
  }
};

// Periodic retry for a failed boot-time tunnel bring-up. The boot IIFE
// calls this after recording bootFailureRecorded; the interval ticks
// every 5s until one of these terminal conditions is met:
//
//   - shutdownStarted          (process is going down; abandon)
//   - !bootFailureRecorded     (someone else already cleared the flag)
//   - tunnel reports live URL  (recovery succeeded; clear flag and stop)
//   - tunnel disabled          (operator opted out; clear flag and stop)
//
// Otherwise each tick enqueues runRecycle through pendingApply. Failed
// retries naturally re-arm for the next tick because we deliberately do
// NOT clear bootFailureRecorded inside the tick — the next tick checks
// cloudflareUrl, and only the success path clears the flag.
//
// This replaces the earlier one-shot, attach-time recovery in
// tryRegisterWebPortWatcher, which failed in two modes: (1) the watcher
// attached AFTER boot timed out and the recovery runRecycle's own
// resolveWebTarget also timed out, leaving no further retry; (2) the
// watcher attached BEFORE boot timed out, then never re-fired because
// the port file didn't change again after bootFailureRecorded was set.
const startBootRecoveryPolling = (): void => {
  if (bootRecoveryInterval !== null) return;
  bootRecoveryInterval = setInterval(() => {
    if (shutdownStarted) {
      clearInterval(bootRecoveryInterval!);
      bootRecoveryInterval = null;
      return;
    }
    if (!bootFailureRecorded) {
      clearInterval(bootRecoveryInterval!);
      bootRecoveryInterval = null;
      return;
    }
    if (tunnelManager.getSnapshot().cloudflareUrl !== null) {
      bootFailureRecorded = false;
      clearInterval(bootRecoveryInterval!);
      bootRecoveryInterval = null;
      return;
    }
    if (!tunnelResolved.config.enabled) {
      bootFailureRecorded = false;
      clearInterval(bootRecoveryInterval!);
      bootRecoveryInterval = null;
      return;
    }
    // Otherwise: enqueue another recycle attempt — but only if no
    // prior recovery recycle is still in-flight. Coalescing here
    // prevents a backlog of recycles from accumulating in
    // pendingApply when runRecycle takes longer than the 5s tick
    // (resolveWebTarget alone can poll up to 60s). The backlog
    // would (a) block a PATCH /api/tunnel disable behind every
    // queued recycle, since applyConfig chains off the same
    // pendingApply; (b) re-fire cloudflared stop/start sequences
    // after recovery already succeeded, rotating the public URL
    // for no reason. Do NOT clear bootFailureRecorded here — the
    // next tick's cloudflareUrl check is what confirms recovery.
    // A failed recycle stays pending and is retried next tick.
    if (bootRecoveryRecycleInFlight) return;
    bootRecoveryRecycleInFlight = true;
    pendingApply = pendingApply
      .then(runRecycle, () => undefined)
      .finally(() => { bootRecoveryRecycleInFlight = false; });
  }, 5000);
  // Detach from the event loop so the interval can't keep the
  // process alive past SIGTERM drain. The SIGTERM handler clears
  // the interval explicitly, but unref() is the belt to that
  // suspenders — without it, a missed clear path would block exit.
  bootRecoveryInterval.unref?.();
};

const tryRegisterWebPortWatcher = (): void => {
  if (webPortWatcher !== null) return;
  if (shutdownStarted) return;
  try {
    // Seed lastSeenWebPortContent BEFORE installing watch() so the
    // dedup check in the watcher callback has a defined baseline. If
    // we seed AFTER watch() registers, a port rewrite landing in the
    // gap (between watch() install and seed-read) shows the same V2
    // value to both the seed read AND the watcher callback — the
    // dedup compares V2 to V2 and swallows the event, leaving the
    // tunnel pointed at the stale V1 port.
    //
    // Caveat: a rewrite that lands AFTER the seed read but BEFORE
    // watch() registers still can't trigger a callback (fs.watch
    // only fires on events that happen after registration). The
    // gap between seed and watch() is microseconds — synchronous
    // ops with no awaits between them — so the practical chance of
    // a write hitting in that window is small. The next legitimate
    // rewrite after watch() registers will recycle correctly
    // because its file content differs from the stale seed. We
    // can't close the residual gap without OS-level inotify or a
    // cross-platform shim that isn't worth the complexity for a
    // sub-millisecond window.
    try {
      lastSeenWebPortContent = readFileSync(webPortPath(config.instance), "utf8").trim();
    } catch {
      lastSeenWebPortContent = null;
    }
    // Watch the PARENT DIRECTORY, not the file. fs.watch on Linux/macOS
    // resolves the path to an inode at watch() time and continues
    // watching that inode forever. `gini stop` deletes web.port; the
    // subsequent `gini start` writes a new web.port with a NEW inode,
    // which the old watcher never sees — port changes silently miss
    // and cloudflared keeps forwarding to the previous port (or to a
    // nothing-there target the freed port now points at).
    //
    // Watching the directory instead means we see every event in the
    // directory; we filter the callback by basename so a sibling file
    // (config.json rewrites, state.json updates, etc.) doesn't kick
    // off a spurious tunnel recycle.
    const portFile = webPortPath(config.instance);
    const watchDir = dirname(portFile);
    const portFileName = basename(portFile);
    webPortWatcher = watch(watchDir, { persistent: false }, (_event, filename) => {
      // Filter to our file only. fs.watch fires for every sibling
      // change in the directory; recycling on a config.json rewrite
      // would be a needless cloudflared rotation.
      if (filename !== portFileName) return;
      // Dedup at the watcher level so a duplicate fs.watch event for
      // a single write (APFS commonly fires rename+change pairs) does
      // not tear down a live tunnel. Read the current port file
      // content; if it matches the last value we observed AND
      // cloudflared is up, swallow the event. Otherwise enqueue a
      // recycle. A read failure (file vanished or perms blip) is
      // treated as "changed" — runRecycle will retry resolve and
      // either succeed or surface the error on the snapshot.
      //
      // Doing dedup here, rather than at the top of runRecycle,
      // preserves the stop-before-resolve invariant: runRecycle no
      // longer has to resolveWebTarget() before stopping the
      // existing tunnel, so a co-tenant can't squat on the freed
      // port while cloudflared still forwards to it.
      let currentContent: string | null;
      try {
        currentContent = readFileSync(portFile, "utf8").trim();
      } catch {
        currentContent = null;
      }
      const tunnelAlive = tunnelManager.getSnapshot().cloudflareUrl !== null;
      if (
        currentContent !== null
        && currentContent === lastSeenWebPortContent
        && tunnelAlive
      ) {
        return;
      }
      lastSeenWebPortContent = currentContent;
      // Chain recycles through the same pendingApply queue as
      // boot/PATCH so the watcher can't kick off a stop() while a
      // PATCH is mid-start. Without this, a port-rotation event
      // racing a PATCH enable could tear down cloudflared after
      // the manager's start() committed, leaving the snapshot
      // inconsistent with the spawned subprocess.
      pendingApply = pendingApply.then(runRecycle, () => undefined);
    });
  } catch {
    // Instance directory missing or not yet created. We watch the
    // directory rather than the file (see above) so this catch
    // covers the cold-boot case where the runtime started before
    // ensureDir(instanceRoot) ran for some reason; retry until the
    // path is available or SIGTERM lands.
    setTimeout(tryRegisterWebPortWatcher, 500).unref?.();
  }
};
tryRegisterWebPortWatcher();

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
  // Fire tunnelManager.stop() SYNCHRONOUSLY (before server.stop's up-to-
  // SERVER_DRAIN_TIMEOUT_MS wait). The manager's stop() triggers
  // spawnAbort, which makes any in-flight cloudflared spawn reject
  // BEFORE its URL banner reaches stderr. Without this, the 5s server-
  // drain window could let an in-flight spawn complete and publish a
  // public URL while we're already shutting down. Mirrors the
  // applyConfig's disable preemption pattern (fire-and-forget stop
  // outside pendingApply). The later tunnelManager.stop() inside the
  // Promise.all drain is idempotent thanks to the manager's stopPromise
  // cache, so this isn't a double-stop.
  void tunnelManager.stop().catch((error) => {
    appendLog(config.instance, "tunnel.shutdown.preempt.stop.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
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
      tunnelManager.stop().catch(() => {}),
      // Close the web-port watcher so its fs handle doesn't keep the
      // process alive past the drain. Synchronous; the close() promise
      // is just wrapped to fit the Promise.all shape.
      Promise.resolve().then(() => { try { webPortWatcher?.close(); } catch { /* ignore */ } }),
      // Stop the boot-recovery retry interval if it's still ticking.
      // The interval also self-terminates on its next tick when it
      // observes shutdownStarted, but clearing here is immediate and
      // avoids an extra event-loop wake during drain. Wrapped in a
      // resolved promise to match the Promise.all shape.
      Promise.resolve().then(() => {
        if (bootRecoveryInterval) {
          clearInterval(bootRecoveryInterval);
          bootRecoveryInterval = null;
        }
      }),
      // Stop the periodic web-health probe. Same rationale as the
      // boot-recovery interval: the probe self-terminates on its
      // next tick when it observes shutdownStarted, but an explicit
      // clear during drain avoids an extra event-loop wake.
      Promise.resolve().then(() => { stopWebHealthPolling(); })
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
