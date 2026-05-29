// Subprocess tests for `gini run` (foreground instance execution).
//
// These tests spawn the real CLI as a child process so we can exercise the
// signal-handling and child-teardown contract end-to-end. Each test gets a
// unique instance + state/log roots under /tmp so they do not collide with
// developer state or with each other when bun test runs them in parallel.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Ask the OS for a free port by binding to port 0 on 0.0.0.0, then
// closing. The kernel won't immediately reissue the same port to
// another caller (TIME_WAIT keeps it owned briefly), so this is a
// good preferred port for spawnRun to pass via --port. The CLI's
// availablePort walker then claims the same port (or, on the rare
// race, walks one or two ports forward). Avoids the
// "No available port found from 7396 to 8395" failure we saw on
// Ubuntu CI runners where the default 7400-8399 random range was
// effectively saturated.
function pickFreePort(): Promise<number> {
  return new Promise((resolveOut, rejectOut) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectOut);
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolveOut(port));
      } else {
        server.close(() => rejectOut(new Error("could not allocate port")));
      }
    });
  });
}

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

// The runtime child (src/server.ts) runs background reconcile/reprobe loops
// that `await Bun.sleep(interval)` between iterations. On SIGTERM the shutdown
// handler waits for those loops to break, bounded by SCHEDULER_DRAIN_TIMEOUT_MS
// (src/server.ts:31 = 5000ms). With the production default reconcile interval
// (src/server.ts:225-227 = 5000ms) the in-flight sleep keeps the loop alive for
// the whole drain window: a teardown measured 5016ms of idle wait between the
// start banner and process exit. These tests assert the signal/teardown
// *contract*, not the polling cadence, so we compress the loop intervals via
// the env knobs the server already reads (src/server.ts:198,225-227). Production
// callers (`gini start`, autostart) never set these, so their defaults stand.
const FAST_LOOP_ENV = {
  GINI_MESSAGING_RECONCILE_MS: "25",
  GINI_REPROBE_TICK_MS: "25"
} as const;

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
  // Pass an OS-allocated free port via --port so the runtime's
  // own availablePort walker doesn't need to hunt through the
  // 7400-8399 default range (saturated on CI). The CLI re-probes
  // the picked port to claim it before binding.
  const port = await pickFreePort();
  const child = spawn("bun", [
    "run",
    CLI_PATH,
    "run",
    "--instance",
    h.instance,
    "--no-web",
    "--port",
    String(port),
    "--state-root",
    h.stateRoot,
    "--log-root",
    h.logRoot
  ], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...FAST_LOOP_ENV }
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
  child.stderr?.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
  // Wait for the start banner to appear so callers know the runtime is live.
  // The banner prints `Instance  <our instance>` — that's the most specific
  // marker and avoids matching incidental output from a different instance.
  const stdout = new Promise<string>((resolveOut) => {
    let combined = "";
    const onData = (chunk: Buffer) => {
      combined += chunk.toString("utf8");
      if (combined.includes(`Instance  ${h.instance}`)) {
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

// Poll a log file until it contains `marker` (or the deadline passes). Replaces
// a fixed sleep that guessed how long the runtime child needs to flush its
// startup line: the parent's start banner (`Instance  <name>`, which `stdout`
// resolves on) is printed by the CLI before the spawned server child has
// necessarily written "Gini runtime listening" into runtime-stdout.log, so
// tearing down the moment the banner appears can race the log write. Waiting on
// the actual condition is both faster and more robust than a fixed delay.
async function waitForLogMarker(logPath: string, marker: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath) && readFileSync(logPath, "utf8").includes(marker)) return;
    await Bun.sleep(20);
  }
}

describe("gini run", () => {
  test.concurrent("SIGTERM tears down the runtime child cleanly", async () => {
    const h = makeHarness("sigterm");
    const { child, stdout, exit } = await spawnRun(h);
    const banner = await stdout;
    expect(banner).toContain(`Instance  ${h.instance}`);
    expect(banner).toContain(`foreground`);
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

  test.concurrent("SIGHUP (terminal close) tears children down within 5s", async () => {
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

  test.concurrent("captures runtime child stdout to runtime-stdout.log", async () => {
    const h = makeHarness("logfile");
    const { child, stdout, exit } = await spawnRun(h);
    await stdout;
    // With GINI_LOG_ROOT set (via --log-root), logDir(instance) resolves to
    // <override>/<instance> (no extra /logs/ segment). See src/paths.ts:logDir.
    const logPath = join(h.logRoot, h.instance, "runtime-stdout.log");
    // Wait for the runtime child to actually flush its startup line before we
    // tear down the parent — the tee stream is closed on child exit, so killing
    // before the write lands would lose the marker we assert on below.
    await waitForLogMarker(logPath, "Gini runtime listening");
    child.kill("SIGTERM");
    await exit;
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    // src/server.ts logs "Gini runtime listening on ..." at boot, so this is
    // the most reliable marker that stdio actually flowed into the log file.
    expect(contents).toContain("Gini runtime listening");
    expect(contents).toContain(`instance=${h.instance}`);
  }, 30_000);

  test.concurrent("captures runtime shutdown output to runtime-stdout.log on SIGTERM", async () => {
    // End-to-end guard for the shutdown contract that
    // `awaitForegroundLogFlush()` in admin.ts:runForeground exists to support:
    // output emitted by the runtime as it tears down (server.ts SIGTERM
    // handler) must reach the log file before the CLI exits. On a slow OS or
    // a future Bun where WriteStream draining isn't already done by the time
    // `await done` resolves, dropping the await would lose the tail bytes.
    const h = makeHarness("shutdown-flush");
    const { child, stdout, exit } = await spawnRun(h);
    await stdout;
    const logPath = join(h.logRoot, h.instance, "runtime-stdout.log");
    // Wait for the runtime child to finish booting (its "listening" line lands
    // in the log) before tearing down. The parent banner (`await stdout`)
    // only proves the child was spawned, not that it reached steady state.
    // Sending SIGTERM mid-boot lets the parent forward the signal before the
    // child's scheduler loops have settled into their short steady-state
    // sleeps; under parallel load the resulting drain can run long enough to
    // race the parent's SIGKILL deadline, killing the child before it writes
    // the shutdown marker this test asserts on.
    await waitForLogMarker(logPath, "Gini runtime listening");
    child.kill("SIGTERM");
    await exit;
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    // Marker comes from src/server.ts SIGTERM handler. The instance suffix
    // makes sure we're seeing OUR runtime's shutdown, not stray output.
    expect(contents).toContain("Gini runtime shutting down (SIGTERM)");
    expect(contents).toContain(`instance=${h.instance}`);
  }, 30_000);

  test.concurrent("refuses to run when the instance is already up", async () => {
    const h = makeHarness("conflict");
    const first = await spawnRun(h);
    await first.stdout;
    try {
      // Second `gini run` against the same instance must fail loudly because we
      // can't bind a runtime we did not spawn into our signal handlers.
      // Pass an OS-allocated free port so the second child doesn't
      // tank on availablePort search the same way the first one
      // would have — its rejection must be on the "instance already
      // running" check, not on port exhaustion (which would mask
      // the test's actual assertion).
      const conflictPort = await pickFreePort();
      const blocked = spawn("bun", [
        "run",
        CLI_PATH,
        "run",
        "--instance",
        h.instance,
        "--no-web",
        "--port",
        String(conflictPort),
        "--state-root",
        h.stateRoot,
        "--log-root",
        h.logRoot
      ], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...FAST_LOOP_ENV } });
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
