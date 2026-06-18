// Unit tests for the action-dispatch core of mobile/src/push.ts.
//
// We test `dispatchNotificationResponse` directly because the rest of
// the module (permission flow, token registration, Expo subscription
// management) requires either a native build or a heavy mock surface.
// The dispatcher is the load-bearing branch — it routes lock-screen
// Approve / Deny buttons to the gateway without forcing the app to
// foreground.

import { describe, expect, test } from "bun:test";
import {
  APPROVAL_CATEGORY_ACTIONS,
  APPROVE_ACTION,
  DENY_ACTION,
  dispatchNotificationResponse,
  type DispatchDeps,
  type ResponseLike
} from "./push-dispatch";

// Builds the minimum shape `dispatchNotificationResponse` reads. Real
// notifications carry a much larger structure but the dispatcher only
// touches actionIdentifier + content.data.
function buildResponse(
  actionIdentifier: string,
  data: Record<string, unknown> | null
): ResponseLike {
  return {
    actionIdentifier,
    notification: { request: { content: data === null ? {} : { data } } }
  };
}

// Records every dependency call so each test can assert what fired.
function buildSpyDeps(opts?: {
  apiShouldThrow?: boolean;
}): DispatchDeps & {
  calls: {
    api: Array<{ path: string; method: string | undefined }>;
    navigate: Array<{ sessionId: string; threadId: string | null }>;
    notifyFailure: Array<"approve" | "deny">;
  };
} {
  const calls = {
    api: [] as Array<{ path: string; method: string | undefined }>,
    navigate: [] as Array<{ sessionId: string; threadId: string | null }>,
    notifyFailure: [] as Array<"approve" | "deny">
  };
  return {
    apiCall: async (path, init) => {
      calls.api.push({ path, method: init?.method });
      if (opts?.apiShouldThrow) throw new Error("network");
      return {} as never;
    },
    navigate: (sessionId, threadId) => { calls.navigate.push({ sessionId, threadId }); },
    notifyFailure: async (verb) => { calls.notifyFailure.push(verb); },
    calls
  };
}

describe("dispatchNotificationResponse", () => {
  test("APPROVE action posts to /authorizations/:id/approve and returns approve outcome", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { approvalId: "authz_1", sessionId: "chat_1" }),
      deps
    );
    expect(outcome).toEqual({ kind: "approve", approvalId: "authz_1" });
    // Posts to the canonical /authorizations/:id route (renamed away from
    // the old /approvals/:id) — the approvalId on an authorization push is
    // the authorization id.
    expect(deps.calls.api).toEqual([{ path: "/authorizations/authz_1/approve", method: "POST" }]);
    expect(deps.calls.navigate).toEqual([]);
    expect(deps.calls.notifyFailure).toEqual([]);
  });

  test("DENY action posts to /authorizations/:id/deny", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse(DENY_ACTION, { approvalId: "authz_2" }),
      deps
    );
    expect(outcome).toEqual({ kind: "deny", approvalId: "authz_2" });
    expect(deps.calls.api).toEqual([{ path: "/authorizations/authz_2/deny", method: "POST" }]);
  });

  test("APPROVE failure schedules a follow-up local notification", async () => {
    const deps = buildSpyDeps({ apiShouldThrow: true });
    const outcome = await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { approvalId: "appr_3" }),
      deps
    );
    expect(outcome).toEqual({ kind: "approve-failed", approvalId: "appr_3" });
    // Caller saw the network blow up — the user gets a visible alert
    // so they know to retry inside the app rather than silently losing
    // the action.
    expect(deps.calls.notifyFailure).toEqual(["approve"]);
  });

  test("DENY failure schedules a follow-up local notification", async () => {
    const deps = buildSpyDeps({ apiShouldThrow: true });
    const outcome = await dispatchNotificationResponse(
      buildResponse(DENY_ACTION, { approvalId: "appr_4" }),
      deps
    );
    expect(outcome).toEqual({ kind: "deny-failed", approvalId: "appr_4" });
    expect(deps.calls.notifyFailure).toEqual(["deny"]);
  });

  test("APPROVE / DENY without an approvalId is ignored (defensive)", async () => {
    const deps = buildSpyDeps();
    const noPayload = await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { sessionId: "chat_x" }),
      deps
    );
    expect(noPayload).toEqual({ kind: "ignored" });
    expect(deps.calls.api).toEqual([]);
  });

  test("Default tap deep-links to /chat/:sessionId", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      // `expo.modules.notifications.actions.DEFAULT` is the literal the
      // OS sends for a plain tap; the dispatcher treats any non-
      // Approve/non-Deny actionIdentifier as a default tap.
      buildResponse("expo.modules.notifications.actions.DEFAULT", {
        sessionId: "chat_5",
        approvalId: "appr_5"
      }),
      deps
    );
    // No threadId on this push → main-chat tap (threadId null).
    expect(outcome).toEqual({ kind: "tap", sessionId: "chat_5", threadId: null });
    expect(deps.calls.navigate).toEqual([{ sessionId: "chat_5", threadId: null }]);
    // Importantly: a plain tap on an approval notification does NOT
    // post to the approve / deny endpoints. The user has to use the
    // explicit action buttons or resolve the approval in-app.
    expect(deps.calls.api).toEqual([]);
  });

  test("Default tap on a threaded completion carries threadId so it deep-links to the thread view", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      // A message_completed push fired by threaded work carries threadId;
      // the banner shows the thread's reply, so the tap must open the
      // thread view (the main chat filters threaded blocks out).
      buildResponse("expo.modules.notifications.actions.DEFAULT", {
        sessionId: "chat_7",
        threadId: "thread_3"
      }),
      deps
    );
    expect(outcome).toEqual({ kind: "tap", sessionId: "chat_7", threadId: "thread_3" });
    expect(deps.calls.navigate).toEqual([{ sessionId: "chat_7", threadId: "thread_3" }]);
    expect(deps.calls.api).toEqual([]);
  });

  test("Default tap with no sessionId is ignored (no router push, no error)", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse("expo.modules.notifications.actions.DEFAULT", null),
      deps
    );
    expect(outcome).toEqual({ kind: "ignored" });
    expect(deps.calls.navigate).toEqual([]);
  });
});

describe("APPROVAL_CATEGORY_ACTIONS", () => {
  test("Approve requires authentication so it can't be granted from a locked screen", () => {
    const approve = APPROVAL_CATEGORY_ACTIONS.find((a) => a.identifier === APPROVE_ACTION);
    // Security invariant: approving authorizes the high-risk action the
    // agent paused on, so iOS must demand Face ID / Touch ID / passcode
    // before the handler runs. Without this a locked-phone holder could
    // approve a dangerous operation straight from the lock screen.
    expect(approve?.options.isAuthenticationRequired).toBe(true);
  });

  test("Deny is fail-safe: destructive styling, no auth gate, no foregrounding", () => {
    const deny = APPROVAL_CATEGORY_ACTIONS.find((a) => a.identifier === DENY_ACTION);
    // Denying only cancels the pending action (never grants), so it needs
    // no unlock; it's marked destructive for the red lock-screen styling.
    expect(deny?.options.isDestructive).toBe(true);
    expect(deny?.options.isAuthenticationRequired).toBe(false);
    expect(deny?.options.opensAppToForeground).toBe(false);
  });

  test("both actions dispatch in the background (no foregrounding)", () => {
    // The response listener routes Approve/Deny straight to the gateway;
    // neither action should force the app to foreground.
    for (const action of APPROVAL_CATEGORY_ACTIONS) {
      expect(action.options.opensAppToForeground).toBe(false);
    }
  });
});
