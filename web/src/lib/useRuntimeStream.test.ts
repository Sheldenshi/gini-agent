// useRuntimeStream SSE singleton tests.
//
// The hook shares one EventSource across every subscriber (module-level
// singleton). These pin: exactly one source opens regardless of how many
// subscribers attach, additional subscribers reuse it, and the source closes
// only after the last subscriber unsubscribes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __streamTestHooks } from "./useRuntimeStream";

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
    // No-op — these tests assert on construction / close, not on dispatch.
  }
  close(): void {
    this.closed = true;
  }
}

let originalEventSource: unknown;

beforeEach(() => {
  originalEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  eventSourceConstructions = 0;
  FakeEventSource.instances.length = 0;
  __streamTestHooks.reset();
});

afterEach(() => {
  __streamTestHooks.reset();
  if (originalEventSource === undefined) {
    delete (globalThis as Record<string, unknown>).EventSource;
  } else {
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  }
});

describe("useRuntimeStream SSE singleton", () => {
  test("first subscribe opens exactly one EventSource", () => {
    const unsub = __streamTestHooks.subscribe(() => {});
    expect(eventSourceConstructions).toBe(1);
    expect(__streamTestHooks.getSource()).not.toBeNull();
    expect(__streamTestHooks.listenerCount()).toBe(1);
    unsub();
  });

  test("additional subscribers reuse the single source", () => {
    const unsub1 = __streamTestHooks.subscribe(() => {});
    const unsub2 = __streamTestHooks.subscribe(() => {});
    expect(eventSourceConstructions).toBe(1);
    expect(__streamTestHooks.listenerCount()).toBe(2);
    unsub1();
    unsub2();
  });

  test("source closes only after the last subscriber unsubscribes", () => {
    const unsub1 = __streamTestHooks.subscribe(() => {});
    const unsub2 = __streamTestHooks.subscribe(() => {});
    unsub1();
    // One subscriber remains — the source stays open.
    expect(__streamTestHooks.getSource()).not.toBeNull();
    expect(__streamTestHooks.listenerCount()).toBe(1);
    unsub2();
    // Last subscriber gone — the source is closed.
    expect(__streamTestHooks.getSource()).toBeNull();
    expect(__streamTestHooks.listenerCount()).toBe(0);
  });
});
