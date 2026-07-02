// Unit tests for the APNs dispatcher. Pins:
//   - authorization_requested blocks fan out to every registered device
//     with the right payload + topic
//   - non-prompt blocks (user_text, assistant_text, etc.) are
//     ignored — no push, no device list scan
//   - a 410 Unregistered response triggers token cleanup so the
//     dead token can't keep accruing pushes
//   - a non-410 failure (BadDeviceToken, apns_not_configured) leaves
//     the token in place — operator may recover the configuration

import { describe, expect, test } from "bun:test";
import {
  buildApprovalPayload,
  buildMessageCompletedPayload,
  buildPhaseSilentPayload,
  createApnsDispatcher
} from "./dispatcher";
import type { APNsClient, APNsPayload, APNsSendOptions, APNsSendResult } from "./client";
import type { ChatBlock, Instance } from "../../types";
import type { PushDevice } from "../../state";

function approvalBlock(overrides?: Partial<Extract<ChatBlock, { kind: "authorization_requested" }>>): Extract<ChatBlock, { kind: "authorization_requested" }> {
  return {
    id: "block_abc",
    sessionId: "chat_xyz",
    instance: "test-instance" as Instance,
    ordinal: 4,
    createdAt: new Date().toISOString(),
    kind: "authorization_requested",
    authorizationId: "appr_1",
    action: "terminal.exec",
    risk: "medium",
    summary: "Run `rm -rf foo`",
    ...overrides
  };
}

function phaseBlock(overrides?: Partial<Extract<ChatBlock, { kind: "phase" }>>): Extract<ChatBlock, { kind: "phase" }> {
  return {
    id: "block_phase_done",
    sessionId: "chat_xyz",
    instance: "test-inst" as Instance,
    ordinal: 10,
    createdAt: new Date().toISOString(),
    kind: "phase",
    label: "Completed",
    ...overrides
  };
}

function buildFakeClient(): { client: APNsClient; calls: Array<{ token: string; payload: APNsPayload; opts: APNsSendOptions }>; programResults: Map<string, APNsSendResult>; } {
  const calls: Array<{ token: string; payload: APNsPayload; opts: APNsSendOptions }> = [];
  const programResults = new Map<string, APNsSendResult>();
  const client: APNsClient = {
    async sendPush(token, payload, opts) {
      calls.push({ token, payload, opts });
      return programResults.get(token) ?? { ok: true, status: 200 };
    },
    close(): void { /* noop */ }
  };
  return { client, calls, programResults };
}

function buildDevice(overrides?: Partial<PushDevice>): PushDevice {
  return {
    token: overrides?.token ?? "tok",
    credentialId: overrides?.credentialId ?? "cred_a",
    platform: "ios",
    bundleId: overrides?.bundleId ?? "ai.lilaclabs.gini.mobile",
    registeredAt: overrides?.registeredAt ?? new Date().toISOString(),
    lastSeenAt: overrides?.lastSeenAt ?? new Date().toISOString(),
    origin: overrides?.origin ?? "loopback"
  };
}

describe("apns dispatcher", () => {
  test("fans authorization_requested out to every registered device with the privacy-safe payload", async () => {
    const { client, calls } = buildFakeClient();
    const devices = [
      buildDevice({ token: "tok_a", bundleId: "ai.lilaclabs.gini.mobile" }),
      buildDevice({ token: "tok_b", bundleId: "ai.lilaclabs.gini.mobile.dev" })
    ];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => devices,
      subscribe: () => () => { /* noop unsubscribe */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(calls.length).toBe(2);
    const byToken = new Map(calls.map((c) => [c.token, c]));
    const a = byToken.get("tok_a");
    const b = byToken.get("tok_b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Topic is per-device bundle id — prod and dev TestFlight installs
    // route to different APNs topics even with one set of creds.
    expect(a?.opts.topic).toBe("ai.lilaclabs.gini.mobile");
    expect(b?.opts.topic).toBe("ai.lilaclabs.gini.mobile.dev");
    expect(a?.opts.pushType).toBe("alert");
    expect(a?.opts.priority).toBe(10);
    expect(a?.opts.collapseId).toBe("appr_1");
    // Privacy: payload carries ids + generic title only, never the
    // approval summary or chat content. Routing fields live under
    // `body` because expo-notifications drops top-level userInfo keys
    // on the client — `userInfo["body"]` is what surfaces as
    // `content.data` in the JS layer.
    const aBody = a?.payload.body as Record<string, unknown>;
    expect(aBody.sessionId).toBe("chat_xyz");
    expect(aBody.blockId).toBe("block_abc");
    expect(aBody.approvalId).toBe("appr_1");
    expect(aBody.event).toBe("authorization_requested");
    expect(aBody.silent).toBe(false);
    const aps = a?.payload.aps as Record<string, unknown>;
    expect((aps.alert as Record<string, unknown>).title).toBe("Gini needs your approval");
    expect((aps.alert as Record<string, unknown>).body).toBe("Tap to review");
    expect(aps.category).toBe("APPROVAL_REQUEST");
    expect(aps["thread-id"]).toBe("chat_xyz");
    // `mutable-content: 1` is what causes iOS to invoke the
    // Notification Service Extension before display. The NSE attaches
    // the APPROVAL_REQUEST category id so the lock-screen Approve /
    // Deny actions surface — without this flag, the NSE never runs.
    // Number-typed (not boolean) per APNs spec: JSON `true`
    // is silently ignored.
    expect(aps["mutable-content"]).toBe(1);
    expect(typeof aps["mutable-content"]).toBe("number");
    // Defensive: nothing carrying the summary or action verb leaked
    // into the wire payload.
    const serialized = JSON.stringify(a?.payload);
    expect(serialized).not.toContain("Run `rm -rf foo`");
    expect(serialized).not.toContain("terminal_exec");

    dispatcher.stop();
  });

  test("setup_requested fans out WITHOUT the approve/deny category", async () => {
    // A setup request is a user-action flow (open browser, fill form),
    // not an approve/deny gate. Attaching APPROVAL_REQUEST would render
    // Approve/Deny buttons whose handler POSTs to /authorizations/:id —
    // a route that can't resolve a setup id. So the payload must omit the
    // category; the user taps in to complete the step.
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch({
      id: "block_setup",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 5,
      createdAt: new Date().toISOString(),
      kind: "setup_requested",
      setupRequestId: "setup_1",
      action: "browser.connect",
      summary: "Sign in to your email"
    });

    expect(calls.length).toBe(1);
    const aps = calls[0]!.payload.aps as Record<string, unknown>;
    // Still mutable (the NSE enriches the preview) and an alert, but no
    // approve/deny category.
    expect(aps["mutable-content"]).toBe(1);
    expect((aps.alert as Record<string, unknown>).title).toBe("Gini needs you to finish a step");
    expect(aps.category).toBeUndefined();
    const body = calls[0]!.payload.body as Record<string, unknown>;
    expect(body.event).toBe("setup_requested");
    expect(body.approvalId).toBe("setup_1");
    dispatcher.stop();
  });

  test("ignores non-approval blocks", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch({
      id: "b1",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 1,
      createdAt: new Date().toISOString(),
      kind: "user_text",
      text: "hi"
    });
    await dispatcher.dispatch({
      id: "b2",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "assistant_text",
      text: "hello",
      streaming: true
    });

    expect(calls.length).toBe(0);
    dispatcher.stop();
  });

  test("410 Unregistered triggers token cleanup", async () => {
    const { client, programResults } = buildFakeClient();
    programResults.set("dead_tok", { ok: false, status: 410, reason: "Unregistered" });
    programResults.set("live_tok", { ok: true, status: 200 });
    const invalidated: Array<{ instance: Instance; token: string }> = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "dead_tok" }), buildDevice({ token: "live_tok" })],
      onTokenInvalidated: (instance, token) => invalidated.push({ instance, token }),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(invalidated).toEqual([{ instance: "test-inst" as Instance, token: "dead_tok" }]);
  });

  test("non-410 failures leave the token in place", async () => {
    const { client, programResults } = buildFakeClient();
    programResults.set("bad_tok", { ok: false, status: 400, reason: "BadDeviceToken" });
    const invalidated: Array<{ instance: Instance; token: string }> = [];
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "bad_tok" })],
      onTokenInvalidated: (instance, token) => invalidated.push({ instance, token }),
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(invalidated.length).toBe(0);
    expect(warnings.some((w) => w.includes("BadDeviceToken"))).toBe(true);
  });

  test("terminal-phase Completed fires a silent background push when the user isn't watching", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a", credentialId: "owner" })],
      isWatching: () => false,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock());

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.opts.pushType).toBe("background");
    expect(call.opts.priority).toBe(5);
    expect(call.opts.collapseId).toBe("chat_xyz");
    // Wire payload: content-available is the literal number 1.
    const aps = call.payload.aps as Record<string, unknown>;
    expect(aps["content-available"]).toBe(1);
    // No alert envelope on silent pushes — iOS would treat the
    // presence of an alert as a regular notification, defeating the
    // wake-up-only intent.
    expect(aps.alert).toBeUndefined();
    // Routing fields live under `body` (see comment in buildApprovalPayload).
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_completed");
    expect(body.sessionId).toBe("chat_xyz");
    expect(body.blockId).toBe("block_phase_done");
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("terminal-phase Failed fires a silent push with event=phase_failed", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ id: "block_phase_fail", ordinal: 11, label: "Failed" }));

    expect(calls.length).toBe(1);
    const body = calls[0]!.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_failed");
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("terminal-phase push is suppressed when THIS device is watching the session", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_active" })],
      // Active SSE subscription keyed by device token + session → skip.
      isWatching: (_inst, tok, sess) => tok === "tok_active" && sess === "chat_xyz",
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock());

    expect(calls.length).toBe(0);

    // Drop the watch → next dispatch sends.
    let watching = false;
    const dispatcher2 = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_active" })],
      isWatching: () => watching,
      subscribe: () => () => { /* noop */ }
    });
    watching = false;
    await dispatcher2.dispatch(phaseBlock({ id: "block_phase_done2", ordinal: 11 }));
    expect(calls.length).toBe(1);
    dispatcher.stop();
    dispatcher2.stop();
  });

  test("per-device suppression: watching iPhone is skipped, backgrounded iPhone is not", async () => {
    // Two iPhones owned by the same human — same credential ("owner"),
    // distinct APNs tokens. iPhone A is foregrounded on chat_xyz over
    // SSE; iPhone B is in background. The dispatcher must skip A
    // (redundant — its SSE will deliver the block) but still wake B
    // so its badge can refresh.
    const { client, calls } = buildFakeClient();
    const watchingDevices = new Set(["tok_iphone_a"]);
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [
        buildDevice({ token: "tok_iphone_a", credentialId: "owner" }),
        buildDevice({ token: "tok_iphone_b", credentialId: "owner" })
      ],
      isWatching: (_inst, tok, sess) =>
        watchingDevices.has(tok) && sess === "chat_xyz",
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock());

    // iPhone B must receive the silent wake; iPhone A must not.
    expect(calls.length).toBe(1);
    expect(calls[0]!.token).toBe("tok_iphone_b");
    dispatcher.stop();
  });

  test("non-terminal phase blocks (Thinking, Working) are ignored", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      subscribe: () => () => { /* noop */ }
    });
    await dispatcher.dispatch(phaseBlock({ id: "phase_thinking", ordinal: 1, label: "Thinking" }));
    await dispatcher.dispatch(phaseBlock({ id: "phase_cancelled", ordinal: 2, label: "Cancelled" }));
    expect(calls.length).toBe(0);
    dispatcher.stop();
  });

  test("buildPhaseSilentPayload carries only routing fields and a number-typed content-available", () => {
    const payload = buildPhaseSilentPayload(phaseBlock({ id: "b1", sessionId: "chat_x", ordinal: 1 }));
    // Round-tripping through JSON preserves the numeric 1.
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire.aps["content-available"]).toBe(1);
    expect(typeof wire.aps["content-available"]).toBe("number");
    expect(wire.aps.alert).toBeUndefined();
    expect(wire.aps.sound).toBeUndefined();
    expect(wire.aps.badge).toBeUndefined();
    // Routing fields nested under `body` so expo-notifications surfaces
    // them on the client side.
    expect(wire.body.event).toBe("phase_completed");
    expect(wire.body.sessionId).toBe("chat_x");
    expect(wire.body.blockId).toBe("b1");
    expect(wire.body.silent).toBe(true);
  });

  test("Completed phase with assistant_text fires an alert push (message_completed)", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      // Task produced a user-visible assistant message → alert path.
      hasAssistantText: (_inst, taskId) => taskId === "task_with_text",
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    // Alert push, not background — the user gets a banner.
    expect(call.opts.pushType).toBe("alert");
    expect(call.opts.priority).toBe(10);
    expect(call.opts.collapseId).toBe("chat_xyz");
    const aps = call.payload.aps as Record<string, unknown>;
    const alert = aps.alert as Record<string, unknown>;
    expect(alert.title).toBe("Gini has a new message");
    expect(alert.body).toBe("Tap to read");
    expect(aps.sound).toBe("default");
    expect(aps["thread-id"]).toBe("chat_xyz");
    expect(aps["mutable-content"]).toBe(1);
    // No category id — these notifications only carry a tap action.
    expect(aps.category).toBeUndefined();
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("message_completed");
    expect(body.sessionId).toBe("chat_xyz");
    expect(body.blockId).toBe("block_phase_done");
    expect(body.silent).toBe(false);
    dispatcher.stop();
  });

  test("Completed phase without assistant_text falls back to silent push", async () => {
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      // Task ran tools but produced no user-visible message → silent path.
      hasAssistantText: () => false,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_tools_only" }));

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.opts.pushType).toBe("background");
    expect(call.opts.priority).toBe(5);
    const aps = call.payload.aps as Record<string, unknown>;
    expect(aps["content-available"]).toBe(1);
    expect(aps.alert).toBeUndefined();
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_completed");
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("Failed phase stays silent even when assistant_text exists", async () => {
    // A failed task may have emitted partial assistant text before
    // crashing, but failure noise shouldn't yell at the user. The badge
    // tick is enough; opening the chat surfaces the error.
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      hasAssistantText: () => true,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ id: "block_phase_fail", ordinal: 11, label: "Failed", taskId: "task_with_text" }));

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.opts.pushType).toBe("background");
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_failed");
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("alert completion push is suppressed when THIS device is watching", async () => {
    // Per-device suppression must apply to alerts the same way it
    // applies to silents — if the user is foregrounded on the chat over
    // SSE, the block is already on its way down the stream.
    const { client, calls } = buildFakeClient();
    const watchingDevices = new Set(["tok_iphone_a"]);
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [
        buildDevice({ token: "tok_iphone_a", credentialId: "owner" }),
        buildDevice({ token: "tok_iphone_b", credentialId: "owner" })
      ],
      isWatching: (_inst, tok, sess) =>
        watchingDevices.has(tok) && sess === "chat_xyz",
      hasAssistantText: () => true,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    expect(calls.length).toBe(1);
    expect(calls[0]!.token).toBe("tok_iphone_b");
    expect(calls[0]!.opts.pushType).toBe("alert");
    dispatcher.stop();
  });

  test("web-watched session downgrades a completion ALERT to a silent badge refresh on the phone", async () => {
    // When a web/CLI client is reading the session as the turn completes,
    // the phone must NOT buzz — but it must still get a silent wake so its
    // badge stays accurate (web reads don't clear the phone's per-device
    // read cursor).
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_phone", credentialId: "owner" })],
      // The phone itself is NOT watching over SSE (it's in the user's
      // pocket); only the web app is.
      isWatching: () => false,
      isWebWatched: (_inst, sess) => sess === "chat_xyz",
      hasAssistantText: () => true,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    // The phone still receives a push, but as a SILENT background wake —
    // no banner, no sound.
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.token).toBe("tok_phone");
    expect(call.opts.pushType).toBe("background");
    expect(call.opts.priority).toBe(5);
    const aps = call.payload.aps as Record<string, unknown>;
    expect(aps["content-available"]).toBe(1);
    expect(aps.alert).toBeUndefined();
    expect(aps.sound).toBeUndefined();
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_completed");
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("send-then-close: web no longer watching at completion → phone gets the alert", async () => {
    // Same user, but they closed the web tab before the turn finished.
    // The pushless entry is gone by push time, so isWebWatched is false
    // and the phone correctly gets its banner.
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_phone", credentialId: "owner" })],
      isWatching: () => false,
      // Web tab already closed — no live web stream on this session.
      isWebWatched: () => false,
      hasAssistantText: () => true,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.opts.pushType).toBe("alert");
    expect(call.opts.priority).toBe(10);
    const aps = call.payload.aps as Record<string, unknown>;
    expect((aps.alert as Record<string, unknown>).title).toBe("Gini has a new message");
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("message_completed");
    expect(body.silent).toBe(false);
    dispatcher.stop();
  });

  test("web-watching does not change an already-silent push, and isWebWatched is not consulted", async () => {
    // A Completed-with-no-assistant_text turn is already silent, so there's
    // no banner to downgrade — the dispatcher short-circuits before the web
    // check (the downgrade only guards the alert branch). Even with
    // isWebWatched returning true, the push stays silent, and the predicate
    // is never called.
    const { client, calls } = buildFakeClient();
    let webWatchedCalls = 0;
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_phone" })],
      isWatching: () => false,
      isWebWatched: () => { webWatchedCalls += 1; return true; },
      hasAssistantText: () => false,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_tools_only" }));

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.opts.pushType).toBe("background");
    const body = call.payload.body as Record<string, unknown>;
    expect(body.event).toBe("phase_completed");
    expect(body.silent).toBe(true);
    // The web check is skipped entirely when the push wouldn't alert.
    expect(webWatchedCalls).toBe(0);
    dispatcher.stop();
  });

  test("web-watch downgrade composes with per-device suppression", async () => {
    // Two phones (same human) + an open web tab. Phone A is foregrounded
    // on the chat over SSE → suppressed entirely. Phone B is in the
    // pocket → would normally get an ALERT, but the web tab downgrades it
    // to a silent badge refresh.
    const { client, calls } = buildFakeClient();
    const watching = new Set(["tok_phone_a"]);
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [
        buildDevice({ token: "tok_phone_a", credentialId: "owner" }),
        buildDevice({ token: "tok_phone_b", credentialId: "owner" })
      ],
      isWatching: (_inst, tok, sess) => watching.has(tok) && sess === "chat_xyz",
      isWebWatched: () => true,
      hasAssistantText: () => true,
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    // Only phone B is contacted, and as a silent wake.
    expect(calls.length).toBe(1);
    expect(calls[0]!.token).toBe("tok_phone_b");
    expect(calls[0]!.opts.pushType).toBe("background");
    const body = calls[0]!.payload.body as Record<string, unknown>;
    expect(body.silent).toBe(true);
    dispatcher.stop();
  });

  test("isWebWatched throwing falls back to sending the alert", async () => {
    // A predicate fault must not swallow the user's notification — the
    // safe default is to deliver the banner the user would otherwise get.
    const { client, calls } = buildFakeClient();
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_phone" })],
      isWatching: () => false,
      isWebWatched: () => {
        throw new Error("registry boom");
      },
      hasAssistantText: () => true,
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_with_text" }));

    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.pushType).toBe("alert");
    expect(warnings.some((w) => w.includes("isWebWatched failed"))).toBe(true);
    dispatcher.stop();
  });

  test("Completed phase with no taskId falls back to silent (conservative)", async () => {
    // Without a taskId we can't look up assistant_text history, so the
    // safer default is silent. This keeps pre-task-binding callers and
    // any edge-case emitters from spuriously banner-ing the user.
    const { client, calls } = buildFakeClient();
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      hasAssistantText: () => {
        throw new Error("must not be called when taskId is absent");
      },
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock());

    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.pushType).toBe("background");
    dispatcher.stop();
  });

  test("buildMessageCompletedPayload omits any user-authored content", () => {
    // Privacy assertion: the wire payload for a completion alert must
    // carry only routing ids and the generic title. No assistant text,
    // no tool output, nothing user-visible.
    const payload = buildMessageCompletedPayload(
      phaseBlock({ id: "b1", sessionId: "chat_x", ordinal: 1, taskId: "task_x" })
    );
    const wire = JSON.stringify(payload);
    // Defensive: a sample of strings that must never leak into push
    // payloads. If a future change starts forwarding chat text, these
    // assertions catch it.
    expect(wire).not.toContain("task_x");
    expect(wire).not.toContain("Hello"); // common assistant lead-in
    expect(wire).not.toContain("user_text");
    // Routing fields surface as expected.
    const body = payload.body as Record<string, unknown>;
    expect(body.sessionId).toBe("chat_x");
    expect(body.blockId).toBe("b1");
    expect(body.event).toBe("message_completed");
    expect(body.silent).toBe(false);
    // No threadId on a main-chat completion.
    expect(body.threadId).toBeUndefined();
  });

  test("buildMessageCompletedPayload carries threadId for a threaded completion", () => {
    // So the NSE's preview fetch resolves the thread's own reply rather
    // than stale main-chat text.
    const payload = buildMessageCompletedPayload(
      phaseBlock({ id: "b2", sessionId: "chat_x", ordinal: 2, taskId: "task_y", threadId: "thread_9" })
    );
    const body = payload.body as Record<string, unknown>;
    expect(body.threadId).toBe("thread_9");
    expect(body.sessionId).toBe("chat_x");
    expect(body.event).toBe("message_completed");
  });

  test("a throwing onTokenInvalidated on 410 is caught and warned, not propagated", async () => {
    // The 410 cleanup hook runs inside a try/catch so a DB fault during
    // token removal can't crash the fan-out for the other devices.
    const { client, programResults } = buildFakeClient();
    programResults.set("dead_tok", { ok: false, status: 410, reason: "Unregistered" });
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "dead_tok" })],
      onTokenInvalidated: () => {
        throw new Error("db locked");
      },
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(warnings.some((w) => w.includes("token cleanup failed"))).toBe(true);
    dispatcher.stop();
  });

  test("a client.sendPush that throws is caught and warned", async () => {
    const calls: string[] = [];
    const throwingClient: APNsClient = {
      async sendPush() {
        throw new Error("socket hang up");
      },
      close(): void { /* noop */ }
    };
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client: throwingClient,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      warn: (msg) => { warnings.push(msg); calls.push(msg); },
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(warnings.some((w) => w.includes("sendPush threw"))).toBe(true);
    dispatcher.stop();
  });

  test("a throwing listDevices is caught on the approval path (no devices, no crash)", async () => {
    const { client, calls } = buildFakeClient();
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => {
        throw new Error("devices table gone");
      },
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(approvalBlock());

    expect(calls.length).toBe(0);
    expect(warnings.some((w) => w.includes("listDevices failed"))).toBe(true);
    dispatcher.stop();
  });

  test("a throwing listDevices is caught on the phase-completion path", async () => {
    const { client, calls } = buildFakeClient();
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => {
        throw new Error("devices table gone");
      },
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_x" }));

    expect(calls.length).toBe(0);
    expect(warnings.some((w) => w.includes("listDevices failed"))).toBe(true);
    dispatcher.stop();
  });

  test("a throwing hasAssistantText falls back to the silent path", async () => {
    const { client, calls } = buildFakeClient();
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      hasAssistantText: () => {
        throw new Error("blocks query failed");
      },
      warn: (msg) => warnings.push(msg),
      subscribe: () => () => { /* noop */ }
    });

    await dispatcher.dispatch(phaseBlock({ taskId: "task_x" }));

    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.pushType).toBe("background");
    expect(warnings.some((w) => w.includes("hasAssistantText failed"))).toBe(true);
    dispatcher.stop();
  });

  test("the production subscribe seam delivers blocks to dispatch", async () => {
    // Exercises the real subscribe(handler) wiring: the dispatcher
    // registers a handler that forwards blocks to dispatch(). We drive a
    // block through the captured handler and assert the fan-out happened.
    // (The rejection-routing half of that handler is covered by the next
    // test.)
    const { client, calls } = buildFakeClient();
    let captured: ((block: ChatBlock) => void) | undefined;
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      isWatching: () => false,
      hasAssistantText: () => false,
      warn: (msg) => warnings.push(msg),
      subscribe: (_inst, handler) => {
        captured = handler;
        return () => { /* noop */ };
      }
    });

    expect(captured).toBeDefined();
    // A terminal phase block drives a (silent) push through the handler.
    captured?.(phaseBlock({ id: "block_from_seam", ordinal: 1, taskId: "task_x" }));
    // The handler's dispatch() is fire-and-forget; let the microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.pushType).toBe("background");
    dispatcher.stop();
  });

  test("a rejection from the subscribe handler's dispatch is routed to warn", async () => {
    // The subscribe handler is fire-and-forget — it can't await dispatch().
    // If dispatch() REJECTS (an error past the per-path try/catch, e.g.
    // payload construction on a malformed block after a successful device
    // list), the handler's .catch must surface it via warn rather than
    // leaving an unhandled rejection. We force that by returning a device
    // list (so the payload-build line is reached) but driving an approval
    // block whose id accessor throws during payload construction.
    const { client } = buildFakeClient();
    let captured: ((block: ChatBlock) => void) | undefined;
    const warnings: string[] = [];
    const dispatcher = createApnsDispatcher("test-inst" as Instance, {
      client,
      listDevices: () => [buildDevice({ token: "tok_a" })],
      warn: (msg) => warnings.push(msg),
      subscribe: (_inst, handler) => {
        captured = handler;
        return () => { /* noop */ };
      }
    });

    // A malformed authorization block: accessing `authorizationId` throws,
    // which buildApprovalPayload triggers AFTER listDevices succeeds —
    // outside dispatchApproval's try, so dispatch() rejects.
    const malformed = {
      id: "block_bad",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 1,
      createdAt: new Date().toISOString(),
      kind: "authorization_requested",
      action: "terminal.exec",
      risk: "medium",
      summary: "boom"
    } as unknown as ChatBlock;
    Object.defineProperty(malformed, "authorizationId", {
      get() { throw new Error("payload build boom"); }
    });

    captured?.(malformed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.some((w) => w.includes("dispatch rejected"))).toBe(true);
    dispatcher.stop();
  });

  test("the default warn (no injected warn dep) logs via console.warn without throwing", async () => {
    // Exercises the default warn closure — both the detail and no-detail
    // branches — when no `warn` dep is supplied. We swap console.warn to a
    // capture so the assertion is deterministic and no noise hits the test
    // output.
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const { client, programResults } = buildFakeClient();
      // A non-410 failure → the no-detail warn branch
      // (`sendPush failed ...`). A 410 with a throwing cleanup → the
      // with-detail branch (`token cleanup failed`, err message).
      programResults.set("bad_tok", { ok: false, status: 400, reason: "BadDeviceToken" });
      programResults.set("dead_tok", { ok: false, status: 410, reason: "Unregistered" });
      const dispatcher = createApnsDispatcher("test-inst" as Instance, {
        client,
        listDevices: () => [buildDevice({ token: "bad_tok" }), buildDevice({ token: "dead_tok" })],
        onTokenInvalidated: () => { throw new Error("cleanup boom"); },
        // No `warn` dep — the default console.warn closure runs.
        subscribe: () => () => { /* noop */ }
      });

      await dispatcher.dispatch(approvalBlock());

      expect(lines.some((l) => l.includes("[apns-dispatcher] sendPush failed"))).toBe(true);
      expect(lines.some((l) => l.includes("[apns-dispatcher] token cleanup failed"))).toBe(true);
      dispatcher.stop();
    } finally {
      console.warn = original;
    }
  });

  test("buildApprovalPayload produces a stable, privacy-safe shape", () => {
    const block = approvalBlock();
    const payload = buildApprovalPayload(block);
    // Top-level keys: aps + body. expo-notifications drops top-level
    // userInfo keys other than `body`, so routing fields must nest
    // inside body to reach the JS client.
    expect(Object.keys(payload).sort()).toEqual(["aps", "body"]);
    const body = payload.body as Record<string, unknown>;
    expect(body.sessionId).toBe(block.sessionId);
    expect(body.blockId).toBe(block.id);
    expect(body.approvalId).toBe(block.authorizationId);
    expect(body.event).toBe("authorization_requested");
    expect(body.silent).toBe(false);
  });
});
