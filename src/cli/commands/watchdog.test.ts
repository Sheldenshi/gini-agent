// Tests for `gini watchdog`. Every external dependency is injected — no real
// fetch, no real launchctl. Port files + the report/log dirs live under a
// unique GINI_STATE_ROOT in /tmp. The watchdog always exits 0
// (process.exitCode === 0) regardless of which services were down.
//
// Coverage:
//   - all healthy -> no kickstart, no report queued, exit 0
//   - web down while runtime healthy -> web kickstart + a pending web report
//   - runtime hung -> gateway kickstart, no web report
//   - missing port files -> treated as down (kickstart fired), no report, exit 0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchdog } from "./watchdog";
import type { CliContext } from "../context";
import type { LaunchctlResult, PlistKind } from "../../integrations/launchd";
import { runtimePortPath, webPortPath } from "../../paths";
import { listPendingReports } from "../../runtime/crash-report";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

const INSTANCE = "watchdog-test";

function ctxFor(): CliContext {
  return {
    config: { instance: INSTANCE } as CliContext["config"],
    cliArgs: ["watchdog"],
    command: "watchdog",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: ["watchdog", "--instance", INSTANCE],
    web: { webPort: 0, webPortPinned: false, noWeb: true, runtimePortPinned: false }
  };
}

const okLaunchctl: LaunchctlResult = { ok: true, stdout: "", stderr: "", status: 0 };

describe("watchdog", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    stateRoot = `/tmp/gini-watchdog-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    mkdirSync(join(stateRoot, "instances", INSTANCE), { recursive: true });
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function writePorts(): void {
    writeFileSync(runtimePortPath(INSTANCE), "7778\n");
    writeFileSync(webPortPath(INSTANCE), "7777\n");
  }

  test("all healthy -> no kickstart, no report queued, exit 0", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      supervisorImpl: () => "launchd"
    });
    expect(kicks.length).toBe(0);
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("web down while runtime healthy (recorded port) -> web kickstart + a pending web report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      supervisorImpl: () => "launchd"
    });
    // Web revived, gateway untouched.
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    // Exactly one web report queued in pending/.
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.source).toBe("web");
    expect(pending[0]!.report.instance).toBe(INSTANCE);
    expect(pending[0]!.report.fingerprint.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });

  test("runtime hung -> gateway kickstart, no web report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      supervisorImpl: () => "launchd"
    });
    expect(kicks.map((k) => k.kind)).toEqual(["gateway"]);
    // A hung runtime is captured via the in-process crash handler, not the
    // watchdog — no web report queued here.
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("missing web port -> kickstart only, NO web crash report (boot race, not a crash)", async () => {
    // No writePorts(): the port files are absent. A missing web port means the
    // service never booted (or was stopped) — that's a boot race, not a web
    // crash, so we kickstart but must NOT queue a false-positive report.
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    let probedRuntime = false;
    let probedWeb = false;
    await watchdog(ctxFor(), {
      probeRuntime: async () => {
        probedRuntime = true;
        return true;
      },
      probeWeb: async () => {
        probedWeb = true;
        return true;
      },
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      supervisorImpl: () => "launchd"
    });
    // With no recorded port, there's nothing to probe — both are down and
    // both get kicked (gateway first, then web).
    expect(probedRuntime).toBe(false);
    expect(probedWeb).toBe(false);
    expect(kicks.map((k) => k.kind)).toEqual(["gateway", "web"]);
    // No web crash report: the missing port is a boot race, not a crash.
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("web down WHILE runtime down -> kickstart web, NO web report (symptom, not web crash)", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      // Runtime is down too — the web BFF failing is just a symptom of the
      // dead gateway, not a web-specific crash worth its own report.
      probeRuntime: async () => false,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      supervisorImpl: () => "launchd"
    });
    // Both kicked, but no web crash report queued.
    expect(kicks.map((k) => k.kind)).toEqual(["gateway", "web"]);
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("a kickstart that throws still results in exit 0 (tick never propagates the throw)", async () => {
    writePorts();
    // Runtime is down, so the gateway kickstart fires — and throws. The tick
    // must still set exitCode 0 (try/finally) and must not reject.
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: () => {
        throw new Error("launchctl blew up");
      },
      supervisorImpl: () => "launchd"
    });
    expect(process.exitCode).toBe(0);
  });

  test("a probe that throws/rejects -> watchdog resolves, exit 0, never propagates", async () => {
    writePorts();
    // probeRuntime rejects. Without the tick's catch, this rejection would
    // propagate out of watchdog and the CLI top-level would exit(1). The tick
    // must instead swallow it, resolve normally, and set exitCode 0.
    await expect(
      watchdog(ctxFor(), {
        probeRuntime: async () => {
          throw new Error("probe blew up");
        },
        probeWeb: async () => true,
        kickstartImpl: () => okLaunchctl,
        supervisorImpl: () => "launchd"
      })
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  test("web down but not under launchd -> still kicks web, and still queues the report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      // Not launchd: capture is unconditional now; the consent gate lives in
      // crash-recovery. The report carries supervisor: null.
      supervisorImpl: () => null
    });
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.supervisor).toBeNull();
    expect(process.exitCode).toBe(0);
  });
});
