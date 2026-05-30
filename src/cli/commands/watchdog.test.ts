// Tests for `gini watchdog`. Every external dependency is injected — no real
// fetch, no real launchctl, no real spawned process. Port files + the report/
// log dirs live under a unique GINI_STATE_ROOT in /tmp. The watchdog always
// exits 0 (process.exitCode === 0) regardless of which services were down.
//
// Coverage:
//   - all healthy -> no kickstart, no report spawned, exit 0
//   - web down -> web kickstart + a report-crash child spawned with a report
//     file that actually exists on disk
//   - runtime hung -> gateway kickstart, no web report
//   - missing port files -> treated as down (kickstart fired), exit 0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchdog, type WatchdogDeps } from "./watchdog";
import type { CliContext } from "../context";
import type { LaunchctlResult, PlistKind } from "../../integrations/launchd";
import { runtimePortPath, webPortPath } from "../../paths";

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

interface SpawnCall {
  command: string;
  args: string[];
}

// A fake spawn that records the call and returns an object with an unref().
function makeSpawn(): { impl: WatchdogDeps["spawnImpl"]; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { unref() {} };
  }) as unknown as WatchdogDeps["spawnImpl"];
  return { impl, calls };
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

  test("all healthy -> no kickstart, no report spawned, exit 0", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const { impl: spawnImpl, calls: spawnCalls } = makeSpawn();
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      spawnImpl,
      supervisorImpl: () => "launchd"
    });
    expect(kicks.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("web down -> web kickstart + report-crash spawned with a written report file", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const { impl: spawnImpl, calls: spawnCalls } = makeSpawn();
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      spawnImpl,
      supervisorImpl: () => "launchd"
    });
    // Web revived, gateway untouched.
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    // Exactly one report-crash child, carrying --report <path>.
    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0]!;
    expect(call.args).toContain("report-crash");
    expect(call.args).toContain("--instance");
    expect(call.args).toContain(INSTANCE);
    const reportIdx = call.args.indexOf("--report");
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    const reportPath = call.args[reportIdx + 1]!;
    // The report file was actually written to disk before the spawn.
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { source: string; fingerprint: string };
    expect(report.source).toBe("web");
    expect(report.fingerprint.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });

  test("runtime hung -> gateway kickstart, no web report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const { impl: spawnImpl, calls: spawnCalls } = makeSpawn();
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      spawnImpl,
      supervisorImpl: () => "launchd"
    });
    expect(kicks.map((k) => k.kind)).toEqual(["gateway"]);
    // A hung runtime files via the in-process crash handler, not the
    // watchdog — no report-crash spawned here.
    expect(spawnCalls.length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("missing port files -> both treated as down, both kicked, exit 0", async () => {
    // No writePorts(): the port files are absent.
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const { impl: spawnImpl } = makeSpawn();
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
      spawnImpl,
      supervisorImpl: () => "launchd"
    });
    // With no recorded port, there's nothing to probe — both are down and
    // both get kicked (gateway first, then web).
    expect(probedRuntime).toBe(false);
    expect(probedWeb).toBe(false);
    expect(kicks.map((k) => k.kind)).toEqual(["gateway", "web"]);
    expect(process.exitCode).toBe(0);
  });

  test("web down but not under launchd -> still kicks web, but spawns no filing child", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const { impl: spawnImpl, calls: spawnCalls } = makeSpawn();
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      spawnImpl,
      // Not launchd: report-crash would no-op, so we don't spawn it.
      supervisorImpl: () => null
    });
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    expect(spawnCalls.length).toBe(0);
    expect(process.exitCode).toBe(0);
  });
});
