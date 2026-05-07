// Lifecycle helpers: start/stop the runtime + Next.js web, doctor, status.
//
// These were previously inline in src/cli.ts. They depend on a few runtime
// flags (the resolved web port and whether the user pinned a port or
// suppressed the web launch). Those flags are passed via WebOptions rather
// than read from module scope, which keeps each helper testable in
// isolation.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { install, status } from "../domain/runtime";
import { providerHealth } from "../provider";
import { readState } from "../state";
import { probeMemoryDb } from "../state/memory-db";
import { legacyMigrationStatus } from "../domain/memory";
import { pidPath, projectRoot } from "../paths";
import { api, auth, url } from "./api";

export interface WebOptions {
  webPort: number;
  webPortPinned: boolean;
  noWeb: boolean;
}

export async function start(config: RuntimeConfig, options: WebOptions): Promise<{ runtimeStarted: boolean; banner: Record<string, unknown> }> {
  const alreadyRunning = await isRunning(config);
  let runtimeStarted = false;
  if (!alreadyRunning) {
    install(config);
    config.port = await availablePort(config.port);
    install(config);
    const child = spawn(process.execPath, ["run", "src/server.ts", "--lane", config.lane], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, GINI_LANE: config.lane, GINI_PORT: String(config.port) }
    });
    child.unref();
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await isRunning(config)) { healthy = true; break; }
      await Bun.sleep(100);
    }
    if (!healthy) throw new Error("Runtime did not become healthy within 5 seconds.");
    runtimeStarted = true;
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
      } catch (error) {
        return {
          runtimeStarted,
          banner: {
            started: runtimeStarted,
            running: alreadyRunning,
            url: url(config),
            lane: config.lane,
            webError: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
  }
  const banner: Record<string, unknown> = runtimeStarted
    ? { started: true, url: url(config), lane: config.lane }
    : { running: true, url: url(config), lane: config.lane };
  if (webUrlValue) banner.webUrl = webUrlValue;
  return { runtimeStarted, banner };
}

/**
 * Returns the live web URL if the recorded pid is both alive AND serving
 * Next.js (via /api/runtime/__healthz). Cleans up stale pidfiles when the
 * process is gone or hung. Returns null when nothing usable is running.
 *
 * We can't reconstruct the URL purely from the pidfile (port isn't recorded),
 * so we probe `webPort` and the next 99 ports. Cheap and covers the common
 * case where the user used the default or an explicit --web-port.
 */
export async function existingWebUrl(config: RuntimeConfig, webPort: number): Promise<string | null> {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8"));
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    return null;
  }
  for (let candidate = webPort; candidate < webPort + 100; candidate += 1) {
    const candidateUrl = `http://127.0.0.1:${candidate}`;
    try {
      const response = await fetch(`${candidateUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (!response.ok) continue;
      const body = (await response.json().catch(() => null)) as { ok?: boolean; service?: string; lane?: string } | null;
      // Lane match is required: the healthz route returns the lane the web
      // process was spawned for. Without this check, a different lane's web
      // (or a stray Gini web from a previous session) is treated as healthy
      // for THIS lane — which leads to "running" banners that point at the
      // wrong runtime.
      if (body && body.ok === true && body.service === "gini-web" && body.lane === config.lane) {
        return candidateUrl;
      }
    } catch { /* try next port */ }
  }
  // Pid is alive but nothing healthy on the expected ports — treat as stale.
  rmSync(path, { force: true });
  return null;
}

export async function startWeb(config: RuntimeConfig, options: WebOptions): Promise<{ webUrl: string }> {
  const webRoot = join(projectRoot(), "web");
  if (!existsSync(join(webRoot, "package.json"))) {
    throw new Error("Web app not found at web/. Cannot start the Next.js control plane.");
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
  const child = spawn("bun", command, {
    cwd: webRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GINI_RUNTIME_URL: url(config),
      GINI_TOKEN: config.token,
      GINI_LANE: config.lane,
      PORT: String(port)
    }
  });
  child.unref();
  if (typeof child.pid === "number") {
    writeFileSync(join(config.stateRoot, "web.pid"), String(child.pid));
  }
  const webUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForWebHealthz(webUrl, child.pid, config.lane);
    return { webUrl };
  } catch (error) {
    // Kill the child group so we don't leak processes on failure.
    if (typeof child.pid === "number") {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
    }
    rmSync(join(config.stateRoot, "web.pid"), { force: true });
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
 * The healthz route returns a marker JSON identifying the runtime+lane. We
 * verify both that we get the marker AND that the spawned child PID is still
 * alive — that combination tells us "the server we spawned is the one
 * answering on this port".
 */
export async function waitForWebHealthz(webUrl: string, childPid: number | undefined, expectedLane: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let sawLaneMismatch = false;
  while (Date.now() < deadline) {
    if (childPid !== undefined && !processAlive(childPid)) {
      throw new Error(`Next.js process exited before becoming healthy. webUrl=${webUrl}`);
    }
    try {
      const response = await fetch(`${webUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { ok?: boolean; service?: string; lane?: string } | null;
        if (body && body.ok === true && body.service === "gini-web") {
          // Lane must match the lane we spawned the child with. Mismatch means
          // we're talking to a different Gini web (different lane on the same
          // port — e.g. user has lane A's web running and started lane B that
          // bound to a port we then probed). Reject and keep waiting in case
          // the spawned child is still coming up.
          if (body.lane === expectedLane) return;
          sawLaneMismatch = true;
        }
      }
    } catch { /* keep waiting */ }
    await Bun.sleep(250);
  }
  if (sawLaneMismatch) {
    throw new Error(`Next.js healthz on ${webUrl} reports a different lane than expected (${expectedLane}). Another Gini web is using this port.`);
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
  // Probe BOTH "0.0.0.0" (IPv4 wildcard) and "::" (IPv6 wildcard) so we don't
  // hand out a port that a dual-stack squatter (Bun.serve, Next.js itself)
  // can't actually claim. macOS specifically: a single-family bind here
  // succeeds even when the other family is already taken, leading to a false
  // positive and a confusing "process exited before becoming healthy" later.
  return Promise.all([probe(port, "0.0.0.0"), probe(port, "::")]).then(([a, b]) => a && b);
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
  const path = pidPath(config.lane);
  if (!existsSync(path)) {
    return { stopped: false, reason: "No pid file", lane: config.lane, web: webResult };
  }
  const pid = Number(readFileSync(path, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
    rmSync(path, { force: true });
    return { stopped: true, pid, lane: config.lane, web: webResult };
  } catch (error) {
    return { stopped: false, pid, error: error instanceof Error ? error.message : String(error), web: webResult };
  }
}

function stopWeb(config: RuntimeConfig): { stopped: boolean; pid?: number; reason?: string } {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) return { stopped: false, reason: "No web pid" };
  const pid = Number(readFileSync(path, "utf8"));
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
  const state = readState(config.lane);
  const webPidFile = join(config.stateRoot, "web.pid");
  const webPid = existsSync(webPidFile) ? Number(readFileSync(webPidFile, "utf8")) : undefined;
  const webPidAlive = webPid ? processAlive(webPid) : false;
  const webHealthyUrl = webPidAlive ? await existingWebUrl(config, options.webPort) : null;
  const recommendations: string[] = [];
  if (!running) recommendations.push("Run `bun run gini start` to launch the local runtime.");
  if (running && !webHealthyUrl && !options.noWeb) recommendations.push("Next.js control plane not healthy — re-run `gini start` to relaunch.");
  // Probe the per-lane SQLite memory store. Phase 1 surfaces row counts so a
  // user (or `gini doctor` consumer) can confirm the schema is in place; phases
  // 2+ will add retain/recall metrics on top of the same probe.
  const memory = probeMemoryDb(config.lane);
  // Phase 6: legacy MemoryRecord migration progress. Surfaced in doctor so a
  // user can verify that all eligible rows have been migrated into the
  // SQLite store before the legacy panel hides itself in the web UI.
  const legacyMigration = legacyMigrationStatus(state.memories);
  if (legacyMigration.pending > 0) {
    recommendations.push(`${legacyMigration.pending} legacy memory rows are not yet migrated. Run \`gini memory migrate\`.`);
  }
  return {
    ok: true,
    bun: Bun.version,
    lane: config.lane,
    running,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    port: config.port,
    web: { running: webPidAlive, pid: webPid ?? null, url: webHealthyUrl },
    tokenConfigured: Boolean(config.token),
    provider: providerHealth(config),
    tasks: state.tasks.length,
    pendingApprovals: state.approvals.filter((item) => item.status === "pending").length,
    memory,
    legacyMigration,
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
