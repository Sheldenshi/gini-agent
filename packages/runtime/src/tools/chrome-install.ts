// On-demand Chromium provisioning. The agent's browser launch prefers an
// installed branded Chrome (the stealth identity) and falls back to Playwright's
// bundled Chromium. On a machine with NEITHER — a fresh server, a CI box, a
// teammate's laptop that has never run `playwright install` — the launch would
// otherwise dead-end with "No Chrome binary found". Rather than make the browser
// feature require a manual setup step, we download Playwright's Chromium on first
// use so "no Chrome on the machine" is a supported, self-healing case.
//
// Mechanism: shell out to the playwright-core CLI it ships at
// node_modules/playwright-core/cli.js (`install chromium`). There is no stable
// public programmatic install API; the CLI is the supported entry point and it
// downloads to the shared ms-playwright cache that chromium.executablePath()
// reads. The download is bounded by a timeout and serialized by a single-flight
// promise so concurrent first-launches (two tasks racing the cold start) trigger
// at most one download.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Generous ceiling for the download+unzip of the Chromium build (tens of MB over
// a possibly slow link). Past this we give up so a wedged download can't hang a
// chat turn forever; the caller surfaces the original "no binary" failure.
const INSTALL_TIMEOUT_MS = 180_000;

// Resolve the playwright-core CLI entry. Separated so a test can stub it.
// playwright-core's package `exports` map does NOT expose `cli.js` as a subpath,
// so `require.resolve("playwright-core/cli.js")` throws. Resolve the package's
// main entry instead (always allowed) — it lives at the package root next to
// cli.js — and take the sibling. Throws if cli.js isn't there, which
// ensureChromiumInstalled catches and treats as "install unavailable".
function resolveCliPath(): string {
  const cli = join(dirname(require.resolve("playwright-core")), "cli.js");
  if (!existsSync(cli)) throw new Error("Could not locate playwright-core/cli.js");
  return cli;
}

// Run `<bun> <cli.js> install chromium` and resolve true on a clean exit. Never
// throws — a failed/timed-out install resolves false so the caller falls back to
// its existing "no binary" error path rather than crashing the turn.
export interface InstallChromiumDeps {
  cliPath: () => string;
  // The Bun/Node executable that runs the CLI. process.execPath is the running
  // runtime, which can execute the JS CLI directly.
  runtimeExec: string;
  timeoutMs: number;
  // The process spawner (injectable so the orchestration is unit-testable
  // without a real download).
  spawn: (cmd: string, args: string[]) => ChildProcess;
  // Optional progress sink (defaults to console) so a caller/test can capture.
  onLog?: (line: string) => void;
}

function defaultInstallDeps(): InstallChromiumDeps {
  return {
    cliPath: resolveCliPath,
    runtimeExec: process.execPath,
    timeoutMs: INSTALL_TIMEOUT_MS,
    spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
    onLog: (line) => console.log(line)
  };
}

// Single-flight: the in-flight install promise, shared by concurrent callers.
let inFlight: Promise<boolean> | undefined;

export async function ensureChromiumInstalled(
  depsOverride: Partial<InstallChromiumDeps> = {}
): Promise<boolean> {
  if (inFlight) return inFlight;
  const deps = { ...defaultInstallDeps(), ...depsOverride };
  const { promise, resolve } = Promise.withResolvers<boolean>();
  inFlight = promise;

  let cli: string;
  try {
    cli = deps.cliPath();
  } catch {
    // playwright-core (or its CLI) isn't resolvable — nothing we can install.
    inFlight = undefined;
    resolve(false);
    return promise;
  }

  deps.onLog?.("[browser] no Chrome found; downloading Playwright's Chromium (first-time setup)…");
  const child = deps.spawn(deps.runtimeExec, [cli, "install", "chromium"]);

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, deps.timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const onChunk = (buf: Buffer) => {
    const text = buf.toString().trim();
    if (text) deps.onLog?.(`[browser] ${text}`);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const settle = (ok: boolean) => {
    clearTimeout(timer);
    inFlight = undefined;
    resolve(ok);
  };
  child.on("error", () => settle(false));
  child.on("exit", (code) => settle(code === 0));
  return promise;
}

// Test-only reset so a suite doesn't leak the single-flight promise.
export function __resetInstallStateForTest(): void {
  inFlight = undefined;
}
