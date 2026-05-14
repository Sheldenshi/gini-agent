// Lifecycle and instance-admin commands: install, start, stop, status, doctor, reset, run.
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import type { CliContext } from "../context";
import { hasFlag } from "../args";
import { install, resetInstance, uninstallAll, uninstallInstance } from "../../runtime";
import { configPath, loadConfig, parseInstance } from "../../paths";
import {
  awaitForegroundLogFlush,
  doctor,
  isRunning,
  remoteOrLocalStatus,
  start as startLifecycle,
  stopRuntime
} from "../process";
import { print, printStartBanner } from "../output";
import { COLOR, header, footer, step, info, warn, tildify } from "../styling";
import { disableForUninstall } from "./autostart";

export async function install_(ctx: CliContext): Promise<void> {
  // Provider configuration is optional at install time. The piped-curl
  // install path (`curl … | bash`) has no GINI_PROVIDER env, and the
  // browser /setup flow is responsible for picking a provider. If no env
  // is set and no config exists yet, materialize a placeholder ("echo")
  // config; the runtime starts, /api/setup/status reports
  // providerConfigured:false, and the browser /setup page replaces the
  // placeholder. Existing configs are not overwritten.
  //
  // For users who want to skip the browser flow, GINI_PROVIDER=openai|codex
  // is still honored — it short-circuits the placeholder and writes the
  // real provider directly.
  const instance = parseInstance(ctx.rawArgs);
  if (!existsSync(configPath(instance))) {
    const envProvider = process.env.GINI_PROVIDER;
    if (envProvider && envProvider !== "openai" && envProvider !== "codex") {
      throw new Error(
        `GINI_PROVIDER='${envProvider}' is not a recognized provider. ` +
        `Use 'openai' or 'codex', leave it unset for a placeholder config that the /setup page replaces, ` +
        `or run \`gini provider set <name> [model]\` after install.`
      );
    }
    // envProvider is undefined → placeholder config will materialize via
    // defaultConfig() inside install(); /api/setup/status will report
    // providerConfigured:false; the browser /setup flow takes over.
  }
  const { config } = ctx;
  install(config);
  print({ installed: true, instance: config.instance, stateRoot: config.stateRoot, port: config.port });
}

export async function start(ctx: CliContext): Promise<boolean> {
  const { banner, runtimeStarted } = await startLifecycle(ctx.config, ctx.web);
  printStartBanner(banner);
  return runtimeStarted;
}

export function stop(ctx: CliContext): void {
  print(stopRuntime(ctx.config));
}

export async function statusCmd(ctx: CliContext): Promise<void> {
  print(await remoteOrLocalStatus(ctx.config, ctx.web));
}

export async function doctorCmd(ctx: CliContext): Promise<void> {
  print(await doctor(ctx.config, ctx.web));
}

export function reset(ctx: CliContext): void {
  resetInstance(ctx.config);
  print({ reset: true, instance: ctx.config.instance, stateRoot: ctx.config.stateRoot });
}

export async function update(_ctx: CliContext): Promise<void> {
  // GINI_STATE_ROOT is the test-mode signal — same convention as `uninstall`.
  // Skip every step that would touch the real $HOME so the command stays
  // exercisable from subprocess tests without clobbering the developer's
  // installed runtime.
  if (process.env.GINI_STATE_ROOT) {
    console.log("gini update: skipped (GINI_STATE_ROOT set; not touching ~/.gini/runtime)");
    return;
  }

  const home = homedir();
  const runtimeDir = join(home, ".gini", "runtime");

  if (!existsSync(runtimeDir) || !existsSync(join(runtimeDir, ".git"))) {
    console.error("gini update operates on the installed runtime at ~/.gini/runtime, which is not present. Reinstall with: curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash");
    process.exit(1);
  }

  const expectedOrigin = "https://github.com/Lilac-Labs/gini-agent";
  const originRes = spawnSync("git", ["-C", runtimeDir, "remote", "get-url", "origin"], { encoding: "utf8" });
  if (originRes.status !== 0) {
    const stderr = (originRes.stderr ?? "").trim();
    console.error(`gini update could not read git origin in ${runtimeDir}${stderr ? `: ${stderr}` : "."}`);
    process.exit(1);
  }
  const actualOrigin = (originRes.stdout ?? "").trim();
  const normalize = (url: string): string => url.replace(/\.git$/, "");
  const isExpectedRemote = normalize(actualOrigin) === normalize(expectedOrigin);
  // Local-test installs (via scripts/install.sh --local) set origin to a
  // filesystem path. Accept that as a valid origin so the test loop
  // (edit → commit in local repo → gini update) works end to end.
  const isLocalCheckout = actualOrigin.startsWith("/") && existsSync(join(actualOrigin, ".git"));
  if (!isExpectedRemote && !isLocalCheckout) {
    console.error(`gini update refuses to touch ~/.gini/runtime because its git origin is ${actualOrigin} (expected ${expectedOrigin} or a local repo path). Move that directory aside and reinstall.`);
    process.exit(1);
  }

  const beforeRes = spawnSync("git", ["-C", runtimeDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (beforeRes.status !== 0) {
    const stderr = (beforeRes.stderr ?? "").trim();
    console.error(`gini update could not read current HEAD${stderr ? `: ${stderr}` : "."}`);
    process.exit(1);
  }
  const beforeSha = (beforeRes.stdout ?? "").trim();

  header("Updating gini-agent");

  const fetchRes = spawnSync("git", ["-C", runtimeDir, "fetch", "origin"], { encoding: "utf8" });
  if (fetchRes.status !== 0) {
    const stderr = (fetchRes.stderr ?? "").trim();
    console.error(`gini update: git fetch origin failed${stderr ? `: ${stderr}` : "."}`);
    process.exit(1);
  }

  // origin/HEAD follows the remote's default branch — works for both the
  // GitHub install (main) and local-test installs that may be on any branch.
  const resetRes = spawnSync("git", ["-C", runtimeDir, "reset", "--hard", "origin/HEAD"], { encoding: "utf8" });
  if (resetRes.status !== 0) {
    const stderr = (resetRes.stderr ?? "").trim();
    console.error(`gini update: git reset --hard origin/HEAD failed${stderr ? `: ${stderr}` : "."}`);
    process.exit(1);
  }

  const afterRes = spawnSync("git", ["-C", runtimeDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (afterRes.status !== 0) {
    const stderr = (afterRes.stderr ?? "").trim();
    console.error(`gini update could not read new HEAD${stderr ? `: ${stderr}` : "."}`);
    process.exit(1);
  }
  const afterSha = (afterRes.stdout ?? "").trim();

  const installRes = spawnSync("bun", ["install"], { cwd: runtimeDir, stdio: "inherit" });
  if (installRes.status !== 0) {
    console.error(`gini update: bun install failed (exit ${installRes.status ?? "null"}).`);
    process.exit(1);
  }

  const webDir = join(runtimeDir, "web");
  if (existsSync(join(webDir, "package.json"))) {
    const webResult = spawnSync("bun", ["install"], { cwd: webDir, stdio: "inherit" });
    if (webResult.status !== 0) {
      console.error(`gini update: bun install in web/ failed (exit ${webResult.status ?? "null"}).`);
      process.exit(1);
    }
  }

  const upToDate = beforeSha === afterSha;
  const countRes = upToDate
    ? null
    : spawnSync("git", ["-C", runtimeDir, "rev-list", "--count", `${beforeSha}..${afterSha}`], { encoding: "utf8" });
  const commitCount = upToDate
    ? "0"
    : countRes && countRes.status === 0 ? (countRes.stdout ?? "").trim() : "?";

  footer("gini-agent updated.");
  if (upToDate) {
    info(`Already at ${afterSha.slice(0, 7)}`);
  } else {
    info(`${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)} (${commitCount} commit${commitCount === "1" ? "" : "s"})`);
  }
  info("If a runtime is running, restart it: gini stop && gini start");
  console.log("");
}

export async function uninstall(ctx: CliContext): Promise<void> {
  const yes = hasFlag(ctx.rawArgs, "--yes");
  const purge = hasFlag(ctx.rawArgs, "--purge");

  if (ctx.explicitInstance) {
    // Disable autostart FIRST so launchd doesn't respawn the runtime
    // mid-uninstall. Bootout failures are surfaced via warn() so a broken
    // plist doesn't get silently dropped; state deletion still proceeds.
    const autostart = await disableForUninstall(ctx.config.instance);
    if (autostart.failures.length > 0) {
      for (const f of autostart.failures) {
        warn(`autostart unload (${f.kind}): ${f.error}`);
      }
      warn("Continuing with uninstall — you may need to clean up the plist manually.");
    }
    // Stop the runtime first if it's running — otherwise removing stateRoot
    // out from under a live process leaves the daemon writing to a deleted
    // directory until it crashes.
    if (await isRunning(ctx.config)) stopRuntime(ctx.config);
    uninstallInstance(ctx.config);
    print({ uninstalled: true, instance: ctx.config.instance, stateRoot: ctx.config.stateRoot, logRoot: ctx.config.logRoot, autostart });
    return;
  }

  await fullUninstall({ yes, purge });
}

interface FullUninstallFlags {
  yes: boolean;
  purge: boolean;
}

async function fullUninstall(flags: FullUninstallFlags): Promise<void> {
  const skipPrompts = flags.yes || flags.purge;
  if (!skipPrompts && !process.stdin.isTTY) {
    console.error("Refusing to run interactively without a TTY. Pass --yes or --purge to proceed.");
    process.exit(1);
  }

  let deleteInstances = flags.purge;

  if (!skipPrompts) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const proceed = await rl.question(`${COLOR.cyan}?${COLOR.reset} This will uninstall gini-agent. Continue? [y/N] `);
      if (!isYes(proceed, false)) {
        console.log("Aborted.");
        return;
      }
      const keep = await rl.question(`${COLOR.cyan}?${COLOR.reset} Keep your instance state at ~/.gini/instances/? [Y/n] `);
      deleteInstances = !isYes(keep, true);
    } finally {
      rl.close();
    }
  }

  console.log("");
  header("Uninstalling gini-agent");

  // Collect autostart bootout warnings across all instances; surface them
  // after uninstallAll completes so the warn lines don't get interleaved
  // with the per-instance "Stopped N/M" summary lines printed below.
  const autostartWarnings: string[] = [];
  const result = await uninstallAll({
    deleteInstances,
    stopInstance: async (name) => {
      // Disable autostart before stopping the runtime so launchd doesn't
      // respawn it the instant we send SIGTERM. Bootout failures are
      // captured for a post-loop warn() pass — a stale plist with no
      // service is still better than a half-uninstalled instance.
      const autostartResult = await disableForUninstall(name);
      for (const f of autostartResult.failures) {
        autostartWarnings.push(`autostart unload [${name}] (${f.kind}): ${f.error}`);
      }
      const cfg = loadConfig(name);
      if (!(await isRunning(cfg))) return;
      const outcome = stopRuntime(cfg);
      if (!outcome.stopped) {
        const reason = outcome.error ?? outcome.reason ?? "unknown error";
        throw new Error(reason);
      }
    }
  });
  for (const w of autostartWarnings) warn(w);

  // GINI_STATE_ROOT is the test-mode signal. When set, the user is not actually
  // tearing down their real install — they're exercising the code path against
  // a scratch directory — so we skip everything that touches the real $HOME
  // (rc files, wrapper, runtime checkout, model cache).
  const testMode = Boolean(process.env.GINI_STATE_ROOT);

  const rcEdits = testMode ? [] : removePathBlockFromRc();

  const home = homedir();
  const wrapperPath = join(home, ".local", "bin", "gini");
  const runtimeDir = join(home, ".gini", "runtime");
  const modelsDir = join(home, ".gini", "models");

  const wrapperOutcome = testMode
    ? { message: "skipped (GINI_STATE_ROOT set)", shouldRemove: false }
    : describeWrapper(wrapperPath);
  const modelsNote = testMode ? undefined : describeModels(modelsDir);

  if (result.instances.length > 0) {
    const stoppedCount = result.stopped.length;
    const total = result.instances.length;
    if (result.stopErrors.length > 0) {
      warn(`Stopped ${stoppedCount}/${total} instance${total === 1 ? "" : "s"} (${result.stopErrors.length} had errors)`);
      for (const f of result.stopErrors) console.error(`    - ${f.instance}: ${f.error}`);
    } else if (stoppedCount > 0) {
      step(`Stopped ${stoppedCount} instance${stoppedCount === 1 ? "" : "s"}`);
    }

    if (deleteInstances) {
      step(`Deleted instance state (${total} instance${total === 1 ? "" : "s"})`);
      if (result.stopErrors.length > 0) {
        warn("Deleted state even though one or more instances did not stop cleanly.");
      }
    } else {
      info(`Kept instance state (${total} instance${total === 1 ? "" : "s"})`);
    }
  }

  if (rcEdits.length > 0) {
    for (const file of rcEdits) step(`Cleaned shell rc (${tildify(file)})`);
  }

  if (wrapperOutcome.shouldRemove) {
    step(`Removed wrapper (${tildify(wrapperPath)})`);
    try { rmSync(wrapperPath, { force: true }); } catch (error) {
      warn(`Failed to remove wrapper: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!testMode && wrapperOutcome.message.startsWith("kept")) {
    warn(`Wrapper not removed: ${wrapperOutcome.message}`);
  }

  if (!testMode && existsSync(runtimeDir)) {
    step(`Removed runtime (${tildify(runtimeDir)})`);
    // Unix keeps file handles alive on unlinked inodes so this is safe even
    // though we may be executing from runtimeDir right now.
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch (error) {
      warn(`Failed to remove runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  footer("gini-agent uninstalled.");
  if (modelsNote) console.log(modelsNote);
  console.log("");
}

function isYes(input: string, defaultYes: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

const RC_MARKER = "# Added by gini-agent installer";
const EXPECTED_PATH_LINES = new Set([
  'export PATH="$HOME/.local/bin:$PATH"',
  'fish_add_path "$HOME/.local/bin"'
]);

function removePathBlockFromRc(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  const zdotdir = process.env.ZDOTDIR;
  if (zdotdir) candidates.push(join(zdotdir, ".zshrc"));
  candidates.push(
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".config", "fish", "config.fish")
  );
  const edited: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let contents: string;
    try { contents = readFileSync(file, "utf8"); } catch { continue; }
    const lines = contents.split("\n");
    const next: string[] = [];
    let removed = false;
    let skippedMismatched = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.trim() === RC_MARKER) {
        const followup = lines[i + 1]?.trim() ?? "";
        if (EXPECTED_PATH_LINES.has(followup)) {
          i += 1;
          removed = true;
          continue;
        }
        skippedMismatched = true;
      }
      next.push(lines[i] ?? "");
    }
    if (skippedMismatched) {
      console.error(`Warning: found installer marker in ${file} but the following line didn't match the expected PATH update. Skipping rc cleanup for ${file}.`);
    }
    if (!removed) continue;
    try {
      writeFileSync(file, next.join("\n"));
      edited.push(file);
    } catch (error) {
      console.error(`Could not edit ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return edited;
}

interface WrapperOutcome {
  message: string;
  shouldRemove: boolean;
}

function describeWrapper(path: string): WrapperOutcome {
  if (!existsSync(path)) return { message: "absent", shouldRemove: false };
  let contents = "";
  try { contents = readFileSync(path, "utf8"); } catch { return { message: `unreadable at ${path}`, shouldRemove: false }; }
  const lines = contents.split("\n");
  const hasMarker = lines.some((line) => line.trim() === "# gini-agent-installer-managed");
  if (!hasMarker) {
    return { message: `kept (not installer-managed at ${path})`, shouldRemove: false };
  }
  return { message: `will remove ${path}`, shouldRemove: true };
}

function describeModels(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let size = "unknown size";
  try {
    // 30s cap so a stuck filesystem can't block the whole uninstall on a
    // best-effort cosmetic measurement.
    const result = spawnSync("du", ["-sh", path], { encoding: "utf8", timeout: 30_000 });
    const out = result.stdout?.trim();
    if (out) {
      const first = out.split(/\s+/)[0];
      if (first) size = first;
    }
  } catch {
    // best-effort
  }
  return `${COLOR.dim}•${COLOR.reset} Model cache at ${tildify(path)} (${size}) kept. Remove with: rm -rf ${tildify(path)}`;
}

// Foreground twin of `start`. Runs the runtime (and optionally Next.js)
// attached to this CLI process: stdio inherits, no detach, signals tear the
// children down. Use this from worktrees and CI where the instance should die
// when the launching session ends. `gini start` remains the daemon path.
export async function runForeground(ctx: CliContext): Promise<void> {
  // Refuse to attach to a runtime we did not spawn. If the instance is already up
  // (likely a previous `gini start`), our signal handlers cannot govern its
  // lifetime — that's exactly the bug `gini run` was created to avoid.
  if (await isRunning(ctx.config)) {
    throw new Error(`Instance '${ctx.config.instance}' already has a runtime running. Stop it with \`gini stop --instance ${ctx.config.instance}\` before running in foreground.`);
  }
  // Install signal handlers BEFORE start() so a Ctrl-C during startup still
  // tears down any partially-launched child.
  let shuttingDown = false;
  let runtimeChild: ChildProcess | null = null;
  let webChild: ChildProcess | null = null;
  let exitCode = 0;
  // Resolve when both children we own have exited (or when shutdown completes
  // for a started-then-failed case).
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  function aliveChildren(): ChildProcess[] {
    const list: ChildProcess[] = [];
    if (runtimeChild && runtimeChild.exitCode === null && runtimeChild.signalCode === null) list.push(runtimeChild);
    if (webChild && webChild.exitCode === null && webChild.signalCode === null) list.push(webChild);
    return list;
  }

  function maybeResolve(): void {
    if (aliveChildren().length === 0 && shuttingDown) {
      // Stop files written by start()/startWeb(). The pid/port files are not
      // load-bearing for the foreground path (parent owns the children
      // directly), but cleaning them keeps `gini status` from misreporting
      // a stale instance after we exit.
      stopRuntime(ctx.config);
      resolveDone?.();
    }
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`gini run: shutting down (${reason})`);
    const children = aliveChildren();
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    // Escalate to SIGKILL after 5s so we don't hang on a stuck child.
    const deadline = Date.now() + 5000;
    while (aliveChildren().length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    for (const child of aliveChildren()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    // Give the OS a tick to reap, then resolve.
    await Bun.sleep(50);
    maybeResolve();
  }

  process.on("SIGINT", () => { exitCode = 130; void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { exitCode = 143; void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { exitCode = 129; void shutdown("SIGHUP"); });

  try {
    const { banner, children } = await startLifecycle(ctx.config, { ...ctx.web, foreground: true });
    runtimeChild = children.runtime;
    webChild = children.web;
    printStartBanner(banner);
  } catch (error) {
    // Startup failed — clean up any partial state and surface the error.
    shuttingDown = true;
    await shutdown("startup-error");
    throw error;
  }

  // Wire child-exit watchers AFTER we've captured handles. If either child
  // exits unexpectedly (i.e. we're not already shutting down), tear the other
  // one down and exit non-zero so the user notices.
  function watch(child: ChildProcess | null, label: string): void {
    if (!child) return;
    child.on("exit", (code, signal) => {
      if (!shuttingDown) {
        console.error(`gini run: ${label} exited (code=${code ?? "null"} signal=${signal ?? "null"}); tearing down`);
        exitCode = code && code !== 0 ? code : 1;
        void shutdown(`${label}-exit`);
      } else {
        maybeResolve();
      }
    });
  }
  watch(runtimeChild, "runtime");
  watch(webChild, "web");

  // Edge: --no-web AND runtime was already running (we'd have thrown above) —
  // so at least one child must exist by here. Defensive fallback for typing.
  if (!runtimeChild && !webChild) {
    stopRuntime(ctx.config);
    return;
  }

  await done;
  // Flush foreground log tee streams before exiting so the tail of a crashing
  // child's output isn't lost on signal-driven exits (SIGINT/SIGTERM/SIGHUP /
  // non-zero child exit). `process.exit` does not wait for write streams to
  // finish, so we explicitly await `'finish'` on each registered stream.
  await awaitForegroundLogFlush();
  if (exitCode !== 0) process.exit(exitCode);
}
