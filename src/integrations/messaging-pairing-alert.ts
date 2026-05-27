// Auto-surface helper for inbound Telegram pairing requests.
//
// Without this module, an operator has to explicitly ask the agent
// "check for pending pairings" before the chat-side approval card
// appears — a worse UX than the settings page, which polls every 3
// seconds and surfaces pending rows automatically. This helper
// hooks the Telegram poller so the moment a fresh pending pair is
// minted (via `recordDeniedChatAttempt`), an `approval_requested`
// chat block lands in the operator's CURRENT web chat session
// (the most-recently-active session that wasn't itself spawned by
// a Telegram/Discord bridge), where the per-session SSE stream
// pushes it to whatever browser tab is open on that session.
//
// Design choices:
//   - Push into the active web chat, not a dedicated "alerts"
//     side-session. The operator sees the card appear inline in
//     whichever conversation they're currently driving — same UX
//     contract the user articulated: "the same chat".
//   - "Active web chat" = the session with the latest updatedAt
//     that has no `source` (i.e. wasn't spawned by a Telegram or
//     Discord bridge — pushing a Telegram pairing prompt into a
//     Telegram-sourced chat would be a routing loop) AND no
//     `origin === "job"` (a scheduled-job thread is a dedicated
//     surface for its own work). If no web chat exists yet,
//     create one titled "Chat" so the alert still surfaces — the
//     user can rename or delete it.
//   - The approval row is bound to that session via the inserted
//     approval_requested block, but carries no taskId —
//     /connect's bounded module (runMessagingPairingConnect)
//     handles the missing-taskId case by skipping the resume hook
//     (gated on `if (taskId && toolCallId)`).
//   - The approval's payload matches what request_messaging_pairing
//     mints, so the chat card renders identically whether the
//     approval came from this auto-push or from an agent tool call.

import type { ChatSessionRecord, RuntimeConfig } from "../types";
import { appendLog, appendTrace, createApproval, createChatSession, insertChatBlock, mutateState } from "../state";
import type { ChatAllowlistView } from "./messaging";

const FALLBACK_SESSION_TITLE = "Chat";

// Pick the operator's active web chat session for the given agent.
// "Active" = newest updatedAt among sessions that are:
//   - bound to the agent (or unbound if no active agent yet)
//   - not spawned by a bridge (no source field)
//   - not a scheduled-job thread (no origin === "job")
// Returns undefined when no eligible session exists.
function pickActiveWebChatSession(
  sessions: ChatSessionRecord[],
  agentId: string | undefined
): ChatSessionRecord | undefined {
  const eligible = sessions.filter((s) => {
    if (s.source) return false;
    if (s.origin === "job") return false;
    if (agentId !== undefined && s.agentId !== agentId) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;
  return eligible.reduce((most, candidate) =>
    candidate.updatedAt > most.updatedAt ? candidate : most
  );
}

export interface SurfacePairingInput {
  bridgeId: string;
  bridgeName: string;
  botUsername?: string;
  chatId: number;
  chatType: string;
  sender?: string;
  verificationCode?: string;
  verificationCodeExpiresAt?: string;
}

// Push a fresh pending pairing into the operator's alert chat
// session as an `approval_requested` block. Returns the approvalId
// for tests / debugging. Errors are caught + logged so a failure to
// surface in chat doesn't break the poller's main loop (the
// pending row is still in `recentDeniedChats` and the settings page
// polling fallback still works).
export async function surfacePendingPairingInChat(
  config: RuntimeConfig,
  input: SurfacePairingInput
): Promise<string | undefined> {
  try {
    const result = await mutateState(config.instance, (state) => {
      // Resolve the owner agent for the alert session. Prefer the
      // instance's active agent so the alert lands on the operator
      // whose current chats this surface routes to. Fall back to
      // the first available agent if no active is set (covers
      // partial-setup instances).
      const agentId = state.activeAgentId
        ?? state.agents.find((a) => a.id)?.id;

      // Land the alert in the operator's active web chat (newest
      // updatedAt among non-bridge, non-job sessions). If none
      // exists yet — fresh instance whose operator hasn't started
      // any chat — fall back to creating a generic chat so the
      // alert still has a surface (the user can rename it later).
      let session = pickActiveWebChatSession(state.chatSessions, agentId);
      if (!session) {
        session = createChatSession(state, FALLBACK_SESSION_TITLE, undefined, agentId);
      }

      // Build the reason string the same way request_messaging_pairing
      // does so the card body reads identically across the
      // auto-push and the agent-driven paths.
      const reason = `Confirm the verification code below matches what you received on Telegram before approving chat ${input.chatId}.`;

      const approval = createApproval(state, {
        action: "messaging.approve_pairing",
        target: `${input.bridgeId}:${input.chatId}`,
        risk: "medium",
        reason,
        agentId,
        payload: {
          bridgeId: input.bridgeId,
          bridgeName: input.bridgeName,
          botUsername: input.botUsername ?? null,
          chatId: input.chatId,
          chatType: input.chatType,
          sender: input.sender ?? null,
          verificationCode: input.verificationCode ?? null,
          verificationCodeExpiresAt: input.verificationCodeExpiresAt ?? null,
          toolCallId: null,
          autoSurfaced: true
        }
      });
      // Update session timestamps + push the approval-requested
      // block so the per-session SSE stream notifies any open
      // browser tab. insertChatBlock allocates the next ordinal
      // inside its own SAVEPOINT so concurrent inserts (multiple
      // bridges pinging at once) serialize cleanly.
      session.updatedAt = new Date().toISOString();
      return { sessionId: session.id, approvalId: approval.id, reason };
    });

    insertChatBlock(config.instance, {
      sessionId: result.sessionId,
      kind: "approval_requested",
      approvalId: result.approvalId,
      action: "messaging.approve_pairing",
      risk: "medium",
      summary: result.reason
    });
    appendLog(config.instance, "messaging.telegram.pairing_alert_surfaced", {
      bridgeId: input.bridgeId,
      chatId: input.chatId,
      approvalId: result.approvalId,
      sessionId: result.sessionId
    });
    return result.approvalId;
  } catch (error) {
    // Best-effort. The pending row is already persisted on
    // `bridge.metadata.recentDeniedChats`, and the settings page +
    // the agent-driven `list_messaging_pairings` path both still
    // work. Don't bubble — losing the alert surface is far less
    // bad than killing the poller's main loop.
    appendLog(config.instance, "messaging.telegram.pairing_alert_error", {
      bridgeId: input.bridgeId,
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

// Convenience: extract the input shape from a bridge + the entry
// returned by recordDeniedChatAttempt so callers don't have to thread
// fields by hand.
export function alertInputFromEntry(
  bridge: { id: string; name: string; metadata?: Record<string, unknown> },
  entry: ChatAllowlistView["recentDeniedChats"][number]
): SurfacePairingInput {
  const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
  const botUsername = typeof meta.botUsername === "string" ? meta.botUsername : undefined;
  return {
    bridgeId: bridge.id,
    bridgeName: bridge.name,
    botUsername,
    chatId: entry.chatId,
    chatType: entry.chatType,
    sender: entry.sender,
    verificationCode: entry.verificationCode,
    verificationCodeExpiresAt: entry.verificationCodeExpiresAt
  };
}

// Exported for tests + dev surfacing. The literal title is used
// only as a fallback session name when no web chat exists yet —
// auto-surfaced alerts normally land in the operator's
// most-recently-active web chat (whatever they happen to be
// driving), so this constant is rarely what surfaces on screen.
export const FALLBACK_ALERT_SESSION_TITLE = FALLBACK_SESSION_TITLE;
// appendTrace re-exported here just so this module can be a single
// import target for any downstream caller that wants to log alongside
// the surface — keeps the consumer's import line tidy.
export { appendTrace };
