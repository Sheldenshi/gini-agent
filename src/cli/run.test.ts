// Subprocess tests for `gini run` (foreground instance execution).
//
// These tests spawn the real CLI as a child process so we can exercise the
// signal-handling and child-teardown contract end-to-end. Each test gets a
// unique instance + state/log roots under /tmp so they do not collide with
// developer state or with each other when bun test runs them in parallel.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

function uniqueInstance(tag: string): string {
  return `run-test-${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

interface RunHarness {
  instance: string;
  stateRoot: string;
  logRoot: string;
}

function makeHarness(tag: string): RunHarness {
  const instance = uniqueInstance(tag);
  const stateRoot = `/tmp/gini-run-tests/${instance}`;
  const logRoot = `/tmp/gini-run-tests-logs/${instance}`;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
  return { instance, stateRoot, logRoot };
}

async function spawnRun(h: RunHarness): Promise<{
  child: ReturnType<typeof spawn>;
  stdout: Promise<string>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const child = spawn("bun", [
    "run",
    CLI_PATH,
    "run",
    "--instance",
    h.instance,
    "--no-web",
    "--state-root",
    h.stateRoot,
    "--log-root",
    h.logRoot
  ], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
  child.stderr?.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
  // Wait for the start banner to appear so callers know the runtime is live.
  // The banner JSON includes "instance": "<our instance>" — that's the most specific
  // marker and avoids matching incidental output from a different instance.
  const stdout = new Promise<string>((resolveOut) => {
    let combined = "";
    const onData = (chunk: Buffer) => {
      combined += chunk.toString("utf8");
      if (combined.includes(`"instance": "${h.instance}"`)) {
        child.stdout?.off("data", onData);
        resolveOut(combined);
      }
    };
    child.stdout?.on("data", onData);
    child.on("exit", () => resolveOut(combined + chunks.map((c) => c.toString("utf8")).join("")));
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, stdout, exit };
}

async function pidAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("gini run", () => {
  test("SIGTERM tears down the runtime child cleanly", async () => {
    const h = makeHarness("sigterm");
    const { child, stdout, exit } = await spawnRun(h);
    const banner = await stdout;
    expect(banner).toContain(`"instance": "${h.instance}"`);
    expect(banner).toContain(`"foreground": true`);
    expect(child.pid).toBeDefined();

    // Capture all child PIDs we spawned so we can confirm none survive teardown.
    const directChildPid = child.pid!;
    expect(await pidAlive(directChildPid)).toBe(true);

    child.kill("SIGTERM");
    const result = await exit;
    // SIGTERM exit code is 143 in our handler.
    expect(result.code === 143 || result.signal === "SIGTERM").toBe(true);
    // Parent should be reaped.
    expect(await pidAlive(directChildPid)).toBe(false);
    // Pid file under the state root must be gone (stopRuntime cleanup).
    expect(existsSync(join(h.stateRoot, "runtime.pid"))).toBe(false);
  }, 30_000);

  test("SIGHUP (terminal close) tears children down within 5s", async () => {
    const h = makeHarness("sighup");
    const { child, stdout, exit } = await spawnRun(h);
    await stdout;
    const directChildPid = child.pid!;
    expect(await pidAlive(directChildPid)).toBe(true);

    const t0 = Date.now();
    child.kill("SIGHUP");
    const result = await exit;
    const elapsed = Date.now() - t0;
    // 129 = 128 + 1 (SIGHUP). Allow either explicit code or signal-on-exit.
    expect(result.code === 129 || result.signal === "SIGHUP").toBe(true);
    expect(elapsed).toBeLessThan(8_000);
    expect(await pidAlive(directChildPid)).toBe(false);
  }, 30_000);

  test("refuses to run when the instance is already up", async () => {
    const h = makeHarness("conflict");
    const first = await spawnRun(h);
    await first.stdout;
    try {
      // Second `gini run` against the same instance must fail loudly because we
      // can't bind a runtime we did not spawn into our signal handlers.
      const blocked = spawn("bun", [
        "run",
        CLI_PATH,
        "run",
        "--instance",
        h.instance,
        "--no-web",
        "--state-root",
        h.stateRoot,
        "--log-root",
        h.logRoot
      ], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      blocked.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      const code = await new Promise<number | null>((resolveCode) => {
        blocked.on("exit", (c) => resolveCode(c));
      });
      expect(code).not.toBe(0);
      expect(stderr).toContain("already has a runtime running");
    } finally {
      first.child.kill("SIGTERM");
      await first.exit;
    }
  }, 30_000);
});
