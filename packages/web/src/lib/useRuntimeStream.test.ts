// useRuntimeStream SSE singleton tests.
//
// The hook shares one EventSource across every subscriber (module-level
// singleton). These pin: exactly one source opens regardless of how many
// subscribers attach, additional subscribers reuse it, and the source closes
// only after the last subscriber unsubscribes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { __streamTestHooks, useRuntimeStream, useRuntimeStreamConnected, type RuntimeStreamEvent } from "./useRuntimeStream";

let eventSourceConstructions = 0;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  handlers = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    eventSourceConstructions += 1;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, handler: (event: { data: string }) => void): void {
    const list = this.handlers.get(kind) ?? [];
    list.push(handler);
    this.handlers.set(kind, list);
  }
  emit(kind: string, data: string): void {
    for (const handler of this.handlers.get(kind) ?? []) handler({ data });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
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

  test("named runtime events and the default message fallback fan out to every subscriber", () => {
    const seenA: RuntimeStreamEvent[] = [];
    const seenB: RuntimeStreamEvent[] = [];
    const unsubA = __streamTestHooks.subscribe((event) => seenA.push(event));
    const unsubB = __streamTestHooks.subscribe((event) => seenB.push(event));
    const transport = FakeEventSource.instances[0]!;
    transport.emit("task", "{\"id\":\"t1\"}");
    transport.emit("message", "fallback");
    expect(seenA).toEqual([
      { kind: "task", data: "{\"id\":\"t1\"}" },
      { kind: "message", data: "fallback" }
    ]);
    expect(seenB).toEqual(seenA);
    unsubA();
    unsubB();
  });

  test("useRuntimeStream subscribes on mount, tracks the latest callback, and unsubscribes on unmount", () => {
    const first: RuntimeStreamEvent[] = [];
    const second: RuntimeStreamEvent[] = [];
    const { rerender, unmount } = renderHook(
      ({ sink }: { sink: RuntimeStreamEvent[] }) => useRuntimeStream((event) => sink.push(event)),
      { initialProps: { sink: first } }
    );
    expect(__streamTestHooks.listenerCount()).toBe(1);
    const transport = FakeEventSource.instances[0]!;
    act(() => transport.emit("job", "a"));
    // A re-render swaps the callback without re-subscribing.
    rerender({ sink: second });
    expect(__streamTestHooks.listenerCount()).toBe(1);
    act(() => transport.emit("job", "b"));
    expect(first).toEqual([{ kind: "job", data: "a" }]);
    expect(second).toEqual([{ kind: "job", data: "b" }]);
    unmount();
    expect(__streamTestHooks.listenerCount()).toBe(0);
  });

  test("useRuntimeStreamConnected mirrors connection transitions and detaches on unmount", () => {
    const { result, unmount } = renderHook(() => useRuntimeStreamConnected());
    expect(result.current).toBe(true);
    act(() => {
      __streamTestHooks.setConnectedForTest(false);
    });
    expect(result.current).toBe(false);
    act(() => {
      __streamTestHooks.setConnectedForTest(true);
    });
    expect(result.current).toBe(true);
    unmount();
    // A post-unmount transition must not warn/update the unmounted hook.
    __streamTestHooks.setConnectedForTest(false);
  });

  test("reset() force-closes a transport that still has subscribers (test-teardown path)", () => {
    __streamTestHooks.subscribe(() => {});
    expect(__streamTestHooks.getSource()).not.toBeNull();
    __streamTestHooks.reset();
    expect(__streamTestHooks.getSource()).toBeNull();
    expect(__streamTestHooks.listenerCount()).toBe(0);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  test("transport open/error transitions drive the shared connection state", () => {
    const unsub = __streamTestHooks.subscribe(() => {});
    const transport = FakeEventSource.instances[0]!;
    // Starts optimistic so the banner never flashes on initial page load.
    expect(__streamTestHooks.isConnected()).toBe(true);
    transport.onopen!();
    expect(__streamTestHooks.isConnected()).toBe(true);
    // A permanent (CLOSED) transport failure flips the tab-wide state; the
    // resilient wrapper schedules the reopen (covered in its own tests).
    transport.readyState = 2;
    transport.onerror!();
    expect(__streamTestHooks.isConnected()).toBe(false);
    unsub();
  });
});
