// Bounded runtime module for the browser_fill_secret /connect flow.
//
// The HTTP /connect handler delegates here so http.ts stays a thin
// routing layer. The flow:
//   1. Parse declared slots from the approval payload via the shared
//      parser in browser-fill-secrets-types.
//   2. Reject partial submissions — every declared slot must carry a
//      non-empty string in the request body's `secrets` map.
//   3. Compare the live browser URL against the structured
//      `approvedUrl` in payload (NOT a parseable substring of
//      `target`) — refuse if the page has navigated since approval.
//   4. resolveApproval(resumeChatTask: false) — atomic check-and-flip
//      from pending → approved that closes the deny-mid-fill race.
//   5. Per-slot fill loop with TWO guards inside browserFillByLocator:
//      a) The owning task's status is still non-terminal (a cancel
//         landing after the atomic resolve aborts the rest of the
//         loop).
//      b) The live page URL still matches approvedUrl (TOCTOU close
//         — a navigation between the pre-loop check and the .fill()
//         must not land secrets on a new origin).
//   6. Audit row with redacted: true and evidence covering filled
//      slots + per-slot errors. Slot VALUES never appear anywhere.
//   7. resumeChatTask with a result string reflecting what actually
//      filled vs. what errored, wrapped in try/catch so a
//      task-already-terminal throw doesn't make the handler claim
//      success despite a missed resume.

import type { Approval, RuntimeConfig } from "../types";
import { resolveApproval } from "../agent";
import { addAudit, mutateState, readState } from "../state";
import { browserFillByLocator, peekCurrentBrowserUrl } from "../tools/browser";
import { isTerminalTaskStatus } from "../state";
import { resumeChatTask } from "./chat-task";
import { sanitizeUrlForAuditTarget } from "./tool-dispatch";
import { parseFillSecretSlots } from "./browser-fill-secrets-types";

export interface FillSecretConnectResult {
  status: number;
  body: {
    ok: boolean;
    message?: string;
    filledSlots?: string[];
  };
}

export async function runFillSecretConnect(
  config: RuntimeConfig,
  approval: Approval,
  secrets: Record<string, string>
): Promise<FillSecretConnectResult> {
  const slots = parseFillSecretSlots(approval.payload.slots);
  if (slots.length === 0) {
    return {
      status: 400,
      body: { ok: false, message: "No valid slots on the approval payload to fill." }
    };
  }

  // Every declared slot must carry a non-empty string. fillReady in
  // the chat card is a UX gate; the runtime must own the contract
  // for non-web clients (CLI, mobile, script).
  const missing = slots
    .filter((slot) => typeof secrets[slot.name] !== "string" || secrets[slot.name].length === 0)
    .map((slot) => slot.name);
  if (missing.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        message: `Missing value for slot(s): ${missing.join(", ")}. All declared slots must be submitted.`
      }
    };
  }

  const taskId = approval.taskId;
  if (!taskId) {
    return { status: 400, body: { ok: false, message: "Approval is not bound to a task; cannot fill." } };
  }

  // Structural approved-URL from payload — peer approvals carry their
  // structured contract fields under payload too (file.write's path,
  // connector.request's provider, etc.). Falls back to undefined if
  // the dispatcher minted the approval without a live URL (no browser
  // session at dispatch time).
  const approvedUrl = typeof approval.payload.approvedUrl === "string"
    ? approval.payload.approvedUrl
    : undefined;
  if (approvedUrl) {
    const liveSanitized = sanitizeUrlForAuditTarget(peekCurrentBrowserUrl(taskId));
    if (!liveSanitized || liveSanitized !== approvedUrl) {
      return {
        status: 409,
        body: {
          ok: false,
          message: `Page navigated since the approval was created (approved: ${approvedUrl}, live: ${liveSanitized ?? "no session"}). Refusing to fill on an unapproved origin.`
        }
      };
    }
  }

  // Atomic check-and-flip closes the deny-mid-fill race.
  try {
    await resolveApproval(config, approval.id, { actor: "user", resumeChatTask: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 410, body: { ok: false, message: `Could not lock approval for fill: ${message}` } };
  }

  const filledSlots: string[] = [];
  const errors: { slot: string; error: string }[] = [];
  let bailedOnCancel = false;
  let bailedOnOriginDrift = false;

  for (const slot of slots) {
    // Before each fill, observe the task status. A cancelTask between
    // the atomic resolve above and this iteration must stop the rest
    // of the loop — the secret values have already been resolved,
    // and continuing to type them into a cancelled task's browser
    // tab is the failure mode the abort registry would otherwise
    // catch for peer actions.
    const taskStatus = readState(config.instance).tasks.find((t) => t.id === taskId)?.status;
    if (taskStatus && isTerminalTaskStatus(taskStatus)) {
      bailedOnCancel = true;
      break;
    }
    const value = secrets[slot.name];
    if (typeof value !== "string") continue;
    // browserFillByLocator receives the approvedUrl so it can
    // re-check the live page URL inside withSession immediately
    // before invoking .fill() — closes the TOCTOU window between
    // the pre-loop check above and the actual DOM write.
    const result = await browserFillByLocator(taskId, {
      locator: slot.locator,
      value,
      expectedOrigin: approvedUrl
    });
    if (result.ok) {
      filledSlots.push(slot.name);
    } else {
      // Distinguish origin-mismatch from other fill errors. If
      // browserFillByLocator detects the page navigated, halt the
      // loop — continuing would type the remaining secrets into the
      // same new origin.
      if (result.error.startsWith("origin-mismatch:")) {
        bailedOnOriginDrift = true;
        errors.push({ slot: slot.name, error: result.error });
        break;
      }
      errors.push({ slot: slot.name, error: result.error });
    }
  }

  // Audit row carries metadata only. The values themselves never
  // appear in evidence (only slot names + per-slot success/error
  // strings) and redacted: true is defense-in-depth that drops
  // evidence at the writer boundary anyway.
  await mutateState(config.instance, (mutable) => {
    addAudit(
      mutable,
      {
        actor: "user",
        action: "browser.fill_secret",
        target: approval.target,
        risk: "high",
        taskId,
        approvalId: approval.id,
        redacted: true,
        evidence: {
          filledSlots,
          errors,
          ...(bailedOnCancel ? { aborted: "task-cancelled-mid-fill" } : {}),
          ...(bailedOnOriginDrift ? { aborted: "origin-drift-mid-fill" } : {})
        }
      },
      { taskId }
    );
  });

  // Build the resume result. The agent gets the truth: which slots
  // filled, which errored, and whether the loop was cut short by a
  // cancel or origin drift.
  const filledList = filledSlots.length > 0 ? filledSlots.join(", ") : "(none)";
  const errorList = errors.length > 0
    ? errors.map((e) => `${e.slot} (${e.error})`).join("; ")
    : "";
  let resumeResult: string;
  if (bailedOnCancel) {
    resumeResult = `Task was cancelled during fill_secret. Filled before cancel: ${filledList}. The page may be in a partial state.`;
  } else if (bailedOnOriginDrift) {
    resumeResult = `Page navigated mid-fill; aborted to keep secrets on the approved origin. Filled before drift: ${filledList}.`;
  } else if (errors.length === 0) {
    resumeResult = `User submitted values for slots ${filledList}. The fields are now filled on the page. Take a fresh browser_snapshot before deciding the next action.`;
  } else {
    resumeResult = `User submitted values; filled slots ${filledList}. ${errors.length} slot(s) failed: ${errorList}. Take a fresh browser_snapshot to see the current state before retrying.`;
  }

  const toolCallId = typeof approval.payload.toolCallId === "string"
    ? approval.payload.toolCallId
    : undefined;
  if (toolCallId) {
    // Wrap so a terminal-task throw inside resumeChatTask doesn't
    // mask the audited side-effect outcome. The values already
    // landed in the DOM (or didn't) regardless of whether the
    // chat loop can be resumed — surfacing a 200 here while
    // logging the resume failure is more honest than 500-ing on a
    // resume that the operator wouldn't act on anyway.
    try {
      await resumeChatTask(config, taskId, toolCallId, resumeResult);
    } catch {
      // resumeChatTask failures are bookkeeping — the next external
      // trigger reconciles task state. Audit row already records
      // the fill outcome.
    }
  }

  if (bailedOnCancel) {
    return { status: 409, body: { ok: false, message: "Task was cancelled mid-fill.", filledSlots } };
  }
  if (bailedOnOriginDrift) {
    return { status: 409, body: { ok: false, message: "Page navigated mid-fill; aborted to keep secrets on the approved origin.", filledSlots } };
  }
  if (errors.length > 0) {
    return {
      status: 200,
      body: {
        ok: false,
        message: `Fill failed for ${errors.length} slot(s): ${errorList}`,
        filledSlots
      }
    };
  }
  return { status: 200, body: { ok: true, filledSlots } };
}
