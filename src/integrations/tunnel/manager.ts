// Tunnel orchestrator. Owns:
//   - the cloudflared subprocess lifecycle
//   - the per-instance secret path
//   - the Apple Notes mirror (when iCloud is signed in)
//   - the in-memory snapshot read by `/api/tunnel/*` endpoints
//
// One manager instance per gateway process. The HTTP layer holds a
// reference so request handlers can read the current URL + secret without
// reaching into the subprocess.

import { appendLog } from "../../state";
import type { Instance, PersistedAppleNotesConfig, PersistedTunnelConfig, RuntimeConfig } from "../../types";
import {
  isICloudAccountAvailable,
  updateAppleNote,
  type AppleNotesTarget,
  type RunOsascript
} from "./apple-notes";
import { spawnQuickTunnel, type SpawnTunnelOptions, type TunnelHandle } from "./cloudflared";
import { encodeQr, renderQrAnsi, renderQrSvg } from "./qr";
import { generateSecret, normalizeSecret } from "./secret-path";

// Resolved tunnel config: every PersistedTunnelConfig field with defaults
// applied. New fields added to the persisted shape automatically widen
// this resolved shape too, so the manager and CLI surfaces stay in sync
// without a manual second declaration.
export type TunnelConfig = Required<PersistedTunnelConfig> & {
  appleNotes: Required<PersistedAppleNotesConfig>;
};

export interface TunnelSnapshot {
  /** Whether the operator has opted into running cloudflared at all. */
  enabled: boolean;
  /** Public URL with the secret path appended (`https://x.trycloudflare.com/<secret>/`). */
  publicUrl: string | null;
  /** Raw cloudflared URL without the secret path. */
  cloudflareUrl: string | null;
  /** Stable per-instance secret used to build the public URL. */
  secret: string;
  /** Local origin cloudflared is forwarding to. */
  targetUrl: string;
  /** When the current URL was first observed. */
  observedAt: string | null;
  /** Apple Notes mirror status. */
  appleNotes: {
    enabled: boolean;
    folder: string;
    noteName: string;
    /** `null` until we have observed an iCloud lookup result. */
    available: boolean | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  };
  /** Last error from the cloudflared subprocess, if any. */
  lastError: string | null;
}

export interface TunnelManagerOptions {
  instance: Instance;
  config: TunnelConfig;
  targetUrl: string;
  // Injection seams used by tests.
  spawn?: SpawnTunnelOptions["spawn"];
  osascript?: RunOsascript;
  binary?: string;
  logPath?: string;
  /**
   * Disable Apple Notes side-effects (used by tests). Bypasses the iCloud
   * detection round-trip entirely.
   */
  disableAppleNotes?: boolean;
}

export class TunnelManager {
  private readonly instance: Instance;
  private readonly config: TunnelConfig;
  private targetUrl: string;
  private readonly spawn?: SpawnTunnelOptions["spawn"];
  private readonly osascript?: RunOsascript;
  private readonly binary?: string;
  private readonly logPath?: string;
  private readonly disableAppleNotes: boolean;
  private handle: TunnelHandle | null = null;
  private snapshot: TunnelSnapshot;
  private stopping = false;
  private monitor: Promise<void> | null = null;
  // AbortController fed into `spawnQuickTunnel` so stop() can cancel an
  // in-flight spawn instead of waiting out the full startup timeout. The
  // gateway's shutdown drain is bounded at SCHEDULER_DRAIN_TIMEOUT_MS;
  // without an abort, a SIGTERM landing mid-spawn would orphan the
  // cloudflared child past process.exit.
  private spawnAbort: AbortController | null = null;
  // In-flight start. Concurrent start() callers share this single promise so
  // we never spawn two cloudflared subprocesses for one manager. Cleared
  // when the spawn settles (success or failure).
  private starting: Promise<TunnelSnapshot> | null = null;
  // Records the most recent stop() promise so callers (and overlapping
  // start() invocations) can await an in-flight teardown before kicking off
  // a fresh tunnel. Cleared when the teardown settles.
  private stopPromise: Promise<void> | null = null;
  // Tracks any in-flight Apple Notes write so stop() can await it before
  // declaring the manager torn down. Without this, a slow osascript write
  // can land snapshot mutations after the user has stopped the manager.
  private notesRefresh: Promise<TunnelSnapshot> | null = null;
  // AbortController fed into every osascript invocation. stop() triggers
  // it so a hung Notes.app permission prompt cannot keep the runtime
  // alive past its shutdown drain budget.
  private notesAbort: AbortController | null = null;

  constructor(opts: TunnelManagerOptions) {
    this.instance = opts.instance;
    this.config = opts.config;
    this.targetUrl = opts.targetUrl;
    this.spawn = opts.spawn;
    this.osascript = opts.osascript;
    this.binary = opts.binary;
    this.logPath = opts.logPath;
    this.disableAppleNotes = opts.disableAppleNotes ?? false;
    this.snapshot = {
      enabled: this.config.enabled,
      publicUrl: null,
      cloudflareUrl: null,
      secret: this.config.secret,
      targetUrl: this.targetUrl,
      observedAt: null,
      appleNotes: {
        enabled: this.config.appleNotes.enabled,
        folder: this.config.appleNotes.folder,
        noteName: this.config.appleNotes.noteName,
        available: null,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    };
  }

  getSnapshot(): TunnelSnapshot {
    return { ...this.snapshot, appleNotes: { ...this.snapshot.appleNotes } };
  }

  /**
   * Update the local origin cloudflared forwards to. Used by the runtime
   * to swap from a placeholder URL to the resolved web port once
   * Next.js has finished booting. Must be called before `start()` —
   * after the manager owns a live handle, the cloudflared subprocess
   * is already bound to the prior target.
   */
  setTargetUrl(url: string): void {
    this.targetUrl = url;
    this.snapshot = { ...this.snapshot, targetUrl: url };
  }

  /**
   * Mutate the live config a running manager observes. Used by the
   * runtime's `applyConfig` hook so flipping `enabled` or the Apple
   * Notes toggle from the web UI takes effect immediately for any
   * subsequent refresh — the manager is constructed once at boot and
   * persists across HTTP requests.
   */
  updateConfig(update: { enabled?: boolean; appleNotes?: TunnelConfig["appleNotes"] }): void {
    if (typeof update.enabled === "boolean") {
      (this.config as { enabled: boolean }).enabled = update.enabled;
      // Mirror onto the snapshot so the UI sees the toggle change
      // immediately, even if cloudflared has not yet been torn down.
      this.snapshot = { ...this.snapshot, enabled: update.enabled };
    }
    if (update.appleNotes) {
      (this.config as { appleNotes: TunnelConfig["appleNotes"] }).appleNotes = {
        ...this.config.appleNotes,
        ...update.appleNotes
      };
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          enabled: this.config.appleNotes.enabled,
          folder: this.config.appleNotes.folder,
          noteName: this.config.appleNotes.noteName
        }
      };
    }
  }

  /**
   * Await any in-flight Apple Notes refresh. Returns immediately when no
   * write is pending. Tests use this to wait deterministically for the
   * fire-and-forget refresh kicked off by `start()`; production callers
   * generally do not need it.
   */
  async flushNotes(): Promise<TunnelSnapshot> {
    if (this.notesRefresh) {
      try { await this.notesRefresh; } catch { /* errors already logged */ }
    }
    return this.getSnapshot();
  }

  /**
   * Spin up cloudflared. Resolves once the public URL has been observed.
   * Concurrent callers share a single in-flight spawn so the manager
   * never owns two cloudflared subprocesses simultaneously. Subsequent
   * calls after a successful start return the existing snapshot.
   */
  async start(): Promise<TunnelSnapshot> {
    if (this.handle) return this.getSnapshot();
    if (this.starting) return this.starting;
    // Wait for an in-flight teardown to complete before spawning a new
    // tunnel. The stopInner path nulls `this.handle` before awaiting
    // `handle.stop()`, so without this guard a fast caller can see no
    // live handle, set `stopping = false`, and spawn cloudflared while
    // the lingering stop() is still in its handle.stop() await. When
    // stop() then resumes, its later clauses (`monitor`, `notesRefresh`
    // cleanup, snapshot clear) would clobber the freshly-started tunnel.
    if (this.stopPromise) {
      try { await this.stopPromise; } catch { /* errors already logged */ }
    }
    if (this.handle) return this.getSnapshot();
    if (this.starting) return this.starting;
    this.stopping = false;
    const startPromise = this.startInner();
    this.starting = startPromise;
    try {
      return await startPromise;
    } finally {
      // Only clear the slot when *this* promise is still the registered
      // in-flight start. A stop() that ran during spawn may have already
      // replaced the slot with null, in which case we leave it alone.
      if (this.starting === startPromise) this.starting = null;
    }
  }

  private async startInner(): Promise<TunnelSnapshot> {
    this.spawnAbort = new AbortController();
    let handle: TunnelHandle;
    try {
      handle = await spawnQuickTunnel({
        targetUrl: this.targetUrl,
        binary: this.binary,
        logPath: this.logPath,
        spawn: this.spawn,
        signal: this.spawnAbort.signal
      });
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        lastError: error instanceof Error ? error.message : String(error)
      };
      appendLog(this.instance, "tunnel.spawn.error", { error: this.snapshot.lastError });
      throw error;
    }
    // If stop() ran while spawn was in flight, the user no longer wants
    // this tunnel. Tear the freshly-born child down ourselves instead of
    // leaving it as an orphan, and surface the cancellation as the
    // start() return value (publicUrl: null, lastError set).
    if (this.stopping) {
      try { await handle.stop(); } catch { /* best effort */ }
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        cloudflareUrl: null,
        lastError: "cloudflared cancelled by concurrent stop()"
      };
      appendLog(this.instance, "tunnel.start.cancelled", { url: handle.url });
      return this.getSnapshot();
    }
    this.handle = handle;
    const observedAt = new Date().toISOString();
    // Emit the bare-secret form (no trailing slash). Next 16 308s the
    // trailing-slash form back to bare anyway; encoding the bare form
    // directly in the QR / Notes / CLI saves a redirect hop and avoids
    // any scanner that follows redirects timing out on the bounce.
    const publicUrl = `${handle.url}/${this.config.secret}`;
    this.snapshot = {
      ...this.snapshot,
      publicUrl,
      cloudflareUrl: handle.url,
      observedAt,
      lastError: null
    };
    appendLog(this.instance, "tunnel.started", {
      url: handle.url,
      target: this.targetUrl,
      pid: handle.pid
    });

    if (this.config.appleNotes.enabled && !this.disableAppleNotes) {
      // Fire-and-forget refresh, but do NOT store the catch-wrapped
      // promise on `this.notesRefresh` — `refreshAppleNote()` already
      // owns that slot and clears it on settle by identity comparison.
      // If we wrapped + reassigned here, the inner promise's finally
      // would see a different value in the slot, skip the clear, and
      // pin the latch forever, blocking every subsequent refresh.
      // Errors are reported via the `tunnel.notes.error` log path.
      void this.refreshAppleNote().catch((error) => {
        appendLog(this.instance, "tunnel.notes.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    // Watch the subprocess so an unexpected exit surfaces in the snapshot
    // and clears the live-handle state. Without nulling `this.handle`, the
    // next `start()` would see a dangling handle and short-circuit on
    // `if (this.handle) return getSnapshot()`, leaving the user stuck on
    // a failed-tunnel snapshot until they explicitly called stop().
    this.monitor = handle.exited.then((code) => {
      if (this.stopping) return;
      if (this.handle === handle) this.handle = null;
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        cloudflareUrl: null,
        lastError: `cloudflared exited unexpectedly (code ${code})`
      };
      appendLog(this.instance, "tunnel.exited", { code, expected: false });
    });

    return this.getSnapshot();
  }

  /**
   * Tear down the cloudflared subprocess. Idempotent and safe to call
   * during an in-flight start: when the spawn settles, startInner sees
   * `stopping === true` and tears the new child down itself.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const stopPromise = this.stopInner();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async stopInner(): Promise<void> {
    // Abort any in-flight spawn so the startup race ends inside the
    // gateway's drain budget instead of running out the full
    // `startupTimeoutMs`. The catch in spawnQuickTunnel kills the
    // freshly-spawned child and closes the log handle, so this path is
    // safe to invoke even when no spawn is in flight.
    if (this.spawnAbort) {
      try { this.spawnAbort.abort(); } catch { /* ignore */ }
      this.spawnAbort = null;
    }
    // Same for an in-flight osascript pipeline. Without this, a Notes
    // permission prompt that's waiting for the user keeps the manager
    // (and the runtime drain) alive for the full OSASCRIPT_TIMEOUT_MS,
    // potentially overrunning SCHEDULER_DRAIN_TIMEOUT_MS in src/server.ts
    // and orphaning the osascript child past process.exit.
    if (this.notesAbort) {
      try { this.notesAbort.abort(); } catch { /* ignore */ }
      this.notesAbort = null;
    }
    // If a start() is in flight, wait for it to settle before we begin
    // teardown. The startInner path sees `stopping === true` and stops
    // the freshly-spawned child itself, so by the time the awaited start
    // returns there is no live subprocess left to clean up here.
    if (this.starting) {
      try { await this.starting; } catch { /* swallowed by start's own logging */ }
    }
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      try {
        await handle.stop();
      } catch (error) {
        appendLog(this.instance, "tunnel.stop.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (this.monitor) {
      try { await this.monitor; } catch { /* monitor never rejects */ }
      this.monitor = null;
    }
    if (this.notesRefresh) {
      // Wait for the in-flight Apple Notes write so its `lastSyncedAt`
      // and `lastError` mutations don't land after we report the
      // snapshot as stopped. Failures already logged inside the refresh
      // path; swallow any rejection here.
      try { await this.notesRefresh; } catch { /* ignore */ }
      this.notesRefresh = null;
    }
    this.snapshot = {
      ...this.snapshot,
      publicUrl: null,
      cloudflareUrl: null
    };
    appendLog(this.instance, "tunnel.stopped", { expected: true });
  }

  /**
   * Refresh the Apple Notes mirror with whatever the current snapshot
   * advertises. Returns the updated snapshot. Safe to call before start —
   * it just resets the notes status without writing.
   */
  async refreshAppleNote(): Promise<TunnelSnapshot> {
    // Share an in-flight refresh across overlapping callers. The HTTP
    // handler can race the start()-time fire-and-forget refresh against
    // a user-initiated GET /api/tunnel; without this gate both paths
    // would invoke osascript concurrently and race two writes against
    // Notes.app, producing duplicate notes or interleaved snapshot
    // mutations.
    if (this.notesRefresh) return this.notesRefresh;
    this.notesAbort = new AbortController();
    const refresh = this.refreshAppleNoteInner(this.notesAbort.signal);
    this.notesRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.notesRefresh === refresh) {
        this.notesRefresh = null;
        this.notesAbort = null;
      }
    }
  }

  private async refreshAppleNoteInner(signal?: AbortSignal): Promise<TunnelSnapshot> {
    if (!this.snapshot.publicUrl) {
      return this.getSnapshot();
    }
    // Honour the operator's `tunnel apple-notes disable` flag here too.
    // start() gates its fire-and-forget refresh on `appleNotes.enabled`,
    // but the HTTP layer invokes this method directly via the tunnel
    // hooks for the documented re-sync path — without this check, a
    // single GET /api/tunnel would still drive an osascript write to
    // Notes.app even after the operator disabled the mirror.
    if (!this.config.appleNotes.enabled || this.disableAppleNotes) {
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          enabled: false,
          available: this.snapshot.appleNotes.available,
          lastError: null
        }
      };
      return this.getSnapshot();
    }
    const available = await isICloudAccountAvailable({
      account: this.config.appleNotes.account,
      run: this.osascript,
      signal
    });
    this.snapshot = {
      ...this.snapshot,
      appleNotes: {
        ...this.snapshot.appleNotes,
        available
      }
    };
    if (!available) {
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          lastError: this.config.appleNotes.enabled
            ? "iCloud account not found in Notes.app — skipping mirror"
            : null
        }
      };
      return this.getSnapshot();
    }
    const target: AppleNotesTarget = {
      folder: this.config.appleNotes.folder,
      noteName: this.config.appleNotes.noteName,
      account: this.config.appleNotes.account
    };
    try {
      await updateAppleNote(
        {
          ...target,
          body: composeAppleNoteBody(this.snapshot)
        },
        this.osascript,
        { signal }
      );
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          lastSyncedAt: new Date().toISOString(),
          lastError: null
        }
      };
      // Persist only the secret-less cloudflare hostname. The full
      // publicUrl carries the secret path that bypasses bearer auth, so
      // logging it to ~/.gini/instances/<inst>/logs/runtime.jsonl would
      // make the credential survive in plain text on disk.
      appendLog(this.instance, "tunnel.notes.synced", {
        folder: target.folder,
        note: target.noteName,
        cloudflareUrl: this.snapshot.cloudflareUrl
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          lastError: message
        }
      };
    }
    return this.getSnapshot();
  }
}

/**
 * Compute the human-readable note body that should land in Apple Notes.
 * Exposed separately so unit tests can pin the format without spinning up
 * the manager.
 */
export function composeAppleNoteBody(snapshot: TunnelSnapshot): string {
  const lines = [
    snapshot.publicUrl ?? "(not connected)",
    "",
    `Updated: ${snapshot.observedAt ?? "—"}`,
    `Target: ${snapshot.targetUrl}`
  ];
  return lines.join("\n");
}

/**
 * Resolve a TunnelConfig from raw RuntimeConfig + environment defaults.
 * Generates a new secret if one is missing and writes it back via the
 * `persist` callback so the caller can save it to disk. Returns the
 * resolved config alongside whether a write is needed.
 */
export function resolveTunnelConfig(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): { config: TunnelConfig; mutated: boolean } {
  const raw = (config as RuntimeConfig & { tunnel?: Partial<TunnelConfig> & { appleNotes?: Partial<TunnelConfig["appleNotes"]> } }).tunnel;
  const persistedSecret = normalizeSecret(raw?.secret);
  let mutated = false;
  let secret = persistedSecret;
  if (!secret) {
    secret = generateSecret();
    mutated = true;
  }
  const enabled = raw?.enabled ?? truthyEnv(env.GINI_TUNNEL);
  const notesRaw = raw?.appleNotes;
  const notesEnabledDefault = process.platform === "darwin";
  const appleNotes = {
    enabled: notesRaw?.enabled ?? notesEnabledDefault,
    folder: notesRaw?.folder ?? "gini",
    noteName: notesRaw?.noteName ?? `gini-tunnel-${config.instance}`,
    account: notesRaw?.account ?? "iCloud"
  };
  return {
    config: {
      enabled,
      secret,
      appleNotes
    },
    mutated
  };
}

/** Build the QR rendering payload from the snapshot. */
export function renderSnapshotQr(snapshot: TunnelSnapshot): { ansi: string; svg: string; url: string } | null {
  if (!snapshot.publicUrl) return null;
  const matrix = encodeQr(snapshot.publicUrl);
  return {
    ansi: renderQrAnsi(matrix),
    svg: renderQrSvg(matrix),
    url: snapshot.publicUrl
  };
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
