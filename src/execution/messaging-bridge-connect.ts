// Bounded runtime module for the messaging.add_bridge /connect flow.
//
// The HTTP /connect handler delegates here so http.ts stays a thin
// routing layer (matching the browser_fill_secret precedent in
// browser-fill-secrets.ts and the AGENTS.md guideline that handlers
// should delegate to bounded runtime modules). The flow:
//   1. Parse kind from approval.payload; reject unknown kinds.
//   2. Parse + validate the submitted name + bot-token + (for
//      discord) deliveryTargets. Run assertHeaderSafeToken BEFORE
//      resolveApproval so a malformed token does not burn the
//      approval — the chat card stays pending and the user can
//      retype.
//   3. resolveApproval(resumeChatTask: false) — atomic check-and-flip
//      from pending → approved that closes the deny-mid-create
//      race (browser-fill-secrets's precedent).
//   4. addMessagingBridge — the shared substrate the CLI and the
//      settings page also use. The bot token never enters audit
//      evidence or the chat transcript; the secret store handles
//      encryption at rest.
//   5. resumeChatTask with a result string reflecting actual
//      outcome, wrapped in a try/catch that calls failTask on
//      throw to recover an orphaned task (matches
//      browser-fill-secrets.ts:318-347). The same recovery is
//      used on the addMessagingBridge-failed path: the approval
//      is already resolved at that point, so the chat-task loop
//      must be told the create failed instead of being left
//      waiting indefinitely.

import type { Approval, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { resolveApproval } from "../agent";
import { addMessagingBridge, assertHeaderSafeToken } from "../integrations/messaging";
import { sanitizeBridgeStatusMessage } from "../integrations/messaging-poller-helpers";
import { addAudit, mutateState } from "../state";
import { persistConnectOutcome, safeResume } from "./safe-resume";

export interface MessagingBridgeConnectResult {
  status: number;
  body: {
    ok: boolean;
    message?: string;
    bridge?: MessagingBridgeRecord;
  };
}

export async function runMessagingBridgeConnect(
  config: RuntimeConfig,
  approval: Approval,
  secrets: Record<string, string>,
  deliveryTargetsRaw: unknown
): Promise<MessagingBridgeConnectResult> {
  const kind = approval.payload.kind === "telegram" || approval.payload.kind === "discord"
    ? (approval.payload.kind as "telegram" | "discord")
    : undefined;
  if (!kind) {
    return {
      status: 400,
      body: { ok: false, message: "Approval payload missing kind (telegram|discord); refusing to create bridge." }
    };
  }
  const submittedName = typeof secrets.name === "string" ? secrets.name.trim() : "";
  const submittedToken = typeof secrets.botToken === "string" ? secrets.botToken.trim() : "";
  const deliveryTargets = Array.isArray(deliveryTargetsRaw)
    ? deliveryTargetsRaw.map(String).map((t) => t.trim()).filter((t) => t.length > 0)
    : [];

  // Field-shape validations BEFORE resolveApproval so a malformed
  // submission does not burn the approval — the chat card stays
  // pending and the user can retype. The fill_secret precedent
  // (browser-fill-secrets.ts:67-105) does the same pre-validation
  // (missing slots + min length) before its resolveApproval at
  // line 189.
  if (!submittedName) {
    return { status: 200, body: { ok: false, message: "Bridge name is required." } };
  }
  if (!submittedToken) {
    return { status: 200, body: { ok: false, message: "Bot token is required." } };
  }
  // Token-format pre-check using the same assertion addMessagingBridge
  // would call internally. Running it here lets a header-unsafe token
  // bounce off the chat card with the approval still pending so the
  // user can paste a clean one without re-issuing the agent tool call.
  try {
    assertHeaderSafeToken(kind, submittedToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 200, body: { ok: false, message } };
  }
  if (kind === "discord" && deliveryTargets.length === 0) {
    return {
      status: 200,
      body: { ok: false, message: "Discord bridges require at least one channel id under deliveryTargets." }
    };
  }

  // Atomic check-and-flip closes the deny-mid-create race.
  // CRITICAL: capture the return value — resolveApproval can succeed
  // (no throw) but internally flip status approved → denied via
  // executeApprovedAction's terminal-task guard. If the owning task
  // went terminal between the chat card mounting and the submit
  // landing, the approval comes back denied; proceeding to
  // addMessagingBridge in that state would create a bridge for a
  // cancelled task and audit it as approved.
  let resolved: Approval;
  try {
    const result = await resolveApproval(config, approval.id, { actor: "user", resumeChatTask: false });
    resolved = result.approval;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 410,
      body: { ok: false, message: `Could not lock approval for bridge create: ${message}` }
    };
  }
  if (resolved.status !== "approved") {
    return {
      status: 410,
      body: {
        ok: false,
        message: `Approval was ${resolved.status} during resolution (likely because the owning task became terminal); no bridge was created.`
      }
    };
  }

  const taskId = approval.taskId;
  const toolCallId = typeof approval.payload.toolCallId === "string"
    ? approval.payload.toolCallId
    : undefined;
  const kindLabel = kind === "telegram" ? "Telegram" : "Discord";

  let bridge: MessagingBridgeRecord;
  try {
    bridge = await addMessagingBridge(config, {
      name: submittedName,
      kind,
      botToken: submittedToken,
      deliveryTargets
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Strip absolute filesystem paths and Authorization / bot-token
    // URL substrings before the message reaches the browser, the
    // chat-task resume, or any persisted artifact. The sibling
    // surfaces in messaging.ts (checkMessagingBridge, sendMessagingOutput)
    // already pipe through this sanitizer; the chat-side card now
    // does too. Filesystem-failure messages from writeSecret /
    // writeState can include absolute paths under <instanceRoot>,
    // and any Telegram fetch error in addMessagingBridge would
    // echo `/bot<token>/`.
    const message = sanitizeBridgeStatusMessage(raw);
    // Approval already resolved — the chat card has flipped out of
    // pending state. Resume the chat-task loop with the sanitized
    // failure string so the agent verbalizes the error back to the
    // user. Recover an orphaned task via failTask if the resume
    // itself throws (mirrors browser-fill-secrets.ts:318-347).
    await persistConnectOutcome(config, approval.id, { ok: false, message });
    if (taskId && toolCallId) {
      await safeResume(
        config,
        taskId,
        toolCallId,
        `Could not create ${kindLabel} bridge: ${message}. Tell the user about the failure so they can retry from the settings page.`,
        { context: "messaging.add_bridge", approvalId: approval.id }
      );
    }
    return { status: 200, body: { ok: false, message } };
  }

  // Persist outcome + resume the chat-task BEFORE the lineage
  // audit write. safeResume swallows its own throws via failTask;
  // the audit mutateState below can throw on disk-full / db-lock
  // and that error must NOT prevent the chat-task from resuming
  // (a failed audit row is far less harmful than orphaning the
  // task in waiting_approval after the bridge already exists).
  await persistConnectOutcome(config, approval.id, {
    ok: true,
    message: `${kindLabel} bridge added: ${bridge.name}`
  });
  if (taskId && toolCallId) {
    await safeResume(
      config,
      taskId,
      toolCallId,
      `${kindLabel} bridge added: ${bridge.name}. Tell the user it's ready and walk them through enrolling a chat (DM the bot, share the verification code, you approve from the settings page) if relevant.`,
      { context: "messaging.add_bridge", approvalId: approval.id }
    );
  }
  // Stamp a follow-up audit row with the chat-side lineage. The
  // shared substrate (createMessagingBridgeRecord) writes a generic
  // `messaging.configured` row with actor:"user" and no task/approval
  // reference, so a bridge created from CLI vs settings vs chat is
  // indistinguishable in the audit log. Add a complementary row so
  // operators can prove "bridge X was created from approval Y inside
  // task Z". Mirrors browser-fill-secrets.ts:247-267 in spirit.
  // Wrapped in try so an audit-write throw doesn't change the
  // chat-side response — the side effect succeeded and the task
  // already resumed.
  try {
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "user",
          action: "messaging.add_bridge",
          target: bridge.id,
          risk: "high",
          taskId,
          approvalId: approval.id,
          evidence: {
            kind,
            bridgeName: bridge.name,
            toolCallId: toolCallId ?? null
          }
        },
        taskId ? { taskId } : { system: true }
      );
    });
  } catch {
    // Audit row is non-load-bearing — operator still has the
    // shared substrate's generic messaging.configured row.
  }
  return { status: 200, body: { ok: true, bridge } };
}
