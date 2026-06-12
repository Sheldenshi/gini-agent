import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { logDir, projectRoot } from "../paths";
import { supervisor } from "../integrations/launchd";
import type { Instance } from "../types";

const EXPECTED_ORIGIN = "https://github.com/Lilac-Labs/gini-agent";
const MAX_INSTALL_FAILURE_OUTPUT = 4000;

// Sha-keyed production web bundles. The update/install flows build the
// Next.js app into web/<prefix><sha12>, where <sha12> is `git rev-parse
// --short=12 HEAD` of the checkout that was built. Every serving path (the
// launchd web shim in src/cli/autostart.ts and startWeb in
// src/cli/process.ts) serves `next start` from that dir iff it exists with a
// BUILD_ID for the CURRENT checkout, falling back to `next dev` otherwise.
// Keying by sha makes a stale build impossible to serve: a bundle built for
// any other commit simply doesn't match. See ADR web-production-serving.md.
export const WEB_PROD_DIST_PREFIX = ".next-prod-";

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
  update: {
    supported: boolean;
    reason?: string;
  };
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
  return join(process.env.HOME || homedir(), ".gini", "runtime");
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
    installedRuntimePresent: existsSync(join(installedRuntimeDir(), ".git")),
    update: updateSupport(runtimeDir)
  };
}

export function refreshVersionInfo(runtimeDir = projectRoot()): GiniVersionInfo {
  const support = updateSupport(runtimeDir);
  if (!support.supported) return currentVersionInfo(runtimeDir);
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
  const stdio = options.stdio ?? "pipe";

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
  runBunInstall(runtimeDir, "bun install", stdio);

  const webDir = join(runtimeDir, "web");
  if (existsSync(join(webDir, "package.json"))) {
    runBunInstall(webDir, "bun install in web/", stdio);
    // Build the sha-keyed production bundle for the NEW head so the
    // restarted web service serves prebuilt assets via `next start` instead
    // of JIT-compiling every route under `next dev` (the cause of the
    // post-update outage when a Next version bump invalidates the dev
    // cache). On failure this throws like the install steps above, so the
    // caller never schedules a restart and the old server keeps serving.
    const sha12 = requireGit(runtimeDir, ["rev-parse", "--short=12", "HEAD"], "could not read new HEAD short sha");
    buildWebProdBundle(runtimeDir, sha12, stdio);
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

// Test seams for scheduleRuntimeRestart. Production callers (http.ts POST
// /api/update) pass nothing and get the real child_process.spawn and
// process.kill — tests inject recorders so they neither spawn a real
// subprocess nor SIGTERM the test runner. Mirrors the spawnImpl seam in
// src/runtime/autostart-refresh.ts.
export interface ScheduleRestartOptions {
  spawnImpl?: typeof spawn;
  killImpl?: (pid: number, signal: NodeJS.Signals | number) => void;
}

export function scheduleRuntimeRestart(instance: Instance, options: ScheduleRestartOptions = {}): boolean {
  const root = projectRoot();
  const oldPid = process.pid;
  const logFile = join(logDir(instance), "update-restart.log");
  const spawnFn = options.spawnImpl ?? spawn;
  const killFn = options.killImpl ?? ((pid: number, signal: NodeJS.Signals | number) => { process.kill(pid, signal); });
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] restart requested cwd=${root} supervisor=${supervisor() ?? "none"}\n`);
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

  // Under launchd, the runtime is a KeepAlive:true job. updateRuntime has
  // already run `git reset --hard` + `bun install` synchronously by the
  // time we get here, so the working tree is the fresh code with no
  // install/respawn race. We:
  //   1. Spawn detached, unref'd `gini autostart kick` children for the web
  //      service (re-execs with any new web/ deps) AND the watchdog. The
  //      watchdog is a long-lived KeepAlive loop, so nothing else replaces
  //      its process on a code-only update — neither KeepAlive (it never
  //      exits) nor the plist-stamp reconcile (the template is unchanged);
  //      without the kick it would run the old code until logout. Both
  //      children must survive our own exit, so they're detached and we
  //      self-SIGTERM after. The gateway is NOT kicked — a kickstart -k
  //      would force-kill it mid-drain; its restart is the self-SIGTERM.
  //   2. Self-SIGTERM. The server's SIGTERM handler drains and exits 0;
  //      KeepAlive:true respawns the gateway with the fresh code.
  // This keeps the gateway under launchd supervision (no detached
  // stop+start helper that would reparent the respawn to PID 1 and orphan
  // it outside KeepAlive).
  if (supervisor() === "launchd") {
    try {
      for (const kind of ["web", "watchdog"] as const) {
        const child = spawnFn(process.execPath, [
          "run", "gini", "autostart", "kick",
          "--instance", instance,
          "--kind", kind
        ], {
          cwd: root,
          detached: true,
          stdio: ["ignore", outFd, errFd],
          env: { ...process.env, GINI_INSTANCE: instance }
        });
        if (typeof child.unref === "function") child.unref();
      }
    } catch (error) {
      try {
        appendFileSync(logFile, `[${new Date().toISOString()}] kick spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      } catch { /* swallowed */ }
    } finally {
      // Parent's FD copies aren't needed after spawn — the child got
      // dup'd copies. Close them so the test runner (which reuses the
      // process) doesn't leak FDs.
      if (typeof outFd === "number") { try { closeSync(outFd); } catch { /* ignore */ } }
      if (typeof errFd === "number") { try { closeSync(errFd); } catch { /* ignore */ } }
    }
    setImmediate(() => {
      try {
        killFn(oldPid, "SIGTERM");
      } catch {
        // If self-signaling fails, KeepAlive won't respawn until the next
        // crash/login; the kick child has already been dispatched.
      }
    });
    return true;
  }

  // Foreground / `gini run` (supervisor()===null): no launchd KeepAlive to
  // respawn us, so keep the detached bash helper that waits for our exit
  // then stop+starts the instance itself.
  const script = `
cd ${shellQuote(root)}
old_pid=${oldPid}
for i in {1..100}; do
  kill -0 "$old_pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$old_pid" 2>/dev/null; then
  bun run src/cli.ts stop --instance ${shellQuote(instance)} || true
  for i in {1..100}; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.1
  done
fi
bun run src/cli.ts start --instance ${shellQuote(instance)}
`;

  const child = spawnFn("bash", ["-lc", script], {
    cwd: root,
    detached: true,
    stdio: ["ignore", outFd, errFd]
  });
  child.unref();

  setImmediate(() => {
    try {
      killFn(oldPid, "SIGTERM");
    } catch {
      // If self-signaling fails, the helper still tries to stop/start.
    }
  });
  return true;
}

export function formatInstallFailure(
  label: string,
  status: number | null,
  stdout?: string | Buffer | null,
  stderr?: string | Buffer | null
): string {
  const output = [toText(stdout), toText(stderr)].filter(Boolean).join("\n").trim();
  const base = `gini update: ${label} failed (exit ${status ?? "null"}).`;
  if (!output) return base;
  return `${base}\n\n----- ${label} output -----\n${truncateOutput(output)}`;
}

// Resolve the production dist dir to serve for the checkout at repoDir:
// web/<prefix><sha12> with a BUILD_ID (next build's completion marker — a
// dir without one is an aborted build and must not be served). Returns the
// dir NAME (relative, the shape GINI_DIST_DIR wants) or null when no bundle
// matches the current HEAD — the caller falls back to `next dev`.
export function resolveWebProdDistDir(repoDir: string): string | null {
  const sha12 = git(repoDir, ["rev-parse", "--short=12", "HEAD"]);
  if (!sha12) return null;
  const distDir = `${WEB_PROD_DIST_PREFIX}${sha12}`;
  return existsSync(join(repoDir, "web", distDir, "BUILD_ID")) ? distDir : null;
}

// Test seam for buildWebProdBundle: tests inject a spawnSync recorder so no
// real `next build` runs. Mirrors the spawnImpl seam in ScheduleRestartOptions.
export interface BuildWebProdOptions {
  spawnImpl?: typeof spawnSync;
}

// Build the production web bundle for sha12 into web/<prefix><sha12>.
// Idempotent: a dir that already carries a BUILD_ID is kept as-is (re-update
// onto the same head). On success, every OTHER <prefix>* dir is deleted —
// they can never be served again (the sha no longer matches) and each one
// holds a full Next build. The still-running old server may 500 on a
// not-yet-loaded route for the moment between this GC and its restart;
// that's accepted (the updating tab sits behind the UpdateGate blur). On
// build failure this throws so updateRuntime aborts before any restart is
// scheduled.
export function buildWebProdBundle(
  runtimeDir: string,
  sha12: string,
  stdio: "inherit" | "pipe",
  options: BuildWebProdOptions = {}
): { distDir: string; built: boolean } {
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const webDir = join(runtimeDir, "web");
  const distDir = `${WEB_PROD_DIST_PREFIX}${sha12}`;
  const alreadyBuilt = existsSync(join(webDir, distDir, "BUILD_ID"));
  if (!alreadyBuilt) {
    const env = { ...process.env, GINI_DIST_DIR: distDir };
    const result = stdio === "inherit"
      ? spawnImpl("bun", ["run", "build"], { cwd: webDir, stdio: "inherit", env })
      : spawnImpl("bun", ["run", "build"], { cwd: webDir, encoding: "utf8", env });
    if (result.status !== 0) {
      throw new Error(formatInstallFailure("bun run build in web/", result.status, result.stdout, result.stderr));
    }
  }
  for (const entry of readdirSync(webDir)) {
    if (!entry.startsWith(WEB_PROD_DIST_PREFIX) || entry === distDir) continue;
    try {
      rmSync(join(webDir, entry), { recursive: true, force: true });
    } catch {
      // GC is best-effort: a leftover dir wastes disk but can never be
      // served (its sha doesn't match), so it must not fail the update.
    }
  }
  return { distDir, built: !alreadyBuilt };
}

function runBunInstall(cwd: string, label: string, stdio: "inherit" | "pipe"): void {
  const result = stdio === "inherit"
    ? spawnSync("bun", ["install"], { cwd, stdio: "inherit" })
    : spawnSync("bun", ["install"], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(formatInstallFailure(label, result.status, result.stdout, result.stderr));
  }
}

function toText(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_INSTALL_FAILURE_OUTPUT) return value;
  return `${value.slice(0, MAX_INSTALL_FAILURE_OUTPUT)}\n... output truncated ...`;
}

export function assertCurrentRuntimeUpdateSupported(runtimeDir = projectRoot()): void {
  const support = updateSupport(runtimeDir);
  if (!support.supported) {
    throw new Error(support.reason ?? "Runtime update is not available from this checkout.");
  }
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

function updateSupport(runtimeDir: string): { supported: boolean; reason?: string } {
  if (!existsSync(join(installedRuntimeDir(), ".git"))) {
    return { supported: false, reason: "Installer-managed runtime is not present. Use git pull from this checkout." };
  }
  if (!sameRealPath(runtimeDir, installedRuntimeDir())) {
    return { supported: false, reason: "Web update is only available from the installer-managed runtime. Use git pull from this checkout." };
  }
  try {
    assertUpdateTarget(runtimeDir);
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
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
