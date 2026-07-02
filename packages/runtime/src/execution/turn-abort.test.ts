// Unit tests for the per-turn abort registry. Pure in-memory module, so no
// state-root or HOME fixture is needed — just reset between tests.

import { afterEach, describe, expect, test } from "bun:test";
import {
  abortTurnForTask,
  registerTurn,
  releaseTurn,
  __resetTurns,
  __turnSnapshot
} from "./turn-abort";

afterEach(() => __resetTurns());

describe("turn-abort registry", () => {
  test("registerTurn returns a fresh un-aborted controller tracked in the snapshot", () => {
    const c = registerTurn("inst", "task_1");
    expect(c.signal.aborted).toBe(false);
    expect(__turnSnapshot("inst")).toEqual([{ taskId: "task_1", aborted: false }]);
  });

  test("abortTurnForTask aborts the registered controller with an AbortError-shaped reason", () => {
    const c = registerTurn("inst", "task_1");
    const fired = abortTurnForTask("inst", "task_1", "task.cancelled");
    expect(fired).toBe(true);
    expect(c.signal.aborted).toBe(true);
    // The reason is a DOMException named AbortError (NOT a bare string) so a
    // fetch aborted with this signal rejects with a classifiable abort error.
    const reason = c.signal.reason as DOMException;
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe("AbortError");
    expect(reason.message).toBe("task.cancelled");
  });

  test("abortTurnForTask is a no-op (returns false) when no turn is registered", () => {
    expect(abortTurnForTask("inst", "missing", "task.cancelled")).toBe(false);
  });

  test("abortTurnForTask is idempotent — a second abort returns false", () => {
    registerTurn("inst", "task_1");
    expect(abortTurnForTask("inst", "task_1", "r1")).toBe(true);
    expect(abortTurnForTask("inst", "task_1", "r2")).toBe(false);
  });

  test("releaseTurn drops the entry and cleans up the empty instance map", () => {
    registerTurn("inst", "task_1");
    releaseTurn("inst", "task_1");
    expect(__turnSnapshot("inst")).toEqual([]);
    // A subsequent abort finds nothing.
    expect(abortTurnForTask("inst", "task_1", "r")).toBe(false);
  });

  test("releaseTurn with a controller guard only removes the matching entry", () => {
    const first = registerTurn("inst", "task_1");
    // A superseding register aborts the first and installs a new controller.
    const second = registerTurn("inst", "task_1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    // Releasing the STALE (first) controller must not evict the live (second) one.
    releaseTurn("inst", "task_1", first);
    expect(__turnSnapshot("inst")).toEqual([{ taskId: "task_1", aborted: false }]);
    // Releasing the live controller does evict it.
    releaseTurn("inst", "task_1", second);
    expect(__turnSnapshot("inst")).toEqual([]);
  });

  test("releaseTurn is idempotent and safe on an unknown instance", () => {
    releaseTurn("never", "task_1");
    registerTurn("inst", "task_1");
    releaseTurn("inst", "task_1");
    releaseTurn("inst", "task_1");
    expect(__turnSnapshot("inst")).toEqual([]);
  });

  test("registry partitions by instance — same taskId in two instances is independent", () => {
    const a = registerTurn("inst-a", "task_1");
    const b = registerTurn("inst-b", "task_1");
    abortTurnForTask("inst-a", "task_1", "r");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(__turnSnapshot("inst-b")).toEqual([{ taskId: "task_1", aborted: false }]);
  });

  test("__resetTurns clears a single instance or the whole registry", () => {
    registerTurn("inst-a", "t");
    registerTurn("inst-b", "t");
    __resetTurns("inst-a");
    expect(__turnSnapshot("inst-a")).toEqual([]);
    expect(__turnSnapshot("inst-b")).toEqual([{ taskId: "t", aborted: false }]);
    __resetTurns();
    expect(__turnSnapshot()).toEqual([]);
  });
});
