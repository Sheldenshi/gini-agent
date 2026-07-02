// Notification-preview builder for the iOS Notification Service Extension
// (NSE). The NSE runs on-device when a `mutable-content: 1` push arrives
// and calls GET /api/push/preview to fetch the real, human-readable title
// + body, then rewrites the lock-screen banner before display.
//
// Why this exists: the APNs wire payload deliberately carries NO chat text
// or approval summary — only routing ids and a generic "Tap to read"
// string — because Apple's servers see every byte of a push payload (see
// ADR mobile-push-notifications.md "Trust + privacy"). This builder runs
// inside the gateway and is reached only over the device's own
// authenticated connection to the gateway, so the enriched text never
// transits Apple. The privacy posture is preserved: APNs sees ids; the
// device fetches content out-of-band.
//
// Three event kinds map to a preview:
//   - message_completed     → the latest assistant reply in the session.
//                             Reads the NEWEST assistant_text so a banner
//                             collapsed onto one session entry tracks the
//                             last message even across multiple agent turns.
//   - authorization_requested → the approval's risk + summary ("Approve?").
//   - setup_requested       → the setup step's summary ("Action needed").
//
// Anything else (silent phase wakes) has no user-facing preview and the
// endpoint never asks for one.

import type { Authorization, Instance, SetupRequest } from "../../types";

// Lock-screen banners truncate visually, but an unbounded body would still
// ship the entire message to the device's notification store. Cap to a
// sentence-ish length and add an ellipsis so long replies read cleanly.
// 178 chars is comfortably under what iOS renders across two expanded
// banner lines while leaving headroom for the title.
const MAX_BODY_CHARS = 178;

// The push events that carry a user-facing preview. Mirrors the `event`
// discriminator the dispatcher writes into the payload `body` (see
// dispatcher.ts buildMessageCompletedPayload / buildApprovalPayload).
export type PreviewEvent =
  | "message_completed"
  | "authorization_requested"
  | "setup_requested";

export interface NotificationPreview {
  title: string;
  body: string;
}

// Dependencies the builder reads, injected so the route handler passes the
// live state lookups and tests pin them without a SQLite layer.
export interface PreviewDeps {
  // Latest non-empty assistant reply text for a session's MAIN chat, or null.
  latestAssistantText: (instance: Instance, sessionId: string) => string | null;
  // Latest non-empty assistant reply WITHIN a thread, or null. Used when a
  // completion push carries a threadId so the preview shows the thread's
  // own reply rather than stale main-chat text.
  latestAssistantTextForThread: (instance: Instance, sessionId: string, threadId: string) => string | null;
  // The session's human title (chat name), or null when not found.
  sessionTitle: (instance: Instance, sessionId: string) => string | null;
  // The pending authorization by id, or null when resolved / not found.
  authorization: (instance: Instance, authorizationId: string) => Authorization | null;
  // The pending setup request by id, or null when resolved / not found.
  setupRequest: (instance: Instance, setupRequestId: string) => SetupRequest | null;
}

// Collapse runs of whitespace (newlines, tabs) into single spaces and trim,
// then hard-cap to MAX_BODY_CHARS with a trailing ellipsis. A multi-line
// assistant reply otherwise renders with literal newlines mid-banner.
export function condense(text: string, max = MAX_BODY_CHARS): string {
  const flattened = text.replace(/\s+/gu, " ").trim();
  if (flattened.length <= max) return flattened;
  // Trim back to the cap, then drop a dangling partial word so the
  // ellipsis attaches to a whole token rather than mid-word.
  const clipped = flattened.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  const head = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${head.trimEnd()}…`;
}

// Builds the notification-ready { title, body } for a push event, or null
// when the underlying content is gone (session deleted, approval already
// resolved, message not yet persisted). A null result tells the endpoint to
// 404 so the NSE falls back to the generic as-sent banner.
export function buildNotificationPreview(
  instance: Instance,
  params: { event: PreviewEvent; sessionId: string; approvalId?: string; threadId?: string },
  deps: PreviewDeps
): NotificationPreview | null {
  const title = deps.sessionTitle(instance, params.sessionId);

  if (params.event === "message_completed") {
    // A threaded completion's reply lives under its threadId; resolve that
    // so the banner shows the thread's own text, not stale main-chat text.
    // Un-threaded completions read the main chat. (Both deep-link to the
    // session on tap.)
    const text = params.threadId
      ? deps.latestAssistantTextForThread(instance, params.sessionId, params.threadId)
      : deps.latestAssistantText(instance, params.sessionId);
    if (!text || text.trim().length === 0) return null;
    return {
      // Fall back to the generic title when the session has no name yet.
      title: title?.trim() || "Gini",
      body: condense(text)
    };
  }

  if (params.event === "authorization_requested") {
    if (!params.approvalId) return null;
    const auth = deps.authorization(instance, params.approvalId);
    if (!auth) return null;
    // Risk pill in the title gives the user the stakes at a glance; the
    // body carries what the agent wants to do.
    return {
      title: title?.trim()
        ? `Approve in ${title.trim()}?`
        : "Gini needs your approval",
      body: condense(approvalBody(auth))
    };
  }

  // setup_requested
  if (!params.approvalId) return null;
  const setup = deps.setupRequest(instance, params.approvalId);
  if (!setup) return null;
  return {
    title: title?.trim() ? `Finish a step in ${title.trim()}` : "Gini needs you to finish a step",
    body: condense(setupBody(setup))
  };
}

// Composes the approval body from the agent's ask plus the risk level so a
// glance conveys both what and how risky. The summary mirrors the chat
// block's derivation (reason ?? target, see chat-task.ts), falling back to
// the action verb if both are empty; the risk prefix is a fixed vocabulary.
function approvalBody(auth: Authorization): string {
  const summary = auth.reason.trim() || auth.target.trim() || auth.action;
  const risk = auth.risk.trim();
  return risk ? `[${risk}] ${summary}` : summary;
}

// The setup body mirrors the chat block's derivation (reason ?? target,
// see chat-task.ts), falling back to the action when both are empty.
function setupBody(setup: SetupRequest): string {
  return setup.reason.trim() || setup.target.trim() || setup.action;
}
