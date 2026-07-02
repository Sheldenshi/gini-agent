// Shared resume-with-recovery helper for /connect-style flows.
//
// Background: after a /connect handler resolves an approval and
// performs its side effect, it must hand the outcome string back to
// the chat-task loop via resumeChatTask. That call flips the task
// status from waiting_approval to running and re-enters the chat
// loop. A throw inside that loop (model provider rate limit,
// dispatch error, downstream tool failure, etc.) leaves the task in
// status="running" with no live executor, no in-flight registry
// entry, and no scheduler to retry — orphaning it.
//
// Both runFillSecretConnect and runMessagingBridgeConnect need the
// same recovery: trace the failure, call failTask to flip the task
// out of the orphan-running state, and swallow any failTask throw
// since it's a best-effort recovery from an already-failed resume.
// This module is the single home for that shape so a future change
// (different trace category, different recovery primitive) lands in
// one place instead of being scattered across each /connect branch.

import type { RuntimeConfig } from "../types";
import { failTask } from "../agent";
import { appendTrace, mutateState } from "../state";
import { resumeChatTask } from "./chat-task";

export interface SafeResumeOptions {
  // Human-readable origin string for the trace message
  // (e.g. "fill_secret", "messaging.add_bridge"). Goes into the
  // trace row's `message` field so operators debugging an orphaned
  // task can tell which /connect branch's resume threw.
  context: string;
  // Approval id the resume was completing. Threaded into trace
  // evidence for join-by-approval reconstruction.
  approvalId: string;
}

// Wrap resumeChatTask in the standard fail-recovery envelope. A
// throw from the chat-task loop traces the failure and triggers
// failTask so the task doesn't sit orphaned in "running". failTask's
// own throw is silently swallowed — the next external trigger
// (user message, supervisor reconcile) will see whatever status
// failTask managed to land and move on.
// Persist the outcome of a /connect-style side effect onto the
// approval row so a future reload of the resolved approval card
// renders the truthful past-tense summary. The React component
// keeps a sticky `setBridgeResultOk` for the in-session render,
// but that state evaporates on reload — without a persisted
// outcome, a failed addMessagingBridge that landed on a row whose
// status was already flipped to "approved" by resolveApproval will
// fall back to rendering as success and lie to the operator.
//
// Best-effort: a swallowed throw here is preferable to failing
// the entire /connect response (the side effect itself already
// happened — the outcome record is just a postscript).
export async function persistConnectOutcome(
  config: RuntimeConfig,
  approvalId: string,
  outcome: { ok: boolean; message?: string }
): Promise<void> {
  try {
    await mutateState(config.instance, (state) => {
      // Messaging connect actions are SetupRequests on the post-merge
      // model, so the outcome record lands on state.setupRequests
      // (the UI reads setup.connectOutcome via useSetupRequests()).
      const setupRequest = state.setupRequests.find((s) => s.id === approvalId);
      if (!setupRequest) return;
      setupRequest.connectOutcome = outcome;
      setupRequest.updatedAt = new Date().toISOString();
    });
  } catch {
    // Outcome persistence is a UI honesty postscript, not load-
    // bearing — swallow rather than failing the response.
  }
}

export async function safeResume(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  result: string,
  opts: SafeResumeOptions
): Promise<void> {
  try {
    await resumeChatTask(config, taskId, toolCallId, result);
  } catch (resumeError) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: `resumeChatTask threw during ${opts.context} completion`,
      data: {
        approvalId: opts.approvalId,
        toolCallId,
        error: resumeError instanceof Error ? resumeError.message : String(resumeError)
      }
    });
    try {
      await failTask(config, taskId, resumeError);
    } catch {
      // Best-effort recovery — leaving the task in whatever status
      // failTask managed to land is preferable to throwing on top of
      // the original failure.
    }
  }
}
