import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ensureChromiumInstalled, __resetInstallStateForTest } from "./chrome-install";

afterEach(() => {
  __resetInstallStateForTest();
});

// A minimal fake ChildProcess: stdout/stderr emitters plus exit/error events.
// The test drives its lifecycle by emitting on the returned handle.
function makeFakeChild(): ChildProcess & { emitExit: (code: number) => void; emitError: () => void; emitOut: (s: string) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    emitExit: (code: number) => void;
    emitError: () => void;
    emitOut: (s: string) => void;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { kill: () => boolean }).kill = () => true;
  child.emitExit = (code: number) => child.emit("exit", code);
  child.emitError = () => child.emit("error", new Error("spawn failed"));
  child.emitOut = (s: string) =>
    (child.stdout as unknown as EventEmitter).emit("data", Buffer.from(s));
  return child;
}

describe("ensureChromiumInstalled", () => {
  test("resolves true when the install CLI exits 0", async () => {
    const child = makeFakeChild();
    const logs: string[] = [];
    const p = ensureChromiumInstalled({
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => child,
      onLog: (l) => logs.push(l)
    });
    child.emitOut("Downloading Chromium 148...");
    child.emitExit(0);
    expect(await p).toBe(true);
    // Progress lines are surfaced (the announce line + the piped output).
    expect(logs.some((l) => l.includes("downloading Playwright's Chromium"))).toBe(true);
    expect(logs.some((l) => l.includes("Downloading Chromium 148"))).toBe(true);
  });

  test("resolves false when the install CLI exits non-zero", async () => {
    const child = makeFakeChild();
    const p = ensureChromiumInstalled({
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => child,
      onLog: () => undefined
    });
    child.emitExit(1);
    expect(await p).toBe(false);
  });

  test("resolves false when the spawn errors", async () => {
    const child = makeFakeChild();
    const p = ensureChromiumInstalled({
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => child,
      onLog: () => undefined
    });
    child.emitError();
    expect(await p).toBe(false);
  });

  test("resolves false when the CLI path can't be resolved", async () => {
    const p = ensureChromiumInstalled({
      cliPath: () => {
        throw new Error("playwright-core not installed");
      },
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => {
        throw new Error("spawn should not be called");
      },
      onLog: () => undefined
    });
    expect(await p).toBe(false);
  });

  test("resolves false (and kills the child) when the install times out", async () => {
    const child = makeFakeChild();
    let killed = false;
    child.kill = () => {
      killed = true;
      // A real kill makes the process exit; mirror that so the promise settles.
      queueMicrotask(() => child.emit("exit", null));
      return true;
    };
    const p = ensureChromiumInstalled({
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 5, // trip the timeout fast
      spawn: () => child,
      onLog: () => undefined
    });
    expect(await p).toBe(false);
    expect(killed).toBe(true);
  });

  test("uses the real playwright-core CLI path when cliPath is not overridden", async () => {
    // Exercises the default resolveCliPath (require.resolve of the real
    // playwright-core/cli.js) without triggering a download — the injected
    // spawn returns a child that exits 0 immediately.
    const child = makeFakeChild();
    let spawnedCmd: string | undefined;
    let spawnedArgs: string[] | undefined;
    const p = ensureChromiumInstalled({
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: (cmd, args) => {
        spawnedCmd = cmd;
        spawnedArgs = args;
        return child;
      },
      onLog: () => undefined
    });
    child.emitExit(0);
    expect(await p).toBe(true);
    expect(spawnedCmd).toBe("/fake/bun");
    // The resolved CLI path is the real playwright-core cli.js, followed by the
    // install args.
    expect(spawnedArgs?.[0]).toContain("playwright-core");
    expect(spawnedArgs?.[0]).toContain("cli.js");
    expect(spawnedArgs?.slice(1)).toEqual(["install", "chromium"]);
  });

  test("single-flight: concurrent calls share one install", async () => {
    let spawnCount = 0;
    const child = makeFakeChild();
    const opts = {
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => {
        spawnCount += 1;
        return child;
      },
      onLog: () => undefined
    };
    const p1 = ensureChromiumInstalled(opts);
    const p2 = ensureChromiumInstalled(opts);
    child.emitExit(0);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(spawnCount).toBe(1); // only one download despite two callers
  });

  test("a fresh call after one settles spawns again (state reset)", async () => {
    let spawnCount = 0;
    const opts = (child: ChildProcess) => ({
      cliPath: () => "/fake/cli.js",
      runtimeExec: "/fake/bun",
      timeoutMs: 1000,
      spawn: () => {
        spawnCount += 1;
        return child;
      },
      onLog: () => undefined
    });
    const c1 = makeFakeChild();
    const p1 = ensureChromiumInstalled(opts(c1));
    c1.emitExit(0);
    await p1;
    const c2 = makeFakeChild();
    const p2 = ensureChromiumInstalled(opts(c2));
    c2.emitExit(0);
    await p2;
    expect(spawnCount).toBe(2); // the in-flight latch cleared after the first settled
  });
});
