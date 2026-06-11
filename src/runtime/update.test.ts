import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { currentVersionInfo, formatInstallFailure, scheduleRuntimeRestart } from "./update";

function scratch(tag: string): string {
  const dir = `/tmp/gini-runtime-update-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

function initRepo(path: string, origin: string): void {
  mkdirSync(path, { recursive: true });
  spawnSync("git", ["-C", path, "init", "--quiet"]);
  spawnSync("git", ["-C", path, "remote", "add", "origin", origin]);
}

describe("runtime update metadata", () => {
  test("repo checkout status does not offer web update for a separate installed runtime", () => {
    const home = scratch("repo-checkout-home");
    const checkout = scratch("repo-checkout");
    initRepo(join(home, ".gini", "runtime"), "https://github.com/Lilac-Labs/gini-agent");
    initRepo(checkout, "https://github.com/Lilac-Labs/gini-agent");

    const info = withHome(home, () => currentVersionInfo(checkout));

    expect(info.installedRuntimePresent).toBe(true);
    expect(info.update.supported).toBe(false);
    expect(info.update.reason).toContain("installer-managed runtime");
  });

  test("installer-managed runtime status offers web update", () => {
    const home = scratch("installed-home");
    const runtimeDir = join(home, ".gini", "runtime");
    initRepo(runtimeDir, "https://github.com/Lilac-Labs/gini-agent");

    const info = withHome(home, () => currentVersionInfo(runtimeDir));

    expect(info.installedRuntimePresent).toBe(true);
    expect(info.update.supported).toBe(true);
  });
});

describe("runtime update install failures", () => {
  test("includes captured bun install output in quiet mode", () => {
    const message = formatInstallFailure("bun install", 1, "stdout line", Buffer.from("stderr line"));

    expect(message).toContain("gini update: bun install failed (exit 1).");
    expect(message).toContain("----- bun install output -----");
    expect(message).toContain("stdout line");
    expect(message).toContain("stderr line");
  });

  test("keeps install failure concise without captured output", () => {
    const message = formatInstallFailure("bun install in web/", null);

    expect(message).toBe("gini update: bun install in web/ failed (exit null).");
  });
});

// Records each scheduleRuntimeRestart spawn call without launching a real
// subprocess. The returned stub only needs an unref().
interface SpawnCall {
  cmd: string;
  args: string[];
}

function makeSpawnRecorder(): { calls: SpawnCall[]; spawn: (cmd: string, args?: readonly string[]) => ChildProcess } {
  const calls: SpawnCall[] = [];
  const spawn = (cmd: string, args?: readonly string[]): ChildProcess => {
    calls.push({ cmd, args: [...(args ?? [])] });
    return { unref() { /* no-op */ } } as unknown as ChildProcess;
  };
  return { calls, spawn };
}

// scheduleRuntimeRestart dispatches its restart strategy on supervisor():
// under launchd it kicks the web service and self-SIGTERMs so KeepAlive
// respawns the gateway with fresh code; in the foreground it falls back to
// the detached stop+start bash helper.
describe("scheduleRuntimeRestart", () => {
  let scratch: string;
  let priorState: string | undefined;
  let priorLog: string | undefined;
  let priorSupervisor: string | undefined;

  beforeEach(() => {
    scratch = `/tmp/gini-restart-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    mkdirSync(scratch, { recursive: true });
    priorState = process.env.GINI_STATE_ROOT;
    priorLog = process.env.GINI_LOG_ROOT;
    priorSupervisor = process.env.GINI_SUPERVISOR;
    // Route logDir() to the scratch dir so the function's update-restart.log
    // write doesn't touch real instance state.
    process.env.GINI_STATE_ROOT = join(scratch, "state");
    process.env.GINI_LOG_ROOT = join(scratch, "logs");
  });

  afterEach(() => {
    restoreEnv("GINI_STATE_ROOT", priorState);
    restoreEnv("GINI_LOG_ROOT", priorLog);
    restoreEnv("GINI_SUPERVISOR", priorSupervisor);
    rmSync(scratch, { recursive: true, force: true });
  });

  test("launchd: kicks the web service AND the watchdog, then self-SIGTERMs (no orphaning stop+start helper)", async () => {
    process.env.GINI_SUPERVISOR = "launchd";
    const { calls, spawn } = makeSpawnRecorder();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    const result = scheduleRuntimeRestart("restart-launchd", {
      spawnImpl: spawn as never,
      killImpl: (pid, signal) => { kills.push({ pid, signal }); }
    });
    expect(result).toBe(true);

    // Two spawns: `gini autostart kick --kind web` and `--kind watchdog`.
    // The watchdog is a long-lived KeepAlive loop, so a code-only update
    // never replaces its process unless the update kicks it. The gateway is
    // NOT kicked (kickstart -k would force-kill it mid-drain — its restart
    // is the self-SIGTERM below). No bash stop+start helper (that's the
    // orphaning path we replaced).
    expect(calls.length).toBe(2);
    const kickedKinds: string[] = [];
    for (const call of calls) {
      expect(call.cmd).not.toBe("bash");
      expect(call.args).toContain("autostart");
      expect(call.args).toContain("kick");
      expect(call.args).toEqual(expect.arrayContaining(["--instance", "restart-launchd"]));
      kickedKinds.push(call.args[call.args.indexOf("--kind") + 1]!);
    }
    expect(kickedKinds.sort()).toEqual(["watchdog", "web"]);
    expect(kickedKinds).not.toContain("gateway");

    // The self-SIGTERM is dispatched via setImmediate; let it run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(kills.length).toBe(1);
    expect(kills[0]!.pid).toBe(process.pid);
    expect(kills[0]!.signal).toBe("SIGTERM");
  });

  test("foreground (no supervisor): uses the detached bash stop+start helper", async () => {
    delete process.env.GINI_SUPERVISOR;
    const { calls, spawn } = makeSpawnRecorder();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    const result = scheduleRuntimeRestart("restart-fg", {
      spawnImpl: spawn as never,
      killImpl: (pid, signal) => { kills.push({ pid, signal }); }
    });
    expect(result).toBe(true);

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.cmd).toBe("bash");
    // The bash script contains the stop+start CLI invocations.
    const script = call.args.join("\n");
    expect(script).toContain("src/cli.ts stop --instance");
    expect(script).toContain("src/cli.ts start --instance");
    expect(script).toContain("restart-fg");
    // It does NOT kick the launchd web service.
    expect(script).not.toContain("autostart kick");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(kills.length).toBe(1);
    expect(kills[0]!.pid).toBe(process.pid);
    expect(kills[0]!.signal).toBe("SIGTERM");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
