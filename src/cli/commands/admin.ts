// Lifecycle and instance-admin commands: install, start, stop, status, doctor, reset, run.
import type { ChildProcess } from "node:child_process";
import type { CliContext } from "../context";
import { install, resetInstance } from "../../domain/runtime";
import {
  doctor,
  isRunning,
  remoteOrLocalStatus,
  start as startLifecycle,
  stopRuntime
} from "../process";
import { print } from "../output";

export async function install_(ctx: CliContext): Promise<void> {
  const { config } = ctx;
  install(config);
  print({ installed: true, instance: config.instance, stateRoot: config.stateRoot, port: config.port });
}

export async function start(ctx: CliContext): Promise<boolean> {
  const { banner, runtimeStarted } = await startLifecycle(ctx.config, ctx.web);
  print(banner);
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
    print(banner);
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
  if (exitCode !== 0) process.exit(exitCode);
}
