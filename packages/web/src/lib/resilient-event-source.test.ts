// Tests for the resilient EventSource wrapper. The transport and timers are
// injected, so these run with no DOM EventSource, no network, and no real
// sleeps. The behavioral contract under test: the browser's built-in retry
// (readyState CONNECTING) is left alone, the spec's permanent-failure state
// (readyState CLOSED, e.g. after the BFF answers 503 for a restarting
// gateway) triggers a backoff reopen, and close() ends everything.

import { afterEach, describe, expect, test } from "bun:test";
import { openResilientEventSource } from "./resilient-event-source";

const CONNECTING = 0;
const CLOSED = 2;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  attached: string[] = [];
  closeCalls = 0;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, _handler: () => void): void {
    this.attached.push(kind);
  }
  close(): void {
    this.closeCalls += 1;
    this.readyState = CLOSED;
  }
}

// Virtual timer queue: callbacks are captured and fired by hand.
interface PendingTimer {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeHarness(opts: { baseDelayMs?: number; maxDelayMs?: number } = {}) {
  FakeEventSource.instances = [];
  const timers: PendingTimer[] = [];
  const states: boolean[] = [];
  let nextId = 1;
  const handle = openResilientEventSource("/api/runtime/events/stream", {
    attach: (source) => source.addEventListener("message", () => {}),
    onStateChange: (connected) => states.push(connected),
    eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
    setTimeoutFn: (fn, ms) => {
      const timer: PendingTimer = { id: nextId, fn, ms, cleared: false };
      nextId += 1;
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (id) => {
      const timer = timers.find((t) => t.id === (id as unknown as number));
      if (timer) timer.cleared = true;
    },
    ...opts
  });
  return { handle, timers, states, sources: FakeEventSource.instances };
}

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("openResilientEventSource", () => {
  test("opens the transport immediately and attaches listeners", () => {
    const { handle, sources } = makeHarness();
    expect(sources.length).toBe(1);
    expect(sources[0]!.url).toBe("/api/runtime/events/stream");
    expect(sources[0]!.attached).toEqual(["message"]);
    expect(handle.current()).toBe(sources[0] as unknown as EventSource);
  });

  test("onopen reports connected; transitions only (no duplicate reports)", () => {
    const { states, sources } = makeHarness();
    sources[0]!.onopen!();
    sources[0]!.onopen!();
    expect(states).toEqual([true]);
  });

  test("a CONNECTING-state error reports disconnected but does NOT reopen (built-in retry owns it)", () => {
    const { states, timers, sources } = makeHarness();
    sources[0]!.onopen!();
    sources[0]!.readyState = CONNECTING;
    sources[0]!.onerror!();
    sources[0]!.onerror!();
    // One transition to disconnected, no reopen timer, no new transport.
    expect(states).toEqual([true, false]);
    expect(timers.length).toBe(0);
    expect(sources.length).toBe(1);
  });

  test("a CLOSED-state error schedules a reopen at the base delay, and firing it opens a fresh transport", () => {
    const { handle, states, timers, sources } = makeHarness({ baseDelayMs: 100 });
    sources[0]!.onopen!();
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    expect(states).toEqual([true, false]);
    // The dead transport is closed and detached.
    expect(sources[0]!.closeCalls).toBe(1);
    expect(handle.current()).toBeNull();
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(100);
    timers[0]!.fn();
    expect(sources.length).toBe(2);
    expect(sources[1]!.attached).toEqual(["message"]);
    expect(handle.current()).toBe(sources[1] as unknown as EventSource);
    // The reconnect succeeding reports connected again.
    sources[1]!.onopen!();
    expect(states).toEqual([true, false, true]);
  });

  test("repeated failures back off exponentially up to maxDelayMs", () => {
    const { timers, sources } = makeHarness({ baseDelayMs: 100, maxDelayMs: 250 });
    const failCurrent = () => {
      const source = sources[sources.length - 1]!;
      source.readyState = CLOSED;
      source.onerror!();
      timers[timers.length - 1]!.fn();
    };
    failCurrent();
    failCurrent();
    failCurrent();
    failCurrent();
    expect(timers.map((t) => t.ms)).toEqual([100, 200, 250, 250]);
  });

  test("a successful open resets the backoff", () => {
    const { timers, sources } = makeHarness({ baseDelayMs: 100, maxDelayMs: 250 });
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    timers[0]!.fn();
    sources[1]!.readyState = CLOSED;
    sources[1]!.onerror!();
    expect(timers.map((t) => t.ms)).toEqual([100, 200]);
    // Third attempt connects — the next failure starts over at the base delay.
    timers[1]!.fn();
    sources[2]!.onopen!();
    sources[2]!.readyState = CLOSED;
    sources[2]!.onerror!();
    expect(timers.map((t) => t.ms)).toEqual([100, 200, 100]);
  });

  test("duplicate CLOSED errors while a reopen is pending do not stack timers", () => {
    const { timers, sources } = makeHarness({ baseDelayMs: 100 });
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    sources[0]!.onerror!();
    expect(timers.length).toBe(1);
  });

  test("close() cancels a pending reopen and the timer firing afterwards is a no-op", () => {
    const { handle, timers, sources } = makeHarness({ baseDelayMs: 100 });
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    handle.close();
    expect(timers[0]!.cleared).toBe(true);
    // Even if the cancelled callback somehow fired, the closed latch holds.
    timers[0]!.fn();
    expect(sources.length).toBe(1);
    expect(handle.current()).toBeNull();
  });

  test("close() closes the live transport and a later CLOSED error does not resurrect it", () => {
    const { handle, timers, sources } = makeHarness();
    handle.close();
    expect(sources[0]!.closeCalls).toBe(1);
    expect(handle.current()).toBeNull();
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    expect(timers.length).toBe(0);
    expect(sources.length).toBe(1);
  });

  test("default delays apply when none are injected", () => {
    const { timers, sources } = makeHarness();
    sources[0]!.readyState = CLOSED;
    sources[0]!.onerror!();
    expect(timers[0]!.ms).toBe(1000);
  });
});
