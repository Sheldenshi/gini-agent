import type { RuntimeConfig } from "../../types";
import { appendLog } from "../../state";
import { setRedactionPublicUrl, setRedactionSecret, redact } from "./redact";
import { launchCloudflared, type CloudflaredLaunch } from "./cloudflared";
import { probeNotesAvailable, writeNote, clearNote } from "./apple-notes";
import { ensureTunnelConfig, patchTunnelConfig, readTunnelConfig } from "./config-store";
import { atomicWriteFile } from "../../atomic-write";
import { isSupervisedWebChild } from "../health-probe";
import { generateTunnelSecret, secretRevision } from "./secret";
import { inferTunnelTransport } from "./transport";
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

// Periodic edge-reachability probe. cloudflared's process can stay healthy
// long after the *.trycloudflare.com hostname has de-routed at Cloudflare's
// edge — observed live with an 18-hour-old child whose hostname stopped
// resolving in DNS while the local process kept reporting ok. The existing
// `exit` listener only fires on process death, so it can't catch this. We
// HEAD the publicUrl on an interval; only a thrown fetch (DNS failure,
// connection refused, timeout) counts as unreachable. ANY resolved HTTP
// response — including 404 / 530 / 502 — means the edge is still routing
// us, so it counts as reachable. After EDGE_PROBE_FAILURE_THRESHOLD
// consecutive failures the manager automatically recycles cloudflared:
// the secret stays stable (only the trycloudflare hostname rotates), so
// the "rotation never happens implicitly" contract still holds —
// rotation means SECRET rotation, and that remains operator-driven. Once
// the recycle stamps a fresh publicUrl, runRefreshNotes fires fire-and-
// forget so the iCloud Notes mirror reflects the live bootstrap URL
// without operator action. Apple Notes is the operator-facing
// propagation channel for hostname changes — the phone re-reads the
// note to pick up the new URL. If we have no lastWebPort to bind
// against, or the recycle fails, the snapshot falls back to the
// degraded shape (enabled && publicUrl === null && lastError set), the
// publicUrl sibling file is removed, and the probe stops so an operator
// can intervene.
const EDGE_PROBE_INTERVAL_MS = 120_000;
const EDGE_PROBE_TIMEOUT_MS = 8_000;
const EDGE_PROBE_FAILURE_THRESHOLD = 3;

/** Pure decision function for the edge-reachability probe — exported so
 *  unit tests can pin the failure-counting semantics without standing up a
 *  full TunnelManager. A reachable probe resets the failure count to zero;
 *  an unreachable probe increments and flags `dead` once the running count
 *  reaches the threshold. */
export function evaluateEdgeProbe(
  prevFailures: number,
  reachable: boolean,
  threshold: number
): { failures: number; dead: boolean } {
  if (reachable) return { failures: 0, dead: false };
  const failures = prevFailures + 1;
  return { failures, dead: failures >= threshold };
}

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
  /** Set by the SIGTERM handler before `stopForShutdown()`. Any in-flight
   *  `enable()` task that wakes up after this is true must abort before
   *  publishing the publicUrl file or stamping a fresh cloudflared as
   *  active — the drain has already cleaned up. */
  private shuttingDown = false;
  // Serialize every apply-path mutation. Promise chain serves as a queue.
  private applyChain: Promise<void> = Promise.resolve();
  private notesAvailable: boolean | null = null;
  /** Last webPort enable() was called with. Used by rotateSecret to
   *  recycle cloudflared (close every open TCP / SSE connection) without
   *  the caller having to know the port. Null until the first enable(). */
  private lastWebPort: number | null = null;
  /** Interval handle for the periodic edge-reachability probe. Non-null
   *  only while a tunnel is live; cleared on disable / shutdown / probe-
   *  observed-dead so the probe never runs against a stale snapshot. */
  private edgeProbeTimer: ReturnType<typeof setInterval> | null = null;
  /** Running count of consecutive unreachable probes — reset to 0 on any
   *  reachable probe and on probe start/stop. Surfaced to the dead-flip
   *  branch via `evaluateEdgeProbe` for the threshold check. */
  private edgeProbeFailures = 0;

  constructor(private readonly config: RuntimeConfig) {
    // Eagerly populate config (mints secret if missing). The on-disk write is
    // idempotent — subsequent boots see the existing block and skip the
    // rewrite, so config.json's mtime doesn't leak enable history.
    const persisted = ensureTunnelConfig(config.instance);
    // Mirror the on-disk tunnel block into the in-memory RuntimeConfig so
    // unrelated whole-config writers (updateAutoApproveSettings,
    // setSetupProvider, …) serialize the up-to-date tunnel state instead
    // of a stale boot-time snapshot. The manager keeps this field in sync
    // through `persistTunnel` below.
    config.tunnel = persisted;
    // Stale publicUrl from a previous boot becomes invalid the moment
    // cloudflared rotates hostnames on restart. Remove on construction so
    // the proxy can't equality-match against a host that no cloudflared
    // process is actually serving.
    try { unlinkSync(publicUrlPath(config.instance)); } catch { /* may not exist */ }
    this.snapshot = {
      enabled: persisted.enabled,
      secret: persisted.secret,
      secretRevision: secretRevision(persisted.secret),
      publicUrl: null,
      tunnelTransport: inferTunnelTransport(null),
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

  /** Atomic disk write of the tunnel block PLUS in-memory sync so any
   *  whole-config writer that runs later (e.g. `updateAutoApproveSettings`,
   *  `setSetupProvider`) serializes the up-to-date tunnel state instead
   *  of the stale boot-time snapshot it picked up from `loadConfig`.
   *  Without this mirror, an enable / disable / rotate-secret transition
   *  would land on disk but the next unrelated config save would clobber
   *  it from the in-memory `RuntimeConfig`. */
  private persistTunnel(
    patch: Partial<TunnelPersistedConfig> & { appleNotes?: Partial<TunnelPersistedConfig["appleNotes"]> }
  ): TunnelPersistedConfig {
    const next = patchTunnelConfig(this.config.instance, patch);
    this.config.tunnel = next;
    return next;
  }

  /** Stop any current cloudflared, launch a new one, install the exit
   *  listener BEFORE awaiting the banner, await the URL, sync-check
   *  exitCode for any same-tick exit, stamp `snapshot.publicUrl /
   *  secret / secretRevision / enabled=true`, atomic-write the
   *  publicUrl sibling file. MUST be called from inside the apply
   *  chain — the queue serialization is the caller's responsibility.
   *  Shared between `enable()` and `rotateSecret()` so the inline
   *  recycle in `rotateSecret` doesn't duplicate the lifecycle. */
  private async swapCloudflared(webPort: number, secret: string): Promise<TunnelTransitionResult> {
    if (this.shuttingDown) {
      return { ok: false, error: "Tunnel manager shutting down" };
    }
    // Re-probe `/__healthz` inside the apply-chain slot, immediately
    // before the spawn. The PATCH handler already probed before calling
    // enable(), but the supervised Next.js child could have died between
    // that probe and now (queue backpressure: a 15s Notes osascript
    // might have been queued ahead of us, plus the prev.stop() below
    // can take up to 5s on its SIGKILL fallback). If a different local
    // process binds the now-free port in that window, cloudflared
    // would forward to a stranger instead of our gateway. The re-probe
    // closes that race; the cost is one 1500ms-bounded fetch per
    // enable/recycle, paid only once per transition.
    const healthy = await isSupervisedWebChild(this.config.instance, webPort);
    if (!healthy) {
      return { ok: false, error: redact(`web port ${webPort} no longer identifies as the supervised gini-web child`) };
    }
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      try { await prev.stop(); } catch { /* already gone */ }
    }
    // Re-check shuttingDown one last time before the spawn. The probe
    // (1500ms timeout) and `prev.stop()` (up to 5s SIGKILL fallback)
    // are both async — SIGTERM may have arrived during either await.
    // Without this gate, the post-banner shutdown check would still
    // catch it, but we'd have spawned cloudflared for the duration
    // of the banner parse before tearing it back down. Skip the
    // spawn entirely if shutdown started.
    if (this.shuttingDown) {
      return { ok: false, error: "Tunnel manager shutting down" };
    }
    const launch = launchCloudflared({ port: webPort });
    this.cloudflared = launch;
    // Install the exit listener BEFORE the await so any same-tick
    // crash during banner parse triggers cleanup. process.once does
    // not fire for past exits. Identity check + null-cloudflared
    // guards double-cleanup when the catch block below also handles
    // the same exit.
    launch.process.once("exit", (code, signal) => {
      if (this.cloudflared !== launch) return;
      this.cloudflared = null;
      try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
      setRedactionPublicUrl(null);
      // `proc.on("exit", (code, signal))` reports exactly one of the two:
      // normal exits set `code` and leave `signal` null, signal-driven
      // termination sets `signal` and leaves `code` null. The pre-banner
      // check below already distinguishes them; mirror the same shape
      // here so a SIGKILL'd cloudflared surfaces as "signal SIGKILL"
      // instead of the noise-y "(code ?)" string.
      const reason = code !== null ? `code ${code}` : `signal ${signal}`;
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(`cloudflared exited (${reason})`)
      };
      // Process death already nulls publicUrl, so any in-flight or
      // future probe would no-op on the !url guard — but stop the
      // interval anyway so we don't burn an event-loop wake every
      // EDGE_PROBE_INTERVAL_MS for a tunnel that's gone.
      this.stopEdgeProbe();
      appendLog(this.config.instance, "tunnel.cloudflared.exit", {
        code: code ?? null,
        signal: signal ?? null
      });
    });
    try {
      const url = await launch.publicUrl;
      // Belt-and-suspenders: process.once fires on the next event-loop
      // tick, so a same-tick exit between the await resolving and our
      // snapshot stamp would slip past. Check both `exitCode` (normal
      // exits set this to a number; signal exits leave it null per the
      // Node child_process docs) AND `signalCode` (set on signal-driven
      // termination — SIGKILL/SIGTERM/etc) so a signal-killed cloudflared
      // doesn't get treated as live.
      if (launch.process.exitCode !== null || launch.process.signalCode !== null) {
        this.cloudflared = null;
        try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
        setRedactionPublicUrl(null);
        const reason = launch.process.exitCode !== null
          ? `code ${launch.process.exitCode}`
          : `signal ${launch.process.signalCode}`;
        const msg = redact(`cloudflared exited (${reason}) during banner parse`);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: msg
        };
        return { ok: false, error: msg };
      }
      // Re-check the shutdown flag after the long await — SIGTERM may
      // have flipped it while we were waiting for cloudflared's banner.
      if (this.shuttingDown) {
        this.cloudflared = null;
        try { await launch.stop(); } catch { /* already gone */ }
        try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: "shutdown"
        };
        return { ok: false, error: "shutdown" };
      }
      this.snapshot = {
        ...this.snapshot,
        enabled: true,
        secret,
        secretRevision: secretRevision(secret, url),
        publicUrl: url,
        tunnelTransport: inferTunnelTransport(url),
        lastError: null
      };
      setRedactionPublicUrl(url);
      try {
        atomicWriteFile(publicUrlPath(this.config.instance), `${url}\n`);
      } catch (writeErr) {
        const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        this.snapshot = { ...this.snapshot, lastError: redact(`tunnel.publicUrl write failed: ${writeMsg}`) };
        appendLog(this.config.instance, "tunnel.publicUrl.write-error", { error: redact(writeMsg) });
      }
      // Start the periodic edge-reachability probe. Covers enable(), the
      // inline rotate-secret recycle, and boot reconcile in one place —
      // every successful publicUrl stamp for a live tunnel flows through
      // this branch. Safe to call when a probe is already running:
      // startEdgeProbe stops the existing timer and resets the failure
      // count before starting fresh, so a recycle's URL swap doesn't
      // inherit the old hostname's accumulated failures.
      this.startEdgeProbe();
      return { ok: true, snapshot: this.snapshot };
    } catch (err) {
      // Banner-parse failure or process exit reject. If the process
      // already exited (the publicUrl rejection came from the internal
      // exit handler), skip the stop — `launch.stop()` would otherwise
      // SIGTERM a dead process and wait up to 5s for the SIGKILL
      // fallback timer to fire, adding gratuitous latency to every
      // failed enable / recycle.
      this.cloudflared = null;
      const alreadyExited = launch.process.exitCode !== null || launch.process.signalCode !== null;
      if (!alreadyExited) {
        try { await launch.stop(); } catch { /* already gone */ }
      }
      try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(msg)
      };
      setRedactionPublicUrl(null);
      return { ok: false, error: redact(msg) };
    }
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

  async enable(webPort: number, opts: { reconcileOnly?: boolean } = {}): Promise<TunnelTransitionResult> {
    // Remember the port so rotateSecret can recycle without needing the
    // caller to thread it back through. Set OUTSIDE the queue so the
    // value is visible to a concurrent rotateSecret read-then-recycle.
    this.lastWebPort = webPort;
    return this.enqueue(async () => {
      // Bail before any write/spawn if shutdown has already started — the
      // drain has already run, so finishing this task would resurrect a
      // tunnel the SIGTERM handler just tore down.
      if (this.shuttingDown) {
        return { ok: false, error: "Tunnel manager shutting down" };
      }
      // Reconcile-only callers (boot reconcile, internal recycle) must
      // re-check disk intent inside the queue slot. A user `disable()`
      // that enqueued between the caller's pre-check and our slot
      // would otherwise be resurrected by us — chain order
      // disable→enable lets enable's last-writer-wins on disk. User-
      // driven enables (`reconcileOnly` unset / false) skip this gate;
      // explicit intent wins.
      if (opts.reconcileOnly) {
        const persisted = this.readPersisted();
        if (!persisted.enabled) {
          return { ok: false, error: "reconcile-aborted: tunnel disabled while enqueued" };
        }
      }
      // Bump generation before any state change so any background Notes
      // write scheduled by a previous enable() (recycle path) hits the
      // gen-mismatch gate inside runRefreshNotes and bails before
      // publishing the now-stale URL/secret to iCloud. The scheduled
      // generation we capture below for THIS enable's own Notes refresh
      // is the post-bump value, so this enable's refresh still proceeds.
      this.generation += 1;
      try {
        // Commit enabled:true to config first. The proxy reads tunnel.enabled
        // on every request; ordering is important for the 5000 ms exposure cap.
        const persisted = this.persistTunnel( { enabled: true });
        setRedactionSecret(persisted.secret);
        const result = await this.swapCloudflared(webPort, persisted.secret);
        if (!result.ok) {
          // Roll back enabled:true so the next gateway boot doesn't see a
          // stale enable claim with no live tunnel.
          try { this.persistTunnel({ enabled: false }); } catch { /* best-effort */ }
          this.snapshot = { ...this.snapshot, enabled: false };
          appendLog(this.config.instance, "tunnel.enable.error", { error: result.error });
          return result;
        }
        appendLog(this.config.instance, "tunnel.enabled", { generation: this.generation });
        // Fire-and-forget Notes refresh OUTSIDE the apply chain. Enqueuing
        // refreshNotes here would put a 15s osascript timeout ahead of a
        // follow-up disable() in the apply chain, defeating PLAN.md's
        // 5000ms exposure cap on disable. The bare `runRefreshNotes()`
        // call updates `this.snapshot` and `this.notesAvailable` outside
        // the queue. Capture the current generation at scheduling time so
        // a later disable / rotateSecret that bumps the generation makes
        // the background refresh bail before writing a stale URL/secret
        // to iCloud Notes.
        if (this.snapshot.appleNotes.enabled) {
          const scheduledGeneration = this.generation;
          void this.runRefreshNotes(scheduledGeneration).catch(() => { /* surfaced in appleNotes.lastError */ });
        }
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        // Outer-catch covers config-write failure before launch — keep the
        // persisted state consistent with the in-memory snapshot.
        try { this.persistTunnel( { enabled: false }); } catch { /* best-effort */ }
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = {
          ...this.snapshot,
          enabled: false,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redact(msg)
        };
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
        this.persistTunnel( { enabled: false });
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
      // Stop the edge probe in lockstep with the cloudflared teardown.
      // The probe's internal !snapshot.enabled guard would also short-
      // circuit it once the snapshot stamp below lands, but killing the
      // interval here avoids the wake-and-skip cost.
      this.stopEdgeProbe();
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
        tunnelTransport: inferTunnelTransport(null),
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

  /** Mint a fresh secret atomically AND recycle cloudflared so every
   *  outstanding tunneled connection drops — the panic-button contract:
   *  rotate-secret must not leave open SSE streams reachable from a
   *  holder whose cookie value just stopped matching the live secret.
   *
   *  Three things invalidate together:
   *  - The new secret on disk: cookie-bearing FRESH requests fail at
   *    the proxy's cookie check because cookieValue ≠ tunnel.secret.
   *  - The recycled cloudflared subprocess: every open TCP connection
   *    (including long-lived SSE streams that wouldn't make another
   *    request) closes at the network layer.
   *  - The rotated trycloudflare hostname: the host-only cookie's
   *    binding doesn't match the new hostname either, so even a
   *    reconnecting client with the old cookie can't piggy-back.
   *
   *  Recycle happens INLINE inside the same apply-chain slot as the
   *  secret commit. A previous version scheduled the recycle as a
   *  fire-and-forget `void this.enable(port)` AFTER the rotate task
   *  resolved; that left a window where a concurrent `disable()`
   *  could queue between rotate and recycle (chain: rotate → disable
   *  → recycle), let disable run, then have recycle resurrect the
   *  tunnel by re-enabling it. Doing the recycle inline makes the
   *  whole rotate+recycle atomic against any other apply-chain
   *  operation. */
  async rotateSecret(): Promise<TunnelTransitionResult> {
    let scheduledGeneration = 0;
    let didRecycle = false;
    const result: TunnelTransitionResult = await this.enqueue(async (): Promise<TunnelTransitionResult> => {
      // Bump the generation so any in-flight detached Notes refresh from
      // a prior enable() / rotateSecret() bails before writing the now-
      // stale URL/secret to iCloud Notes.
      this.generation += 1;
      try {
        // Pre-flight port re-probe BEFORE committing the new secret to
        // disk. If the supervised web child is gone (or some other
        // process now owns the port), we can't recycle cloudflared
        // safely — abort the rotation entirely so the disk + snapshot
        // stay coherent. Without this check we'd persist the new secret
        // to disk and then bail in swapCloudflared's probe, leaving
        // the OLD cloudflared running with the NEW disk secret (which
        // breaks rotate-secret's panic-button contract: open SSE
        // streams continue serving against an out-of-sync state).
        if (this.cloudflared !== null && this.lastWebPort !== null) {
          const healthy = await isSupervisedWebChild(this.config.instance, this.lastWebPort);
          if (!healthy) {
            this.snapshot = { ...this.snapshot, lastError: redact(`web port ${this.lastWebPort} not healthy — rotation aborted before commit`) };
            return { ok: false, error: `web port ${this.lastWebPort} not healthy — rotation aborted before commit` };
          }
        }
        const next = this.persistTunnel( { secret: generateTunnelSecret() });
        setRedactionSecret(next.secret);
        scheduledGeneration = this.generation;
        // Stamp the new secret + revision into the snapshot BEFORE
        // attempting the recycle. If the recycle fails (cloudflared
        // banner timeout, port re-probe fails) the snapshot still
        // reflects the on-disk truth — the QR launcher / settings card
        // show the new secret instead of leaving the old in-memory
        // value live while disk + proxy already moved to the new one.
        // The pre-stamp's publicUrl uses the prior value; swap rewrites
        // it (with the new URL) on success or nulls it on failure.
        this.snapshot = {
          ...this.snapshot,
          secret: next.secret,
          secretRevision: secretRevision(next.secret, this.snapshot.publicUrl)
        };
        // If a tunnel is running, recycle cloudflared INLINE so a
        // concurrent disable() can't interleave between commit and
        // recycle. swapCloudflared assumes it's inside the apply chain.
        if (this.cloudflared !== null && this.lastWebPort !== null) {
          const swap = await this.swapCloudflared(this.lastWebPort, next.secret);
          if (!swap.ok) {
            // swap already stamped publicUrl=null + lastError; the
            // pre-stamp above ensured snapshot.secret matches disk so
            // the UI shows the rotated state truthfully even though
            // the relaunch failed.
            return swap;
          }
          didRecycle = true;
        }
        // If no tunnel was running, the pre-stamp above is the only
        // snapshot update we need — publicUrl stays null, secret +
        // revision reflect the rotation.
        appendLog(this.config.instance, "tunnel.secret-rotated", { recycled: didRecycle });
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
    if (!result.ok) return result;
    // Fire-and-forget Notes refresh OUTSIDE the apply chain (15s
    // osascript timeout would otherwise sit ahead of a follow-up
    // disable). The captured scheduledGeneration gate inside
    // runRefreshNotes bails if a concurrent disable / re-rotate /
    // re-enable bumps the generation before the write lands.
    if (this.snapshot.appleNotes.enabled && this.snapshot.publicUrl && this.notesAvailable) {
      void this.runRefreshNotes(scheduledGeneration).catch(() => { /* surfaced in appleNotes.lastError */ });
    }
    return result;
  }

  async setAppleNotesEnabled(enabled: boolean): Promise<TunnelTransitionResult> {
    // Split the config commit (queued — must serialize with enable / disable /
    // rotateSecret) from the actual osascript side effect (NOT queued — the
    // 15s timeout would sit ahead of a follow-up disable() on the apply chain
    // and break PLAN.md's 5000ms exposure cap). Pattern mirrors enable()'s
    // fire-and-forget Notes refresh.
    let scheduledGeneration = 0;
    const result: TunnelTransitionResult = await this.enqueue(async (): Promise<TunnelTransitionResult> => {
      try {
        this.persistTunnel( { appleNotes: { enabled } });
        const notes: AppleNotesState = {
          enabled,
          notesAvailable: this.notesAvailable,
          lastError: null
        };
        this.snapshot = { ...this.snapshot, appleNotes: notes };
        scheduledGeneration = this.generation;
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
    if (!result.ok) return result;
    if (enabled) {
      void this.runRefreshNotes(scheduledGeneration).catch(() => { /* surfaced in appleNotes.lastError */ });
    } else if (this.notesAvailable) {
      void this.runClearNotes(scheduledGeneration).catch(() => { /* surfaced in appleNotes.lastError */ });
    }
    return result;
  }

  async refreshNotes(): Promise<TunnelTransitionResult> {
    // NOT queued. The 15s osascript timeout inside runRefreshNotes would
    // otherwise sit ahead of a follow-up disable() on the apply chain. The
    // generation gates inside runRefreshNotes invalidate this call if a
    // concurrent disable / rotateSecret / re-enable bumps the generation
    // mid-write, so an out-of-band tunnel teardown is still safe.
    return this.runRefreshNotes(this.generation);
  }

  /** Notes clear worker. Mirrors runRefreshNotes — pure body, no enqueue,
   *  generation gate against disable / rotateSecret / re-enable interleavings.
   *  Also re-checks the mirror toggle: setAppleNotesEnabled doesn't bump
   *  generation, so a fast off→on flip could leave this fire-and-forget
   *  clear racing a fresh writeNote from the subsequent enable. Bail if
   *  the mirror has been re-enabled between scheduling and execution so
   *  we don't delete a note the user just intentionally wrote. */
  private async runClearNotes(scheduledGeneration: number): Promise<TunnelTransitionResult> {
    if (scheduledGeneration !== this.generation) {
      return { ok: false, error: "superseded" };
    }
    if (this.shuttingDown) return { ok: false, error: "shutdown" };
    if (this.snapshot.appleNotes.enabled) {
      return { ok: false, error: "superseded by re-enable" };
    }
    try {
      await clearNote(NOTES_FOLDER, this.notesNoteName());
      // Re-check immediately after the osascript returns — between the
      // pre-clear gate and the actual delete, the mirror could have
      // flipped back on AND the new runRefreshNotes could have written
      // a fresh note. We can't undo what clearNote already did, but we
      // can schedule a recovery refresh so the steady-state matches the
      // user's most recent intent.
      if (this.snapshot.appleNotes.enabled) {
        void this.runRefreshNotes(this.generation).catch(() => { /* surfaced in lastError */ });
      }
      return { ok: true, snapshot: this.snapshot };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        ...this.snapshot,
        appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
      };
      return { ok: false, error: redact(msg) };
    }
  }

  /** Notes refresh worker. Pure body — DOES NOT enqueue. Public callers go
   *  through `refreshNotes()` which adds the enqueue wrapper; internal callers
   *  (already inside an enqueue task) invoke this directly to avoid the
   *  promise-chain self-deadlock.
   *
   *  `scheduledGeneration`, when supplied by the detached fire-and-forget
   *  caller from enable(), is the generation observed at scheduling time.
   *  A rotateSecret() / disable() bumping the generation while we're
   *  awaiting probeNotesAvailable / writeNote bails the refresh before it
   *  can resurrect a stale URL/secret in iCloud Notes. */
  private async runRefreshNotes(scheduledGeneration?: number): Promise<TunnelTransitionResult> {
    if (scheduledGeneration !== undefined && scheduledGeneration !== this.generation) {
      return { ok: false, error: "superseded" };
    }
    if (this.shuttingDown) return { ok: false, error: "shutdown" };
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
    if (scheduledGeneration !== undefined && scheduledGeneration !== this.generation) {
      return { ok: false, error: "superseded" };
    }
    if (this.shuttingDown) return { ok: false, error: "shutdown" };
    // Re-check the mirror toggle — the operator may have flipped it off
    // while the probe was running. A background refresh from an earlier
    // enable() must not resurrect the note after the user explicitly
    // disabled the mirror.
    if (!this.snapshot.appleNotes.enabled) {
      return { ok: false, error: "Apple Notes mirror disabled" };
    }
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
      // One more guard right before the side effect — if the operator hit
      // disable / rotate / Notes-off between the probe and now, drop the
      // write.
      if (scheduledGeneration !== undefined && scheduledGeneration !== this.generation) {
        return { ok: false, error: "superseded" };
      }
      if (this.shuttingDown) return { ok: false, error: "shutdown" };
      if (!this.snapshot.appleNotes.enabled) {
        return { ok: false, error: "Apple Notes mirror disabled" };
      }
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

  /** Stop cloudflared as part of gateway shutdown. Does not modify config.
   *  The publicUrl sibling file is unlinked BEFORE we await cloudflared.stop()
   *  because the SIGTERM drain is bounded at 5000 ms — if cloudflared
   *  termination overruns the cap, `process.exit(0)` fires and an
   *  unlinkSync queued after the await would never run. The proxy reads
   *  the file per-request; removing it first means a fresh boot can't
   *  classify Host against the stale URL even if cloudflared is still
   *  exiting in the background.
   *
   *  Setting `shuttingDown = true` first lets any in-flight `enable()`
   *  task that's currently suspended on `await launch.publicUrl` abort
   *  before it can republish the file or stamp a fresh cloudflared as
   *  active. */
  async stopForShutdown(): Promise<void> {
    this.shuttingDown = true;
    // Stop the edge probe before awaiting cloudflared so the SIGTERM
    // drain's 5000ms cap isn't competing with a probe wake. The probe's
    // own shuttingDown guard would also bail any in-flight fetch's
    // result-handling, but unscheduling the interval first is the
    // cleaner termination order.
    this.stopEdgeProbe();
    try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      await prev.stop();
    }
  }

  /** (Re)start the periodic edge probe. Idempotent — clears any existing
   *  timer and zeros the failure count so a hostname rotation (rotate-
   *  secret recycle) doesn't inherit the prior hostname's accumulated
   *  failures. `.unref()` lets the Bun process exit naturally if the
   *  probe is the only remaining handle keeping the event loop alive. */
  private startEdgeProbe(): void {
    this.stopEdgeProbe();
    this.edgeProbeFailures = 0;
    const timer = setInterval(() => void this.probeEdge(), EDGE_PROBE_INTERVAL_MS);
    timer.unref();
    this.edgeProbeTimer = timer;
  }

  /** Cancel the periodic edge probe and reset the failure count. Called on
   *  disable, shutdown, cloudflared exit, and once the probe itself
   *  declares the hostname dead (no point continuing to poll a URL we
   *  just nulled in the snapshot). */
  private stopEdgeProbe(): void {
    if (this.edgeProbeTimer !== null) {
      clearInterval(this.edgeProbeTimer);
      this.edgeProbeTimer = null;
    }
    this.edgeProbeFailures = 0;
  }

  /** One probe tick. Captures the generation + URL up-front so a concurrent
   *  rotate / disable / boot reconcile that bumps the generation or swaps
   *  publicUrl between the fetch issue and the dead-flip can be detected
   *  and skipped — we must not stamp lastError onto a fresh, healthy
   *  tunnel that happens to share the now-stale failure count. */
  private async probeEdge(): Promise<void> {
    const url = this.snapshot.publicUrl;
    const gen = this.generation;
    if (this.shuttingDown || !this.snapshot.enabled || !url) {
      // If the tunnel is no longer enabled there's nothing for the probe
      // to do — kill the interval rather than wake every probe interval
      // just to no-op. The enabled-but-no-url case is "already degraded";
      // leave the timer in place so a future recycle can reuse it.
      if (!this.snapshot.enabled) this.stopEdgeProbe();
      return;
    }
    let reachable: boolean;
    try {
      // HEAD with `redirect: manual` so a 301/302 to an error page still
      // counts as the edge routing us. AbortSignal.timeout bounds the
      // probe at EDGE_PROBE_TIMEOUT_MS — DNS resolution alone can take
      // tens of seconds against a dead authority.
      await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(EDGE_PROBE_TIMEOUT_MS)
      });
      reachable = true;
    } catch {
      // ONLY a thrown fetch counts as unreachable: DNS failure, TCP
      // refused, TLS failure, or timeout. Any resolved HTTP Response
      // (including 404, 502, 530) means the edge is still routing
      // requests to us, so a misconfigured origin doesn't get
      // misclassified as a dead hostname.
      reachable = false;
    }
    const { failures, dead } = evaluateEdgeProbe(
      this.edgeProbeFailures,
      reachable,
      EDGE_PROBE_FAILURE_THRESHOLD
    );
    this.edgeProbeFailures = failures;
    if (!dead) return;
    // Re-validate before reacting. Between the await and now a rotate-
    // secret recycle could have swapped publicUrl, a disable could have
    // nulled it, or SIGTERM could have started the drain. Reacting in
    // any of those races would clobber a fresh, healthy state with a
    // stale failure count.
    if (
      gen !== this.generation ||
      this.shuttingDown ||
      !this.snapshot.enabled ||
      this.snapshot.publicUrl !== url
    ) {
      return;
    }
    // Auto-recycle path: capture the values we need before we yield the
    // event loop, then enqueue the swap so it serializes against any
    // concurrent enable / disable / rotateSecret. The integration path
    // (probe → enqueue → swapCloudflared → runRefreshNotes) is covered
    // by manual + CHECKLIST live testing rather than a unit test —
    // testing it would require fake timers plus an invasive
    // swapCloudflared mock in this single-class structure.
    const deadUrl = this.snapshot.publicUrl;
    const port = this.lastWebPort;
    const genBeforeRecycle = this.generation;
    const priorFailures = failures;
    appendLog(this.config.instance, "tunnel.edge-unreachable.recycling", { deadUrl, failures });
    if (port === null) {
      // No port to bind against — we never observed a successful enable
      // with a webPort, so we can't safely respawn cloudflared. Fall
      // back to the original degraded behavior and let the operator
      // intervene.
      try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
      setRedactionPublicUrl(null);
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(
          `tunnel unreachable at the Cloudflare edge after ${failures} consecutive probes — the quick-tunnel hostname likely expired; recycle to restore`
        )
      };
      appendLog(this.config.instance, "tunnel.edge-unreachable.no-port", { failures });
      this.stopEdgeProbe();
      return;
    }
    void this.enqueue(async () => {
      // Re-validate inside the queue slot — a concurrent disable /
      // rotateSecret / re-enable that ran ahead of us would have bumped
      // the generation, flipped shuttingDown, or toggled enabled.
      if (
        this.generation !== genBeforeRecycle ||
        this.shuttingDown ||
        !this.snapshot.enabled
      ) {
        appendLog(this.config.instance, "tunnel.edge-unreachable.recycle-aborted", { reason: "superseded" });
        return;
      }
      // Pull secret from disk — TunnelPersistedConfig.secret is `string`
      // (always present), unlike TunnelSnapshot.secret which is
      // `string | null`. Disk is the source of truth for the live
      // secret anyway, and reading inside the queue slot means we
      // capture the value any concurrent rotateSecret would have
      // already committed.
      const secret = this.readPersisted().secret;
      const swap = await this.swapCloudflared(port, secret);
      if (!swap.ok) {
        const swapError = swap.error ?? "unknown swap failure";
        try { unlinkSync(publicUrlPath(this.config.instance)); } catch { /* may not exist */ }
        setRedactionPublicUrl(null);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redact(`tunnel unreachable; auto-recycle failed: ${swapError}`)
        };
        appendLog(this.config.instance, "tunnel.edge-unreachable.recycle-failed", { error: redact(swapError) });
        this.stopEdgeProbe();
        return;
      }
      // swapCloudflared already called startEdgeProbe(), which zeros the
      // failure count for the new URL — keep this assignment as a belt-
      // and-suspenders guard so a future refactor of startEdgeProbe
      // can't silently leave us counting against a fresh hostname.
      this.edgeProbeFailures = 0;
      appendLog(this.config.instance, "tunnel.edge-unreachable.recycled", {
        newUrl: this.snapshot.publicUrl,
        priorFailures
      });
      // Fire-and-forget Notes refresh so iCloud reflects the new
      // bootstrap URL without operator action — the phone re-reads the
      // note to find the live hostname. Same pattern as enable() /
      // rotateSecret().
      if (this.snapshot.appleNotes.enabled && this.notesAvailable) {
        const scheduledGeneration = this.generation;
        void this.runRefreshNotes(scheduledGeneration).catch(() => { /* surfaced in appleNotes.lastError */ });
      }
    }).catch(() => { /* surfaced in snapshot.lastError + appendLog above */ });
  }

  private notesNoteName(): string {
    return `gini-tunnel-${this.config.instance}`;
  }
}

/** Compose the bootstrap URL the phone scans: `<publicUrl>/<secret>`. The
 *  proxy accepts both `/<secret>` and `/<secret>/` (matchSecretPrefix in
 *  tunnel-policy.ts), but Next.js 16's trailing-slash URL normalization
 *  intercepts the slash form with a 308 redirect BEFORE the proxy/middleware
 *  runs, dropping the Set-Cookie header the proxy would have minted. Encoding
 *  the no-slash form sidesteps that normalization entirely — the request
 *  goes straight to the proxy, which mints the cookie and 302s to `/`. See
 *  PLAN.md "Request flow — Scenario A". */
export function bootstrapUrl(publicUrl: string, secret: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/${secret}`;
}
