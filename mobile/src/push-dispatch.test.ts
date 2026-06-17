// Unit tests for the notification-response dispatcher. Pins the action
// routing — especially that Approve / Deny post to the canonical
// /authorizations/:id/{approve,deny} routes (NOT the renamed-away
// /approvals/... path) — plus the deep-link-on-tap and failure-fallback
// paths. Pure module: no react-native / expo-notifications loaded.

import { describe, expect, test } from "bun:test";
import {
  dispatchNotificationResponse,
  APPROVE_ACTION,
  DENY_ACTION,
  type DispatchDeps,
  type ResponseLike
} from "./push-dispatch";

function makeResponse(actionIdentifier: string, data: unknown): ResponseLike {
  return {
    actionIdentifier,
    notification: { request: { content: { data } } }
  };
}

function makeDeps(overrides?: Partial<DispatchDeps>): {
  deps: DispatchDeps;
  calls: string[];
  navigated: string[];
  failures: string[];
} {
  const calls: string[] = [];
  const navigated: string[] = [];
  const failures: string[] = [];
  const deps: DispatchDeps = {
    apiCall: async <T = unknown>(path: string) => {
      calls.push(path);
      return undefined as T;
    },
    navigate: (sessionId) => {
      navigated.push(sessionId);
    },
    notifyFailure: async (verb) => {
      failures.push(verb);
    },
    ...overrides
  };
  return { deps, calls, navigated, failures };
}

describe("dispatchNotificationResponse", () => {
  test("APPROVE posts to the canonical /authorizations/:id/approve route", async () => {
    const { deps, calls } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse(APPROVE_ACTION, { approvalId: "authz_1" }),
      deps
    );
    expect(calls).toEqual(["/authorizations/authz_1/approve"]);
    expect(out).toEqual({ kind: "approve", approvalId: "authz_1" });
  });

  test("DENY posts to the canonical /authorizations/:id/deny route", async () => {
    const { deps, calls } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse(DENY_ACTION, { approvalId: "authz_2" }),
      deps
    );
    expect(calls).toEqual(["/authorizations/authz_2/deny"]);
    expect(out).toEqual({ kind: "deny", approvalId: "authz_2" });
  });

  test("APPROVE without an approvalId is ignored (no API call)", async () => {
    const { deps, calls } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse(APPROVE_ACTION, { sessionId: "chat_x" }),
      deps
    );
    expect(calls).toHaveLength(0);
    expect(out).toEqual({ kind: "ignored" });
  });

  test("DENY without an approvalId is ignored", async () => {
    const { deps, calls } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse(DENY_ACTION, {}),
      deps
    );
    expect(calls).toHaveLength(0);
    expect(out).toEqual({ kind: "ignored" });
  });

  test("APPROVE failure schedules a fallback notification", async () => {
    const { deps, failures } = makeDeps({
      apiCall: async <T = unknown>(): Promise<T> => {
        throw new Error("network down");
      }
    });
    const out = await dispatchNotificationResponse(
      makeResponse(APPROVE_ACTION, { approvalId: "authz_3" }),
      deps
    );
    expect(failures).toEqual(["approve"]);
    expect(out).toEqual({ kind: "approve-failed", approvalId: "authz_3" });
  });

  test("DENY failure schedules a fallback notification", async () => {
    const { deps, failures } = makeDeps({
      apiCall: async <T = unknown>(): Promise<T> => {
        throw new Error("5xx");
      }
    });
    const out = await dispatchNotificationResponse(
      makeResponse(DENY_ACTION, { approvalId: "authz_4" }),
      deps
    );
    expect(failures).toEqual(["deny"]);
    expect(out).toEqual({ kind: "deny-failed", approvalId: "authz_4" });
  });

  test("default tap deep-links to the chat when a sessionId is present", async () => {
    const { deps, navigated } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse("com.apple.UNNotificationDefaultActionIdentifier", { sessionId: "chat_y" }),
      deps
    );
    expect(navigated).toEqual(["chat_y"]);
    expect(out).toEqual({ kind: "tap", sessionId: "chat_y" });
  });

  test("a tap with no sessionId is ignored", async () => {
    const { deps, navigated } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse("com.apple.UNNotificationDefaultActionIdentifier", {}),
      deps
    );
    expect(navigated).toHaveLength(0);
    expect(out).toEqual({ kind: "ignored" });
  });

  test("tolerates null/absent content data", async () => {
    const { deps } = makeDeps();
    const out = await dispatchNotificationResponse(
      makeResponse("com.apple.UNNotificationDefaultActionIdentifier", null),
      deps
    );
    expect(out).toEqual({ kind: "ignored" });
  });
});
