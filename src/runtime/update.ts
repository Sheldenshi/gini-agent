import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { logDir, projectRoot } from "../paths";
import type { Instance } from "../types";

const EXPECTED_ORIGIN = "https://github.com/Lilac-Labs/gini-agent";

export interface GiniVersionInfo {
  packageVersion: string;
  runtimeDir: string;
  git: {
    sha: string | null;
    shortSha: string | null;
    branch: string | null;
    origin: string | null;
    upstreamSha: string | null;
    updateAvailable: boolean;
  };
  installedRuntimePresent: boolean;
}

export interface GiniUpdateResult {
  beforeSha: string;
  afterSha: string;
  commitCount: string;
  upToDate: boolean;
  runtimeDir: string;
  version: GiniVersionInfo;
}

export function installedRuntimeDir(): string {
  return join(homedir(), ".gini", "runtime");
}

export function currentVersionInfo(runtimeDir = projectRoot()): GiniVersionInfo {
  const packageVersion = readPackageVersion(runtimeDir);
  const sha = git(runtimeDir, ["rev-parse", "HEAD"]);
  const branch = git(runtimeDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const origin = git(runtimeDir, ["remote", "get-url", "origin"]);
  const upstreamSha = git(runtimeDir, ["rev-parse", "--verify", "origin/HEAD"]);
  return {
    packageVersion,
    runtimeDir,
    git: {
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      branch,
      origin,
      upstreamSha,
      updateAvailable: Boolean(sha && upstreamSha && sha !== upstreamSha)
    },
    installedRuntimePresent: existsSync(join(installedRuntimeDir(), ".git"))
  };
}

export function refreshVersionInfo(runtimeDir = projectRoot()): GiniVersionInfo {
  if (existsSync(join(runtimeDir, ".git"))) {
    const fetchRes = spawnSync("git", ["-C", runtimeDir, "fetch", "origin"], { encoding: "utf8" });
    if (fetchRes.status !== 0) {
      const stderr = (fetchRes.stderr ?? "").trim();
      throw new Error(`gini update check: git fetch origin failed${stderr ? `: ${stderr}` : "."}`);
    }
  }
  return currentVersionInfo(runtimeDir);
}

export function updateRuntime(runtimeDir = installedRuntimeDir(), options: { stdio?: "inherit" | "pipe" } = {}): GiniUpdateResult {
  assertUpdateTarget(runtimeDir);

  const beforeSha = requireGit(runtimeDir, ["rev-parse", "HEAD"], "could not read current HEAD");
  const fetchRes = spawnSync("git", ["-C", runtimeDir, "fetch", "origin"], { encoding: "utf8" });
  if (fetchRes.status !== 0) {
    const stderr = (fetchRes.stderr ?? "").trim();
    throw new Error(`gini update: git fetch origin failed${stderr ? `: ${stderr}` : "."}`);
  }

  const resetRes = spawnSync("git", ["-C", runtimeDir, "reset", "--hard", "origin/HEAD"], { encoding: "utf8" });
  if (resetRes.status !== 0) {
    const stderr = (resetRes.stderr ?? "").trim();
    throw new Error(`gini update: git reset --hard origin/HEAD failed${stderr ? `: ${stderr}` : "."}`);
  }

  const afterSha = requireGit(runtimeDir, ["rev-parse", "HEAD"], "could not read new HEAD");
  const installRes = spawnSync("bun", ["install"], { cwd: runtimeDir, stdio: options.stdio ?? "pipe" });
  if (installRes.status !== 0) {
    throw new Error(`gini update: bun install failed (exit ${installRes.status ?? "null"}).`);
  }

  const webDir = join(runtimeDir, "web");
  if (existsSync(join(webDir, "package.json"))) {
    const webResult = spawnSync("bun", ["install"], { cwd: webDir, stdio: options.stdio ?? "pipe" });
    if (webResult.status !== 0) {
      throw new Error(`gini update: bun install in web/ failed (exit ${webResult.status ?? "null"}).`);
    }
  }

  const upToDate = beforeSha === afterSha;
  const commitCount = upToDate
    ? "0"
    : git(runtimeDir, ["rev-list", "--count", `${beforeSha}..${afterSha}`]) ?? "?";

  return {
    beforeSha,
    afterSha,
    commitCount,
    upToDate,
    runtimeDir,
    version: currentVersionInfo(runtimeDir)
  };
}

export function scheduleRuntimeRestart(instance: Instance): boolean {
  const root = projectRoot();
  const logFile = join(logDir(instance), "update-restart.log");
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] restart requested cwd=${root}\n`);
  } catch {
    // Logging is best-effort; restart should still be attempted.
  }

  let outFd: number | "ignore" = "ignore";
  let errFd: number | "ignore" = "ignore";
  try {
    outFd = openSync(logFile, "a");
    errFd = openSync(logFile, "a");
  } catch {
    // Fall back to ignored stdio.
  }

  const script = [
    "sleep 0.8",
    `cd ${shellQuote(root)}`,
    `bun run src/cli.ts stop --instance ${shellQuote(instance)} || true`,
    `bun run src/cli.ts start --instance ${shellQuote(instance)}`
  ].join("; ");

  const child = spawn("bash", ["-lc", script], {
    cwd: root,
    detached: true,
    stdio: ["ignore", outFd, errFd]
  });
  child.unref();

  setImmediate(() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      // If self-signaling fails, the helper still tries to stop/start.
    }
  });
  return true;
}

function assertUpdateTarget(runtimeDir: string): void {
  if (!existsSync(runtimeDir) || !existsSync(join(runtimeDir, ".git"))) {
    throw new Error(
      "gini update operates on the installed runtime at ~/.gini/runtime, which is not present. " +
      "Reinstall with: curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash"
    );
  }
  const actualOrigin = requireGit(runtimeDir, ["remote", "get-url", "origin"], "could not read git origin");
  const normalize = (url: string): string => url.replace(/\.git$/, "");
  const isExpectedRemote = normalize(actualOrigin) === normalize(EXPECTED_ORIGIN);
  const isLocalCheckout = actualOrigin.startsWith("/") && existsSync(join(actualOrigin, ".git"));
  if (!isExpectedRemote && !isLocalCheckout) {
    throw new Error(
      `gini update refuses to touch ~/.gini/runtime because its git origin is ${actualOrigin} ` +
      `(expected ${EXPECTED_ORIGIN} or a local repo path). Move that directory aside and reinstall.`
    );
  }
}

function readPackageVersion(runtimeDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function requireGit(runtimeDir: string, args: string[], label: string): string {
  const value = git(runtimeDir, args);
  if (value) return value;
  throw new Error(`gini update ${label}.`);
}

function git(runtimeDir: string, args: string[]): string | null {
  if (!existsSync(join(runtimeDir, ".git"))) return null;
  const result = spawnSync("git", ["-C", runtimeDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
