// useRuntimeStream singleton race test.
//
// Pins the fix for the dev-StrictMode-driven double-invocation race in
// `ensureConnection()`: the original code awaited `fetchTunnelTransport()`
// before assigning `source` / `pollAbort`, so two `subscribe()` calls in
// rapid succession (the canonical StrictMode pattern) both passed the
// synchronous `source || pollAbort` check, both fetched the transport, and
// both opened a transport — leaking one orphaned EventSource or, worse, an
// orphan poll loop whose AbortController was unreachable from
// `closeConnection()`.
//
// The fix adds a module-level `connecting: Promise<void> | null` claimed
// synchronously inside `ensureConnection()` before any await, so the second
// call short-circuits on `connecting !== null`. This test pins the
// flag-flipping behavior: exactly one transport opens regardless of how many
// subscribe() calls race the initial fetch.
//
// Integration coverage: the React hook layer (`useRuntimeStream`) and the
// EventSource → SSE listener fan-out are still uncovered here — driving them
// requires React + EventSource DOM mocks we don't have. The race fix lives
// entirely in the module-level subscribe/ensureConnection plumbing, which
// this test exercises directly via the `__raceTestHooks` export.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __raceTestHooks } from "./useRuntimeStream";

// Hold-and-release controller for the tunnel-snapshot fetch. Each test
// installs a fresh one so we can let `subscribe()` calls race the
// in-flight fetch deterministically.
type FetchGate = {
  release(value: { publicUrl: string; tunnelTransport: "sse" | "poll" }): void;
  callCount(): number;
};

function installFetchGate(): FetchGate {
  let callCount = 0;
  const { promise: gate, resolve: settle } =
    Promise.withResolvers<{ publicUrl: string; tunnelTransport: "sse" | "poll" }>();
  // Replace `fetch` so `fetchTunnelTransport()` awaits our gate. The poll
  // path also calls `fetch` once the transport opens, but the assertions in
  // this file only run BEFORE we release the gate (for the race assertions)
  // or after a short tick (for the third-call assertion), so any post-open
  // poll fetch lands on the same stub and resolves with our snapshot JSON.
  // That's harmless — `openPollTransport` only uses the body as
  // `{ events, cursor }`, and the wrong shape just makes the loop throw and
  // retry, which we tear down with `reset()` between tests.
  globalThis.fetch = ((..._args: unknown[]): Promise<Response> => {
    callCount += 1;
    return gate.then(
      (snap) =>
        new Response(JSON.stringify(snap), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
  }) as unknown as typeof fetch;
  return {
    release(value): void {
      settle(value);
    },
    callCount(): number {
      return callCount;
    }
  };
}

// Fake EventSource — counts constructions so the SSE-path assertion can
// pin that exactly ONE source opens regardless of how many subscribers
// race the initial fetch.
let eventSourceConstructions = 0;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    eventSourceConstructions += 1;
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {
    // No-op — the test asserts on construction count, not on dispatch.
  }
  close(): void {
    this.closed = true;
  }
}

let originalFetch: typeof fetch;
let originalEventSource: unknown;
let originalWindow: unknown;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEventSource = (globalThis as Record<string, unknown>).EventSource;
  originalWindow = (globalThis as Record<string, unknown>).window;
  // pageIsOnTunnelHost() reads window.location.origin (then derives
  // hostname via the URL constructor) — without this shim it would
  // early-return "sse" without awaiting the gate (the ternary branch
  // becomes synchronous), which would mask the race.
  (globalThis as Record<string, unknown>).window = {
    location: { origin: "https://abc.trycloudflare.com" }
  };
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  eventSourceConstructions = 0;
  FakeEventSource.instances.length = 0;
  __raceTestHooks.reset();
});

afterEach(() => {
  __raceTestHooks.reset();
  globalThis.fetch = originalFetch;
  if (originalEventSource === undefined) {
    delete (globalThis as Record<string, unknown>).EventSource;
  } else {
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  }
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }
});

describe("subscribe() singleton race fix", () => {
  test("two rapid subscribe() calls open exactly one SSE transport", async () => {
    const gate = installFetchGate();
    // Two listeners race ensureConnection() against the held fetch. The fix
    // claims `connecting` synchronously in the first call, so the second
    // call's ensureConnection() short-circuits on `connecting !== null`.
    const unsub1 = __raceTestHooks.subscribe(() => {});
    const unsub2 = __raceTestHooks.subscribe(() => {});
    // Both calls returned, but the fetch is still pending. We should have
    // exactly ONE in-flight fetch and ZERO opened transports at this point.
    expect(gate.callCount()).toBe(1);
    expect(__raceTestHooks.getState().source).toBeNull();
    expect(__raceTestHooks.getState().pollAbort).toBeNull();
    expect(__raceTestHooks.getState().connecting).not.toBeNull();
    expect(__raceTestHooks.getState().listenerCount).toBe(2);

    // Release the snapshot — SSE branch wins (tunnelTransport: "sse").
    gate.release({ publicUrl: "https://abc.trycloudflare.com", tunnelTransport: "sse" });
    // Yield long enough for the ensureConnection() IIFE to settle.
    await __raceTestHooks.getState().connecting;

    // Exactly ONE EventSource constructed — the race fix worked. Without
    // it, both ensureConnection() invocations would have constructed a
    // FakeEventSource each.
    expect(eventSourceConstructions).toBe(1);
    expect(__raceTestHooks.getState().source).not.toBeNull();
    expect(__raceTestHooks.getState().activeTransport).toBe("sse");
    expect(__raceTestHooks.getState().connecting).toBeNull();

    unsub1();
    unsub2();
  });

  test("third subscribe() after connection established does not reopen", async () => {
    const gate = installFetchGate();
    const unsub1 = __raceTestHooks.subscribe(() => {});
    gate.release({ publicUrl: "https://abc.trycloudflare.com", tunnelTransport: "sse" });
    await __raceTestHooks.getState().connecting;
    // Source is up; a fresh subscribe() must NOT trigger a new fetch and
    // must NOT construct a second EventSource.
    expect(eventSourceConstructions).toBe(1);
    const fetchCallsBefore = gate.callCount();
    const unsub2 = __raceTestHooks.subscribe(() => {});
    expect(gate.callCount()).toBe(fetchCallsBefore);
    expect(eventSourceConstructions).toBe(1);
    expect(__raceTestHooks.getState().listenerCount).toBe(2);
    unsub1();
    unsub2();
  });

  test("closeConnection() while connecting aborts the in-flight open", async () => {
    const gate = installFetchGate();
    const unsub = __raceTestHooks.subscribe(() => {});
    // Unmount the only subscriber while the fetch is still pending. The
    // close path latches `closeRequestedWhileConnecting` so the IIFE's
    // post-await body bails out before constructing a transport.
    unsub();
    expect(__raceTestHooks.getState().listenerCount).toBe(0);
    gate.release({ publicUrl: "https://abc.trycloudflare.com", tunnelTransport: "sse" });
    await __raceTestHooks.getState().connecting;
    // No transport opened — the bail-out fired.
    expect(eventSourceConstructions).toBe(0);
    expect(__raceTestHooks.getState().source).toBeNull();
    expect(__raceTestHooks.getState().pollAbort).toBeNull();
    expect(__raceTestHooks.getState().activeTransport).toBeNull();
  });

  test("resubscribe during in-flight close reopens transport for the new subscriber", async () => {
    // Strand scenario: subscribe A, immediately unsub A (latches
    // closeRequestedWhileConnecting because the IIFE is still awaiting
    // the gate), subscribe B BEFORE the gate releases. Without the
    // listeners.size check, the IIFE would observe the latch and bail
    // — leaving B with source/pollAbort/connecting all null and no
    // path to ever open a transport.
    const gate = installFetchGate();
    const unsubA = __raceTestHooks.subscribe(() => {});
    unsubA();
    // The latch is now set; the IIFE hasn't run its post-await body yet.
    expect(__raceTestHooks.getState().listenerCount).toBe(0);
    expect(__raceTestHooks.getState().connecting).not.toBeNull();
    // New subscriber arrives BEFORE the gate releases.
    const unsubB = __raceTestHooks.subscribe(() => {});
    expect(__raceTestHooks.getState().listenerCount).toBe(1);
    // Now release the gate — the IIFE's post-await body sees the latch
    // set AND listeners.size > 0, so it MUST proceed to open the
    // transport for the new subscriber B.
    gate.release({ publicUrl: "https://abc.trycloudflare.com", tunnelTransport: "sse" });
    await __raceTestHooks.getState().connecting;
    // B has a transport — the strand is fixed.
    expect(eventSourceConstructions).toBe(1);
    expect(__raceTestHooks.getState().source).not.toBeNull();
    expect(__raceTestHooks.getState().activeTransport).toBe("sse");
    expect(__raceTestHooks.getState().connecting).toBeNull();
    unsubB();
    // B is gone — connection actually closes now.
    expect(__raceTestHooks.getState().source).toBeNull();
  });

  test("two rapid subscribe() calls open exactly one poll transport", async () => {
    // Same race shape, but the snapshot picks the poll branch. Asserts the
    // poll path (the costly one — orphan retry loops) is also gated.
    const gate = installFetchGate();
    const unsub1 = __raceTestHooks.subscribe(() => {});
    const unsub2 = __raceTestHooks.subscribe(() => {});
    expect(__raceTestHooks.getState().connecting).not.toBeNull();
    gate.release({ publicUrl: "https://abc.trycloudflare.com", tunnelTransport: "poll" });
    await __raceTestHooks.getState().connecting;
    expect(__raceTestHooks.getState().activeTransport).toBe("poll");
    // Exactly ONE AbortController stored — without the fix, the second
    // subscribe() would have overwritten it with its own controller and
    // orphaned the first poll loop forever.
    expect(__raceTestHooks.getState().pollAbort).not.toBeNull();
    unsub1();
    unsub2();
    // After last unsub, the controller is aborted and pollAbort reset.
    expect(__raceTestHooks.getState().pollAbort).toBeNull();
  });
});
