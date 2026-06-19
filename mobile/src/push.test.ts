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
  buildChatRoute,
  consumeLaunchTap,
  DENY_ACTION,
  dispatchNotificationResponse,
  type LaunchConsumeDeps,
  resolveLaunchTapRoute,
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

  test("a well-formed approvalId passes through the path unchanged", async () => {
    // encodeURIComponent must be a no-op for the server's opaque id shape
    // (`authz_<hex>`) — every character is URL-unreserved.
    const deps = buildSpyDeps();
    const outcome = await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { approvalId: "authz_a1b2c3d4" }),
      deps
    );
    expect(outcome).toEqual({ kind: "approve", approvalId: "authz_a1b2c3d4" });
    expect(deps.calls.api).toEqual([
      { path: "/authorizations/authz_a1b2c3d4/approve", method: "POST" }
    ]);
  });

  test("a malformed approvalId is percent-encoded so it can't reshape the request path", async () => {
    // Boundary guard: a payload id containing path/query metacharacters must
    // not traverse out of /authorizations/:id/approve. The id is server-
    // generated so this can't happen in practice, but the encode keeps a
    // future regression / corrupt payload from retargeting the request.
    const deps = buildSpyDeps();
    await dispatchNotificationResponse(
      buildResponse(APPROVE_ACTION, { approvalId: "../authz_x/deny?x=" }),
      deps
    );
    expect(deps.calls.api).toEqual([
      { path: "/authorizations/..%2Fauthz_x%2Fdeny%3Fx%3D/approve", method: "POST" }
    ]);
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

  test("a throwing navigate rejects the dispatch promise (caller must catch)", async () => {
    // The navigate branch doesn't guard deps.navigate, so a synchronous throw
    // from router.push rejects the returned promise. The live listener's
    // fire-and-forget call site appends .catch() to keep that from surfacing
    // as an unhandled rejection; this pins the reject path it guards.
    const deps: DispatchDeps = {
      apiCall: async () => ({}) as never,
      navigate: () => { throw new Error("navigator not ready"); },
      notifyFailure: async () => {}
    };
    await expect(
      dispatchNotificationResponse(
        buildResponse("expo.modules.notifications.actions.DEFAULT", { sessionId: "chat_throw" }),
        deps
      )
    ).rejects.toThrow("navigator not ready");
  });
});

describe("resolveLaunchTapRoute (cold-start launch tap)", () => {
  test("a default tap resolves to the main chat route", () => {
    const route = resolveLaunchTapRoute(
      buildResponse("expo.modules.notifications.actions.DEFAULT", {
        sessionId: "chat_cold_1"
      })
    );
    expect(route).toEqual({ sessionId: "chat_cold_1", threadId: null });
  });

  test("a threaded completion launch tap carries threadId so it opens the thread view", () => {
    const route = resolveLaunchTapRoute(
      buildResponse("expo.modules.notifications.actions.DEFAULT", {
        sessionId: "chat_cold_2",
        threadId: "thread_cold_2"
      })
    );
    expect(route).toEqual({ sessionId: "chat_cold_2", threadId: "thread_cold_2" });
  });

  test("an APPROVE action launch does not navigate (resolves to null)", () => {
    // Approve/Deny resolve the authorization in the background handler, not
    // by opening a chat — even if such an action ever cold-launched the app.
    const route = resolveLaunchTapRoute(
      buildResponse(APPROVE_ACTION, { sessionId: "chat_cold_3", approvalId: "authz_3" })
    );
    expect(route).toBeNull();
  });

  test("a DENY action launch does not navigate (resolves to null)", () => {
    const route = resolveLaunchTapRoute(
      buildResponse(DENY_ACTION, { sessionId: "chat_cold_4", approvalId: "authz_4" })
    );
    expect(route).toBeNull();
  });

  test("a launch response with no sessionId resolves to null (silent wake / malformed)", () => {
    const route = resolveLaunchTapRoute(
      buildResponse("expo.modules.notifications.actions.DEFAULT", { threadId: "thread_only" })
    );
    expect(route).toBeNull();
  });

  test("a launch response with no data block resolves to null", () => {
    const route = resolveLaunchTapRoute(
      buildResponse("expo.modules.notifications.actions.DEFAULT", null)
    );
    expect(route).toBeNull();
  });
});

describe("buildChatRoute", () => {
  test("a main-chat route omits the thread segment", () => {
    expect(buildChatRoute("chat_1", null)).toBe("/chat/chat_1");
  });

  test("a thread route includes both segments", () => {
    expect(buildChatRoute("chat_1", "thread_2")).toBe("/chat/chat_1/thread/thread_2");
  });

  test("a well-formed id passes through unchanged (encode is a no-op)", () => {
    // Server ids are `[a-z0-9_]`, all URL-unreserved — encoding must not alter them.
    expect(buildChatRoute("chat_a1b2c3d4", "thread_e5f6")).toBe(
      "/chat/chat_a1b2c3d4/thread/thread_e5f6"
    );
  });

  test("a malformed sessionId is percent-encoded so it can't reshape the route", () => {
    expect(buildChatRoute("../setup?x=", null)).toBe("/chat/..%2Fsetup%3Fx%3D");
  });

  test("both segments are encoded on the thread path (the second is the easy one to miss)", () => {
    expect(buildChatRoute("../a?x=", "../b#y")).toBe(
      "/chat/..%2Fa%3Fx%3D/thread/..%2Fb%23y"
    );
  });
});

describe("consumeLaunchTap (get → clear-once → navigate orchestration)", () => {
  // Records the order and arguments of the injected native seams so each
  // test can pin both WHAT fired and the clear-before-navigate sequencing.
  function buildConsumeDeps(last: ResponseLike | null): LaunchConsumeDeps & {
    calls: { clear: number; navigate: Array<{ sessionId: string; threadId: string | null }> };
  } {
    const calls = { clear: 0, navigate: [] as Array<{ sessionId: string; threadId: string | null }> };
    return {
      getLast: () => last,
      clear: () => { calls.clear += 1; },
      navigate: (sessionId, threadId) => { calls.navigate.push({ sessionId, threadId }); },
      calls
    };
  }

  test("no stored response: neither clears nor navigates, returns null", () => {
    const deps = buildConsumeDeps(null);
    const route = consumeLaunchTap(deps);
    expect(route).toBeNull();
    expect(deps.calls.clear).toBe(0);
    expect(deps.calls.navigate).toEqual([]);
  });

  test("default tap: clears once then navigates to the resolved chat", () => {
    const deps = buildConsumeDeps(
      buildResponse("expo.modules.notifications.actions.DEFAULT", { sessionId: "chat_launch_1" })
    );
    const route = consumeLaunchTap(deps);
    expect(route).toEqual({ sessionId: "chat_launch_1", threadId: null });
    expect(deps.calls.clear).toBe(1);
    expect(deps.calls.navigate).toEqual([{ sessionId: "chat_launch_1", threadId: null }]);
  });

  test("threaded completion tap: navigates into the thread view", () => {
    const deps = buildConsumeDeps(
      buildResponse("expo.modules.notifications.actions.DEFAULT", {
        sessionId: "chat_launch_2",
        threadId: "thread_launch_2"
      })
    );
    const route = consumeLaunchTap(deps);
    expect(route).toEqual({ sessionId: "chat_launch_2", threadId: "thread_launch_2" });
    expect(deps.calls.navigate).toEqual([{ sessionId: "chat_launch_2", threadId: "thread_launch_2" }]);
  });

  test("non-navigable response (no sessionId): still clears once, never navigates", () => {
    // The clear-before-null-gate invariant: a silent wake / malformed launch
    // response must be cleared so it isn't re-evaluated on the next mount.
    const deps = buildConsumeDeps(
      buildResponse("expo.modules.notifications.actions.DEFAULT", { threadId: "thread_only" })
    );
    const route = consumeLaunchTap(deps);
    expect(route).toBeNull();
    expect(deps.calls.clear).toBe(1);
    expect(deps.calls.navigate).toEqual([]);
  });

  test("APPROVE action launch: clears once, never navigates", () => {
    const deps = buildConsumeDeps(
      buildResponse(APPROVE_ACTION, { sessionId: "chat_launch_3", approvalId: "authz_3" })
    );
    const route = consumeLaunchTap(deps);
    expect(route).toBeNull();
    expect(deps.calls.clear).toBe(1);
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
