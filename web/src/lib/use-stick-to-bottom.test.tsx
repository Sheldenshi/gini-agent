/// <reference lib="dom" />

// useStickToBottom: every scroll is instant ("auto") — the first snap so a
// transcript opens already at the bottom, and later growth so a pinned user
// keeps following with no visible animation. Growth scrolls ONLY while the user
// is still pinned to the bottom — a new block must not yank a reader who
// scrolled up. A key change (panel reused for a different conversation) and an
// enabled false→true cycle (tab hidden then shown again) both re-arm the snap.
// scrollIntoView isn't implemented in happy-dom, so it's spied; the scroll
// container's metrics are stubbed to drive the guard.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { useStickToBottom } from "./use-stick-to-bottom";

let behaviors: (ScrollBehavior | undefined)[] = [];
const original = Element.prototype.scrollIntoView;

beforeEach(() => {
  behaviors = [];
  Element.prototype.scrollIntoView = mock((arg?: boolean | ScrollIntoViewOptions) => {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
  });
});

afterEach(() => {
  Element.prototype.scrollIntoView = original;
});

function Harness({ count, k, enabled }: { count: number; k?: unknown; enabled?: boolean }) {
  const ref = useStickToBottom(count, { key: k, enabled });
  return <div ref={ref} data-testid="end" />;
}

// Harness whose sentinel lives inside a real scroll-area viewport, so the hook
// finds a scroller and the near-bottom guard engages.
function ScrollerHarness({ count, k }: { count: number; k?: unknown }) {
  const ref = useStickToBottom(count, { key: k });
  return (
    <div data-slot="scroll-area-viewport">
      <div ref={ref} data-testid="end" />
    </div>
  );
}

// Stub the layout metrics the guard reads, then fire a scroll so the hook
// samples the new pinned state. gap = scrollHeight - scrollTop - clientHeight.
function setScroll(vp: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(vp, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(vp, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(vp, "scrollTop", { configurable: true, writable: true, value: scrollTop });
  vp.dispatchEvent(new Event("scroll"));
}

describe("useStickToBottom", () => {
  test("first snap and later growth are both instant", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    rerender(<Harness count={3} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto", "auto"]);
  });

  test("changing the key re-arms the snap", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    // Same instance, different conversation → snap again (and the guard is
    // bypassed for the first snap of the new key).
    rerender(<Harness count={5} k="s2" />);
    expect(behaviors).toEqual(["auto", "auto", "auto"]);
  });

  test("disabling skips the scroll and re-arms on re-enable", () => {
    const { rerender } = render(<Harness count={1} k="s1" enabled />);
    expect(behaviors).toEqual(["auto"]);

    // Hidden view: background growth must not scroll or consume the latch.
    rerender(<Harness count={2} k="s1" enabled={false} />);
    expect(behaviors).toEqual(["auto"]);

    // Returning to the view snaps instantly.
    rerender(<Harness count={2} k="s1" enabled />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("defaults to enabled with an undefined key", () => {
    const { rerender } = render(<Harness count={1} />);
    expect(behaviors).toEqual(["auto"]);
    rerender(<Harness count={2} />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("growth follows while the user is pinned to the bottom", () => {
    const { container, rerender } = render(<ScrollerHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 580 - 400 = 20 <= 64 → pinned.
    setScroll(vp, 1000, 400, 580);

    rerender(<ScrollerHarness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("growth does NOT scroll when the user has scrolled up", () => {
    const { container, rerender, unmount } = render(<ScrollerHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 100 - 400 = 500 > 64 → scrolled up, not pinned.
    setScroll(vp, 1000, 400, 100);

    rerender(<ScrollerHarness count={2} k="s1" />);
    // No yank: the follow is suppressed.
    expect(behaviors).toEqual(["auto"]);

    // A fresh view (key change) still snaps instantly even while scrolled up.
    rerender(<ScrollerHarness count={9} k="s2" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    // Unmount detaches the scroll listener.
    unmount();
  });
});
