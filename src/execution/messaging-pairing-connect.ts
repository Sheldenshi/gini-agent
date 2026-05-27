// Bounded runtime module for the messaging.approve_pairing /connect
// flow. Mirrors runMessagingBridgeConnect's shape: the HTTP /connect
// handler delegates here so http.ts stays a routing layer.
//
// One endpoint, two outcomes:
//   - approve: server calls allowChat(bridge, chatId, expectedCode)
//     from the payload. allowChat owns the verification-code
//     handshake + idempotency check internally; we forward its
//     errors verbatim.
//   - reject: caller sends `{ reject: true }`; server calls
//     rejectPendingChat(bridge, chatId).
//
// The atomic resolveApproval(resumeChatTask:false) runs BEFORE
// either side effect — same race-safety rationale as
// runMessagingBridgeConnect: a concurrent /deny or task cancel
// cannot land an enroll/reject after the operator has abandoned
// the prompt. The chat-task resume is fired from this module via
// the shared safeResume helper.

import type { Approval, RuntimeConfig } from "../types";
import { resolveApproval } from "../agent";
import { allowChat, rejectPendingChat } from "../integrations/messaging";
import { sanitizeBridgeStatusMessage } from "../integrations/messaging-poller-helpers";
import { safeResume } from "./safe-resume";

export interface MessagingPairingConnectResult {
  status: number;
  body: {
    ok: boolean;
    message?: string;
    enrolled?: boolean;
    rejected?: boolean;
  };
}

export async function runMessagingPairingConnect(
  config: RuntimeConfig,
  approval: Approval,
  body: {
    reject?: unknown;
  }
): Promise<MessagingPairingConnectResult> {
  const bridgeId = typeof approval.payload.bridgeId === "string"
    ? approval.payload.bridgeId
    : "";
  const chatIdRaw = approval.payload.chatId;
  const chatId = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  const verificationCode = typeof approval.payload.verificationCode === "string"
    ? approval.payload.verificationCode
    : undefined;
  if (!bridgeId || !Number.isFinite(chatId)) {
    return {
      status: 400,
      body: { ok: false, message: "Approval payload missing bridgeId or chatId; refusing to resolve pairing." }
    };
  }
  const isReject = body.reject === true;

  // Atomic check-and-flip BEFORE either side effect — mirrors the
  // browser.fill_secret / messaging.add_bridge ordering.
  let resolved: Approval;
  try {
    const result = await resolveApproval(config, approval.id, { actor: "user", resumeChatTask: false });
    resolved = result.approval;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 410,
      body: { ok: false, message: `Could not lock approval for pairing resolution: ${message}` }
    };
  }
  if (resolved.status !== "approved") {
    return {
      status: 410,
      body: {
        ok: false,
        message: `Approval was ${resolved.status} during resolution (likely because the owning task became terminal); pairing was not touched.`
      }
    };
  }

  const taskId = approval.taskId;
  const toolCallId = typeof approval.payload.toolCallId === "string"
    ? approval.payload.toolCallId
    : undefined;

  if (isReject) {
    try {
      await rejectPendingChat(config, bridgeId, chatId);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = sanitizeBridgeStatusMessage(raw);
      if (taskId && toolCallId) {
        await safeResume(
          config,
          taskId,
          toolCallId,
          `Could not reject pairing for chat ${chatId}: ${message}.`,
          { context: "messaging.approve_pairing", approvalId: approval.id }
        );
      }
      return { status: 200, body: { ok: false, message } };
    }
    if (taskId && toolCallId) {
      await safeResume(
        config,
        taskId,
        toolCallId,
        `Pairing request for chat ${chatId} was rejected. Tell the user the request was cleared; a fresh DM will mint a new request.`,
        { context: "messaging.approve_pairing", approvalId: approval.id }
      );
    }
    return { status: 200, body: { ok: true, rejected: true } };
  }

  // Approve path: forward the verification code captured at approval
  // mint time so allowChat's handshake check sees the same code the
  // operator confirmed on the card.
  try {
    await allowChat(config, bridgeId, chatId, verificationCode ? { expectedCode: verificationCode } : {});
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = sanitizeBridgeStatusMessage(raw);
    if (taskId && toolCallId) {
      await safeResume(
        config,
        taskId,
        toolCallId,
        `Could not approve pairing for chat ${chatId}: ${message}. Tell the user what went wrong.`,
        { context: "messaging.approve_pairing", approvalId: approval.id }
      );
    }
    return { status: 200, body: { ok: false, message } };
  }
  if (taskId && toolCallId) {
    await safeResume(
      config,
      taskId,
      toolCallId,
      `Pairing approved: chat ${chatId} is now enrolled on the bridge. The bot has sent the user a confirmation message — they can chat with Gini now.`,
      { context: "messaging.approve_pairing", approvalId: approval.id }
    );
  }
  return { status: 200, body: { ok: true, enrolled: true } };
}
