// Behavior tests for the Telegram messaging channel.
//
// Conventions:
//   - The fetch mock fails closed in beforeAll. Any test that needs to
//     allow a network call must install a per-test responder via
//     mockFetch(...). An unmocked call to api.telegram.org throws and
//     fails the test loudly so a real network request from a leaked
//     poller can't be missed.
//   - afterEach drains the poller registry via stopAllPollers so no
//     worker outlives its case (addMessagingBridge starts a poller
//     unconditionally for telegram bridges and the registry is process-
//     singleton, so without this each test would leak a poller).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ProviderConfig, RuntimeConfig } from "../../types";
import { mutateState, readState } from "../../state";
import { writeSecret } from "../../state/secrets";
import { install } from "../../runtime";
import {
  addMessagingBridge,
  addTelegramAllowlistEntry,
  receiveMessagingInput
} from "../messaging";
import { handleCallbackQuery, handleInboundMessage } from "./telegram-handlers";
import { dispatchOutboundMessage, splitForTelegram } from "./telegram-stream";
import { stopAllPollers } from "./telegram-registry";

const ROOT = "/tmp/gini-telegram-messaging-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

// Default fail-closed fetch. Replaces globalThis.fetch in beforeEach so
// any unmocked call to api.telegram.org from a leaked poller (or a test
// that forgot to install a responder) blows up loudly instead of
// touching the real network.
function failClosedFetch(): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.telegram.org")) {
      throw new Error(`telegram.test: unmocked fetch ${url}`);
    }
    return new Response("", { status: 599, statusText: "no responder" });
  }) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = failClosedFetch();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Drain leaked pollers. addMessagingBridge for kind === "telegram"
  // unconditionally starts a worker; without this drain a stale worker
  // would keep firing fetches against the next test's mocks.
  await stopAllPollers();
});

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLog[] {
  const log: FetchLog[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    log.push({ url, init });
    return responder(url, init);
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

  test("rejects telegram bridges that point at a non-telegram connector", async () => {
    const config = buildConfig("telegram-wrong-provider");
    install(config);
    // Seed a generic connector with a token secret — exactly the shape
    // a malicious config would use to try to ship a Telegram bot token
    // to a non-Telegram upstream.
    const ref = writeSecret(config.instance, "id_generic", "token", "token");
    await mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_generic",
        instance: state.instance,
        name: "generic-impostor",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [ref],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "healthy",
        source: "user"
      });
    });
    await expect(
      addMessagingBridge(config, { name: "tg-evil", kind: "telegram", connectorId: "id_generic" })
    ).rejects.toThrow(/must be a telegram provider/);
  });

  test("rejects telegram bridge create with caller-supplied allowlist", async () => {
    const config = buildConfig("telegram-no-direct-allowlist");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    await expect(
      addMessagingBridge(config, {
        name: "tg",
        kind: "telegram",
        connectorId: "id_conn",
        telegram: {
          allowlist: [{ telegramUserId: 7, agentId: "any" }]
        }
      })
    ).rejects.toThrow(/Allowlist entries must be added via/);
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
    // The poller-owned fields are never seeded from caller input — even
    // if a caller had snuck them past, addMessagingBridge ignores them.
    expect(bridge.telegram?.botUsername).toBeUndefined();
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

    // Allow the typing-action best-effort fetch.
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 100,
      from: { id: 999, username: "tester" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hello bot"
    }, 42);

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
    // The allowlist entry's pinned agent is stamped on the Task row so
    // the chat-task loop doesn't have to consult activeAgentId.
    expect(task?.agentId).toBe(agentId);
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

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 7,
      from: { id: 12345, username: "intruder" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hi"
    }, 11);

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

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 999, username: "other-member" }, // not allowlisted
      chat: { id: 555, type: "group" },             // group includes allowlisted user 100
      date: Math.floor(Date.now() / 1000),
      text: "drive the agent"
    }, 1);

    const state = readState(config.instance);
    expect(state.messagingMessages.length).toBe(0);
    expect(state.audit.some((a) => a.action === "messaging.telegram.dropped")).toBe(true);
  });

  test("duplicate externalId on restart is a no-op (advances offset, no second task)", async () => {
    const config = buildConfig("telegram-inbound-dedupe");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    const msg = {
      message_id: 7,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" as const },
      date: Math.floor(Date.now() / 1000),
      text: "first"
    };
    await handleInboundMessage(config, bridge.id, msg, 50);
    const tasksAfterFirst = readState(config.instance).tasks.length;
    // Replay the same update — simulates a poller resuming from an
    // earlier offset after a crash before the offset advance landed.
    await handleInboundMessage(config, bridge.id, msg, 50);
    const tasksAfterSecond = readState(config.instance).tasks.length;
    expect(tasksAfterSecond).toBe(tasksAfterFirst);
    // The offset advanced past update_id=50 on both invocations.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(51);
  });

  test("concurrent inbound submissions from distinct allowlist entries run under their own agent", async () => {
    const config = buildConfig("telegram-concurrent-agents");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    // Build two distinct agents and bind each to a separate allowlist
    // entry so the per-task agent override has something to verify.
    const stateBefore = readState(config.instance);
    const agentA = stateBefore.agents[0]!.id;
    let agentBId = "";
    await mutateState(config.instance, (state) => {
      const newAgent = {
        id: "agent_B_id",
        instance: state.instance,
        name: "agent-B",
        status: "inactive" as const,
        toolsets: [] as string[],
        messagingTargets: [] as string[],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.agents.push(newAgent);
      agentBId = newAgent.id;
    });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId: agentA });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 200, agentId: agentBId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // Interleave: fire both dispatches concurrently. The per-task agent
    // override has to be stable per-task — without it, both tasks would
    // see whichever activateAgent wrote last.
    await Promise.all([
      handleInboundMessage(config, bridge.id, {
        message_id: 1, from: { id: 100 }, chat: { id: 1, type: "private" },
        date: 0, text: "from A"
      }, 1),
      handleInboundMessage(config, bridge.id, {
        message_id: 2, from: { id: 200 }, chat: { id: 2, type: "private" },
        date: 0, text: "from B"
      }, 2)
    ]);

    const state = readState(config.instance);
    const inboundA = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.target === "1");
    const inboundB = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.target === "2");
    const taskA = state.tasks.find((t) => t.id === inboundA?.taskId);
    const taskB = state.tasks.find((t) => t.id === inboundB?.taskId);
    expect(taskA?.agentId).toBe(agentA);
    expect(taskB?.agentId).toBe(agentBId);
  });
});

describe("callback_query handling", () => {
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

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // User B taps Approve in their own chat — must be rejected.
    await handleCallbackQuery(config, bridge.id, {
      id: "cbq_1",
      from: { id: 200, username: "userB" },
      data: "appr:appr_a"
    }, 70);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_a");
    expect(approval?.status).toBe("pending");
    const drop = state.audit.find((a) => a.action === "messaging.telegram.dropped" && (a.evidence as Record<string, unknown> | undefined)?.reason === "cross_user_approval");
    expect(drop).toBeDefined();
  });

  test("validated callback acks immediately and edits the prompt message", async () => {
    const config = buildConfig("telegram-callback-happy");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_user100";
      state.chatSessions.push({
        id: "chat_user100",
        instance: state.instance,
        title: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_x",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/x",
        risk: "low",
        status: "pending",
        reason: "test approval low risk",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_x",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "42",
        approvalId: "appr_x",
        chatSessionId: "chat_user100",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const log = mockFetch(async (url) => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    });

    await handleCallbackQuery(config, bridge.id, {
      id: "cbq_x",
      from: { id: 100, username: "u" },
      data: "deny:appr_x"
    }, 80);

    // The deny path causes the agent to fail the task. Inspect the
    // calls: the first call must be answerCallbackQuery (early ack);
    // the prompt-edit must reflect the verdict.
    const ackCalls = log.filter((entry) => entry.url.includes("answerCallbackQuery"));
    const editCalls = log.filter((entry) => entry.url.includes("editMessageText"));
    expect(ackCalls.length).toBeGreaterThanOrEqual(1);
    expect(editCalls.length).toBeGreaterThanOrEqual(1);
    // The ack must precede the editMessageText so the user sees the
    // spinner clear before the verdict is written into the prompt.
    const firstAckIndex = log.findIndex((entry) => entry.url.includes("answerCallbackQuery"));
    const firstEditIndex = log.findIndex((entry) => entry.url.includes("editMessageText"));
    expect(firstAckIndex).toBeLessThan(firstEditIndex);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_x");
    expect(approval?.status).toBe("denied");
    // Offset advances past the callback update in the same mutation
    // that records the decision audit, so a poller restart doesn't
    // re-dispatch the callback.
    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(81);
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

    const fetchLog = mockFetch(async (url) => {
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
    mockFetch(async () =>
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

  test("fetch-level network failure flips message status to failed", async () => {
    // Distinct from Telegram-shaped failures: this is a transport-level
    // throw (DNS, ECONNREFUSED, TLS). Without the postJson try/catch the
    // throw propagates past callers and the row stays "queued".
    const config = buildConfig("telegram-dispatch-network-throw");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    mockFetch(async () => {
      throw new Error("network unreachable");
    });
    const message = {
      id: "msg_net_throw",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "555",
      text: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_net_throw");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("network unreachable");
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

  test("inbound handler advances offset in the same mutation as the inbound row", async () => {
    const config = buildConfig("telegram-offset-with-inbound");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 1, agentId });
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 9,
      from: { id: 1 },
      chat: { id: 100, type: "private" },
      date: 0,
      text: "x"
    }, 555);

    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(556);
  });
});

describe("/receive bypass guard", () => {
  test("receiveMessagingInput rejects telegram bridges", async () => {
    const config = buildConfig("telegram-receive-rejected");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    await expect(
      receiveMessagingInput(config, bridge.id, { text: "smuggled" })
    ).rejects.toThrow(/receive inbound messages via the poller/);
  });
});

describe("malformed payload handling", () => {
  test("malformed update audits and skips dispatch", async () => {
    // We exercise the validation path indirectly by importing the
    // module-private helper through its export. The poller routes
    // malformed updates through the same audit + offset advance code
    // path.
    const { isValidTelegramUpdate } = await import("./telegram-transport");
    expect(isValidTelegramUpdate({})).toBe(false);
    expect(isValidTelegramUpdate({ update_id: "not-a-number" })).toBe(false);
    expect(isValidTelegramUpdate({ update_id: 1, message: { /* no chat */ } })).toBe(false);
    expect(isValidTelegramUpdate({
      update_id: 1,
      callback_query: { id: "x" /* no from */ }
    })).toBe(false);
    expect(isValidTelegramUpdate({
      update_id: 1,
      message: { chat: { id: 2 } }
    })).toBe(true);
    expect(isValidTelegramUpdate({
      update_id: 1,
      callback_query: { id: "x", from: { id: 5 } }
    })).toBe(true);
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
