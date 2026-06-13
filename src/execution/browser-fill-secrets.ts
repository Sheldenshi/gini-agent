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
//   4. resolveSetupRequest(complete) — atomic check-and-flip from
//      pending → completed that closes the cancel-mid-fill race.
//   5. Per-slot fill loop with TWO guards at DIFFERENT layers:
//      a) Task-status check INSIDE this loop (readState per
//         iteration BEFORE the browserFillByLocator call): a cancel
//         landing after the atomic resolve makes the next iteration
//         observe terminal status and bail, recording
//         aborted: "task-cancelled-mid-fill".
//      b) URL re-check INSIDE browserFillByLocator (which holds a
//         live withSession lock): the comparison against
//         approvedUrl runs immediately before locator.fill(),
//         TOCTOU-closing the window to one playwright API hop.
//      The split exists because task status needs no playwright
//      session (a state read) while URL needs the live page
//      reference.
//   6. Audit row with redacted: true and evidence covering filled
//      slots + per-slot errors. Slot VALUES never appear anywhere.
//   7. resumeChatTask with a result string reflecting what actually
//      filled vs. what errored, wrapped in try/catch so a
//      task-already-terminal throw doesn't make the handler claim
//      success despite a missed resume.

import type { RuntimeConfig, SetupRequest } from "../types";
import { resolveSetupRequest } from "../agent";
import { addAudit, appendTrace, mutateState, readState } from "../state";
import { FILLED_SECRET_MIN_REDACTION_LENGTH, browserFillByLocator, peekCurrentBrowserUrl } from "../tools/browser";
import { isTerminalTaskStatus } from "../state";
import { parseFillSecretSlots, sanitizeUrlForAuditTarget } from "./browser-fill-secrets-types";
import { safeResume } from "./safe-resume";

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
  approval: SetupRequest,
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
  // Minimum-length floor, scoped to password-kind slots only.
  //
  // FILLED_SECRET_MIN_REDACTION_LENGTH is the redactor's floor:
  // recordFilledSecret (src/tools/browser.ts) refuses to register
  // values shorter than it, because the redactor does literal
  // substring replacement and a short value would shred structural
  // snapshot tokens like [@e1] / @e43. The constant is imported
  // here so the gate and the registry move together if it is ever
  // bumped.
  //
  // The gate is NOT a general input-validation floor. fill_secret
  // also collects identity/PII fields (the tool advertises "account
  // ids"; a real call here asks for date of birth + last name), and
  // those are legitimately short — "Shi", "Ng", "Li", "Wu", "Lee"
  // are valid last names. Blocking them is wrong. A short non-
  // password value fills but is not redaction-registered; that is
  // inherent and acceptable because substring-redacting a sub-floor
  // value is meaningless/harmful regardless, and the field is not a
  // credential.
  //
  // password-kind is the one case where a sub-floor value is both a
  // near-certain typo AND an un-redactable leak risk (the exfil
  // scans in src/tools/browser.ts that catch a registered secret
  // smuggled into a URL / form / dialog all skip values below the
  // floor too). So keep refusing there. An agent that wants a short
  // numeric secret (a PIN) protected should declare kind "password",
  // which also masks it — the correct choice.
  const tooShort = slots
    .filter((slot) => slot.kind === "password" && secrets[slot.name].length < FILLED_SECRET_MIN_REDACTION_LENGTH)
    .map((slot) => slot.name);
  if (tooShort.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        message: `Secret value too short (< ${FILLED_SECRET_MIN_REDACTION_LENGTH} chars): ${tooShort.join(", ")}. Re-enter a longer value.`
      }
    };
  }
  // Belt-and-braces duplicate-name check. The dispatcher's
  // browserFillSecretsTool refuses duplicates up-front, so the
  // approval row is normally minted with unique names — but a
  // state-edit, replay, or any future code path that mints a
  // browser.fill_secret approval without going through the
  // dispatch validator would bypass that gate. Mirror the
  // dispatch check here so /connect's per-slot fill loop never
  // sees duplicates (which would silently fill the same value
  // into two distinct DOM locators).
  const dupeSeen = new Set<string>();
  const dupes: string[] = [];
  for (const slot of slots) {
    if (dupeSeen.has(slot.name)) dupes.push(slot.name);
    else dupeSeen.add(slot.name);
  }
  if (dupes.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        message: `Approval payload has duplicate slot names: ${Array.from(new Set(dupes)).join(", ")}. Refusing to fill.`
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
    && approval.payload.approvedUrl.length > 0
    ? approval.payload.approvedUrl
    : undefined;
  // Refuse if no approved URL was captured. The dispatcher rejects
  // browser_fill_secrets when no browser session exists at
  // approval-creation time, but we belt-and-braces the gate here too
  // so a legacy approval (or any future code path that mints an
  // approval without going through browserFillSecretsTool) can't
  // bypass the origin check.
  if (!approvedUrl) {
    return {
      status: 409,
      body: {
        ok: false,
        message: "Approval has no approved page URL; refusing to fill on an unbound origin."
      }
    };
  }
  const livePageUrl = peekCurrentBrowserUrl(taskId);
  const liveSanitized = sanitizeUrlForAuditTarget(livePageUrl);
  if (!livePageUrl) {
    // The browser session is gone entirely. The most common cause
    // is the idle sweeper (src/tools/browser.ts:IDLE_TIMEOUT_MS,
    // 5 min) closing the session while the user was reading the
    // amber chat card. The "page navigated" message would mislead;
    // tell the operator the session expired so the agent can
    // re-navigate and re-request.
    return {
      status: 409,
      body: {
        ok: false,
        message: `Browser session expired since the approval was created (approved origin: ${approvedUrl}). The agent must browser_navigate back to the page before submitting again.`
      }
    };
  }
  if (!liveSanitized || liveSanitized !== approvedUrl) {
    return {
      status: 409,
      body: {
        ok: false,
        message: `Page navigated since the approval was created (approved: ${approvedUrl}, live: ${liveSanitized ?? "invalid"}). Refusing to fill on an unapproved origin.`
      }
    };
  }

  // Atomic check-and-flip closes the cancel-mid-fill race. Marks the
  // SetupRequest completed BEFORE the per-slot fill loop runs, so a
  // concurrent /cancel can no longer pull the rug out mid-fill. We pass
  // resumeChatTask: false because we own the resume after the fill loop
  // — the result string reflects what actually filled vs errored.
  try {
    await resolveSetupRequest(config, approval.id, "complete", { actor: "user", resumeChatTask: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 410, body: { ok: false, message: `Could not lock setup request for fill: ${message}` } };
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
      expectedUrl: approvedUrl
    });
    if (result.ok) {
      filledSlots.push(slot.name);
    } else {
      // Distinguish origin-mismatch from other fill errors via the
      // discriminated `code` field, NOT a magic-string prefix on
      // `error` — see BrowserFillByLocatorResult in
      // src/tools/browser.ts. Origin drift halts the loop;
      // continuing would type the remaining secrets into the same
      // new origin.
      if (result.code === "origin-mismatch") {
        bailedOnOriginDrift = true;
        errors.push({ slot: slot.name, error: result.error });
        break;
      }
      errors.push({ slot: slot.name, error: result.error });
    }
  }

  // Audit row carries contract-fields only. The redacted: true flag
  // tells the writer-boundary to drop `evidence` entirely as
  // defense-in-depth — slot values were never going to be in
  // evidence (only names + error strings), but the flag protects
  // against a future bug that puts them there. See ADR
  // browser-fill-secret.md.
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
  // Append the per-slot outcome to the trace JSONL. Because the
  // audit row's `evidence` gets dropped by the redacted-writer
  // boundary, operators debugging "which slots filled? which
  // errored?" need a non-redacted artifact to read. Slot NAMES
  // are safe (the agent emitted them on the original tool call);
  // slot VALUES never reach this point. The end-to-end leak test
  // (src/http.test.ts) greps trace JSONL for absence of submitted
  // marker bytes — adding this trace must NOT change that
  // invariant, only slot.name / error-message strings (no value
  // substring) live here.
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "browser.fill_secret completed",
    data: {
      approvalId: approval.id,
      filledSlots,
      errors,
      ...(bailedOnCancel ? { aborted: "task-cancelled-mid-fill" } : {}),
      ...(bailedOnOriginDrift ? { aborted: "origin-drift-mid-fill" } : {})
    }
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
    // Wrap resumeChatTask in the shared safeResume recovery: a
    // terminal-task throw inside the chat loop (provider rate limit,
    // dispatch error, etc.) flips the task into status=running with
    // no live executor unless we trace the failure and call failTask
    // ourselves. See src/execution/safe-resume.ts. The audit row
    // above already recorded the fill outcome regardless of whether
    // the resume completes.
    await safeResume(config, taskId, toolCallId, resumeResult, {
      context: "fill_secret",
      approvalId: approval.id
    });
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
