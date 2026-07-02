// Note: we don't have full-flow integration tests for fetch/reset/install
// because they'd require either a local git server or network access to
// GitHub. The 3 guardrail tests below cover the safety paths (missing
// runtime, wrong origin, GINI_STATE_ROOT shortcut). The actual fetch/reset
// behavior is exercised manually via the curl|bash install script which
// uses the same shell commands.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatUpdateSummary, updateRequiresRuntimeRestart } from "./commands/admin";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn("bun", ["run", CLI_PATH, ...opts.args], {
      cwd: PROJECT_ROOT,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-update-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("gini update", () => {
  test("formats success output without installer noise", () => {
    expect(formatUpdateSummary({
      upToDate: false,
      afterSha: "1ecfc5dabc123",
      commitCount: "3"
    })).toBe("Gini updated to 1ecfc5d (3 commits)");
    expect(formatUpdateSummary({
      upToDate: true,
      afterSha: "1ecfc5dabc123",
      commitCount: "0"
    })).toBe("Gini already up to date at 1ecfc5d (0 commits)");
  });

  test("restarts when checkout is current but the running runtime has no version metadata", () => {
    expect(updateRequiresRuntimeRestart(
      { upToDate: true, afterSha: "abc123" },
      { ok: true }
    )).toBe(true);
  });

  test("does not restart when checkout and running runtime report the same sha", () => {
    expect(updateRequiresRuntimeRestart(
      { upToDate: true, afterSha: "abc123" },
      { ok: true, version: { git: { sha: "abc123" } } }
    )).toBe(false);
  });

  test("GINI_STATE_ROOT short-circuits", async () => {
    const stateRoot = scratch("short-circuit");
    const result = await runCli({
      args: ["update"],
      env: { ...process.env, GINI_STATE_ROOT: stateRoot }
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipped (GINI_STATE_ROOT set");
  }, 30_000);

  test("missing runtime errors clearly", async () => {
    const home = scratch("no-runtime");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.GINI_STATE_ROOT;
    const result = await runCli({ args: ["update"], env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not present");
    expect(result.stderr).toContain("curl -fsSL");
  }, 30_000);

  test("wrong origin errors clearly", async () => {
    const home = scratch("wrong-origin");
    const runtimeDir = join(home, ".gini", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    // Initialize a real git repo with a non-matching origin so the command
    // reaches the origin-check branch instead of the missing-runtime branch.
    spawnSync("git", ["-C", runtimeDir, "init", "--quiet"]);
    spawnSync("git", ["-C", runtimeDir, "remote", "add", "origin", "https://example.com/foo"]);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.GINI_STATE_ROOT;
    const result = await runCli({ args: ["update"], env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refuses to touch");
    expect(result.stderr).toContain("https://example.com/foo");
  }, 30_000);
});
