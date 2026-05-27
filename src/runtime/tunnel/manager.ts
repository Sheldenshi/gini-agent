import type { RuntimeConfig } from "../../types";
import { appendLog } from "../../state";
import { setRedactionPublicUrl, setRedactionSecret, redact } from "./redact";
import { launchCloudflared, type CloudflaredLaunch } from "./cloudflared";
import { probeNotesAvailable, writeNote, clearNote } from "./apple-notes";
import { ensureTunnelConfig, patchTunnelConfig, readTunnelConfig } from "./config-store";
import { atomicWriteFile } from "./atomic-write";
import { instanceRoot } from "../../paths";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AppleNotesState, TunnelSnapshot, TunnelTransitionResult, TunnelPersistedConfig } from "./types";

/** Path of the sibling file the runtime writes when the tunnel is up so the
 *  Next.js proxy (a separate process) can match the live tunnel hostname per
 *  request instead of trusting any `*.trycloudflare.com`. The file is removed
 *  on disable / shutdown / failed enable. */
function publicUrlPath(instance: string): string {
  return join(instanceRoot(instance), "tunnel.publicUrl");
}

/** Read-only view of the persisted tunnel hostname for callers in other
 *  processes (the Next.js proxy). Returns the empty string when the file is
 *  absent — the proxy treats that as "no live tunnel" and rejects the
 *  request at the Host classifier. */
export function readPersistedPublicUrl(instance: string): string {
  const p = publicUrlPath(instance);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

// Tunnel manager. Owns the in-memory snapshot, the cloudflared subprocess,
// and the Apple Notes mirror. Every state transition (enable/disable/recycle/
// rotate) goes through a single serialized apply path. See PLAN.md
// "Operational invariants".

const NOTES_FOLDER = "gini";

let manager: TunnelManager | null = null;

export function tunnelManager(config: RuntimeConfig): TunnelManager {
  if (!manager) manager = new TunnelManager(config);
  return manager;
}

/** Test-only reset. */
export function __resetTunnelManagerForTests(): void {
  if (manager) {
    void manager.stopForShutdown();
  }
  manager = null;
}

class TunnelManager {
  private snapshot: TunnelSnapshot;
  private cloudflared: CloudflaredLaunch | null = null;
  private generation = 0;
  // Serialize every apply-path mutation. Promise chain serves as a queue.
  private applyChain: Promise<void> = Promise.resolve();
  private notesAvailable: boolean | null = null;

  constructor(private readonly config: RuntimeConfig) {
    // Eagerly populate config (mints secret if missing). The on-disk write is
    // idempotent — subsequent boots see the existing block and skip the
    // rewrite, so config.json's mtime doesn't leak enable history.
    const persisted = ensureTunnelConfig(config.instance);
    this.snapshot = {
      enabled: persisted.enabled,
      secret: persisted.secret,
      publicUrl: null,
      lastError: null,
      appleNotes: {
        enabled: persisted.appleNotes.enabled,
        notesAvailable: null,
        lastError: null
      }
    };
    setRedactionSecret(persisted.secret);
    // Probe Notes availability once on construction. Routed through the
    // serialized apply path so the snapshot mutation can't race a concurrent
    // setAppleNotesEnabled / refreshNotes. Failures latch into `lastError`,
    // NOT into `notesAvailable` — that field stays null until a successful
    // probe answers it.
    void this.enqueue(async () => {
      const result = await probeNotesAvailable();
      this.notesAvailable = result.available;
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          notesAvailable: result.available,
          lastError: result.available ? null : redact(result.error ?? "Notes unavailable")
        }
      };
      return undefined;
    }).catch(() => { /* probe failure is reflected in snapshot.appleNotes.lastError */ });
  }

  current(): TunnelSnapshot {
    return this.snapshot;
  }

  /** Current persisted-config view. Cheap; reads memory then disk. */
  private readPersisted(): TunnelPersistedConfig {
    return readTunnelConfig(this.config.instance);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let outerResolve!: (value: T) => void;
    let outerReject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { outerResolve = res; outerReject = rej; });
    this.applyChain = this.applyChain.then(async () => {
      try {
        outerResolve(await fn());
      } catch (err) {
        outerReject(err);
      }
    });
    return promise;
  }

  async enable(webPort: number): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        // Commit enabled:true to config first. The proxy reads tunnel.enabled
        // on every request; ordering is important for the 5000 ms exposure cap.
        const persisted = patchTunnelConfig(this.config.instance, { enabled: true });
        setRedactionSecret(persisted.secret);
        // Stop any existing tunnel before spawning a new one — call sites use
        // this both to bring up after disable and to recycle on port change.
        if (this.cloudflared) {
          const prev = this.cloudflared;
          this.cloudflared = null;
          await prev.stop();
        }
        const launch = launchCloudflared({ port: webPort });
        this.cloudflared = launch;
        try {
          const url = await launch.publicUrl;
          this.snapshot = {
            ...this.snapshot,
            enabled: true,
            secret: persisted.secret,
            publicUrl: url,
            lastError: null
          };
          setRedactionPublicUrl(url);
          // Publish the live URL to disk so the Next.js proxy (separate
          // process) can equality-match Host instead of trusting any
          // .trycloudflare.com suffix. If the write fails the proxy can't
          // classify Host and will 404 every request — surface the error
          // in lastError so the operator sees the failure rather than a
          // silently broken tunnel.
          try {
            atomicWriteFile(publicUrlPath(this.config.instance), `${url}\n`);
          } catch (writeErr) {
            const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            this.snapshot = { ...this.snapshot, lastError: redact(`tunnel.publicUrl write failed: ${writeMsg}`) };
            appendLog(this.config.instance, "tunnel.publicUrl.write-error", { error: redact(writeMsg) });
          }
          appendLog(this.config.instance, "tunnel.enabled", { generation: this.generation });
          // Fire Notes refresh asynchronously when enabled.
          if (this.snapshot.appleNotes.enabled) void this.refreshNotes();
        } catch (err) {
          // Banner-parse failure or process exit — the subprocess may still be
          // running. Calling launch.stop() here closes the orphan window
          // before we null the reference. This is symmetric with the
          // success-path teardown in disable().
          this.cloudflared = null;
          try { await launch.stop(); } catch { /* already gone */ }
          // Roll back the persisted enabled:true so the next gateway boot
          // doesn't see a stale "enabled with no live tunnel" claim and so
          // proxy requests stop being accepted immediately.
          try { patchTunnelConfig(this.config.instance, { enabled: false }); } catch { /* surfaced via lastError */ }
          try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
          const msg = err instanceof Error ? err.message : String(err);
          this.snapshot = { ...this.snapshot, enabled: false, publicUrl: null, lastError: redact(msg) };
          setRedactionPublicUrl(null);
          appendLog(this.config.instance, "tunnel.enable.error", { error: redact(msg) });
          return { ok: false, error: redact(msg) };
        }
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        // Outer-catch covers config-write failure before launch — keep the
        // persisted state consistent with the in-memory snapshot.
        try { patchTunnelConfig(this.config.instance, { enabled: false }); } catch { /* best-effort */ }
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, enabled: false, publicUrl: null, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async disable(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      this.generation += 1;
      // Try to commit enabled:false BEFORE killing cloudflared (PLAN.md
      // "Operational invariants" ordering for the 5000 ms exposure cap).
      // If the config write throws (EACCES, disk full), we MUST still stop
      // cloudflared so the public URL doesn't keep accepting traffic from
      // a state the operator believes is disabled. Surface both failures
      // in lastError but keep the disable flow committed.
      let configErr: string | null = null;
      try {
        patchTunnelConfig(this.config.instance, { enabled: false });
      } catch (err) {
        configErr = err instanceof Error ? err.message : String(err);
        appendLog(this.config.instance, "tunnel.disable.config-error", { error: redact(configErr) });
      }
      let stopErr: string | null = null;
      if (this.cloudflared) {
        const prev = this.cloudflared;
        this.cloudflared = null;
        try {
          await prev.stop();
        } catch (err) {
          stopErr = err instanceof Error ? err.message : String(err);
          appendLog(this.config.instance, "tunnel.disable.stop-error", { error: redact(stopErr) });
        }
      }
      // Clear iCloud Notes copy on disable transition if Notes mirror is on.
      let notesErr: string | null = null;
      if (this.snapshot.appleNotes.enabled && this.notesAvailable) {
        try {
          await clearNote(NOTES_FOLDER, this.notesNoteName());
        } catch (err) {
          notesErr = err instanceof Error ? err.message : String(err);
        }
      }
      const errorMsg = configErr ?? stopErr ?? null;
      this.snapshot = {
        ...this.snapshot,
        enabled: false,
        publicUrl: null,
        lastError: errorMsg ? redact(errorMsg) : null,
        appleNotes: notesErr
          ? { ...this.snapshot.appleNotes, lastError: redact(notesErr) }
          : this.snapshot.appleNotes
      };
      setRedactionPublicUrl(null);
      try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
      appendLog(this.config.instance, "tunnel.disabled", { generation: this.generation });
      if (errorMsg) return { ok: false, error: redact(errorMsg) };
      return { ok: true, snapshot: this.snapshot };
    });
  }

  /** Mint a fresh secret atomically. The next request's cookie no longer
   *  matches the live secret — 404 on the next hit. */
  async rotateSecret(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        const persisted = patchTunnelConfig(this.config.instance, {}); // ensure block exists
        const next = patchTunnelConfig(this.config.instance, { secret: cryptoSecret() });
        this.snapshot = { ...this.snapshot, secret: next.secret };
        setRedactionSecret(next.secret);
        // Refresh Notes if mirror is on and tunnel is up — the note carries
        // the URL which embeds the secret as the QR-encoded path.
        if (this.snapshot.appleNotes.enabled && this.snapshot.publicUrl && this.notesAvailable) {
          try {
            await writeNote({
              folder: NOTES_FOLDER,
              noteName: this.notesNoteName(),
              body: bootstrapUrl(this.snapshot.publicUrl, next.secret)
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot = {
              ...this.snapshot,
              appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
            };
          }
        }
        appendLog(this.config.instance, "tunnel.secret-rotated", {});
        // No persisted result captured from `persisted` — avoids unused-var warning.
        void persisted;
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async setAppleNotesEnabled(enabled: boolean): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        patchTunnelConfig(this.config.instance, { appleNotes: { enabled } });
        const notes: AppleNotesState = {
          enabled,
          notesAvailable: this.notesAvailable,
          lastError: null
        };
        this.snapshot = { ...this.snapshot, appleNotes: notes };
        if (enabled) {
          // Call the un-enqueued worker — re-entering enqueue from inside an
          // already-running task would deadlock the apply chain.
          await this.runRefreshNotes();
        } else if (this.notesAvailable) {
          try {
            await clearNote(NOTES_FOLDER, this.notesNoteName());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot = {
              ...this.snapshot,
              appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
            };
          }
        }
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async refreshNotes(): Promise<TunnelTransitionResult> {
    return this.enqueue(() => this.runRefreshNotes());
  }

  /** Notes refresh worker. Pure body — DOES NOT enqueue. Public callers go
   *  through `refreshNotes()` which adds the enqueue wrapper; internal callers
   *  (already inside an enqueue task) invoke this directly to avoid the
   *  promise-chain self-deadlock. */
  private async runRefreshNotes(): Promise<TunnelTransitionResult> {
    const url = this.snapshot.publicUrl;
    const secret = this.snapshot.secret;
    if (!url || !secret) {
      return { ok: false, error: "Tunnel not enabled" };
    }
    if (!this.snapshot.appleNotes.enabled) {
      return { ok: false, error: "Apple Notes mirror disabled" };
    }
    // Re-probe availability before writing — handles TCC denial recovery.
    const probe = await probeNotesAvailable();
    this.notesAvailable = probe.available;
    if (!probe.available) {
      const msg = redact(probe.error ?? "Notes unavailable");
      this.snapshot = {
        ...this.snapshot,
        appleNotes: { ...this.snapshot.appleNotes, notesAvailable: false, lastError: msg }
      };
      return { ok: false, error: msg };
    }
    try {
      await writeNote({
        folder: NOTES_FOLDER,
        noteName: this.notesNoteName(),
        body: bootstrapUrl(url, secret)
      });
      this.snapshot = {
        ...this.snapshot,
        appleNotes: { ...this.snapshot.appleNotes, notesAvailable: true, lastError: null }
      };
      return { ok: true, snapshot: this.snapshot };
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      this.snapshot = {
        ...this.snapshot,
        appleNotes: { ...this.snapshot.appleNotes, lastError: msg }
      };
      return { ok: false, error: msg };
    }
  }

  /** Stop cloudflared as part of gateway shutdown. Does not modify config. */
  async stopForShutdown(): Promise<void> {
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      await prev.stop();
    }
    // The hostname rotates on every restart; the persisted URL is invalid
    // after gateway exit. Remove it so the next boot's proxy doesn't equality-
    // match against a stale host.
    try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
  }

  private notesNoteName(): string {
    return `gini-tunnel-${this.config.instance}`;
  }
}

function cryptoSecret(): string {
  // Delegate to the same generator used at boot. Imported lazily to avoid
  // import-cycle paranoia (this file is the highest layer in the tunnel
  // subtree).
  return require("./secret").generateTunnelSecret() as string;
}

/** Compose the bootstrap URL the phone scans: `<publicUrl>/<secret>/`. */
export function bootstrapUrl(publicUrl: string, secret: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/${secret}/`;
}
