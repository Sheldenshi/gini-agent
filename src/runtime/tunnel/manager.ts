import type { RuntimeConfig } from "../../types";
import { appendLog, purgeTunnelDevices } from "../../state";
import { setRedactionPublicUrl, setRedactionSecret, redact } from "./redact";
import { launchCloudflared, TERMINATE_CAP_MS, type CloudflaredLaunch } from "./cloudflared";
import { ensureCloudflaredBin, manualInstallHint, CloudflaredUnavailableError } from "./cloudflared-install";
import { probeNotesAvailable, writeNote, clearNote } from "./apple-notes";
import { ensureTunnelConfig, patchTunnelConfig, readTunnelConfig } from "./config-store";
import { atomicWriteFile } from "../../atomic-write";
import { isSupervisedWebChild } from "../health-probe";
import { generateTunnelSecret, secretRevision } from "./secret";
import { inferTunnelTransport } from "./transport";
import { instanceRoot } from "../../paths";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { TUNNEL_PUBLIC_URL_FILENAME, type AppleNotesState, type TunnelSnapshot, type TunnelTransitionResult, type TunnelPersistedConfig } from "./types";

/** Path of the sibling file the runtime writes when the tunnel is up so the
 *  Next.js proxy (a separate process) can match the live tunnel hostname per
 *  request instead of trusting any `*.trycloudflare.com`. The file is removed
 *  on disable / shutdown / failed enable. */
function publicUrlPath(instance: string): string {
  return join(instanceRoot(instance), TUNNEL_PUBLIC_URL_FILENAME);
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
// rotate) goes through a single serialized apply path. See
// docs/adr/tunnel-and-mobile-access.md "Architecture (summary)".

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
  // Detached-kill chain for the prior cloudflared process. disable() and
  // the kill-old branches of swapCloudflared chain their `prev.stop()`
  // onto this Promise instead of awaiting it inline so the in-flight HTTP
  // response (the operator clicked Disable / Rotate over the live tunnel)
  // can flush through the still-alive OLD cloudflared BEFORE that process
  // dies and severs the TCP connection. Subsequent operations that need
  // to know the kill is done (enable, swapCloudflared's spawn, shutdown)
  // await `pendingKill` to preserve the apply-chain serialization
  // documented above swapCloudflared.
  private pendingKill: Promise<void> = Promise.resolve();
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
  /** True while rotateSecret is mid-flight, from the moment the new
   *  secret is persisted to disk until the recycle finishes (or fails).
   *  Read by the QR endpoint to suppress emission during the window
   *  where the new on-disk secret is bonded to the old publicUrl —
   *  handing out that mix would yield a bootstrap URL the old tunnel
   *  immediately rejects with HTTP 404 once its cookie compare fails. */
  private rotating = false;

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
    this.removePublicUrlFile();
    this.snapshot = {
      enabled: persisted.enabled,
      secret: persisted.secret,
      secretRevision: secretRevision(persisted.secret),
      publicUrl: null,
      tunnelTransport: inferTunnelTransport(null),
      lastError: null,
      lastErrorCode: null,
      // Constant for the process lifetime — computed once from this host's
      // platform/arch. Carried forward by every `...this.snapshot` spread.
      cloudflaredInstall: manualInstallHint(),
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

  /** True between the on-disk secret persist and the recycle finishing
   *  (success or failure). The QR endpoint reads this so it doesn't
   *  hand out a bootstrap URL that pairs the new secret with the old
   *  publicUrl. */
  isRotating(): boolean {
    return this.rotating;
  }

  /** TEST-ONLY: directly set the rotating flag so http.test.ts can
   *  drive the QR endpoint's rotate-window suppression branch without
   *  spinning up a real cloudflared. Production code never calls this
   *  — rotateSecret manages the flag through its try/finally. */
  __setRotatingForTest(value: boolean): void {
    this.rotating = value;
  }

  /** TEST-ONLY: drive `enabled` / `secret` directly so handler tests can
   *  cover the live-state recheck paths (disable-in-flight, rotate-in-
   *  flight) without spinning up a real cloudflared. Production code
   *  always routes these transitions through enable / disable /
   *  rotateSecret so the on-disk config, cloudflared lifecycle, and
   *  in-memory snapshot stay in lockstep. */
  __setSnapshotForTest(patch: { enabled?: boolean; secret?: string | null }): void {
    this.snapshot = {
      ...this.snapshot,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.secret !== undefined ? { secret: patch.secret } : {})
    };
  }

  /** TEST-ONLY: queue a single override result for the next `enable()` /
   *  `rotateSecret()` call so handler tests can pin the HTTP-status
   *  mapping without spinning up a real cloudflared. The override is
   *  consumed once; subsequent calls fall back to the real apply chain.
   *  Production code never sets these — the manager owns its own result
   *  generation through the queue. */
  private nextEnableResultOverride: TunnelTransitionResult | null = null;
  private nextRotateSecretResultOverride: TunnelTransitionResult | null = null;
  __setNextEnableResultForTest(result: TunnelTransitionResult): void {
    this.nextEnableResultOverride = result;
  }
  __setNextRotateSecretResultForTest(result: TunnelTransitionResult): void {
    this.nextRotateSecretResultOverride = result;
  }

  /** TEST-ONLY: expose the cached web port so a test can pin the
   *  disable()-clears-lastWebPort invariant without depending on an
   *  observable side effect like rotateSecret's swap behavior. */
  __getLastWebPortForTest(): number | null {
    return this.lastWebPort;
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

  /** Remove the publicUrl sibling file, swallowing ENOENT (the file
   *  legitimately may not exist on the disable / failed-enable /
   *  shutdown paths that call this). Any OTHER error is surfaced as a
   *  log entry so an operator can see when the tear-down is silently
   *  failing — a stuck file on disk would let the proxy keep matching
   *  the Host header against a hostname no cloudflared process is
   *  serving. Sync (not async) so the call is safe inside finally
   *  blocks and the SIGTERM drain path. Extracted from ten inline
   *  copies in this file so the ENOENT handling and the operator
   *  visibility on real errors stay consistent across every call
   *  site. */
  private removePublicUrlFile(): void {
    try {
      unlinkSync(publicUrlPath(this.config.instance));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // appendLog can itself throw (EACCES on the log dir, ENOSPC).
        // This helper's contract is "swallow the file-removal failure";
        // the constructor and the cloudflared exit listener both call
        // removePublicUrlFile() without an outer try/catch, so a thrown
        // log error would surface as an uncaughtException. Keep the
        // log emission strictly best-effort.
        try {
          appendLog(this.config.instance, "tunnel.publicurl-remove-failed", { code });
        } catch {
          // best-effort logging; log-dir errors must not crash the helper
        }
      }
    }
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
      // The operator's intent was to swap (rotateSecret persisted a fresh
      // secret BEFORE this call; edge-probe auto-recycle persisted enabled
      // intent). Leaving the old cloudflared alive after we can't spawn a
      // new one would keep open SSE/TCP streams flowing through a process
      // whose served secret no longer matches what the proxy reads from
      // disk — the exact panic-button violation rotate is supposed to
      // prevent. Tear down the old process AND the publicUrl sibling so
      // the proxy stops accepting requests against a stale URL, stamp
      // the snapshot into the documented degraded shape (enabled &&
      // publicUrl===null && lastError set), and stop the edge probe so
      // it doesn't keep counting failures against a vanished URL. The
      // caller's `if (!swap.ok)` branch then runs (rotateSecret preserves
      // its pre-stamped new secret on disk per the existing pre-stamp
      // contract; auto-recycle falls back to its degraded-with-lastError
      // log path).
      //
      // Manual test path: trigger rotateSecret with the Next.js
      // supervised child killed externally between the pre-probe at
      // rotateSecret and the re-probe in swapCloudflared; assert
      // snapshot reports enabled && publicUrl===null && lastError,
      // `pgrep -fl cloudflared` shows no process bound to this
      // instance, and the next `enable()` brings it back cleanly.
      if (this.cloudflared) {
        const prev = this.cloudflared;
        this.cloudflared = null;
        // Defer the SIGTERM to a macrotask so the in-flight HTTP response
        // has flushed past the IO turn before the tunnel process is
        // signaled. A .then() chain alone runs on the microtask queue,
        // which fires before the IO callbacks that write response bytes
        // to the socket. setImmediate schedules the callback for the
        // next IO check, after the current turn's microtask drain. The
        // next operation that needs the kill complete (enable's
        // pre-spawn await, shutdown's await) will block on pendingKill,
        // so chain order is preserved even though this call doesn't
        // await.
        this.pendingKill = this.pendingKill.then(
          () => new Promise<void>((resolve) => {
            setImmediate(() => {
              prev.stop().catch(() => { /* already gone */ }).finally(() => resolve());
            });
          }),
        );
      }
      this.removePublicUrlFile();
      setRedactionPublicUrl(null);
      const message = `web port ${webPort} not healthy — swap aborted, prior cloudflared stopped`;
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(message),
        lastErrorCode: "web_port_unhealthy"
      };
      this.stopEdgeProbe();
      return { ok: false, error: redact(message), code: "web_port_unhealthy" };
    }
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      // Defer the SIGTERM to a macrotask so the in-flight HTTP response
      // has flushed past the IO turn before the tunnel process is
      // signaled. A .then() chain alone runs on the microtask queue,
      // which fires before the IO callbacks that write response bytes
      // to the socket. setImmediate schedules the callback for the
      // next IO check, after the current turn's microtask drain. The
      // await below blocks on the chain so spawn order is preserved
      // (the new cloudflared can't bind until the prior one's stop
      // promise settles).
      this.pendingKill = this.pendingKill.then(
        () => new Promise<void>((resolve) => {
          setImmediate(() => {
            prev.stop().catch(() => { /* already gone */ }).finally(() => resolve());
          });
        }),
      );
    }
    // Block on any prior detached kill before spawning so we don't race
    // a new cloudflared against the dying one binding the same upstream.
    await this.pendingKill;
    // Re-check shuttingDown one last time before the spawn. The probe
    // (1500ms timeout) and the prior detached kill (up to 5s SIGKILL
    // fallback) are both async — SIGTERM may have arrived during either
    // await. Without this gate, the post-banner shutdown check would
    // still catch it, but we'd have spawned cloudflared for the
    // duration of the banner parse before tearing it back down. Skip
    // the spawn entirely if shutdown started.
    if (this.shuttingDown) {
      return { ok: false, error: "Tunnel manager shutting down" };
    }
    // Resolve a usable cloudflared binary, auto-installing it on first use so
    // a fresh machine with no Homebrew / apt / system cloudflared can still
    // bring the tunnel up. Only an offline host with no managed binary reaches
    // the catch, where we stamp actionable, platform-appropriate guidance
    // instead of the raw spawn-ENOENT blob the UI used to render.
    let cloudflaredBin: string;
    try {
      cloudflaredBin = await ensureCloudflaredBin({
        log: (event, data) => appendLog(this.config.instance, event, data ?? {})
      });
    } catch (err) {
      const hint = err instanceof CloudflaredUnavailableError ? err.hint : manualInstallHint();
      const message = err instanceof Error ? err.message : String(err);
      this.removePublicUrlFile();
      setRedactionPublicUrl(null);
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(message),
        lastErrorCode: "cloudflared_unavailable",
        cloudflaredInstall: hint
      };
      this.stopEdgeProbe();
      appendLog(this.config.instance, "tunnel.cloudflared.unavailable", { platform: hint.platform });
      return { ok: false, error: redact(message), code: "cloudflared_unavailable" };
    }
    // Re-check shuttingDown one more time after the install await. A first-
    // use enable can spend a long time inside ensureCloudflaredBin downloading
    // the binary over the network; SIGTERM may have flipped the flag during
    // that download. Without this gate a brand-new cloudflared would spawn
    // and outlive the bounded drain — the post-banner shutdown check below
    // would still tear it down, but only after the spawn + banner-parse
    // window. Mirror the pre-spawn shutdown check above and skip the spawn
    // entirely.
    if (this.shuttingDown) {
      return { ok: false, error: "Tunnel manager shutting down" };
    }
    const launch = launchCloudflared({ bin: cloudflaredBin, port: webPort });
    this.cloudflared = launch;
    // Install the exit listener BEFORE the await so any same-tick
    // crash during banner parse triggers cleanup. process.once does
    // not fire for past exits. Identity check + null-cloudflared
    // guards double-cleanup when the catch block below also handles
    // the same exit.
    launch.process.once("exit", (code, signal) => {
      if (this.cloudflared !== launch) return;
      this.cloudflared = null;
      this.removePublicUrlFile();
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
        lastError: redact(`cloudflared exited (${reason})`),
        lastErrorCode: null
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
        this.removePublicUrlFile();
        setRedactionPublicUrl(null);
        const reason = launch.process.exitCode !== null
          ? `code ${launch.process.exitCode}`
          : `signal ${launch.process.signalCode}`;
        const msg = redact(`cloudflared exited (${reason}) during banner parse`);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: msg,
          lastErrorCode: null
        };
        return { ok: false, error: msg };
      }
      // Re-check the shutdown flag after the long await — SIGTERM may
      // have flipped it while we were waiting for cloudflared's banner.
      if (this.shuttingDown) {
        this.cloudflared = null;
        try { await launch.stop(); } catch { /* already gone */ }
        this.removePublicUrlFile();
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: "shutdown",
          lastErrorCode: null
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
        lastError: null,
        lastErrorCode: null
      };
      setRedactionPublicUrl(url);
      try {
        atomicWriteFile(publicUrlPath(this.config.instance), `${url}\n`);
      } catch (writeErr) {
        // The sibling publicUrl file is what the proxy reads on every
        // request via readPersistedPublicUrl. If the write fails, the
        // proxy sees an empty string and 404s every request — but the
        // snapshot would still claim publicUrl:url + enabled:true,
        // lying to the PATCH handler, settings card, and QR launcher.
        // Bring the snapshot back to a coherent failed state, kill the
        // freshly spawned cloudflared so we don't leak the process, and
        // return ok:false so the caller's existing failure-handling
        // path (rollback the persisted enable intent, log the error)
        // runs.
        const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        const redactedMsg = redact(`tunnel.publicUrl write failed: ${writeMsg}`);
        appendLog(this.config.instance, "tunnel.publicUrl.write-error", { error: redact(writeMsg) });
        this.cloudflared = null;
        try { await launch.stop(); } catch { /* already gone */ }
        setRedactionPublicUrl(null);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redactedMsg,
          lastErrorCode: null
        };
        return { ok: false, error: redactedMsg };
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
      this.removePublicUrlFile();
      const msg = err instanceof Error ? err.message : String(err);
      // ensureCloudflaredBin resolved a real binary just above, so the
      // spawn should never ENOENT — but a resolve→spawn TOCTOU (the
      // binary deleted/renamed in the gap, PATH mutated) can still reject
      // here with a raw spawn ENOENT now that cloudflared.ts no longer
      // rewrites it. Classify that residual ENOENT into the same
      // actionable `cloudflared_unavailable` shape the ensureCloudflaredBin
      // catch stamps so the install-guidance UI renders, instead of the
      // old three-OS blob with lastErrorCode:null. All other spawn / banner
      // failures keep the generic lastErrorCode:null path unchanged.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        const hint = manualInstallHint();
        setRedactionPublicUrl(null);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redact(msg),
          lastErrorCode: "cloudflared_unavailable",
          cloudflaredInstall: hint
        };
        this.stopEdgeProbe();
        appendLog(this.config.instance, "tunnel.cloudflared.unavailable", { platform: hint.platform });
        return { ok: false, error: redact(msg), code: "cloudflared_unavailable" };
      }
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(msg),
        lastErrorCode: null
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

  // Manual test path for the boot-reconcile + shutdown rollback guards
  // (no unit test — the rollback branch wraps swapCloudflared which
  // depends on cloudflared spawn + banner parse, both of which would
  // need invasive mocks to drive synthetically). Two scenarios:
  //   1. Boot-reconcile transient failure: persist `tunnel.enabled:true`
  //      in config, rename the cloudflared binary out of PATH (or move
  //      the listener web port), boot the gateway, observe that the
  //      reconcile attempt fails AND that tunnel.enabled on disk is
  //      still true after the failure. Restart proves the persisted
  //      intent survives so the next reboot retries.
  //   2. SIGTERM during enable: with a live gateway and tunnel enabled,
  //      issue a user enable() (e.g. re-enable after a brief disable)
  //      and send SIGTERM during the cloudflared banner-parse window
  //      (bounded at 30_000 ms by bannerTimeoutMs in cloudflared.ts).
  //      Observe tunnel.enabled on disk is still true after shutdown
  //      so the next boot brings the tunnel back up.
  async enable(webPort: number, opts: { reconcileOnly?: boolean } = {}): Promise<TunnelTransitionResult> {
    // Remember the port so rotateSecret can recycle without needing the
    // caller to thread it back through. Set OUTSIDE the queue so the
    // value is visible to a concurrent rotateSecret read-then-recycle.
    this.lastWebPort = webPort;
    if (this.nextEnableResultOverride !== null) {
      const override = this.nextEnableResultOverride;
      this.nextEnableResultOverride = null;
      return override;
    }
    return this.enqueue(async () => {
      // Bail before any write/spawn if shutdown has already started — the
      // drain has already run, so finishing this task would resurrect a
      // tunnel the SIGTERM handler just tore down.
      if (this.shuttingDown) {
        return { ok: false, error: "Tunnel manager shutting down" };
      }
      // Wait for any prior detached cloudflared kill (deferred by a
      // disable / rotate / swapCloudflared kill-old branch) before
      // spawning fresh state. swapCloudflared also awaits pendingKill
      // before its launch call; this outer await keeps the persist+
      // snapshot writes serialized with the kill too.
      await this.pendingKill;
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
        // on every request; ordering is important for the TERMINATE_CAP_MS exposure cap.
        const persisted = this.persistTunnel( { enabled: true });
        setRedactionSecret(persisted.secret);
        const result = await this.swapCloudflared(webPort, persisted.secret);
        if (!result.ok) {
          // Roll back enabled:true so the next gateway boot doesn't see a
          // stale enable claim with no live tunnel — but ONLY for operator-
          // driven enables AND only when the failure wasn't caused by
          // shutdown. On the boot-reconcile path the operator's persisted
          // intent was already enabled:true; a transient cloudflared spawn
          // failure (binary missing, banner timeout, port flaky) must NOT
          // silently overwrite that intent. Similarly, if SIGTERM arrived
          // mid-swap the inner shutdown checks return error:"shutdown" /
          // "Tunnel manager shutting down" — rolling back here would
          // disarm the operator's intent purely because of process
          // teardown, and the next gateway boot would not bring the
          // tunnel back up. The in-memory snapshot still reflects the
          // failure so the UI / status can show the degraded state.
          const causedByShutdown = this.shuttingDown
            || result.error === "shutdown"
            || result.error === "Tunnel manager shutting down";
          if (!opts.reconcileOnly && !causedByShutdown) {
            try { this.persistTunnel({ enabled: false }); } catch { /* best-effort */ }
          }
          this.snapshot = { ...this.snapshot, enabled: false };
          appendLog(this.config.instance, "tunnel.enable.error", { error: result.error });
          return result;
        }
        appendLog(this.config.instance, "tunnel.enabled", { generation: this.generation });
        // Fire-and-forget Notes refresh OUTSIDE the apply chain. Enqueuing
        // refreshNotes here would put a 15s osascript timeout ahead of a
        // follow-up disable() in the apply chain, defeating the TERMINATE_CAP_MS
        // exposure cap on disable (see docs/adr/tunnel-and-mobile-access.md
        // "Architecture (summary)"). The bare `runRefreshNotes()`
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
        // persisted state consistent with the in-memory snapshot. Same
        // boot-reconcile + shutdown guards as the inner branch above:
        // neither a reconcile-only transient failure nor a SIGTERM-driven
        // abort should disarm the operator's persisted enable intent.
        const msg = err instanceof Error ? err.message : String(err);
        const causedByShutdown = this.shuttingDown
          || msg === "shutdown"
          || msg === "Tunnel manager shutting down";
        if (!opts.reconcileOnly && !causedByShutdown) {
          try { this.persistTunnel( { enabled: false }); } catch { /* best-effort */ }
        }
        this.snapshot = {
          ...this.snapshot,
          enabled: false,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redact(msg),
          lastErrorCode: null
        };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async disable(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      this.generation += 1;
      // Try to commit enabled:false BEFORE killing cloudflared — ordering
      // for the TERMINATE_CAP_MS exposure cap, see
      // docs/adr/tunnel-and-mobile-access.md "Architecture (summary)".
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
      if (this.cloudflared) {
        const prev = this.cloudflared;
        this.cloudflared = null;
        // Defer the SIGTERM to a macrotask so the in-flight HTTP response
        // has flushed past the IO turn before the tunnel process is
        // signaled. A .then() chain alone runs on the microtask queue,
        // which fires before the IO callbacks that write response bytes
        // to the socket. setImmediate schedules the callback for the
        // next IO check, after the current turn's microtask drain.
        // Subsequent operations await pendingKill to preserve
        // apply-chain ordering. Logging on failure stays attached to
        // the chained Promise rather than this synchronous slot — we
        // want to RETURN now, with the new snapshot, so the HTTP layer
        // can flush.
        this.pendingKill = this.pendingKill.then(
          () => new Promise<void>((resolve) => {
            setImmediate(() => {
              prev.stop()
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  appendLog(this.config.instance, "tunnel.disable.stop-error", { error: redact(msg) });
                })
                .finally(() => resolve());
            });
          }),
        );
      }
      // Stop the edge probe in lockstep with the cloudflared teardown.
      // The probe's internal !snapshot.enabled guard would also short-
      // circuit it once the snapshot stamp below lands, but killing the
      // interval here avoids the wake-and-skip cost.
      this.stopEdgeProbe();
      // Stamp the in-memory snapshot to enabled=false BEFORE the purge
      // so any in-flight push-device handler whose recheck reads
      // `tunnelManager(config).current()` during the upcoming clearNote
      // await sees the disabled state and returns 503. Without this
      // pre-stamp the snapshot keeps `enabled: true` for the duration
      // of the 15s osascript window, letting the recheck pass and
      // upsertDevice insert a fresh `origin:"tunnel"` row AFTER the
      // purge has already wiped the table — leaving an orphan
      // subscription window the dispatcher can never reach. The
      // `appleNotes` block stays as-is here so the post-clear branch
      // below can still observe `appleNotes.enabled` to decide whether
      // to run clearNote; the eventual notesErr stamp lands below.
      const errorMsg = configErr ?? null;
      this.snapshot = {
        ...this.snapshot,
        enabled: false,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: errorMsg ? redact(errorMsg) : null,
        lastErrorCode: null
      };
      // Drop the cached web port now that cloudflared is stopped. The
      // rotateSecret recycle path gates its swap on
      // `cloudflared !== null && lastWebPort !== null`, so today the
      // null cloudflared above already blocks a swap from running
      // against the stale port. Clearing lastWebPort keeps the
      // invariant local: a future change that drops the
      // `cloudflared !== null` half of the gate would otherwise pick
      // up the port from the prior enable() and try to recycle into
      // a process that's no longer there.
      this.lastWebPort = null;
      setRedactionPublicUrl(null);
      this.removePublicUrlFile();
      // Wipe every push-device row tagged as tunneled BEFORE the Notes
      // clear. With the tunnel off, those rows refer to APNs
      // subscriptions that can never be reached again (the public URL
      // is gone); leaving them lets the dispatcher keep trying to
      // deliver to dead devices and gives a leaked-bootstrap holder a
      // permanent subscription window. The purge is a fast local
      // SQLite DELETE, so running it ahead of the Notes osascript
      // means a Notes hang (15s timeout) or failure can't delay the
      // device-row teardown.
      const purgedOnDisable = purgeTunnelDevices(this.config.instance);
      // Clear iCloud Notes copy on disable transition if Notes mirror is on.
      let notesErr: string | null = null;
      if (this.snapshot.appleNotes.enabled && this.notesAvailable) {
        try {
          await clearNote(NOTES_FOLDER, this.notesNoteName());
        } catch (err) {
          notesErr = err instanceof Error ? err.message : String(err);
        }
      }
      // The stop-error path is logged inside the detached kill chain;
      // the disable() response itself only surfaces the synchronous
      // config-write error. Fold any clearNote error into the
      // appleNotes block now that the await has settled.
      if (notesErr) {
        this.snapshot = {
          ...this.snapshot,
          appleNotes: { ...this.snapshot.appleNotes, lastError: redact(notesErr) }
        };
      }
      appendLog(this.config.instance, "tunnel.disabled", {
        generation: this.generation,
        tunnelDevicesPurged: purgedOnDisable.deleted
      });
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
    if (this.nextRotateSecretResultOverride !== null) {
      const override = this.nextRotateSecretResultOverride;
      this.nextRotateSecretResultOverride = null;
      return override;
    }
    let scheduledGeneration = 0;
    let didRecycle = false;
    const result: TunnelTransitionResult = await this.enqueue(async (): Promise<TunnelTransitionResult> => {
      // Bump the generation so any in-flight detached Notes refresh from
      // a prior enable() / rotateSecret() bails before writing the now-
      // stale URL/secret to iCloud Notes.
      this.generation += 1;
      // True once the new secret has been written to disk. Gates the
      // finally-block purge: rows are bound to the OLD secret and
      // become unreachable only after the NEW secret hits disk. A
      // pre-commit abort (web port unhealthy) leaves the old secret
      // live, so purging device rows would silently revoke phones
      // whose cookie still validly matches what's running.
      let didCommitNewSecret = false;
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
            this.snapshot = {
              ...this.snapshot,
              lastError: redact(`web port ${this.lastWebPort} not healthy — rotation aborted before commit`),
              lastErrorCode: "web_port_unhealthy"
            };
            return { ok: false, error: `web port ${this.lastWebPort} not healthy — rotation aborted before commit`, code: "web_port_unhealthy" };
          }
        }
        // Open the rotate window. From this point until the recycle
        // settles, the on-disk secret is the new value but the still-
        // live publicUrl belongs to the OLD cloudflared. The QR
        // endpoint reads this.rotating and returns 503 until the
        // window closes, so a tunneled caller can't pick up a
        // bootstrap URL whose secret+url pair would immediately fail
        // the proxy's cookie compare. Cleared in the outer finally so
        // a thrown / rejected recycle still releases the flag.
        this.rotating = true;
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null)
        };
        const next = this.persistTunnel( { secret: generateTunnelSecret() });
        // Flip the commit-marker the instant persistTunnel returns —
        // every device row tagged against the old secret is now
        // unreachable, so the finally-block purge is authorized.
        didCommitNewSecret = true;
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
        //
        // Clear lastError / lastErrorCode here so a successful rotate
        // wipes any stale failure state regardless of whether the
        // tunnel is currently up. The no-cloudflared branch below
        // returns directly from this pre-stamp without further
        // snapshot updates, so a prior enable() / rotate failure that
        // left lastError set would otherwise persist across an
        // operator-driven rotation that has, by definition, succeeded.
        this.snapshot = {
          ...this.snapshot,
          secret: next.secret,
          secretRevision: secretRevision(next.secret, this.snapshot.publicUrl),
          lastError: null,
          lastErrorCode: null
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
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg), lastErrorCode: null };
        return { ok: false, error: redact(msg) };
      } finally {
        // Only wipe device rows when the new secret actually landed on
        // disk. If the rotate aborted before the persist call (e.g. the
        // pre-flight `web_port_unhealthy` return), the OLD secret is
        // still the live one — purging would silently drop every phone
        // that still has a valid cookie, breaking push delivery until
        // each device re-launches and re-registers. Once the commit has
        // happened, every old-secret-bound row is unreachable and the
        // purge is mandatory whether the recycle succeeded, returned
        // early, or threw — a leaked bootstrap holder would otherwise
        // retain a permanent APNs subscription window even though
        // their cookie no longer matches the live secret. The purge
        // count is logged below so an operator inspecting the audit
        // trail can see how many subscriptions were dropped on each
        // successful rotation.
        if (didCommitNewSecret) {
          const purgedOnRotate = purgeTunnelDevices(this.config.instance);
          appendLog(this.config.instance, "tunnel.secret-rotated", {
            recycled: didRecycle,
            tunnelDevicesPurged: purgedOnRotate.deleted
          });
        } else {
          appendLog(this.config.instance, "tunnel.secret-rotate-aborted", {
            recycled: didRecycle,
            tunnelDevicesPurged: 0
          });
        }
        // Always release the rotate window — without this a thrown
        // recycle (e.g. cloudflared banner timeout) would leave the QR
        // endpoint returning 503 forever, with no operator-visible
        // recovery short of restarting the gateway.
        this.rotating = false;
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
    // and break the TERMINATE_CAP_MS exposure cap — see
    // docs/adr/tunnel-and-mobile-access.md "Architecture (summary)"). Pattern
    // mirrors enable()'s fire-and-forget Notes refresh.
    let scheduledGeneration = 0;
    const result: TunnelTransitionResult = await this.enqueue(async (): Promise<TunnelTransitionResult> => {
      try {
        this.persistTunnel( { appleNotes: { enabled } });
        // Bump the generation on every Notes-toggle transition so an
        // in-flight `runRefreshNotes` / `runClearNotes` scheduled by a
        // prior enable() / rotateSecret() / edge-recycle (or by the
        // previous toggle) supersedes cleanly. Without this, a fast
        // off→on sequence leaves `this.generation` unchanged across
        // the persist, so the prior worker's `scheduledGeneration ===
        // this.generation` check at its post-await re-entry passes —
        // and writeNote fires against the now-stale URL/secret pair.
        // Bumping here makes the gen-mismatch gate inside the worker
        // bodies bail the older scheduled task before its side
        // effect lands. The new `scheduledGeneration` captured below
        // is the post-bump value, so this toggle's own follow-up
        // worker still proceeds.
        this.generation += 1;
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
        this.snapshot = { ...this.snapshot, lastError: redact(msg), lastErrorCode: null };
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
      //
      // Only schedule the recovery if the generation hasn't moved since
      // this clear was scheduled. A concurrent setAppleNotesEnabled that
      // bumps the generation has already (or will) schedule its own
      // refresh under the new generation — firing another one here
      // would duplicate the writeNote and reintroduce the very race the
      // generation gate exists to prevent.
      if (this.snapshot.appleNotes.enabled && this.generation === scheduledGeneration) {
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
   *  because the SIGTERM drain is bounded at TERMINATE_CAP_MS — if cloudflared
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
    // drain's TERMINATE_CAP_MS cap isn't competing with a probe wake. The probe's
    // own shuttingDown guard would also bail any in-flight fetch's
    // result-handling, but unscheduling the interval first is the
    // cleaner termination order.
    this.stopEdgeProbe();
    this.removePublicUrlFile();
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      await prev.stop();
    }
    // Drain any detached kill scheduled by a recent disable / rotate /
    // swapCloudflared kill-old branch so we don't leak a cloudflared
    // process across shutdown. The chained `.catch` inside the
    // pendingKill chain swallows individual errors, so this await
    // never rejects.
    await this.pendingKill;
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
      this.removePublicUrlFile();
      setRedactionPublicUrl(null);
      this.snapshot = {
        ...this.snapshot,
        publicUrl: null,
        tunnelTransport: inferTunnelTransport(null),
        lastError: redact(
          `tunnel unreachable at the Cloudflare edge after ${failures} consecutive probes — the quick-tunnel hostname likely expired; recycle to restore`
        ),
        lastErrorCode: null
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
      // Bump generation so any prior fire-and-forget runRefreshNotes
      // from rotateSecret / enable bails the gen-mismatch gate before
      // its osascript can land a stale URL into iCloud Notes. The
      // recycle's own runRefreshNotes captures `this.generation` AFTER
      // the bump below, so it's not invalidated by its own bump.
      // Mirrors the same pattern used in enable(), disable(), and
      // rotateSecret(): every state transition that ends in a
      // snapshot change bumps generation before doing the side effect.
      this.generation += 1;
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
        this.removePublicUrlFile();
        setRedactionPublicUrl(null);
        this.snapshot = {
          ...this.snapshot,
          publicUrl: null,
          tunnelTransport: inferTunnelTransport(null),
          lastError: redact(`tunnel unreachable; auto-recycle failed: ${swapError}`),
          lastErrorCode: null
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
 *  docs/adr/tunnel-and-mobile-access.md "Architecture (summary)". */
export function bootstrapUrl(publicUrl: string, secret: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/${secret}`;
}
