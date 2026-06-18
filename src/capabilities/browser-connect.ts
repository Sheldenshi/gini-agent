// Headed-browser connect/disconnect capability. The runtime exposes three
// HTTP routes that delegate to the functions in this module:
//
//   GET  /api/browser                 -> getBrowserConnection
//   POST /api/browser/connect         -> connectBrowser
//   POST /api/browser/disconnect      -> disconnectBrowser
//
// Transport (see issue #420): the runtime drives a SINGLE spawned per-instance
// Chrome (src/tools/browser.ts). There is no managed-window or cdp-attach
// transport and no state.browser record — the spawned Chrome is the agent's
// browser at all times.
//
// Profile persistence shape:
//
// The agent ALWAYS drives the same per-instance profile directory at
// ~/.gini/instances/<inst>/chrome-profile/. Sign-ins land in that dir and
// survive across runtime restarts, Chrome process restarts, and idle teardown.
// The only way to lose them is to manually rm -rf the profile dir.
//
// Sign-in happens in-place: the `browser.connect` SetupRequest opens an in-chat
// screencast of the already-running headless spawned Chrome (over its CDP debug
// port). The user signs in through the modal; cookies land in the shared
// profile, so there is nothing to relaunch and no record to persist.
//
// The shape returned by the GET/POST handlers is `{ connected: boolean }` so the
// CLI / webapp can render a uniform status card.

import { mkdirSync } from "node:fs";
import { addAudit, mutateState } from "../state";
import { chromeProfileDirFor, disconnectSharedBrowser } from "../tools/browser";
import type { RuntimeConfig } from "../types";

type Status = {
  connected: boolean;
};

// GET /api/browser status. The spawned Chrome carries no state record, so this
// reports a stable disconnected/false shape: there is no long-lived "managed
// window" the user explicitly connected. The agent's headless Chrome is an
// internal implementation detail launched on demand, not a connection the user
// toggles, so `connected: false` is the truthful state for this endpoint.
export function getBrowserConnection(_config: RuntimeConfig): Status {
  return { connected: false };
}

// PUBLIC input shape — accepted directly from authenticated callers (HTTP
// POST /api/browser/connect body, CLI). The spawn-only transport takes no
// connection parameters (no cdpUrl, no managed-window toggle); the body is
// ignored and connect/disconnect are no-ops that report the stable status.
// Kept as a named type so the HTTP route and callers stay typed.
export interface ConnectInput {
  // Reserved for forward-compatibility with a future remote provider. The
  // spawn-only transport ignores every field.
  mode?: "managed";
  headless?: boolean;
}

// INTERNAL options — never plumbed from network input. Lives as a separate
// argument to `connectBrowser` so it can't be smuggled in through the POST
// body. Retained for the in-process tool-dispatch caller's contract; the
// spawn-only transport ignores it.
interface InternalConnectOptions {
  skipAudit?: boolean;
}

// Idempotent connect. The runtime always drives a single spawned Chrome, so
// there is nothing to launch or attach here — the next browser_* tool call
// lazily spawns the per-instance Chrome via ensureShared(). This stays as a
// thin acknowledgement so the HTTP route and CLI keep a stable contract.
export async function connectBrowser(
  _config: RuntimeConfig,
  _input: ConnectInput = {},
  _internal: InternalConnectOptions = {}
): Promise<Status> {
  return { connected: false };
}

// Thin alias kept for back-compat with the test helpers. The spawned launch
// uses this per-instance profile dir; ensuring it exists here keeps the first
// tool-call launch from racing directory creation.
function profileDirFor(config: RuntimeConfig): string {
  return chromeProfileDirFor(config.instance);
}

export async function disconnectBrowser(_config: RuntimeConfig): Promise<Status> {
  // Drop the in-process spawned handle. The next browser_* tool call relaunches
  // the SAME per-instance profile dir, so the user's sign-ins remain accessible.
  // The on-disk profile is untouched.
  await disconnectSharedBrowser();
  return { connected: false };
}

// Drives the user-side completion of a `browser.connect` SetupRequest's
// non-screencast path. Sign-in normally happens in-place via the screencast
// bridge (handled directly in the /complete HTTP route), so this is the
// degenerate fallback: the user has finished acting in the agent's spawned
// Chrome and cookies are already in the shared profile — there is nothing to
// relaunch. We write the rich `browser.connect` audit row carrying the
// originating setup id and user-facing reason and return the JSON tool-result
// string the chat-task loop expects.
export async function completeBrowserConnectSetup(
  config: RuntimeConfig,
  setup: {
    id: string;
    target: string;
    taskId?: string;
    agentId?: string;
    payload: Record<string, unknown>;
  }
): Promise<{ ok: boolean; result: string }> {
  const result = JSON.stringify({ success: true, connected: true, mode: "spawned" });
  const reasonTarget = typeof setup.payload.reason === "string" && setup.payload.reason.length > 0
    ? setup.payload.reason
    : setup.target;
  await mutateState(config.instance, (state) => {
    addAudit(
      state,
      {
        actor: "user",
        action: "browser.connect",
        target: reasonTarget,
        risk: "medium",
        taskId: setup.taskId,
        runId: setup.taskId ? state.tasks.find((task) => task.id === setup.taskId)?.runId : undefined,
        approvalId: setup.id,
        evidence: { success: true, mode: "spawned" }
      },
      setupAuditContext(setup)
    );
  });
  return { ok: true, result };
}

// Inlined here (rather than importing approvalAgentContext from src/agent.ts)
// because capabilities/* must not depend on agent.ts — that would create a
// cycle. Matches approvalAgentContext: prefer task scope, then agent scope,
// then system.
function setupAuditContext(setup: {
  taskId?: string;
  agentId?: string;
}): { taskId: string } | { agentId: string } | { system: true } {
  if (setup.taskId) return { taskId: setup.taskId };
  if (setup.agentId) return { agentId: setup.agentId };
  return { system: true };
}

// Internal helpers exported only for unit tests.
export const __test = {
  profileDirFor,
  // Verifying the existsSync side effect of mkdirSync in tests would
  // require touching the real filesystem; the helper makes that observable.
  ensureProfileDir(config: RuntimeConfig): string {
    const dir = profileDirFor(config);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
};
