// The `gmail-delta` pre-run hook (ADR job-pre-run-hooks.md, ADR email-watch.md).
//
// This is the email-watch feature's consumer of the pre-run hook primitive. It
// runs the hardened delta engine (processWatcher) for ONE watcher and maps the
// outcome onto the typed hook result:
//   - 0 collected prompts (seeding / all-seen / nothing new) => shortCircuit
//     ("[SILENT]") => the run finalizes with NO model turn.
//   - 1+ collected prompts => context(items) => the drafting turn runs with the
//     fenced matches injected (each prompt is already JSON+nonce-fenced by the
//     engine, so the item is untrusted:false and the runner doesn't re-wrap it).
//
// This is email-domain code that REGISTERS into the generic hooks primitive (see
// the registerHook call at the bottom). It imports only the primitive's TYPES
// (type-only, erased) + registerHook; it never imports the runner or any other
// hooks internals.
//
// Error policy is deliberate: a gws/transport failure stamps the WATCHER status
// `error` (with a scrubbed lastError) and returns shortCircuit so the backing
// JOB stays active and retries next tick — a hook `error` would flip
// job.status="failed" and stop scheduling. The hook's `error` kind is reserved
// for broken config (missing/unknown watcher) where a draft is meaningless.

import { appendLog, getEmailWatcher, now, updateEmailWatcher } from "../state";
import { gwsSessionStatus, type GwsSessionStatus } from "./connectors/gws-session";
import {
  defaultGwsSpawn,
  processWatcher,
  resolveSelfEmail,
  sanitizeWatcherError,
  type GwsSpawn
} from "./gmail-poll-worker";
import type { HookContext, HookResult } from "../hooks/types";
import { registerHook } from "../hooks/registry";

// Injectable subprocess + session boundaries, mirroring the old worker's deps
// bag. Production leaves these unset and the handler shells `gws`; unit tests
// stub them so no child process or model turn runs.
export interface GmailDeltaDeps {
  gwsSpawn?: GwsSpawn;
  sessionStatus?: () => Promise<GwsSessionStatus>;
  resolveSelfEmail?: () => Promise<string | undefined>;
}

export async function gmailDeltaHandler(
  ctx: HookContext,
  deps: GmailDeltaDeps = {}
): Promise<HookResult> {
  const { config, hookConfig } = ctx;
  const gwsSpawn = deps.gwsSpawn ?? defaultGwsSpawn;

  const watcherId = typeof hookConfig.watcherId === "string" ? hookConfig.watcherId : undefined;
  if (!watcherId) return { kind: "error", message: "gmail-delta: missing watcherId in hook config" };

  const watcher = getEmailWatcher(config, watcherId);
  if (!watcher) return { kind: "error", message: `gmail-delta: watcher not found: ${watcherId}` };
  // A disabled watcher's backing job is paused, but a paused-but-claimed race
  // (or a hand-edited job) could still reach here — self-guard with a
  // short-circuit so no turn fires.
  if (!watcher.enabled) return { kind: "shortCircuit", summary: "[SILENT]" };

  // Signed-out handling (mirrors the removed runGmailPollTick): flip enabled
  // watchers to needs_auth and skip. NEVER surface as a hook error — a failed
  // job stops scheduling, but the watcher must keep polling so it recovers the
  // moment the user re-auths.
  const status = await (deps.sessionStatus ?? gwsSessionStatus)();
  if (!status.signedIn) {
    if (watcher.status !== "needs_auth") {
      await updateEmailWatcher(config, watcherId, { status: "needs_auth" });
    }
    return { kind: "shortCircuit", summary: "[SILENT]" };
  }

  try {
    const selfEmail = await (deps.resolveSelfEmail ?? (() => resolveSelfEmail(gwsSpawn)))();
    const { prompts, commit } = await processWatcher(config, watcher, gwsSpawn, selfEmail);
    if (prompts.length === 0) return { kind: "shortCircuit", summary: "[SILENT]" };
    // The engine already JSON+nonce-fences each prompt, so the scheduler must
    // not double-fence — untrusted:false passes it through verbatim. The engine's
    // commit thunk (present only for to-be-drafted matches) defers markSeen +
    // cursor-advance until AFTER the drafting turn dispatches, so a dispatch
    // failure re-triggers the matches next tick (at-least-once).
    return {
      kind: "context",
      items: prompts.map((text) => ({ text, untrusted: false })),
      ...(commit ? { onDispatched: commit } : {})
    };
  } catch (error) {
    // Per-watcher error isolation: stamp the watcher `error` (visible in the
    // typed surface) but short-circuit so the JOB stays active and retries.
    const message = sanitizeWatcherError(error);
    appendLog(config.instance, "email.watch.error", { watcherId, error: message });
    await updateEmailWatcher(config, watcherId, {
      status: "error",
      lastError: message,
      lastPolledAt: now()
    });
    return { kind: "shortCircuit", summary: "[SILENT]" };
  }
}

// Self-register into the trusted hooks registry as a load side-effect. The
// optional `deps` arg defaults, so gmailDeltaHandler satisfies HookHandler's
// 1-arg signature. Reached at composition time via src/hooks/builtins.ts.
registerHook("gmail-delta", gmailDeltaHandler);
