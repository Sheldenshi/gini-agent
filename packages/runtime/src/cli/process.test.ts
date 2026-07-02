// Unit tests for the stdio-capture plumbing in src/cli/process.ts.
//
// These tests drive `setupChildLog` directly (not via a full `gini run`
// subprocess) so we can exercise the FD-as-stdio daemon path and the tee+flush
// foreground path with a trivial, fast child. The previous coverage gap (only
// foreground runtime stdout was tested) hid two regressions: daemon mode had
// zero coverage, and tail bytes were lost on signal-driven exits.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { awaitForegroundLogFlush, setupChildLog, waitForPortFree, webLaunchPlan } from "./process";

function uniqueInstance(tag: string): string {
  return `process-test-${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeLogRoot(): string {
  const root = `/tmp/gini-process-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(root, { recursive: true, force: true });
  return root;
}

describe("setupChildLog", () => {
  let originalLogRoot: string | undefined;
  let logRoot: string;

  beforeEach(() => {
    originalLogRoot = process.env.GINI_LOG_ROOT;
    logRoot = makeLogRoot();
    process.env.GINI_LOG_ROOT = logRoot;
  });

  afterEach(() => {
    if (originalLogRoot === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = originalLogRoot;
    rmSync(logRoot, { recursive: true, force: true });
  });

  test("daemon mode captures both stdout and stderr via FD stdio", async () => {
    const instance = uniqueInstance("daemon");
    const plumbing = setupChildLog(instance, "child.log", false);
    // Daemon plumbing must hand numeric FDs to spawn() so writes survive the
    // parent unrefing the child. "ignore" + numeric fd + numeric fd is the
    // canonical shape.
    expect(plumbing.stdio[0]).toBe("ignore");
    expect(typeof plumbing.stdio[1]).toBe("number");
    expect(typeof plumbing.stdio[2]).toBe("number");

    const child = spawn("bun", ["-e", "console.log('hi'); console.error('bye')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });

    const logPath = join(logRoot, instance, "child.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("hi");
    expect(contents).toContain("bye");
  });

  test("foreground mode tees stdout and stderr to the log file and flushes the tail", async () => {
    const instance = uniqueInstance("fg");
    const plumbing = setupChildLog(instance, "child.log", true);
    expect(plumbing.stdio).toEqual(["inherit", "pipe", "pipe"]);

    const child = spawn("bun", ["-e", "console.log('hi'); console.error('bye')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });

    // Mirrors the production exit path: callers await flush before process.exit
    // so the tail of stderr bursts isn't dropped.
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "child.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("hi");
    expect(contents).toContain("bye");
  });

  test("foreground mode uses web.log filename when requested", async () => {
    // Sanity: the helper writes to whatever filename the caller supplies, so
    // both web.log (Next.js) and runtime-stdout.log (runtime) are covered by
    // the same plumbing — verifying once is enough.
    const instance = uniqueInstance("web");
    const plumbing = setupChildLog(instance, "web.log", true);
    const child = spawn("bun", ["-e", "console.log('next-dev-banner')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "web.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("next-dev-banner");
  });

  test("awaitForegroundLogFlush waits for tail bytes printed shortly before child exit", async () => {
    // Validates the fix for the race where `process.exit` ran before the tee
    // stream's `'finish'` event. We print on stderr immediately before exiting
    // and assert the bytes made it to disk after awaiting flush.
    const instance = uniqueInstance("tail");
    const plumbing = setupChildLog(instance, "child.log", true);
    const child = spawn("bun", [
      "-e",
      "process.stderr.write('TAIL_MARKER_LINE\\n'); process.exit(7)"
    ], { stdio: plumbing.stdio });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "child.log");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("TAIL_MARKER_LINE");
  });
});

// The prod-vs-dev pick for the inner Next server. Both branches MUST carry
// -H 127.0.0.1: Next defaults to 0.0.0.0 and the BFF trusts a loopback Host
// for owner-bearer injection, so an all-interfaces bind would hand owner
// access to any LAN peer.
describe("webLaunchPlan", () => {
  test("serves next start from the prod bundle when one matches the current sha", () => {
    const plan = webLaunchPlan(".next-prod-abc123def456", "default", 7777);
    expect(plan.command).toEqual(["run", "start", "--", "-H", "127.0.0.1", "-p", "7777"]);
    expect(plan.distDir).toBe(".next-prod-abc123def456");
  });

  test("falls back to next dev with the per-instance dist dir when no bundle matches", () => {
    const plan = webLaunchPlan(null, "default", 7777);
    expect(plan.command).toEqual(["run", "dev", "--", "-H", "127.0.0.1", "-p", "7777"]);
    expect(plan.distDir).toBe(".next-default");
  });

  test("dev fallback sanitizes the instance name for the dist dir", () => {
    const plan = webLaunchPlan(null, "feat/x", 7777);
    expect(plan.distDir).toBe(".next-feat_x");
  });
});

describe("waitForPortFree", () => {
  // Bind a listener on an OS-assigned port (port 0), returning the chosen
  // port and a closer. Loopback host matches what the gateway/web bind and
  // what waitForPortFree probes.
  function holdPort(host = "127.0.0.1"): Promise<{ port: number; server: Server }> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (address && typeof address === "object") resolve({ port: address.port, server });
        else reject(new Error("no port assigned"));
      });
    });
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  test("returns true quickly when the port is free", async () => {
    const { port, server } = await holdPort();
    await closeServer(server);
    // Port is free now — should resolve true well within the budget.
    const free = await waitForPortFree(port, "127.0.0.1", 2000, 25);
    expect(free).toBe(true);
  });

  test("returns false when a listener holds the port through the timeout", async () => {
    const { port, server } = await holdPort();
    try {
      // A real listener holds the port; a short injected timeout means the
      // poll exhausts without ever seeing it free.
      const free = await waitForPortFree(port, "127.0.0.1", 300, 25);
      expect(free).toBe(false);
    } finally {
      await closeServer(server);
    }
    // Once released it becomes bindable again.
    const freeAfter = await waitForPortFree(port, "127.0.0.1", 2000, 25);
    expect(freeAfter).toBe(true);
  });
});
