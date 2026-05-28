// Unit tests for the APNs dispatcher. Pins:
//   - approval_requested blocks fan out to every registered device
//     with the right payload + topic
//   - non-approval blocks (user_text, assistant_text, etc.) are
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
    lastSeenAt: overrides?.lastSeenAt ?? new Date().toISOString()
  };
}

describe("apns dispatcher", () => {
  test("fans approval_requested out to every registered device with the privacy-safe payload", async () => {
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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });

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

    await dispatcher.dispatch({
      id: "block_phase_fail",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 11,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Failed"
    });

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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });

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
    await dispatcher2.dispatch({
      id: "block_phase_done2",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 11,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });
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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });

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
    await dispatcher.dispatch({
      id: "phase_thinking",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 1,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Thinking"
    });
    await dispatcher.dispatch({
      id: "phase_cancelled",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 2,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Cancelled"
    });
    expect(calls.length).toBe(0);
    dispatcher.stop();
  });

  test("buildPhaseSilentPayload carries only routing fields and a number-typed content-available", () => {
    const payload = buildPhaseSilentPayload({
      id: "b1",
      sessionId: "chat_x",
      instance: "test-inst" as Instance,
      ordinal: 1,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });
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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed",
      taskId: "task_with_text"
    });

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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed",
      taskId: "task_tools_only"
    });

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

    await dispatcher.dispatch({
      id: "block_phase_fail",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 11,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Failed",
      taskId: "task_with_text"
    });

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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed",
      taskId: "task_with_text"
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.token).toBe("tok_iphone_b");
    expect(calls[0]!.opts.pushType).toBe("alert");
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

    await dispatcher.dispatch({
      id: "block_phase_done",
      sessionId: "chat_xyz",
      instance: "test-inst" as Instance,
      ordinal: 10,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed"
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.pushType).toBe("background");
    dispatcher.stop();
  });

  test("buildMessageCompletedPayload omits any user-authored content", () => {
    // Privacy assertion: the wire payload for a completion alert must
    // carry only routing ids and the generic title. No assistant text,
    // no tool output, nothing user-visible.
    const payload = buildMessageCompletedPayload({
      id: "b1",
      sessionId: "chat_x",
      instance: "test-inst" as Instance,
      ordinal: 1,
      createdAt: new Date().toISOString(),
      kind: "phase",
      label: "Completed",
      taskId: "task_x"
    });
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
