// Pure dispatch core for notification responses. Lives in its own
// module so unit tests can import it without pulling in react-native,
// expo-router, or expo-notifications — none of which load in a Node /
// bun:test environment.
//
// The production wrapper in `./push.ts` calls into this with the real
// `api()`, expo-router's `router`, and the local-notification fallback;
// tests inject spies for all three.

// Category and action identifiers shared with the server-side
// dispatcher (`src/integrations/apns/dispatcher.ts`) and the iOS NSE
// (`mobile/ios-extensions/...`). Changing either string requires
// updating all three sites.
export const APPROVAL_CATEGORY = "APPROVAL_REQUEST";
export const APPROVE_ACTION = "APPROVE";
export const DENY_ACTION = "DENY";

export type NotificationDispatchOutcome =
  | { kind: "tap"; sessionId: string }
  | { kind: "approve"; approvalId: string }
  | { kind: "deny"; approvalId: string }
  | { kind: "approve-failed"; approvalId: string }
  | { kind: "deny-failed"; approvalId: string }
  | { kind: "ignored" };

export interface DispatchDeps {
  apiCall: <T = unknown>(path: string, init?: { method?: string }) => Promise<T>;
  navigate: (sessionId: string) => void;
  notifyFailure: (verb: "approve" | "deny") => Promise<void>;
}

// Minimal shape we depend on from expo-notifications'
// NotificationResponse. Defined locally so the test file doesn't drag
// the full expo-notifications import into bun:test.
export interface ResponseLike {
  actionIdentifier: string;
  notification: { request: { content: { data?: unknown } } };
}

/**
 * Routes an incoming `NotificationResponse` to the right side-effect:
 *   - APPROVE button → POST /api/approvals/:id/approve
 *   - DENY button → POST /api/approvals/:id/deny
 *   - any other actionIdentifier (default tap, future actions) →
 *     navigate to /chat/:sessionId if the payload carries one
 *
 * Action failures (network error, 5xx from the gateway) schedule a
 * follow-up local notification ("Failed to approve — open the app")
 * so the user knows to retry inside the app instead of silently
 * losing the action.
 */
export async function dispatchNotificationResponse(
  response: ResponseLike,
  deps: DispatchDeps
): Promise<NotificationDispatchOutcome> {
  const rawData = response.notification.request.content.data as
    | { sessionId?: unknown; approvalId?: unknown }
    | null
    | undefined;
  const sessionId = typeof rawData?.sessionId === "string" ? rawData.sessionId : null;
  const approvalId = typeof rawData?.approvalId === "string" ? rawData.approvalId : null;

  if (response.actionIdentifier === APPROVE_ACTION) {
    if (!approvalId) return { kind: "ignored" };
    try {
      await deps.apiCall(`/approvals/${approvalId}/approve`, { method: "POST" });
      return { kind: "approve", approvalId };
    } catch {
      await deps.notifyFailure("approve");
      return { kind: "approve-failed", approvalId };
    }
  }

  if (response.actionIdentifier === DENY_ACTION) {
    if (!approvalId) return { kind: "ignored" };
    try {
      await deps.apiCall(`/approvals/${approvalId}/deny`, { method: "POST" });
      return { kind: "deny", approvalId };
    } catch {
      await deps.notifyFailure("deny");
      return { kind: "deny-failed", approvalId };
    }
  }

  // Any non-Approve / non-Deny action — including the OS-default tap
  // (`expo.modules.notifications.actions.DEFAULT`) — falls through to
  // the deep-link branch. We deliberately don't gate on the literal
  // default-action constant so a future custom action that doesn't
  // need an API call still routes to the chat.
  if (sessionId) {
    deps.navigate(sessionId);
    return { kind: "tap", sessionId };
  }
  return { kind: "ignored" };
}
