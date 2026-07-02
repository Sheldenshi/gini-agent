// Bounded runtime module for the messaging.remove_bridge /connect
// flow. Mirrors runMessagingBridgeConnect: atomic resolveApproval
// BEFORE the side effect so a concurrent /deny or task cancel
// cannot land a removal after the operator has clicked Cancel,
// then safeResume back into the chat-task loop.

import type { RuntimeConfig, SetupRequest } from "../types";
import { resolveSetupRequest } from "../agent";
import { removeMessagingBridge } from "../integrations/messaging";
import { sanitizeBridgeStatusMessage } from "../integrations/messaging-poller-helpers";
import { addAudit, mutateState } from "../state";
import { persistConnectOutcome, safeResume } from "./safe-resume";

export interface MessagingRemoveConnectResult {
  status: number;
  body: {
    ok: boolean;
    message?: string;
    removed?: boolean;
    bridgeId?: string;
  };
}

export async function runMessagingRemoveConnect(
  config: RuntimeConfig,
  approval: SetupRequest
): Promise<MessagingRemoveConnectResult> {
  const bridgeId = typeof approval.payload.bridgeId === "string"
    ? approval.payload.bridgeId
    : "";
  const bridgeName = typeof approval.payload.bridgeName === "string"
    ? approval.payload.bridgeName
    : bridgeId;
  if (!bridgeId) {
    return {
      status: 400,
      body: { ok: false, message: "Approval payload missing bridgeId; refusing to remove." }
    };
  }

  // Atomic check-and-flip BEFORE the destructive call.
  let resolved: SetupRequest;
  try {
    resolved = await resolveSetupRequest(config, approval.id, "complete", { actor: "user", resumeChatTask: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 410,
      body: { ok: false, message: `Could not lock approval for bridge removal: ${message}` }
    };
  }
  if (resolved.status !== "completed") {
    return {
      status: 410,
      body: {
        ok: false,
        message: `Approval was ${resolved.status} during resolution (likely because the owning task became terminal); no bridge was removed.`
      }
    };
  }

  const taskId = approval.taskId;
  const toolCallId = typeof approval.payload.toolCallId === "string"
    ? approval.payload.toolCallId
    : undefined;

  try {
    await removeMessagingBridge(config, bridgeId);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = sanitizeBridgeStatusMessage(raw);
    await persistConnectOutcome(config, approval.id, { ok: false, message });
    if (taskId && toolCallId) {
      await safeResume(
        config,
        taskId,
        toolCallId,
        `Could not remove bridge '${bridgeName}': ${message}.`,
        { context: "messaging.remove_bridge", approvalId: approval.id }
      );
    }
    return { status: 200, body: { ok: false, message } };
  }

  await persistConnectOutcome(config, approval.id, {
    ok: true,
    message: `Bridge '${bridgeName}' removed`
  });
  if (taskId && toolCallId) {
    // Detached — see messaging-bridge-connect.ts comment.
    void safeResume(
      config,
      taskId,
      toolCallId,
      `Bridge '${bridgeName}' has been removed. Its bot token was deleted; past messages remain in history.`,
      { context: "messaging.remove_bridge", approvalId: approval.id }
    ).catch(() => {});
  }
  // Chat-card lineage audit row — same rationale as the pairing
  // and bridge-create connect handlers. removeMessagingBridge writes
  // a generic messaging.removed row with `{ system: true }` and no
  // taskId/approvalId, so chat-card-driven removes are otherwise
  // indistinguishable from CLI / settings-page removes. Audit runs
  // AFTER safeResume so a throw can't orphan the task.
  try {
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "user",
          action: "messaging.remove_bridge",
          target: bridgeId,
          risk: "high",
          taskId,
          approvalId: approval.id,
          evidence: {
            bridgeId,
            bridgeName,
            toolCallId: toolCallId ?? null
          }
        },
        taskId ? { taskId } : { system: true }
      );
    });
  } catch {
    // Non-load-bearing.
  }
  return { status: 200, body: { ok: true, removed: true, bridgeId } };
}
