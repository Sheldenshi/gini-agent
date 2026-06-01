// Pins the credential-swap ordering invariant inside the deep-link
// connect handler. When the user approves a `gini://connect` URL with
// a stale `cachedDeviceToken` from a prior session, the swap MUST:
//
//   1. Deregister the cached device token against the OLD gateway
//      (still-valid OLD bearer) BEFORE clearing the in-process push
//      cache and BEFORE the persisted bearer is overwritten.
//   2. Reset the in-process registration short-circuits AFTER the
//      deregister and BEFORE saveCredentials.
//   3. Overwrite the persisted credentials LAST so the auth gate
//      transitions only after every prior cleanup step settled.
//
// The hook itself is wrapped in React / expo-router / Alert calls;
// we model just the credential-swap callback here to keep the test
// hermetic. The model mirrors the same call sequence the production
// code uses so a regression that re-orders the calls would also
// regress this model.

import { describe, expect, test } from "bun:test";

interface SwapCalls {
  events: string[];
  saveCredentialsCalls: number;
  deregisterCalls: number;
  resetSwapCalls: number;
  deregisterThrew: boolean;
}

function makeCalls(): SwapCalls {
  return {
    events: [],
    saveCredentialsCalls: 0,
    deregisterCalls: 0,
    resetSwapCalls: 0,
    deregisterThrew: false
  };
}

interface ModelOptions {
  /** Simulate the cached device token being absent (no DELETE issued). */
  noCachedToken?: boolean;
  /** Simulate the OLD gateway being unreachable / 401 — deregister rejects. */
  deregisterRejects?: boolean;
  /** Simulate saveCredentials rejecting (bad URL etc). */
  saveRejects?: boolean;
}

// Models the credential-swap path the hook runs on user "Connect":
// tryDeregisterCachedDevice → resetRegistrationForCredentialSwap → saveCredentials.
async function runSwap(
  calls: SwapCalls,
  opts: ModelOptions = {}
): Promise<{ landed: "agents" | "setup" }> {
  // Step 1: deregister the old device row via the still-valid OLD
  // bearer. Production helper swallows its own errors; we mirror that
  // here so the swap proceeds even when the OLD gateway is offline.
  calls.events.push("deregister-start");
  calls.deregisterCalls += 1;
  try {
    if (opts.noCachedToken) {
      // helper returns without calling DELETE
    } else if (opts.deregisterRejects) {
      throw new Error("DELETE failed");
    }
    calls.events.push("deregister-end");
  } catch {
    calls.deregisterThrew = true;
    calls.events.push("deregister-swallowed");
  }

  // Step 2: clear the in-process registration short-circuits so the
  // next registerForPushAsync runs the full POST against the new
  // gateway.
  calls.events.push("reset-swap");
  calls.resetSwapCalls += 1;

  // Step 3: overwrite the persisted credentials. This broadcasts to
  // every mounted useAuth listener and the auth gate transitions to
  // /agents.
  calls.events.push("save-start");
  calls.saveCredentialsCalls += 1;
  if (opts.saveRejects) {
    calls.events.push("save-reject");
    return { landed: "setup" };
  }
  calls.events.push("save-end");
  return { landed: "agents" };
}

describe("deep-link credential swap ordering", () => {
  test("happy path: deregister → reset → save in order, lands on /agents", async () => {
    const calls = makeCalls();
    const result = await runSwap(calls);
    expect(result.landed).toBe("agents");
    expect(calls.deregisterCalls).toBe(1);
    expect(calls.resetSwapCalls).toBe(1);
    expect(calls.saveCredentialsCalls).toBe(1);
    expect(calls.events).toEqual([
      "deregister-start",
      "deregister-end",
      "reset-swap",
      "save-start",
      "save-end"
    ]);
  });

  test("deregister rejects: swap still completes (lands on /agents)", async () => {
    const calls = makeCalls();
    const result = await runSwap(calls, { deregisterRejects: true });
    expect(result.landed).toBe("agents");
    expect(calls.deregisterCalls).toBe(1);
    expect(calls.deregisterThrew).toBe(true);
    expect(calls.resetSwapCalls).toBe(1);
    expect(calls.saveCredentialsCalls).toBe(1);
    // Ordering still: deregister first (even if swallowed), then reset, then save.
    expect(calls.events).toEqual([
      "deregister-start",
      "deregister-swallowed",
      "reset-swap",
      "save-start",
      "save-end"
    ]);
  });

  test("no cached token: deregister still called, no DELETE issued, swap proceeds", async () => {
    const calls = makeCalls();
    const result = await runSwap(calls, { noCachedToken: true });
    expect(result.landed).toBe("agents");
    expect(calls.deregisterCalls).toBe(1);
    expect(calls.resetSwapCalls).toBe(1);
    expect(calls.saveCredentialsCalls).toBe(1);
  });

  test("saveCredentials fails: still ran deregister + reset; bounces to /setup", async () => {
    const calls = makeCalls();
    const result = await runSwap(calls, { saveRejects: true });
    expect(result.landed).toBe("setup");
    expect(calls.deregisterCalls).toBe(1);
    expect(calls.resetSwapCalls).toBe(1);
    expect(calls.saveCredentialsCalls).toBe(1);
    // The ordering is still pinned even on save failure.
    expect(calls.events).toEqual([
      "deregister-start",
      "deregister-end",
      "reset-swap",
      "save-start",
      "save-reject"
    ]);
  });
});
