// Subprocess tests for `gini uninstall`. Each test points GINI_STATE_ROOT at
// a scratch dir under /tmp so it never touches the developer's real ~/.gini.
// The CLI's test-mode shortcut (GINI_STATE_ROOT set ⇒ skip HOME-level steps)
// is what keeps the real wrapper/runtime/rc safe even though those paths are
// hard-coded to homedir() in production.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  stateRoot: string;
  stdin?: "ignore" | "pipe";
  stdinData?: string;
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
      env: { ...process.env, GINI_STATE_ROOT: opts.stateRoot },
      stdio: [opts.stdin ?? "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (opts.stdin === "pipe" && opts.stdinData !== undefined) {
      child.stdin?.write(opts.stdinData);
      child.stdin?.end();
    }
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-uninstall-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("gini uninstall", () => {
  test("--instance with --yes removes a single instance and never touches HOME paths", async () => {
    const stateRoot = scratch("single");
    const instance = "nope";
    const instanceDir = join(stateRoot, "instances", instance);
    mkdirSync(instanceDir, { recursive: true });
    const result = await runCli({
      args: ["uninstall", "--instance", instance, "--yes", "--state-root", stateRoot],
      stateRoot
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`"uninstalled": true`);
    expect(result.stdout).toContain(`"instance": "${instance}"`);
    expect(existsSync(instanceDir)).toBe(false);
  }, 30_000);

  test("--purge deletes every instance and stays clear of HOME paths under GINI_STATE_ROOT", async () => {
    const stateRoot = scratch("purge");
    mkdirSync(join(stateRoot, "instances", "foo"), { recursive: true });
    mkdirSync(join(stateRoot, "instances", "bar"), { recursive: true });
    const result = await runCli({
      args: ["uninstall", "--purge", "--state-root", stateRoot],
      stateRoot
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Uninstalling gini-agent");
    expect(result.stdout).toContain("Deleted instance state");
    expect(result.stdout).toContain("gini-agent uninstalled.");
    expect(existsSync(join(stateRoot, "instances"))).toBe(false);
  }, 30_000);

  test("refuses to run interactively without a TTY when no --yes/--purge passed", async () => {
    const stateRoot = scratch("no-tty");
    const result = await runCli({
      args: ["uninstall", "--state-root", stateRoot],
      stateRoot,
      stdin: "pipe",
      stdinData: ""
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to run interactively without a TTY");
    expect(existsSync(join(stateRoot, "instances"))).toBe(false);
  }, 30_000);

  test("--yes (full, no --purge) keeps instances", async () => {
    const stateRoot = scratch("yes-keep");
    mkdirSync(join(stateRoot, "instances", "foo"), { recursive: true });
    const result = await runCli({
      args: ["uninstall", "--yes", "--state-root", stateRoot],
      stateRoot
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Kept instance state");
    expect(existsSync(join(stateRoot, "instances", "foo"))).toBe(true);
  }, 30_000);
});
