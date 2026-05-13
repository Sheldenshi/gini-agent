// Post-shutdown autostart-refresh signaling.
//
// Why this exists: the browser /setup flow writes a new OPENAI_API_KEY to
// secrets.env and needs the autostart plist's EnvironmentVariables to be
// re-written so the NEXT launchd respawn (after a crash or reboot) picks
// up the new key. The running gateway already has the key in process.env,
// so the user's session keeps working — this is purely a survive-future-
// respawn concern.
//
// The naive approach (round-3 entry state) was:
//   POST /api/setup/provider → setImmediate → setTimeout(200ms) →
//   spawn detached `gini autostart enable --kind gateway`.
//
// That's a heuristic. `setImmediate` runs in the next I/O tick, and 200ms
// is a hope, not a guarantee. A slow client (or a non-trivial response
// body) can still be mid-read when the detached child issues
// `launchctl bootout` and SIGTERMs the gateway, breaking the user's
// POST mid-response.
//
// The robust fix uses the actual response lifecycle. We hand the work to
// the gateway's SIGTERM handler:
//
//   1. The POST handler writes a marker file
//      `<instanceRoot>/.autostart-refresh-pending` containing the instance
//      name.
//   2. The POST handler signals the gateway via SIGTERM. Bun's
//      `server.stop(true)` drains all in-flight responses — including the
//      one we're answering — BEFORE the SIGTERM handler proceeds to its
//      final actions.
//   3. After drain, the SIGTERM handler consumes the marker: removes it
//      and execs `gini autostart enable --kind gateway` as a detached
//      child. That child's `launchctl bootstrap` re-registers the plist
//      with the new EnvironmentVariables (read from secrets.env at
//      `enable` time).
//   4. process.exit(0). launchctl honors KeepAlive.SuccessfulExit:false →
//      does NOT respawn. The detached child does the bootstrap →
//      launchd spawns a fresh gateway with the new env.
//
// This guarantees the response is fully written and the connection
// closed before any launchctl interaction — shutdown only happens once
// Bun has flushed all in-flight responses.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { projectRoot } from "../paths";
import type { Instance } from "../types";

// Path to the per-instance marker file. We deliberately co-locate with
// other per-instance state under instanceRoot so a state purge cleans it
// up too. We resolve via HOME directly (not src/paths) so test seams that
// override HOME don't fight os.homedir()'s macOS cache.
export function refreshMarkerPath(instance: Instance): string {
  const stateRoot = process.env.GINI_STATE_ROOT
    ? process.env.GINI_STATE_ROOT
    : join(process.env.HOME || homedir(), ".gini");
  return join(stateRoot, "instances", instance, ".autostart-refresh-pending");
}

// In-memory flag: did THIS process call requestAutostartRefresh? If not,
// `consumeAutostartRefresh` MUST NOT spawn the bootstrap subprocess even
// when it finds a marker on disk.
//
// Why this matters: the marker file persists across the SIGTERM → exit
// → next-launchd-spawn boundary. Without an in-process flag, ANY SIGTERM
// — including `gini stop` issued by the user from another terminal — would
// trigger an unwanted respawn. With the flag, only the SIGTERM dispatched
// from inside requestAutostartRefresh leads to a refresh; an unrelated
// SIGTERM cleans up the (stale) marker but does NOT spawn the bootstrap.
//
// This is module-level (process-local) state; it is intentionally NOT
// persisted to disk.
let refreshRequestedInProcess = false;

// Test seam: reset the in-memory flag so unit tests can exercise the
// "marker exists but flag not set" path. Not exported from the public
// API surface — only via __testing below.
function resetRefreshFlag(): void {
  refreshRequestedInProcess = false;
}

// Called from the response handler (POST /api/setup/provider) after the
// new key has been persisted. Writes the marker so the SIGTERM handler
// will pick it up after Bun drains in-flight responses, then signals
// SIGTERM to ourselves so `server.stop(true)` runs.
//
// Returns true when a refresh was requested (marker written + SIGTERM
// dispatched). Returns false on non-darwin or when no gateway plist
// exists on disk for the instance — both signal "no refresh needed".
//
// Tests set GINI_SKIP_PLIST_REFRESH=1 to write the marker without firing
// SIGTERM (so unit tests don't have to mock self-signaling).
export function requestAutostartRefresh(instance: Instance): boolean {
  if (process.platform !== "darwin") return false;
  const home = process.env.HOME || homedir();
  const gatewayPlist = join(home, "Library", "LaunchAgents", `ai.lilac.gini.${instance}.gateway.plist`);
  if (!existsSync(gatewayPlist)) return false;

  const marker = refreshMarkerPath(instance);
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, instance);
  } catch {
    // If we can't write the marker (permission, fs full), abort cleanly.
    // The running gateway still has the new key in process.env — the
    // user's session works. Survival-across-respawn is the only thing
    // lost, and the user can re-run `gini autostart enable` to fix it.
    return false;
  }

  // Flip the in-process flag BEFORE dispatching SIGTERM so the consume
  // path (which runs in the same process) sees the intent regardless of
  // signal-handler ordering.
  refreshRequestedInProcess = true;

  // GINI_SKIP_PLIST_REFRESH=1: tests assert the marker is written without
  // the SIGTERM actually firing (which would kill the test runner). The
  // contract remains observable.
  if (process.env.GINI_SKIP_PLIST_REFRESH === "1") return true;

  // Self-signal SIGTERM. Bun's `server.stop(true)` (called from the
  // SIGTERM handler in src/server.ts) waits for in-flight responses to
  // finish writing before returning. Our response to the POST that
  // triggered this is one of those in-flight responses — so the gateway
  // can't actually exit until our response bytes hit the socket.
  //
  // We dispatch via setImmediate so the current request handler's
  // Response object is fully returned to Bun before the signal lands.
  // (Without that, an edge case where SIGTERM handlers run synchronously
  // could interrupt the handler's return path. With setImmediate, the
  // handler returns first; the SIGTERM enqueues; Bun starts flushing
  // bytes; server.stop(true) waits for that flush.)
  setImmediate(() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      // Best-effort: if signaling fails, the marker is still on disk so
      // a later manual restart will pick up the refresh.
    }
  });
  return true;
}

// Called from the SIGTERM handler in src/server.ts AFTER `server.stop(false)`
// has drained in-flight responses. If a refresh marker exists for this
// instance AND this process is the one that requested the refresh
// (refreshRequestedInProcess === true), remove the marker and exec the
// autostart-refresh child as detached.
//
// If the marker exists but the in-process flag is FALSE, this SIGTERM
// did NOT originate from our /api/setup/provider flow — it came from
// somewhere else (e.g. user ran `gini stop`). In that case we still
// clean up the stale marker (so it doesn't accumulate on disk and fire
// at the next setup POST) but we do NOT spawn the bootstrap. This is
// the round-4 HIGH-2 fix: a `gini stop` issued while a marker was
// sitting around from a prior crash must not respawn the gateway.
//
// Returns true when a refresh was kicked off; false otherwise (no
// marker, non-darwin, or marker present without the in-process flag).
//
// Test seam: `spawnImpl` lets tests inject a recorder instead of the
// real child_process.spawn. Production callers pass nothing and get the
// real spawn.
export interface ConsumeOptions {
  spawnImpl?: typeof spawn;
}

export function consumeAutostartRefresh(instance: Instance, options: ConsumeOptions = {}): boolean {
  if (process.platform !== "darwin") return false;
  const marker = refreshMarkerPath(instance);
  if (!existsSync(marker)) return false;
  // Read first, then remove. If we crash between read and remove, the
  // next startup picks up the marker — at worst we trigger a redundant
  // refresh, never the wrong one.
  let recordedInstance: string;
  try {
    recordedInstance = readFileSync(marker, "utf8").trim();
  } catch {
    return false;
  }
  if (recordedInstance && recordedInstance !== instance) {
    // Marker is for a different instance (shouldn't happen — markers are
    // per-instance — but defensively skip). Leave the file alone so the
    // correct instance handles it.
    return false;
  }

  // Marker is for us. ALWAYS clean it up, regardless of whether we go
  // on to spawn — a stale marker on disk should not survive any
  // shutdown.
  try {
    rmSync(marker, { force: true });
  } catch {
    // Best-effort: if we can't remove, the next startup will redo the
    // refresh. Not the end of the world.
  }

  // Gate: only spawn when THIS process initiated the refresh. An
  // unrelated SIGTERM (`gini stop`, `launchctl bootout`, kill from
  // ops) must NOT trigger a respawn — that would defeat the whole
  // point of stop.
  if (!refreshRequestedInProcess) return false;

  const spawnFn = options.spawnImpl ?? spawn;
  try {
    const child = spawnFn(process.execPath, [
      "run", "gini", "autostart", "enable",
      "--instance", instance,
      "--kind", "gateway"
    ], {
      cwd: projectRoot(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, GINI_INSTANCE: instance }
    });
    if (typeof child.unref === "function") child.unref();
  } catch {
    // Best-effort: if spawn fails the user can re-run autostart enable
    // manually. The marker is already removed.
    return false;
  }
  return true;
}

// Exposed for tests that want to manipulate the marker directly + reset
// the in-process flag between cases.
export const __testing = { refreshMarkerPath, resetRefreshFlag };
