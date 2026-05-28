// Deferred cloudflared-kill invariant: when the operator clicks Disable
// or Rotate over the live tunnel host, the BFF forwards
// PATCH /api/runtime/tunnel through that same tunnel. If
// `TunnelManager.disable()` / `.swapCloudflared()` awaited `prev.stop()`
// inline, killing cloudflared would sever the TCP connection carrying
// the in-flight response — the browser would see a network error mid-
// response even though the operation succeeded on disk. The fix
// detaches `prev.stop()` onto a `pendingKill` chain so the response
// flushes through the still-alive OLD cloudflared BEFORE that process
// dies. Subsequent operations await `pendingKill` to preserve the
// serialization invariant the apply chain emphasizes.
//
// The TunnelManager class is not exported, and exercising the real
// disable/swap paths end-to-end would require an invasive cloudflared
// mock. We model the two essential primitives here — the apply chain
// and the pendingKill chain — and pin the two invariants the fix
// introduces:
//
//   1. disable() returns BEFORE the prior cloudflared's stop() is
//      invoked. The response can flush.
//   2. A subsequent enable() awaits the deferred kill before spawning,
//      preserving apply-chain ordering across the detached gap.

import { describe, expect, test } from "bun:test";

/** Strip-down replica of TunnelManager's apply chain + pendingKill. */
class TestManager {
  private chain: Promise<void> = Promise.resolve();
  private pendingKill: Promise<void> = Promise.resolve();
  private cloudflared: { stop: () => Promise<void> } | null = null;
  events: string[] = [];

  setCloudflared(c: { stop: () => Promise<void> }): void {
    this.cloudflared = c;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.chain = this.chain.then(async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    });
    return promise;
  }

  /** Mirrors the disable() shape after the fix: stamp synchronously,
   *  detach the kill, return. */
  disable(): Promise<{ ok: true }> {
    return this.enqueue(async () => {
      this.events.push("disable:return");
      if (this.cloudflared) {
        const prev = this.cloudflared;
        this.cloudflared = null;
        this.pendingKill = this.pendingKill.then(async () => {
          this.events.push("disable:kill-start");
          try {
            await prev.stop();
          } catch { /* swallow */ }
          this.events.push("disable:kill-end");
        });
      }
      return { ok: true };
    });
  }

  /** Mirrors the post-fix enable(): await pendingKill before spawn. */
  enable(spawn: () => Promise<void>): Promise<{ ok: true }> {
    return this.enqueue(async () => {
      this.events.push("enable:enter");
      await this.pendingKill;
      this.events.push("enable:spawn");
      await spawn();
      this.events.push("enable:spawned");
      return { ok: true };
    });
  }

  /** Drain pendingKill — mirrors stopForShutdown()'s final await. */
  drainKill(): Promise<void> {
    return this.pendingKill;
  }
}

describe("TunnelManager deferred-kill ordering", () => {
  test("disable() resolves BEFORE the prior cloudflared's stop() is invoked", async () => {
    const mgr = new TestManager();
    // A blocking stop — simulates the SIGTERM/SIGKILL latency that
    // would otherwise span the in-flight HTTP response and sever it.
    const stopGate = Promise.withResolvers<void>();
    let stopStarted = false;
    mgr.setCloudflared({
      stop: async () => {
        stopStarted = true;
        await stopGate.promise;
      }
    });

    // Issue disable and await its resolution. The response would be
    // flushed by the HTTP handler at this point.
    const disableResult = await mgr.disable();
    expect(disableResult.ok).toBe(true);

    // Crucial: at the moment disable() resolved, stop() had not yet
    // started (or, if it had started, it was running detached so the
    // disable() promise was unblocked by its scheduling, not its
    // completion). The detached kill is still pending behind the gate.
    expect(mgr.events[0]).toBe("disable:return");
    // The kill hasn't completed — kill-end never landed.
    expect(mgr.events).not.toContain("disable:kill-end");

    // Release the gate; let the deferred kill finish.
    stopGate.resolve();
    await mgr.drainKill();
    expect(stopStarted).toBe(true);
    expect(mgr.events).toContain("disable:kill-end");
  });

  test("a subsequent enable() awaits the deferred kill before spawning", async () => {
    const mgr = new TestManager();
    const stopGate = Promise.withResolvers<void>();
    mgr.setCloudflared({
      stop: async () => {
        await stopGate.promise;
      }
    });

    // Issue disable; the kill is now detached behind the gate. The
    // detached chain's first `await prev.stop()` may already be in
    // progress (the kill-start event fires before the await yields),
    // but kill-end MUST NOT have landed — that proves the stop is
    // genuinely deferred behind the gate, not joined inline.
    await mgr.disable();
    expect(mgr.events).toContain("disable:return");
    expect(mgr.events).not.toContain("disable:kill-end");

    // Issue enable next. It must NOT spawn until the deferred kill
    // settles — the new cloudflared can't bind alongside the dying old
    // one without risking a race.
    let spawnCalled = false;
    const enablePromise = mgr.enable(async () => {
      spawnCalled = true;
    });

    // Yield several microtasks. Enable should be parked on pendingKill;
    // spawn must not have run yet because stopGate is still closed.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(spawnCalled).toBe(false);
    // The enable task is inside its enqueue slot; it logged 'enable:enter'
    // but not 'enable:spawn' yet — it's parked on pendingKill.
    expect(mgr.events).toContain("enable:enter");
    expect(mgr.events).not.toContain("enable:spawn");

    // Release the kill. Enable should now spawn.
    stopGate.resolve();
    await enablePromise;
    expect(spawnCalled).toBe(true);

    // Final ordering: disable-return, enable-enter (could come before
    // or after disable's kill-start depending on microtask interleave),
    // then kill-end strictly before enable-spawn (the await pendingKill
    // gate), then spawned.
    const killEndIdx = mgr.events.indexOf("disable:kill-end");
    const spawnIdx = mgr.events.indexOf("enable:spawn");
    expect(killEndIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(killEndIdx);
  });

  test("drainKill() awaits any in-flight detached kill — shutdown safety", async () => {
    const mgr = new TestManager();
    const stopGate = Promise.withResolvers<void>();
    let stopCompleted = false;
    mgr.setCloudflared({
      stop: async () => {
        await stopGate.promise;
        stopCompleted = true;
      }
    });

    await mgr.disable();
    // Schedule the drain — it should block on stopGate.
    const drain = mgr.drainKill();
    let drainResolved = false;
    void drain.then(() => { drainResolved = true; });

    // Yield microtasks; drain must not resolve while stopGate is held.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(drainResolved).toBe(false);
    expect(stopCompleted).toBe(false);

    stopGate.resolve();
    await drain;
    expect(drainResolved).toBe(true);
    expect(stopCompleted).toBe(true);
  });
});
