// Lifecycle helpers: start/stop the runtime + Next.js web, doctor, status.
//
// These were previously inline in src/cli.ts. They depend on a few runtime
// flags (the resolved web port and whether the user pinned a port or
// suppressed the web launch). Those flags are passed via WebOptions rather
// than read from module scope, which keeps each helper testable in
// isolation.

import { createWriteStream, existsSync, openSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { install, status } from "../runtime";
import { providerHealth } from "../provider";
import { readState } from "../state";
import { probeMemoryDb } from "../state/memory-db";
import { legacyMigrationStatus } from "../memory";
import { embeddingStatus, listBanksWithModelMismatch } from "../memory/embedding";
import { rerankerStatus } from "../memory/reranker";
import { defaultRuntimePort, defaultWebPort, ensureDir, logDir, pidPath, projectRoot, runtimePortPath, webPortPath } from "../paths";
import { api, auth, url } from "./api";

export interface WebOptions {
  webPort: number;
  webPortPinned: boolean;
  noWeb: boolean;
  // True when the runtime port came from --port or GINI_PORT. Pinned ports
  // strict-fail on collision (the user asked for that exact port; silently
  // walking would surprise them). Unpinned uses the instance default and walks.
  runtimePortPinned?: boolean;
  // Foreground mode: don't detach/unref children, inherit their stdio so the
  // user sees logs live. Caller (gini run) attaches signal handlers and is
  // responsible for tearing the children down. start()/startWeb() return the
  // child handles in this mode so the caller can wait on / signal them.
  foreground?: boolean;
}

export interface ForegroundChildren {
  runtime: ChildProcess | null;
  web: ChildProcess | null;
}

// Capture stdout/stderr from a spawned child to <logPath>, tee'ing also to the
// caller's terminal in foreground mode. Daemon mode opens the file once and
// hands the FD to spawn() as stdio so writes survive the parent unref. We keep
// the helpers separate because the call sites have different setup (FD-based
// stdio must be configured BEFORE spawn; pipes are wired up AFTER spawn).
//
// Returns { stdio, onSpawned } so callers can drop the result straight into
// their spawn options object and run a one-line post-spawn hook for foreground
// pipe wiring (no-op in daemon mode).
interface ChildLogPlumbing {
  stdio: ["ignore" | "inherit", number | "pipe", number | "pipe"];
  onSpawned: (child: ChildProcess) => void;
}

// Foreground tee streams registered by setupChildLog so the run command can
// await their `'finish'` event before `process.exit` — otherwise tail bytes
// from a crashing child's stderr burst can be lost on signal-driven exits.
const foregroundLogStreams: Set<WriteStream> = new Set();

export async function awaitForegroundLogFlush(): Promise<void> {
  // `'finish'` fires after `.end()` has flushed all queued writes. Streams that
  // are already finished are skipped so we don't hang waiting for an event
  // that's never coming. Per-stream errors (ENOSPC/EACCES/NFS hiccups) are
  // swallowed: a logging failure must never override the child's exit code.
  await Promise.all(
    [...foregroundLogStreams].map((stream) =>
      stream.writableFinished
        ? Promise.resolve()
        : once(stream, "finish").then(() => undefined).catch(() => undefined)
    )
  );
}

export function setupChildLog(instance: string, fileName: string, foreground: boolean): ChildLogPlumbing {
  const dir = logDir(instance);
  ensureDir(dir);
  const logPath = join(dir, fileName);
  if (foreground) {
    // Foreground: open a write stream and tee child.stdout/stderr to both the
    // user's terminal and the log file. Stream is closed when the child's stdio
    // fully drains (`close` event) so the tail is flushed and we don't leak FDs
    // across instance restarts. We register on the module-level Set so the run
    // command can await `'finish'` before process.exit (see awaitForegroundLogFlush).
    const stream: WriteStream = createWriteStream(logPath, { flags: "a" });
    foregroundLogStreams.add(stream);
    stream.once("finish", () => { foregroundLogStreams.delete(stream); });
    // Without an `'error'` listener the stream stays registered after a
    // failure (ENOSPC/EACCES/NFS), so a later `awaitForegroundLogFlush()`
    // would hang waiting for a `'finish'` that never fires. Cleaning up here
    // also prevents an unhandled-error abort.
    stream.once("error", () => { foregroundLogStreams.delete(stream); });
    return {
      stdio: ["inherit", "pipe", "pipe"],
      onSpawned: (child) => {
        child.stdout?.on("data", (chunk: Buffer | string) => {
          process.stdout.write(chunk);
          stream.write(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          process.stderr.write(chunk);
          stream.write(chunk);
        });
        const close = () => { try { stream.end(); } catch { /* ignore */ } };
        // `close` (not `exit`) fires after stdio has fully drained. Using `exit`
        // here let late `data` events arrive after the stream had been ended,
        // which truncates the tail.
        child.once("close", close);
        child.once("error", close);
      }
    };
  }
  // Daemon: hand the FD directly to the child so writes go straight to the
  // file from the kernel's perspective. This survives child.unref() and the
  // parent CLI exiting (a JS-level pipe would not — the parent owns it).
  const fd = openSync(logPath, "a");
  return {
    stdio: ["ignore", fd, fd],
    onSpawned: () => { /* nothing to wire; FDs go to the kernel */ }
  };
}

function readRecordedPort(path: string): number | null {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function recordedRuntimePort(config: RuntimeConfig): number | null {
  return readRecordedPort(runtimePortPath(config.instance));
}

export function recordedWebPort(config: RuntimeConfig): number | null {
  return readRecordedPort(webPortPath(config.instance));
}

export async function start(config: RuntimeConfig, options: WebOptions): Promise<{ runtimeStarted: boolean; banner: Record<string, unknown>; children: ForegroundChildren }> {
  const foreground = options.foreground === true;
  const children: ForegroundChildren = { runtime: null, web: null };
  const alreadyRunning = await isRunning(config);
  let runtimeStarted = false;
  if (!alreadyRunning) {
    install(config);
    const requestedRuntimePort = config.port;
    const claimedPort = await availablePort(requestedRuntimePort);
    if (claimedPort !== requestedRuntimePort && options.runtimePortPinned) {
      // User pinned via --port / GINI_PORT; refuse to silently roll forward.
      throw new Error(`Requested runtime port ${requestedRuntimePort} is busy. Stop the other process or pick a different --port.`);
    }
    config.port = claimedPort;
    install(config);
    writeFileSync(runtimePortPath(config.instance), String(config.port));
    // Foreground mode keeps the child attached to the CLI: no detached process
    // group, and stdio is tee'd to both the user's terminal and runtime-stdout.log.
    // Daemon mode (gini start) preserves detach + unref but hands a log-file FD
    // to the child so its stdio survives parent exit (kept separate from the
    // structured runtime.jsonl event stream).
    const runtimeLog = setupChildLog(config.instance, "runtime-stdout.log", foreground);
    const child = spawn(process.execPath, ["run", "src/server.ts", "--instance", config.instance], {
      cwd: process.cwd(),
      detached: !foreground,
      stdio: runtimeLog.stdio,
      env: { ...process.env, GINI_INSTANCE: config.instance, GINI_PORT: String(config.port) }
    });
    runtimeLog.onSpawned(child);
    if (!foreground) child.unref();
    if (foreground) children.runtime = child;
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await isRunning(config)) { healthy = true; break; }
      await Bun.sleep(100);
    }
    if (!healthy) throw new Error("Runtime did not become healthy within 5 seconds.");
    runtimeStarted = true;
  } else {
    // Even if the runtime was already up, refresh the recorded port so
    // status/stop/doctor read the live value.
    const recorded = recordedRuntimePort(config);
    if (recorded !== config.port) {
      writeFileSync(runtimePortPath(config.instance), String(config.port));
    }
  }
  // Web launch runs whether or not the runtime was already up — a user whose
  // web crashed should be able to recover with `gini start` without first stopping.
  let webUrlValue: string | null = null;
  if (!options.noWeb) {
    const existing = await existingWebUrl(config, options.webPort);
    if (existing) {
      webUrlValue = existing;
    } else {
      try {
        const result = await startWeb(config, options);
        webUrlValue = result.webUrl;
        if (foreground) children.web = result.child ?? null;
      } catch (error) {
        return {
          runtimeStarted,
          banner: {
            started: runtimeStarted,
            running: alreadyRunning,
            url: url(config),
            instance: config.instance,
            webError: error instanceof Error ? error.message : String(error)
          },
          children
        };
      }
    }
  }
  const banner: Record<string, unknown> = runtimeStarted
    ? { started: true, url: url(config), instance: config.instance }
    : { running: true, url: url(config), instance: config.instance };
  if (webUrlValue) banner.webUrl = webUrlValue;
  if (foreground) banner.foreground = true;
  return { runtimeStarted, banner, children };
}

/**
 * Returns the live web URL if the recorded pid is both alive AND serving
 * Next.js (via /api/runtime/__healthz). Cleans up stale pidfiles when the
 * process is gone or hung. Returns null when nothing usable is running.
 *
 * Probe order:
 *   1. The persisted `web.port` recorded at startup (always correct when present).
 *   2. The caller-supplied `webPort` and the next 9 candidates (covers the
 *      case where the port file is missing — e.g. pre-upgrade install — but
 *      the user is likely on the default or an explicit --web-port).
 */
export async function existingWebUrl(config: RuntimeConfig, webPort: number): Promise<string | null> {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8"));
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return null;
  }
  const recorded = recordedWebPort(config);
  const candidates: number[] = [];
  if (recorded !== null) candidates.push(recorded);
  for (let candidate = webPort; candidate < webPort + 10; candidate += 1) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const candidateUrl = `http://127.0.0.1:${candidate}`;
    try {
      const response = await fetch(`${candidateUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (!response.ok) continue;
      const body = (await response.json().catch(() => null)) as { ok?: boolean; service?: string; instance?: string } | null;
      // Instance match is required: the healthz route returns the instance the web
      // process was spawned for. Without this check, a different instance's web
      // (or a stray Gini web from a previous session) is treated as healthy
      // for THIS instance — which leads to "running" banners that point at the
      // wrong runtime.
      if (body && body.ok === true && body.service === "gini-web" && body.instance === config.instance) {
        return candidateUrl;
      }
    } catch { /* try next port */ }
  }
  // Pid is alive but nothing healthy on the expected ports — treat as stale.
  rmSync(path, { force: true });
  rmSync(webPortPath(config.instance), { force: true });
  return null;
}

export async function startWeb(config: RuntimeConfig, options: WebOptions): Promise<{ webUrl: string; child?: ChildProcess }> {
  const webRoot = join(projectRoot(), "web");
  if (!existsSync(join(webRoot, "package.json"))) {
    throw new Error("Web app not found at web/. Cannot start the Next.js control plane.");
  }
  // Worktrees and fresh clones don't have web/node_modules. Auto-install once
  // so `gini run` / `gini start` works without a separate manual step. Detected
  // by the presence of next's binary stub; a partial install (lockfile only)
  // also triggers a re-install.
  if (!existsSync(join(webRoot, "node_modules", ".bin", "next"))) {
    process.stderr.write("Installing web dependencies (one-time)... \n");
    const result = spawnSync("bun", ["install"], { cwd: webRoot, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error("Failed to install web dependencies. Run `cd web && bun install` manually.");
    }
  }
  // We require the chosen port to be claimable BEFORE spawning. If
  // `availablePort` hands us a free port but a foreign process binds it
  // between then and now, the child will fail to listen and we'll detect that
  // via the healthz probe. We do NOT silently roll up to the next port —
  // foreign-server squatting should fail loudly so the user knows.
  const requestedPort = options.webPort;
  const port = await availablePort(requestedPort);
  if (port !== requestedPort && options.webPortPinned) {
    // User pinned a port (via --web-port or GINI_WEB_PORT); refuse to silently
    // roll forward to a neighbor. They asked for a specific port, so the right
    // behavior is to fail loudly so they can stop the squatter or pick another.
    throw new Error(`Requested web port ${requestedPort} is busy. Stop the other process or pick a different --web-port.`);
  }
  // Always use `bun run dev` for the local control plane. Production builds
  // (`bun run start`) require an explicit prior `bun run build` step, which
  // is hostile to fresh-clone "gini start" workflows: a stale .next/ from a
  // previous checkout will silently serve outdated code. Dev mode compiles
  // on demand and always reflects the current source.
  const command = ["run", "dev", "--", "-p", String(port)];
  // detached: true puts the child in its own process group so we can SIGTERM
  // the entire group on stop (`bun run dev` re-execs into Next.js, leaving an
  // orphaned grandchild if we only kill the recorded pid).
  // Each instance gets its own `.next-<instance>` build dir. Without this, two
  // parallel `next dev` instances in the same web/ refuse to start: Next.js
  // grabs an exclusive lock at `<distDir>/lock`. The dist dir must stay
  // inside the project (Next.js rejects `../`-style paths), so we sanitize
  // and namespace per instance. Standalone `bun run dev` still defaults to
  // `.next` because that env var is unset.
  const instanceSlug = config.instance.replace(/[^a-zA-Z0-9_-]/g, "_");
  const foreground = options.foreground === true;
  // Foreground: keep the web child attached and tee dev-server stdio to both
  // the user's terminal and web.log. Daemon (gini start) keeps the historic
  // detached group but writes stdio into web.log via an FD so the dev-server
  // output is recoverable after the CLI exits.
  const webLog = setupChildLog(config.instance, "web.log", foreground);
  const child = spawn("bun", command, {
    cwd: webRoot,
    detached: !foreground,
    stdio: webLog.stdio,
    env: {
      ...process.env,
      GINI_RUNTIME_URL: url(config),
      GINI_TOKEN: config.token,
      GINI_INSTANCE: config.instance,
      GINI_DIST_DIR: `.next-${instanceSlug}`,
      PORT: String(port)
    }
  });
  webLog.onSpawned(child);
  if (!foreground) child.unref();
  if (typeof child.pid === "number") {
    writeFileSync(join(config.stateRoot, "web.pid"), String(child.pid));
  }
  // Persist the actual port so status/stop/doctor and `existingWebUrl` find
  // it without having to scan a port range. Cleared on stop and on stale-pid
  // detection above.
  writeFileSync(webPortPath(config.instance), String(port));
  const webUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForWebHealthz(webUrl, child.pid, config.instance);
    return foreground ? { webUrl, child } : { webUrl };
  } catch (error) {
    // Kill the child group so we don't leak processes on failure. In foreground
    // mode there is no separate group (we did not pass detached), so signal
    // the child pid directly.
    if (typeof child.pid === "number") {
      try {
        if (foreground) process.kill(child.pid, "SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* ignore */ }
    }
    rmSync(join(config.stateRoot, "web.pid"), { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    throw error;
  }
}

/**
 * Probes /api/runtime/__healthz on the spawned Next.js child.
 *
 * Why this is non-trivial:
 *  - HEAD `/` returns success against ANY HTTP server (Python's http.server, a
 *    random Bun.serve, etc), so any port-squatter satisfies it. False positive.
 *  - `availablePort` only checks IPv4 127.0.0.1 binding, but Next.js dual-
 *    stacks; a port that succeeds on net.createServer can still collide with
 *    something listening on ::.
 *
 * The healthz route returns a marker JSON identifying the runtime+instance. We
 * verify both that we get the marker AND that the spawned child PID is still
 * alive — that combination tells us "the server we spawned is the one
 * answering on this port".
 */
export async function waitForWebHealthz(webUrl: string, childPid: number | undefined, expectedInstance: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let sawInstanceMismatch = false;
  while (Date.now() < deadline) {
    if (childPid !== undefined && !processAlive(childPid)) {
      throw new Error(`Next.js process exited before becoming healthy. webUrl=${webUrl}`);
    }
    try {
      const response = await fetch(`${webUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { ok?: boolean; service?: string; instance?: string } | null;
        if (body && body.ok === true && body.service === "gini-web") {
          // Instance must match the instance we spawned the child with. Mismatch means
          // we're talking to a different Gini web (different instance on the same
          // port — e.g. user has instance A's web running and started instance B that
          // bound to a port we then probed). Reject and keep waiting in case
          // the spawned child is still coming up.
          if (body.instance === expectedInstance) return;
          sawInstanceMismatch = true;
        }
      }
    } catch { /* keep waiting */ }
    await Bun.sleep(250);
  }
  if (sawInstanceMismatch) {
    throw new Error(`Next.js healthz on ${webUrl} reports a different instance than expected (${expectedInstance}). Another Gini web is using this port.`);
  }
  throw new Error(`Next.js did not become healthy within 30s on ${webUrl}.`);
}

export async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port found from ${preferred} to ${preferred + 99}.`);
}

function canListen(port: number): Promise<boolean> {
  // Probe every host we (or downstream Next.js) might bind to. Wildcard
  // probes alone are insufficient on macOS: binding 0.0.0.0:N succeeds even
  // when 127.0.0.1:N is already taken (different addresses, kernel doesn't
  // refuse). We probe 127.0.0.1 (where the Bun runtime listens), ::1 (IPv6
  // loopback), AND 0.0.0.0 (dual-stack squatters like Next.js). If any one
  // fails, the port is unusable and we walk to the next.
  return Promise.all([
    probe(port, "127.0.0.1"),
    probe(port, "::1"),
    probe(port, "0.0.0.0")
  ]).then((results) => results.every(Boolean));
}

function probe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, host);
  });
}

export function stopRuntime(config: RuntimeConfig) {
  const webResult = stopWeb(config);
  const path = pidPath(config.instance);
  if (!existsSync(path)) {
    // Clean up any orphaned port file even when there's no pidfile — keeps
    // the instance root tidy across upgrades and aborted starts.
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: false, reason: "No pid file", instance: config.instance, web: webResult };
  }
  const pid = Number(readFileSync(path, "utf8"));
  // Process already dead → stale pidfile, treat as a successful stop. The
  // user just wanted "make sure it's not running"; surfacing an error here
  // makes them re-run stop or rm the pidfile by hand.
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: true, pid, reason: "process already dead", instance: config.instance, web: webResult };
  }
  try {
    process.kill(pid, "SIGTERM");
    rmSync(path, { force: true });
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: true, pid, instance: config.instance, web: webResult };
  } catch (error) {
    return { stopped: false, pid, error: error instanceof Error ? error.message : String(error), web: webResult };
  }
}

function stopWeb(config: RuntimeConfig): { stopped: boolean; pid?: number; reason?: string } {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) {
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: false, reason: "No web pid" };
  }
  const pid = Number(readFileSync(path, "utf8"));
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: true, pid, reason: "process already dead" };
  }
  let groupKilled = false;
  // The web pid is the group leader (we spawned with detached: true). Killing
  // the group with -pid reaches every descendant: bun run -> next dev -> the
  // actual server process. Falling back to a plain kill keeps us robust if the
  // platform somehow rejects the group signal.
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* fall through */ }
  }
  try {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: true, pid, ...(groupKilled ? { reason: "group SIGTERM" } : {}) };
  } catch (error) {
    return { stopped: false, pid, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function isRunning(config: RuntimeConfig): Promise<boolean> {
  try {
    const response = await fetch(`${url(config)}/api/status`, { headers: auth(config) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function remoteOrLocalStatus(config: RuntimeConfig, options: WebOptions) {
  // R2-m1: include the web URL/health alongside the runtime status so a single
  // `gini status` invocation tells the user where the UI is. We probe via the
  // healthz route (rather than just trusting the pidfile) because that's the
  // only signal that distinguishes "Next.js really running" from "stale pid".
  const webUrl = await existingWebUrl(config, options.webPort);
  try {
    const remote = await api(config, "/api/status");
    return { ...remote, web: { running: Boolean(webUrl), url: webUrl } };
  } catch {
    return { ...status(config), ok: false, running: false, web: { running: Boolean(webUrl), url: webUrl } };
  }
}

export async function doctor(config: RuntimeConfig, options: WebOptions) {
  const running = await isRunning(config);
  const state = readState(config.instance);
  const webPidFile = join(config.stateRoot, "web.pid");
  const webPid = existsSync(webPidFile) ? Number(readFileSync(webPidFile, "utf8")) : undefined;
  const webPidAlive = webPid ? processAlive(webPid) : false;
  const webHealthyUrl = webPidAlive ? await existingWebUrl(config, options.webPort) : null;
  const recommendations: string[] = [];
  if (!running) recommendations.push("Run `bun run gini start` to launch the local runtime.");
  if (running && !webHealthyUrl && !options.noWeb) recommendations.push("Next.js control plane not healthy — re-run `gini start` to relaunch.");
  // Probe the per-instance SQLite memory store. Phase 1 surfaces row counts so a
  // user (or `gini doctor` consumer) can confirm the schema is in place; phases
  // 2+ will add retain/recall metrics on top of the same probe.
  const memory = probeMemoryDb(config.instance);
  // Phase 6: legacy MemoryRecord migration progress. Surfaced in doctor so a
  // user can verify that all eligible rows have been migrated into the
  // SQLite store before the legacy panel hides itself in the web UI.
  const legacyMigration = legacyMigrationStatus(state.memories);
  if (legacyMigration.pending > 0) {
    recommendations.push(`${legacyMigration.pending} legacy memory rows are not yet migrated. Run \`gini memory migrate\`.`);
  }
  // Embedding-provider snapshot. Surfaces the active provider/model + cache
  // size, and warns if any active unit is embedded with a model other than
  // the current provider's model (recall's semantic channel skips those).
  const embedding = embeddingStatus(config);
  const mismatches = listBanksWithModelMismatch(config);
  if (mismatches.length > 0) {
    const banks = [...new Set(mismatches.map((m) => m.bankId))].join(", ");
    recommendations.push(
      `Some banks (${banks}) have units embedded with a different model than the active provider (${embedding.provider.model}). Run \`gini embedding reembed --bank <id>\` to refresh.`
    );
  }
  // Cross-encoder reranker snapshot. Surfaces the active provider/model and
  // the top-N. Default is local; smoke pins echo. The reranker shares the
  // ~/.gini/models cache with embeddings, so size is reported on the same dir.
  const reranker = rerankerStatus(config);
  return {
    ok: true,
    bun: Bun.version,
    instance: config.instance,
    running,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    port: config.port,
    // Surface instance defaults vs. the actual recorded port so users can see
    // when a port walk happened (e.g. another instance already grabbed the
    // default). `recorded` is null when nothing has been started for this instance.
    ports: {
      runtime: {
        default: defaultRuntimePort(config.instance),
        configured: config.port,
        recorded: recordedRuntimePort(config)
      },
      web: {
        default: defaultWebPort(config.instance),
        configured: options.webPort,
        recorded: recordedWebPort(config)
      }
    },
    web: { running: webPidAlive, pid: webPid ?? null, url: webHealthyUrl },
    tokenConfigured: Boolean(config.token),
    provider: providerHealth(config),
    tasks: state.tasks.length,
    pendingApprovals: state.approvals.filter((item) => item.status === "pending").length,
    memory,
    legacyMigration,
    embedding,
    reranker,
    recommendations
  };
}

export async function waitForTask(config: RuntimeConfig, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = await api(config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval"].includes(detail.task.status)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}
