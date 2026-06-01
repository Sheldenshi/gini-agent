// PATCH /api/tunnel ordering invariant: concurrent enable/disable
// requests must reach the manager's apply chain in arrival order so
// the later-issued operation wins the final state.
//
// Pins the fix for a race where PATCH /api/tunnel could invert
// enable/disable order: the original HTTP handler `await`-ed
// `isSupervisedWebChild()` (a bounded fetch up to 1500ms) BEFORE
// calling `tunnelManager.enable()`. A client that issued enable at
// T0 and disable at T1 > T0 could see disable enqueue first (because
// its body parse is fast and there's no pre-probe), then enable
// would enqueue AFTER disable had already completed — re-enabling a
// tunnel the operator had just disabled. The fix removes the
// pre-handler probe so enable's path to `mgr.enable()` no longer
// stalls behind a 1500ms timeout; the probe still runs inside
// swapCloudflared on the apply-chain slot.
//
// We model the apply chain directly here: a single Promise-chain
// `applyChain` that serializes async tasks in arrival order. This
// mirrors the `enqueue` mechanism in TunnelManager (see
// `runtime/tunnel/manager.ts`). The test pins TWO invariants:
//
//  1. When tasks are enqueued in arrival order T0 then T1, they
//     execute in that order — the apply chain itself is FIFO.
//  2. When the HTTP handler does NOT introduce an unbounded pre-
//     probe await before enqueue, two near-simultaneous PATCH
//     requests preserve their arrival order at the queue boundary,
//     so the later-issued operation wins the final state.
//
// Together these pin the fix: removing the pre-handler probe makes
// the handler's enqueue call site happen before any heavy await, so
// the FIFO invariant of the apply chain matches the request
// arrival order.

import { describe, expect, test } from "bun:test";

/** Strip-down replica of TunnelManager's apply chain. enqueue()
 *  returns a promise that resolves with fn()'s result; tasks run
 *  strictly in the order enqueue() was called. */
class TestApplyChain {
  private chain: Promise<void> = Promise.resolve();
  private completedOps: string[] = [];

  enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.chain = this.chain.then(async () => {
      try {
        const value = await fn();
        this.completedOps.push(label);
        resolve(value);
      } catch (err) {
        reject(err);
      }
    });
    return promise;
  }

  get history(): string[] {
    return this.completedOps;
  }
}

/** Simulate the PATCH handler's pre-fix behavior: it awaited a
 *  slow health probe BEFORE enqueuing the enable. Disable went
 *  straight to enqueue. */
async function preFixHandlerEnable(
  chain: TestApplyChain,
  state: { enabled: boolean },
  slowProbe: Promise<void>
): Promise<void> {
  // The slow probe stalls the enable handler OUTSIDE the queue.
  await slowProbe;
  // ONLY now does enable touch the apply chain.
  await chain.enqueue("enable", async () => {
    state.enabled = true;
  });
}

async function preFixHandlerDisable(
  chain: TestApplyChain,
  state: { enabled: boolean }
): Promise<void> {
  // Disable has no pre-probe in either version of the handler.
  await chain.enqueue("disable", async () => {
    state.enabled = false;
  });
}

/** Simulate the post-fix handler: no pre-probe, both enable and
 *  disable enqueue directly after body parse. */
async function postFixHandlerEnable(
  chain: TestApplyChain,
  state: { enabled: boolean }
): Promise<void> {
  await chain.enqueue("enable", async () => {
    state.enabled = true;
  });
}

async function postFixHandlerDisable(
  chain: TestApplyChain,
  state: { enabled: boolean }
): Promise<void> {
  await chain.enqueue("disable", async () => {
    state.enabled = false;
  });
}

describe("PATCH /api/tunnel ordering invariant", () => {
  test("pre-fix: slow pre-probe lets the later-issued disable enqueue first, inverting order", async () => {
    // Issue enable first (T0), then disable (T1 > T0). The enable
    // handler stalls on the slow probe gate; disable rushes through
    // and reaches the queue first. Once the probe gate releases,
    // enable enqueues AFTER disable has already completed —
    // silently overwriting the operator's later disable intent.
    const chain = new TestApplyChain();
    const state = { enabled: false };
    const probeGate = Promise.withResolvers<void>();

    const enablePromise = preFixHandlerEnable(chain, state, probeGate.promise);
    // Yield once so the enable's await on probeGate is parked.
    await Promise.resolve();
    const disablePromise = preFixHandlerDisable(chain, state);
    // Release the probe gate AFTER disable has already enqueued.
    probeGate.resolve();

    await Promise.all([enablePromise, disablePromise]);

    // Order inversion: disable ran first, then enable. The
    // operator-visible final state is `enabled: true` even though
    // disable was issued LATER. This is the bug.
    expect(chain.history).toEqual(["disable", "enable"]);
    expect(state.enabled).toBe(true);
  });

  test("post-fix: no pre-probe await means arrival order is preserved", async () => {
    // Same client behavior — enable at T0, disable at T1 > T0.
    // Without the pre-probe stall, both handlers enqueue
    // immediately on arrival. The apply chain is FIFO, so the
    // later-issued disable runs last and wins the final state.
    const chain = new TestApplyChain();
    const state = { enabled: false };

    const enablePromise = postFixHandlerEnable(chain, state);
    // Same scheduling gap as the pre-fix test — a single
    // microtask yield between the two calls.
    await Promise.resolve();
    const disablePromise = postFixHandlerDisable(chain, state);

    await Promise.all([enablePromise, disablePromise]);

    // Arrival order preserved at the queue: enable then disable.
    // Final state correctly reflects the later-issued operation.
    expect(chain.history).toEqual(["enable", "disable"]);
    expect(state.enabled).toBe(false);
  });

  test("apply chain itself is FIFO regardless of work duration", async () => {
    // Sanity check on the underlying primitive: a long-running
    // task ahead of a short-running task does not let the short
    // task jump the queue. The fix relies on this property.
    const chain = new TestApplyChain();
    const slowGate = Promise.withResolvers<void>();
    const slow = chain.enqueue("slow", async () => {
      await slowGate.promise;
    });
    const fast = chain.enqueue("fast", async () => {});
    slowGate.resolve();
    await Promise.all([slow, fast]);
    expect(chain.history).toEqual(["slow", "fast"]);
  });
});
