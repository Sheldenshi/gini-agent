import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  buildWebProdBundle,
  currentVersionInfo,
  formatInstallFailure,
  isUpdateInFlight,
  resolveWebProdDistDir,
  scheduleRuntimeRestart,
  updateRuntime,
  WEB_PROD_DIST_PREFIX,
  type RunStepImpl
} from "./update";
import { updateInProgressMarkerPath } from "../paths";

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

// buildWebProdBundle / resolveWebProdDistDir: the sha-keyed production web
// bundle lifecycle. The build subprocess is injected (no real `next build`);
// the dist dirs and BUILD_ID markers are real files in a scratch runtime dir.
describe("web production bundle", () => {
  const SHA = "abc123def456";

  function makeRuntimeDir(): string {
    const dir = scratch("web-prod");
    mkdirSync(join(dir, "web"), { recursive: true });
    return dir;
  }

  function markBuilt(runtimeDir: string, distDir: string): void {
    mkdirSync(join(runtimeDir, "web", distDir), { recursive: true });
    writeFileSync(join(runtimeDir, "web", distDir, "BUILD_ID"), "build-id\n");
  }

  // Records build invocations; `status` controls the simulated exit code.
  function makeBuildRecorder(status = 0) {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string; distDir?: string }> = [];
    const runStepImpl: RunStepImpl = async (cmd, args, options) => {
      calls.push({ cmd, args: [...args], cwd: options.cwd, distDir: options.env?.GINI_DIST_DIR });
      return { status, stdout: "", stderr: status === 0 ? "" : "next build exploded" };
    };
    return { calls, runStepImpl };
  }

  test("builds into the sha-keyed dist dir via bun run build", async () => {
    const runtimeDir = makeRuntimeDir();
    const { calls, runStepImpl } = makeBuildRecorder();
    const result = await buildWebProdBundle(runtimeDir, SHA, "pipe", { runStepImpl });
    expect(result).toEqual({ distDir: `${WEB_PROD_DIST_PREFIX}${SHA}`, built: true });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("bun");
    expect(calls[0]!.args).toEqual(["run", "build"]);
    expect(calls[0]!.cwd).toBe(join(runtimeDir, "web"));
    expect(calls[0]!.distDir).toBe(`${WEB_PROD_DIST_PREFIX}${SHA}`);
  });

  test("skips the build when the sha dir already carries a BUILD_ID (idempotent re-update)", async () => {
    const runtimeDir = makeRuntimeDir();
    markBuilt(runtimeDir, `${WEB_PROD_DIST_PREFIX}${SHA}`);
    const { calls, runStepImpl } = makeBuildRecorder();
    const result = await buildWebProdBundle(runtimeDir, SHA, "pipe", { runStepImpl });
    expect(result).toEqual({ distDir: `${WEB_PROD_DIST_PREFIX}${SHA}`, built: false });
    expect(calls.length).toBe(0);
  });

  test("GCs other prod dist dirs on success, leaving the current bundle and dev dirs alone", async () => {
    const runtimeDir = makeRuntimeDir();
    markBuilt(runtimeDir, `${WEB_PROD_DIST_PREFIX}${SHA}`);
    markBuilt(runtimeDir, `${WEB_PROD_DIST_PREFIX}0dd5a00000000`);
    // A dev dist dir must never be GC'd — it belongs to `next dev` fallback.
    mkdirSync(join(runtimeDir, "web", ".next-default"), { recursive: true });
    // Nor may the dev dist dir of an instance whose NAME starts with
    // "prod-": only sha-shaped (>=12 hex chars) suffixes are GC-able.
    mkdirSync(join(runtimeDir, "web", ".next-prod-foo"), { recursive: true });
    const { runStepImpl } = makeBuildRecorder();
    await buildWebProdBundle(runtimeDir, SHA, "pipe", { runStepImpl });
    expect(existsSync(join(runtimeDir, "web", `${WEB_PROD_DIST_PREFIX}${SHA}`))).toBe(true);
    expect(existsSync(join(runtimeDir, "web", `${WEB_PROD_DIST_PREFIX}0dd5a00000000`))).toBe(false);
    expect(existsSync(join(runtimeDir, "web", ".next-default"))).toBe(true);
    expect(existsSync(join(runtimeDir, "web", ".next-prod-foo"))).toBe(true);
  });

  test("preserves a named prod dir (the previous HEAD's bundle) while still GCing strictly-older ones", async () => {
    const runtimeDir = makeRuntimeDir();
    markBuilt(runtimeDir, `${WEB_PROD_DIST_PREFIX}${SHA}`);
    const preserved = `${WEB_PROD_DIST_PREFIX}0dd5a00000000`;
    const older = `${WEB_PROD_DIST_PREFIX}1111aaaa2222`;
    markBuilt(runtimeDir, preserved);
    markBuilt(runtimeDir, older);
    mkdirSync(join(runtimeDir, "web", ".next-default"), { recursive: true });
    const { runStepImpl } = makeBuildRecorder();
    await buildWebProdBundle(runtimeDir, SHA, "pipe", { runStepImpl, preserveDistDirs: [preserved] });
    expect(existsSync(join(runtimeDir, "web", `${WEB_PROD_DIST_PREFIX}${SHA}`))).toBe(true);
    expect(existsSync(join(runtimeDir, "web", preserved))).toBe(true);
    expect(existsSync(join(runtimeDir, "web", older))).toBe(false);
    expect(existsSync(join(runtimeDir, "web", ".next-default"))).toBe(true);
  });

  test("a failed build throws (so updateRuntime aborts before scheduling a restart) and GCs nothing", async () => {
    const runtimeDir = makeRuntimeDir();
    markBuilt(runtimeDir, `${WEB_PROD_DIST_PREFIX}0dd5a00000000`);
    const { runStepImpl } = makeBuildRecorder(1);
    await expect(buildWebProdBundle(runtimeDir, SHA, "pipe", { runStepImpl })).rejects.toThrow(/bun run build in web\/ failed/);
    // The old (still-servable-by-the-old-process) bundle survives a failure.
    expect(existsSync(join(runtimeDir, "web", `${WEB_PROD_DIST_PREFIX}0dd5a00000000`))).toBe(true);
  });

  // resolveWebProdDistDir reads the real `git rev-parse --short=12 HEAD`, so
  // these tests commit into a scratch repo and key the dist dir off that sha.
  function initRepoWithCommit(path: string): string {
    initRepo(path, "https://github.com/Lilac-Labs/gini-agent");
    spawnSync("git", [
      "-C", path,
      "-c", "user.email=test@example.invalid",
      "-c", "user.name=test",
      "commit", "--allow-empty", "-m", "init", "--quiet"
    ]);
    return spawnSync("git", ["-C", path, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim();
  }

  test("resolveWebProdDistDir returns the dir matching the current HEAD's short sha", () => {
    const repo = scratch("resolve-hit");
    const sha12 = initRepoWithCommit(repo);
    markBuilt(repo, `${WEB_PROD_DIST_PREFIX}${sha12}`);
    expect(resolveWebProdDistDir(repo)).toBe(`${WEB_PROD_DIST_PREFIX}${sha12}`);
  });

  test("resolveWebProdDistDir returns null without a BUILD_ID (aborted build must not be served)", () => {
    const repo = scratch("resolve-no-marker");
    const sha12 = initRepoWithCommit(repo);
    mkdirSync(join(repo, "web", `${WEB_PROD_DIST_PREFIX}${sha12}`), { recursive: true });
    expect(resolveWebProdDistDir(repo)).toBeNull();
  });

  test("resolveWebProdDistDir returns null when only a STALE-sha bundle exists or outside a git repo", () => {
    const repo = scratch("resolve-stale");
    initRepoWithCommit(repo);
    markBuilt(repo, `${WEB_PROD_DIST_PREFIX}0dd5a00000000`);
    expect(resolveWebProdDistDir(repo)).toBeNull();
    // No .git at all (fresh tarball-style dir) -> dev fallback.
    const plain = scratch("resolve-plain");
    expect(resolveWebProdDistDir(plain)).toBeNull();
  });
});

// updateRuntime end-to-end against a scratch git repo. The fast local git
// calls (rev-parse, reset --hard) run real git; the long steps (fetch, the
// installs, the build) go through the injected async runner so nothing slow
// or networked runs. GINI_STATE_ROOT is pinned to a scratch dir so the
// update-in-progress marker lands there.
describe("updateRuntime", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    stateRoot = scratch("update-state");
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    restoreEnv("GINI_STATE_ROOT", prevStateRoot);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  // A repo whose origin/HEAD resolves locally: the stubbed fetch never
  // creates remote-tracking refs, so point origin/HEAD at the local HEAD —
  // the sync `git reset --hard origin/HEAD` step then succeeds (up to date).
  function makeUpdateRepo(): string {
    const dir = scratch("update-repo");
    initRepo(dir, "https://github.com/Lilac-Labs/gini-agent");
    spawnSync("git", [
      "-C", dir,
      "-c", "user.email=test@example.invalid",
      "-c", "user.name=test",
      "commit", "--allow-empty", "-m", "init", "--quiet"
    ]);
    spawnSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    spawnSync("git", ["-C", dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    return dir;
  }

  const okStep = { status: 0, stdout: "", stderr: "" };

  test("runs the long steps through the awaited runner, with the marker present for the duration", async () => {
    const runtimeDir = makeUpdateRepo();
    const calls: string[] = [];
    let markerSeenDuringSteps = true;
    let markerBody: string | null = null;
    const runStepImpl: RunStepImpl = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      markerSeenDuringSteps &&= existsSync(updateInProgressMarkerPath());
      if (markerBody === null && existsSync(updateInProgressMarkerPath())) {
        markerBody = readFileSync(updateInProgressMarkerPath(), "utf8");
      }
      return okStep;
    };

    const result = await updateRuntime(runtimeDir, { runStepImpl });

    expect(result.upToDate).toBe(true);
    expect(result.commitCount).toBe("0");
    // git fetch + root bun install (no web/package.json in the scratch repo).
    expect(calls).toEqual([`git -C ${runtimeDir} fetch origin`, "bun install"]);
    // The marker covered every long step and is gone once the update settles.
    expect(markerSeenDuringSteps).toBe(true);
    // The body records the updater's pid so the watchdog can detect a dead
    // updater (stale marker) instead of waiting out the mtime backstop.
    expect(JSON.parse(markerBody ?? "{}")).toEqual({ pid: process.pid });
    expect(existsSync(updateInProgressMarkerPath())).toBe(false);
  });

  test("a failed step rejects AND removes the marker (no permanent watchdog suppression)", async () => {
    const runtimeDir = makeUpdateRepo();
    const runStepImpl: RunStepImpl = async (cmd) =>
      cmd === "bun" ? { status: 1, stdout: "", stderr: "install exploded" } : okStep;

    await expect(updateRuntime(runtimeDir, { runStepImpl })).rejects.toThrow(/bun install failed/);
    expect(existsSync(updateInProgressMarkerPath())).toBe(false);
  });

  test("single-flight: a second update while one is in flight rejects, and the guard clears after settle", async () => {
    const runtimeDir = makeUpdateRepo();
    const gate = Promise.withResolvers<void>();
    expect(isUpdateInFlight()).toBe(false);
    const first = updateRuntime(runtimeDir, {
      runStepImpl: async () => {
        await gate.promise;
        return okStep;
      }
    });
    // The guard state is what GET /api/version surfaces as updateInProgress
    // (the UpdateGate's deadline-extension signal): true exactly while the
    // single-flight promise is held.
    expect(isUpdateInFlight()).toBe(true);

    await expect(updateRuntime(runtimeDir, { runStepImpl: async () => okStep })).rejects.toThrow(/already in progress/);

    gate.resolve();
    await first;
    expect(isUpdateInFlight()).toBe(false);
    // The in-flight guard cleared: a fresh update runs to completion.
    const again = await updateRuntime(runtimeDir, { runStepImpl: async () => okStep });
    expect(again.upToDate).toBe(true);
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

// scheduleRuntimeRestart dispatches its restart strategy on supervisor() OR
// whether the launchd gateway is loaded: under launchd it kicks the web service
// and self-SIGTERMs so KeepAlive respawns the gateway with fresh code; when no
// loaded launchd gateway exists it falls back to the detached stop+start bash
// helper.
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

  test("dual supervision (no GINI_SUPERVISOR but the launchd gateway is loaded): takes the launchd branch", async () => {
    // A foreground gateway running on an instance whose launchd gateway is ALSO
    // loaded. supervisor() is null (env unset) but the launchd gateway is
    // loaded, so the restart must route through launchd — kick web+watchdog and
    // self-SIGTERM — NOT the foreground stop+start bash helper that could spawn
    // a competing daemon and walk the port to an offset.
    delete process.env.GINI_SUPERVISOR;
    const { calls, spawn } = makeSpawnRecorder();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    const result = scheduleRuntimeRestart("restart-dual", {
      spawnImpl: spawn as never,
      killImpl: (pid, signal) => { kills.push({ pid, signal }); },
      gatewayLoadedImpl: () => true
    });
    expect(result).toBe(true);

    // Same launchd behavior as the env-set case: kick web + watchdog, no bash
    // helper, gateway NOT kicked.
    expect(calls.length).toBe(2);
    const kickedKinds: string[] = [];
    for (const call of calls) {
      expect(call.cmd).not.toBe("bash");
      expect(call.args).toContain("autostart");
      expect(call.args).toContain("kick");
      expect(call.args).toEqual(expect.arrayContaining(["--instance", "restart-dual"]));
      kickedKinds.push(call.args[call.args.indexOf("--kind") + 1]!);
    }
    expect(kickedKinds.sort()).toEqual(["watchdog", "web"]);
    expect(kickedKinds).not.toContain("gateway");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(kills.length).toBe(1);
    expect(kills[0]!.pid).toBe(process.pid);
    expect(kills[0]!.signal).toBe("SIGTERM");
  });

  test("foreground (no supervisor, gateway not loaded): uses the detached bash stop+start helper", async () => {
    delete process.env.GINI_SUPERVISOR;
    const { calls, spawn } = makeSpawnRecorder();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    const result = scheduleRuntimeRestart("restart-fg", {
      spawnImpl: spawn as never,
      killImpl: (pid, signal) => { kills.push({ pid, signal }); },
      // Pin the gateway-not-loaded state so this case doesn't depend on the
      // absence of a real plist in ~/Library/LaunchAgents.
      gatewayLoadedImpl: () => false
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
