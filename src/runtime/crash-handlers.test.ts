// Tests for installCrashHandlers. We inject exit/write/supervisor so no process
// exits and no disk write touches ~/.gini. Handlers are emitted synchronously
// via process.emit and removed after each test so listeners don't leak into the
// rest of the suite.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  installCrashHandlers,
  __resetCrashHandlersForTest
} from "./crash-handlers";
import { listPendingReports, type CrashReport } from "./crash-report";

function captureListeners() {
  return {
    uncaught: [...process.listeners("uncaughtException")],
    rejection: [...process.listeners("unhandledRejection")]
  };
}

describe("installCrashHandlers", () => {
  let before: ReturnType<typeof captureListeners>;
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    __resetCrashHandlersForTest();
    before = captureListeners();
    stateRoot = `/tmp/gini-crash-handlers-tests-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    // Remove only the listeners this test installed.
    const after = captureListeners();
    for (const l of after.uncaught) {
      if (!before.uncaught.includes(l)) process.off("uncaughtException", l);
    }
    for (const l of after.rejection) {
      if (!before.rejection.includes(l)) process.off("unhandledRejection", l);
    }
    __resetCrashHandlersForTest();
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  function install(overrides: {
    exitCodes: number[];
    supervisorValue?: "launchd" | null;
    writeThrows?: boolean;
    writeImpl?: (r: CrashReport) => string;
  }) {
    const supervisorValue =
      "supervisorValue" in overrides ? overrides.supervisorValue! : "launchd";
    installCrashHandlers({
      instance: "test-inst",
      source: "runtime",
      supervisorImpl: () => supervisorValue,
      exitImpl: (code) => { overrides.exitCodes.push(code); },
      // Default to the real writer so the report lands in the temp pending
      // queue (GINI_STATE_ROOT points under /tmp). Overrides can intercept it.
      writeImpl: overrides.writeThrows
        ? () => { throw new Error("disk full"); }
        : overrides.writeImpl,
      clock: () => new Date("2026-05-29T00:00:00.000Z")
    });
  }

  test("uncaughtException -> writes a pending report, exits 1", () => {
    const exitCodes: number[] = [];
    install({ exitCodes });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.error.message).toBe("boom");
  });

  test("unhandledRejection -> writes a pending report, exits 1", () => {
    const exitCodes: number[] = [];
    install({ exitCodes });
    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    expect(exitCodes).toEqual([1]);
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.error.message).toBe("rejected");
  });

  test("write throwing still exits 1 (finally)", () => {
    const exitCodes: number[] = [];
    install({ exitCodes, writeThrows: true });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    // The write threw, so nothing was queued — but exit still fired.
    expect(listPendingReports().length).toBe(0);
  });

  test("not under launchd -> still writes a pending report and exits 1", () => {
    const exitCodes: number[] = [];
    install({ exitCodes, supervisorValue: null });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    // Capture is unconditional now; the consent gate lives in crash-recovery.
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.supervisor).toBeNull();
  });

  test("the built report carries the source and instance", () => {
    const exitCodes: number[] = [];
    let captured: CrashReport | null = null;
    install({
      exitCodes,
      writeImpl: (r) => { captured = r; return "/tmp/fake-report.json"; }
    });
    process.emit("uncaughtException", new Error("boom"));
    expect(captured).not.toBeNull();
    expect(captured!.source).toBe("runtime");
    expect(captured!.instance).toBe("test-inst");
    expect(captured!.supervisor).toBe("launchd");
  });

  test("double-registration is guarded (second install is a no-op)", () => {
    const exitCodes: number[] = [];
    install({ exitCodes });
    // Second install without reset must not add a second listener pair.
    install({ exitCodes });
    process.emit("uncaughtException", new Error("boom"));
    // Exactly one handler fired -> one exit, one queued report.
    expect(exitCodes).toEqual([1]);
    expect(listPendingReports().length).toBe(1);
  });
});
