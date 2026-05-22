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
import type { Instance, RuntimeConfig } from "../../types";
import {
  isICloudAccountAvailable,
  updateAppleNote,
  type AppleNotesTarget,
  type RunOsascript
} from "./apple-notes";
import { spawnQuickTunnel, type SpawnTunnelOptions, type TunnelHandle } from "./cloudflared";
import { encodeQr, renderQrAnsi, renderQrSvg } from "./qr";
import { generateSecret, normalizeSecret, tunnelPathPrefix } from "./secret-path";

export interface TunnelConfig {
  enabled: boolean;
  secret: string;
  appleNotes: {
    enabled: boolean;
    folder: string;
    noteName: string;
    account: string;
  };
}

export interface TunnelSnapshot {
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
  private readonly targetUrl: string;
  private readonly spawn?: SpawnTunnelOptions["spawn"];
  private readonly osascript?: RunOsascript;
  private readonly binary?: string;
  private readonly logPath?: string;
  private readonly disableAppleNotes: boolean;
  private handle: TunnelHandle | null = null;
  private snapshot: TunnelSnapshot;
  private stopping = false;
  private monitor: Promise<void> | null = null;

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
   * Spin up cloudflared. Resolves once the public URL has been observed.
   * Safe to call multiple times — subsequent calls return the existing
   * snapshot without re-spawning.
   */
  async start(): Promise<TunnelSnapshot> {
    if (this.handle) return this.getSnapshot();
    this.stopping = false;
    try {
      this.handle = await spawnQuickTunnel({
        targetUrl: this.targetUrl,
        binary: this.binary,
        logPath: this.logPath,
        spawn: this.spawn
      });
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        lastError: error instanceof Error ? error.message : String(error)
      };
      appendLog(this.instance, "tunnel.spawn.error", { error: this.snapshot.lastError });
      throw error;
    }
    const observedAt = new Date().toISOString();
    const publicUrl = `${this.handle.url}${tunnelPathPrefix(this.config.secret)}`;
    this.snapshot = {
      ...this.snapshot,
      publicUrl,
      cloudflareUrl: this.handle.url,
      observedAt,
      lastError: null
    };
    appendLog(this.instance, "tunnel.started", {
      url: this.handle.url,
      target: this.targetUrl,
      pid: this.handle.pid
    });

    if (this.config.appleNotes.enabled && !this.disableAppleNotes) {
      void this.refreshAppleNote().catch((error) => {
        appendLog(this.instance, "tunnel.notes.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    // Watch the subprocess so an unexpected exit surfaces in the snapshot.
    this.monitor = this.handle.exited.then((code) => {
      if (this.stopping) return;
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
   * Tear down the cloudflared subprocess. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.handle) return;
    this.stopping = true;
    const handle = this.handle;
    this.handle = null;
    try {
      await handle.stop();
    } catch (error) {
      appendLog(this.instance, "tunnel.stop.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (this.monitor) {
      try { await this.monitor; } catch { /* monitor never rejects */ }
      this.monitor = null;
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
    if (!this.snapshot.publicUrl) {
      return this.getSnapshot();
    }
    const available = await isICloudAccountAvailable({
      account: this.config.appleNotes.account,
      run: this.osascript
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
        this.osascript
      );
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          lastSyncedAt: new Date().toISOString(),
          lastError: null
        }
      };
      appendLog(this.instance, "tunnel.notes.synced", {
        folder: target.folder,
        note: target.noteName,
        publicUrl: this.snapshot.publicUrl
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
