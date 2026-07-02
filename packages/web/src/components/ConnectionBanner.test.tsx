/// <reference lib="dom" />

// ConnectionBanner tests. The banner mirrors the shared runtime-stream
// connection state (driven here via the stream test hooks — no fake SSE
// transport needed) and debounces before showing so sub-second blips never
// flicker. `showAfterMs={0}` keeps the debounce on the timer path while
// firing on the next tick.

import { afterEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";
import { __streamTestHooks } from "@/lib/useRuntimeStream";

afterEach(() => {
  __streamTestHooks.reset();
});

describe("ConnectionBanner", () => {
  test("renders nothing while connected (default delay path)", () => {
    render(<ConnectionBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("shows the reconnecting pill after the stream stays down past the debounce", async () => {
    render(<ConnectionBanner showAfterMs={0} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      __streamTestHooks.setConnectedForTest(false);
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeNull();
    });
    expect(screen.getByRole("status").textContent).toContain("Reconnecting to Gini");
  });

  test("hides again the moment the stream reconnects", async () => {
    render(<ConnectionBanner showAfterMs={0} />);
    act(() => {
      __streamTestHooks.setConnectedForTest(false);
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeNull();
    });
    act(() => {
      __streamTestHooks.setConnectedForTest(true);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a blip shorter than the debounce never shows the pill", async () => {
    // A generous real delay would slow the suite; 50ms keeps the debounce
    // window real while the reconnect lands well inside it.
    render(<ConnectionBanner showAfterMs={50} />);
    act(() => {
      __streamTestHooks.setConnectedForTest(false);
    });
    act(() => {
      __streamTestHooks.setConnectedForTest(true);
    });
    // Give the (cancelled) timer window time to elapse, then confirm nothing
    // appeared.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 80);
    await promise;
    expect(screen.queryByRole("status")).toBeNull();
  });
});
