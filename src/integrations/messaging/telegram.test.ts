// Behavior tests for the Telegram messaging channel. We mock fetch so
// no real Telegram traffic happens; the tests focus on the security
// gates (allowlist by user_id, cross-user approval prevention) and the
// data-flow invariants (updateOffset round-trip, message status flips).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ProviderConfig, RuntimeConfig } from "../../types";
import { mutateState, readState } from "../../state";
import { writeSecret } from "../../state/secrets";
import { install } from "../../runtime";
import { addMessagingBridge, addTelegramAllowlistEntry } from "../messaging";
import { handleCallbackQuery, handleInboundMessage } from "./telegram-handlers";
import { dispatchOutboundMessage, splitForTelegram } from "./telegram-stream";

const ROOT = "/tmp/gini-telegram-messaging-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function captureFetch(responder: (url: string) => Response | Promise<Response>): FetchLog[] {
  const log: FetchLog[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    log.push({ url, init });
    return responder(url);
  }) as typeof fetch;
  return log;
}

function buildConfig(instance: string): RuntimeConfig {
  const provider: ProviderConfig = { name: "echo", model: "gini-echo-v0" };
  return {
    instance,
    port: 0,
    token: "test",
    provider,
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

async function seedTelegramConnector(config: RuntimeConfig, connectorId: string, token: string): Promise<void> {
  const ref = writeSecret(config.instance, connectorId, "token", token);
  await mutateState(config.instance, (state) => {
    state.connectors.push({
      id: connectorId,
      instance: state.instance,
      name: "telegram-test",
      provider: "telegram",
      status: "configured",
      scopes: [],
      secretRefs: [ref],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      health: "healthy",
      source: "user"
    });
  });
}

describe("addMessagingBridge for telegram", () => {
  test("rejects telegram bridges without connectorId", async () => {
    const config = buildConfig("telegram-no-connector");
    install(config);
    await expect(
      addMessagingBridge(config, { name: "telegram-bot", kind: "telegram" })
    ).rejects.toThrow(/require connectorId/);
  });

  test("creates a telegram bridge with allowlist + offset initialized", async () => {
    const config = buildConfig("telegram-create");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    expect(bridge.kind).toBe("telegram");
    expect(bridge.connectorId).toBe("id_conn");
    expect(bridge.telegram?.allowlist).toEqual([]);
    expect(bridge.telegram?.updateOffset).toBe(0);
  });
});

describe("inbound message authorization", () => {
  test("allowlisted user_id submits a chat-mode task with stamped target", async () => {
    const config = buildConfig("telegram-allowlist-ok");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, {
      telegramUserId: 999,
      telegramUsername: "tester",
      agentId
    });

    // Mock sendChatAction so the best-effort typing indicator doesn't
    // touch the real network.
    captureFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 100,
      from: { id: 999, username: "tester" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hello bot"
    });

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound).toBeDefined();
    expect(inbound!.target).toBe("555");
    expect(inbound!.externalId).toBe("100");
    expect(inbound!.text).toBe("hello bot");
    expect(inbound!.chatSessionId).toBeDefined();
    expect(inbound!.taskId).toBeDefined();

    const task = state.tasks.find((t) => t.id === inbound!.taskId);
    expect(task?.mode).toBe("chat");
  });

  test("non-allowlisted user_id drops with an audit row", async () => {
    const config = buildConfig("telegram-allowlist-drop");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 1, agentId });

    captureFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 7,
      from: { id: 12345, username: "intruder" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hi"
    });

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound).toBeUndefined();
    const audit = state.audit.find((a) => a.action === "messaging.telegram.dropped");
    expect(audit).toBeDefined();
    expect(audit?.evidence).toMatchObject({ reason: "unauthorized", telegramUserId: 12345 });
  });

  test("authorization is by from.id, not chat.id (group-chat scenario)", async () => {
    // Same chat.id, but the sender's user_id is NOT allowlisted. Even
    // though an allowlisted user might be in the same group, the
    // non-allowlisted member's message must drop.
    const config = buildConfig("telegram-chatid-not-auth");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    // Allowlist user 100 only.
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    captureFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 999, username: "other-member" }, // not allowlisted
      chat: { id: 555, type: "group" },             // group includes allowlisted user 100
      date: Math.floor(Date.now() / 1000),
      text: "drive the agent"
    });

    const state = readState(config.instance);
    expect(state.messagingMessages.length).toBe(0);
    expect(state.audit.some((a) => a.action === "messaging.telegram.dropped")).toBe(true);
  });
});

describe("callback_query cross-user approval prevention", () => {
  test("rejects a callback whose from.id doesn't own the approval's chat session", async () => {
    const config = buildConfig("telegram-cross-user");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    // Two allowlisted users, A and B. Each gets a session.
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 200, agentId });

    // Seed: user A had an approval prompt emitted into their session.
    // Build the messaging message + approval row directly so we don't
    // depend on the full LLM loop.
    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_userA";
      liveBridge.telegram!.allowlist[1]!.chatSessionId = "chat_userB";
      state.chatSessions.push({
        id: "chat_userA",
        instance: state.instance,
        title: "A",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_a",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/a",
        risk: "high",
        status: "pending",
        reason: "test approval",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_a",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "9",
        approvalId: "appr_a",
        chatSessionId: "chat_userA",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    // Mock answerCallbackQuery so the rejection path can speak back.
    captureFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // User B taps Approve in their own chat — must be rejected.
    await handleCallbackQuery(config, bridge.id, {
      id: "cbq_1",
      from: { id: 200, username: "userB" },
      data: "appr:appr_a"
    });

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_a");
    expect(approval?.status).toBe("pending");
    const drop = state.audit.find((a) => a.action === "messaging.telegram.dropped" && (a.evidence as Record<string, unknown> | undefined)?.reason === "cross_user_approval");
    expect(drop).toBeDefined();
  });
});

describe("dispatchOutboundMessage", () => {
  test("connector-resolves the token and stamps externalId on success", async () => {
    const config = buildConfig("telegram-dispatch-ok");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token_value");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });

    const fetchLog = captureFetch(async (url) => {
      // Confirm the token went into the URL (the Bot API path includes
      // the token). We never log the token via audit — only here in the
      // test do we see it.
      expect(url).toContain("/bottoken_value/");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
    });

    const message = await mutateState(config.instance, (state) => {
      return {
        id: "msg_out_1",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound" as const,
        status: "queued" as const,
        target: "555",
        text: "hello",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    await mutateState(config.instance, (state) => {
      state.messagingMessages.unshift(message);
    });

    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);

    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_out_1");
    expect(updated?.status).toBe("sent");
    expect(updated?.externalId).toBe("4242");
    expect(fetchLog.length).toBeGreaterThan(0);
  });

  test("Telegram HTTP failure flips message status to failed with error captured", async () => {
    const config = buildConfig("telegram-dispatch-fail");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    captureFetch(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
    );
    const message = {
      id: "msg_fail",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "bogus-chat",
      text: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_fail");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("chat not found");
  });
});

describe("updateOffset persistence", () => {
  test("updateOffset survives a write-then-read round trip", async () => {
    const config = buildConfig("telegram-offset-roundtrip");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
      live.telegram!.updateOffset = 12345;
    });
    // Force a state re-read by going through readState again.
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    expect(reloaded.telegram?.updateOffset).toBe(12345);
  });
});

describe("splitForTelegram", () => {
  test("short text stays in one chunk", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  test("oversized text splits across multiple chunks", () => {
    const chunk = "x".repeat(5000);
    const parts = splitForTelegram(chunk);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    // Reassemble — splitForTelegram drops the newline join marker so
    // the recombined string equals the original when there are no
    // newlines.
    expect(parts.join("")).toBe(chunk);
  });
});
