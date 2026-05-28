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
    navigate: string[];
    notifyFailure: Array<"approve" | "deny">;
  };
} {
  const calls = {
    api: [] as Array<{ path: string; method: string | undefined }>,
    navigate: [] as string[],
    notifyFailure: [] as Array<"approve" | "deny">
  };
  return {
    apiCall: async (path, init) => {
      calls.api.push({ path, method: init?.method });
      if (opts?.apiShouldThrow) throw new Error("network");
      return {} as never;
    },
    navigate: (sessionId) => { calls.navigate.push(sessionId); },
    notifyFailure: async (verb) => { calls.notifyFailure.push(verb); },
    calls
  };
}

describe("dispatchNotificationResponse", () => {
  test("APPROVE action posts to /approvals/:id/approve and returns approve outcome", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { approvalId: "appr_1", sessionId: "chat_1" }),
      deps
    );
    expect(outcome).toEqual({ kind: "approve", approvalId: "appr_1" });
    expect(deps.calls.api).toEqual([{ path: "/approvals/appr_1/approve", method: "POST" }]);
    expect(deps.calls.navigate).toEqual([]);
    expect(deps.calls.notifyFailure).toEqual([]);
  });

  test("DENY action posts to /approvals/:id/deny", async () => {
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse(DENY_ACTION, { approvalId: "appr_2" }),
      deps
    );
    expect(outcome).toEqual({ kind: "deny", approvalId: "appr_2" });
    expect(deps.calls.api).toEqual([{ path: "/approvals/appr_2/deny", method: "POST" }]);
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
    expect(outcome).toEqual({ kind: "tap", sessionId: "chat_5" });
    expect(deps.calls.navigate).toEqual(["chat_5"]);
    // Importantly: a plain tap on an approval notification does NOT
    // post to the approve / deny endpoints. The user has to use the
    // explicit action buttons or resolve the approval in-app.
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
