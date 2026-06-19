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

// The lock-screen action buttons for the APPROVAL_REQUEST category, kept
// here (the native-free module) as a plain data spec so the security
// invariants are unit-testable without expo-notifications. `push.ts`
// feeds this straight into `setNotificationCategoryAsync`.
//
// Security invariant: Approve MUST set `isAuthenticationRequired: true`.
// Approving grants the high-risk action the agent paused on (terminal
// exec, file writes, etc.); without the flag iOS would let anyone tap
// Approve from a LOCKED phone and authorize it. The flag forces Face ID /
// Touch ID / passcode before the handler runs, without foregrounding the
// app (the gateway POST stays a background dispatch). Deny is fail-safe
// (it cancels, never grants), so it needs no auth gate; it is marked
// destructive for the red styling.
export interface ApprovalActionSpec {
  identifier: string;
  buttonTitle: string;
  options: {
    opensAppToForeground: boolean;
    isAuthenticationRequired: boolean;
    isDestructive: boolean;
  };
}

export const APPROVAL_CATEGORY_ACTIONS: readonly ApprovalActionSpec[] = [
  {
    identifier: APPROVE_ACTION,
    buttonTitle: "Approve",
    options: {
      opensAppToForeground: false,
      isAuthenticationRequired: true,
      isDestructive: false
    }
  },
  {
    identifier: DENY_ACTION,
    buttonTitle: "Deny",
    options: {
      opensAppToForeground: false,
      isAuthenticationRequired: false,
      isDestructive: true
    }
  }
];

export type NotificationDispatchOutcome =
  | { kind: "tap"; sessionId: string; threadId: string | null }
  | { kind: "approve"; approvalId: string }
  | { kind: "deny"; approvalId: string }
  | { kind: "approve-failed"; approvalId: string }
  | { kind: "deny-failed"; approvalId: string }
  | { kind: "ignored" };

// The deep-link route a notification tap resolves to. `threadId` is set
// only for a threaded completion (the tap opens the thread view); a plain
// main-chat tap carries null.
export interface LaunchTapRoute {
  sessionId: string;
  threadId: string | null;
}

// Builds the deep-link route string a notification tap opens. A threaded
// completion opens the thread view (the main chat filters threaded blocks
// out, so opening it would hide the reply the banner previewed); a main-chat
// tap omits the thread segment. Both dynamic segments are percent-encoded as
// a boundary guard so a malformed id from the push payload can't reshape the
// route path — the ids are server-generated opaque tokens, so the encode is a
// no-op for well-formed input. Pure (no expo-router) so the encode + the
// thread-vs-main branch are unit-testable; the push.ts navigateToChat wrapper
// just feeds the result to router.push.
export function buildChatRoute(sessionId: string, threadId: string | null): string {
  return threadId
    ? `/chat/${encodeURIComponent(sessionId)}/thread/${encodeURIComponent(threadId)}`
    : `/chat/${encodeURIComponent(sessionId)}`;
}

// Reads the routing fields the server-side dispatcher writes into a push
// payload's `body` object (surfaced by expo-notifications as
// `content.data`). Shared by the live-tap dispatcher and the cold-start
// launch-tap resolver so both parse the wire shape identically.
function readRouting(data: unknown): {
  sessionId: string | null;
  approvalId: string | null;
  threadId: string | null;
} {
  const raw = data as
    | { sessionId?: unknown; approvalId?: unknown; threadId?: unknown }
    | null
    | undefined;
  return {
    sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : null,
    approvalId: typeof raw?.approvalId === "string" ? raw.approvalId : null,
    threadId: typeof raw?.threadId === "string" ? raw.threadId : null
  };
}

/**
 * Resolves the chat route a notification tap should open, or null when the
 * response is not a navigable tap.
 *
 * This is the cold-start counterpart to `dispatchNotificationResponse`'s
 * deep-link branch. When the app is launched from a fully-killed state by a
 * notification tap, iOS does NOT replay the tap through
 * `addNotificationResponseReceivedListener` — the only way to recover it is
 * `Notifications.getLastNotificationResponse()`. The launch screen feeds that
 * stored response here to decide where to navigate.
 *
 * Returns null (no navigation) for:
 *   - an APPROVE / DENY action launch — those resolve the authorization via
 *     the background action handler, not by opening a chat. (In practice the
 *     non-foregrounding actions don't cold-launch the app, but guarding here
 *     keeps the resolver correct for any action that ever opens to foreground.)
 *   - a payload with no sessionId (silent wake, malformed, or a non-routing
 *     notification).
 *
 * A genuine default tap returns `{ sessionId, threadId }`; threadId is
 * non-null only for a threaded completion, matching the live-tap branch.
 */
export function resolveLaunchTapRoute(response: ResponseLike): LaunchTapRoute | null {
  if (
    response.actionIdentifier === APPROVE_ACTION ||
    response.actionIdentifier === DENY_ACTION
  ) {
    return null;
  }
  const { sessionId, threadId } = readRouting(response.notification.request.content.data);
  if (!sessionId) return null;
  return { sessionId, threadId };
}

// Native seams the launch-tap consume orchestration depends on, injected so
// the get → clear → navigate sequence is unit-testable without loading
// react-native / expo-notifications / expo-router.
export interface LaunchConsumeDeps {
  // Expo's stored launch tap (Notifications.getLastNotificationResponse).
  getLast: () => ResponseLike | null;
  // Notifications.clearLastNotificationResponse — drops the stored response
  // so it isn't re-evaluated on a later mount.
  clear: () => void;
  // Deep-link into the resolved chat / thread.
  navigate: (sessionId: string, threadId: string | null) => void;
}

/**
 * Pure orchestration for cold-start launch-tap recovery: read the stored
 * launch response, clear it exactly once, and navigate when it resolves to a
 * chat route.
 *
 * The clear is intentionally placed BEFORE the null-route gate: any observed
 * launch response — even a non-navigable one (an action launch, a silent
 * wake, a malformed payload) — must be cleared so it can't be re-evaluated on
 * the next mount. Only a genuine deep-link tap then navigates.
 *
 * The `push.ts` wrapper injects the real Notifications APIs + router; tests
 * inject spies to pin the clear-once and navigate-on-route semantics.
 */
export function consumeLaunchTap(deps: LaunchConsumeDeps): LaunchTapRoute | null {
  const last = deps.getLast();
  if (!last) return null;
  const route = resolveLaunchTapRoute(last);
  deps.clear();
  if (!route) return null;
  deps.navigate(route.sessionId, route.threadId);
  return route;
}

export interface DispatchDeps {
  apiCall: <T = unknown>(path: string, init?: { method?: string }) => Promise<T>;
  navigate: (sessionId: string, threadId: string | null) => void;
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
 *   - APPROVE button → POST /api/authorizations/:id/approve
 *   - DENY button → POST /api/authorizations/:id/deny
 *   - any other actionIdentifier (default tap, future actions) →
 *     navigate to the chat the payload names; a threaded completion
 *     carries `threadId` so the tap deep-links into the thread view
 *     (the main chat filters threaded blocks out, so opening it would
 *     hide the very reply the banner previewed)
 *
 * The action buttons only ride on `authorization_requested` pushes (the
 * server-side NSE attaches the APPROVAL_REQUEST category for that event
 * alone); setup requests need the app and deep-link on tap instead. The
 * approvalId carried by an authorization push is the authorization id, so
 * these post to /api/authorizations/:id/{approve,deny} — the canonical
 * routes in src/http.ts.
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
  const { sessionId, approvalId, threadId } = readRouting(
    response.notification.request.content.data
  );

  if (response.actionIdentifier === APPROVE_ACTION) {
    if (!approvalId) return { kind: "ignored" };
    try {
      // Percent-encode the id segment. The id is a server-generated opaque
      // token (`authz_…`), so this is a no-op for well-formed input; it's a
      // boundary guard so a malformed id from the push payload can't reshape
      // the request target (path traversal / query injection).
      await deps.apiCall(`/authorizations/${encodeURIComponent(approvalId)}/approve`, { method: "POST" });
      return { kind: "approve", approvalId };
    } catch {
      await deps.notifyFailure("approve");
      return { kind: "approve-failed", approvalId };
    }
  }

  if (response.actionIdentifier === DENY_ACTION) {
    if (!approvalId) return { kind: "ignored" };
    try {
      await deps.apiCall(`/authorizations/${encodeURIComponent(approvalId)}/deny`, { method: "POST" });
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
    deps.navigate(sessionId, threadId);
    return { kind: "tap", sessionId, threadId };
  }
  return { kind: "ignored" };
}
