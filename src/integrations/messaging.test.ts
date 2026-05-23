import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import {
  addMessagingBridge,
  checkMessagingBridge,
  disableMessagingBridge,
  readBridgeBotToken,
  resetMessagingDeps,
  sendMessagingOutput,
  setMessagingDeps
} from "./messaging";
import type { TelegramClient } from "./telegram";
import type { DiscordClient } from "./discord";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-messaging-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

interface StubCall { method: string; args: unknown[] }

// Wait for a set of task ids to reach a terminal state before
// returning. Used by tests that spawn real chat tasks through
// receiveMessagingInput — submitTask runs runTask detached, and a
// task still in flight when the next test file's testConfig rebinds
// GINI_STATE_ROOT would land its state write against the wrong
// instance directory and throw "Task not found".
async function waitForTaskSettled(
  config: RuntimeConfig,
  taskIds: string[],
  isTerminal: (status: import("../types").TaskStatus) => boolean,
  timeoutMs = 5000
): Promise<void> {
  const { readState } = await import("../state");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = readState(config.instance).tasks;
    const allDone = taskIds.every((id) => {
      const task = tasks.find((t) => t.id === id);
      return task ? isTerminal(task.status) : false;
    });
    if (allDone) return;
    await Bun.sleep(10);
  }
  throw new Error(`Tasks did not settle within ${timeoutMs}ms: ${taskIds.join(", ")}`);
}

function stubClient(overrides: Partial<TelegramClient> = {}): { client: TelegramClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client: TelegramClient = {
    getMe: async () => {
      calls.push({ method: "getMe", args: [] });
      return { id: 11, is_bot: true, username: "ginibot" };
    },
    sendMessage: async (chatId, text, opts) => {
      calls.push({ method: "sendMessage", args: [chatId, text, opts] });
      return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
    },
    sendChatAction: async (chatId, action) => {
      calls.push({ method: "sendChatAction", args: [chatId, action] });
      return true as const;
    },
    sendPhoto: async (chatId, source, opts) => {
      calls.push({ method: "sendPhoto", args: [chatId, source, opts] });
      return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
    },
    getFile: async (fileId) => {
      calls.push({ method: "getFile", args: [fileId] });
      return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
    },
    downloadFile: async (path) => {
      calls.push({ method: "downloadFile", args: [path] });
      return new Uint8Array([1, 2, 3]).buffer;
    },
    getUpdates: async () => {
      calls.push({ method: "getUpdates", args: [] });
      return [];
    },
    ...overrides
  };
  return { client, calls };
}

describe("messaging telegram wiring", () => {
  afterEach(() => resetMessagingDeps());

  test("addMessagingBridge requires a botToken for telegram and persists it via the secret store", async () => {
    const config = testConfig("telegram-add");

    await expect(
      addMessagingBridge(config, { name: "tg", kind: "telegram", deliveryTargets: ["123"] })
    ).rejects.toThrow(/botToken/);

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "SECRET-TOKEN"
    });

    expect(bridge.kind).toBe("telegram");
    expect(bridge.secretRefs?.[0]?.purpose).toBe("bot-token");
    // The plaintext token must round-trip through the encrypted store but
    // must never appear on the bridge record itself.
    expect(JSON.stringify(bridge)).not.toContain("SECRET-TOKEN");
    expect(readBridgeBotToken(config, bridge)).toBe("SECRET-TOKEN");
  });

  test("checkMessagingBridge calls getMe and records the bot username on metadata", async () => {
    const config = testConfig("telegram-health");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "TOK"
    });
    const checked = await checkMessagingBridge(config, bridge.id);

    expect(calls.map((c) => c.method)).toEqual(["getMe"]);
    expect(checked.status).toBe("configured");
    expect(checked.metadata?.botUsername).toBe("ginibot");
    expect(checked.message).toContain("@ginibot");
  });

  test("checkMessagingBridge surfaces a telegram error as bridge.status=error", async () => {
    const config = testConfig("telegram-health-err");
    setMessagingDeps({
      telegramClientFactory: () => stubClient({ getMe: async () => { throw new Error("Unauthorized"); } }).client
    });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "TOK"
    });
    const checked = await checkMessagingBridge(config, bridge.id);

    expect(checked.status).toBe("error");
    expect(checked.message).toContain("Unauthorized");
  });

  test("sendMessagingOutput dispatches to Telegram and records sent status", async () => {
    const config = testConfig("telegram-send");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["42"],
      botToken: "TOK"
    });
    const outbound = await sendMessagingOutput(config, bridge.id, { text: "hi from gini" });

    expect(outbound.status).toBe("sent");
    expect(outbound.target).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    const [chatId, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(chatId).toBe("42");
    expect(payload).toBe("hi from gini");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("MarkdownV2 transform runs on outbound text by default", async () => {
    const config = testConfig("telegram-send-mdv2");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await sendMessagingOutput(config, bridge.id, { text: "see **README.md**!" });

    const [, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(payload).toBe("see *README\\.md*\\!");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("replyToMessageId on send threads the reply onto an inbound message", async () => {
    const config = testConfig("telegram-send-reply-to");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await sendMessagingOutput(config, bridge.id, { text: "hi", replyToMessageId: 99 });
    const [, , opts] = calls[0]!.args as [string, string, { parseMode?: string; replyToMessageId?: number } | undefined];
    expect(opts?.replyToMessageId).toBe(99);
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("parseMode=\"none\" skips the transform and sends raw text", async () => {
    const config = testConfig("telegram-send-raw");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await sendMessagingOutput(config, bridge.id, { text: "ver. 1.2", parseMode: "none" });

    const [, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(payload).toBe("ver. 1.2");
    expect(opts).toBeUndefined();
  });

  test("sendMessagingOutput threads its AbortSignal into the Telegram client", async () => {
    const config = testConfig("telegram-send-signal");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const controller = new AbortController();
    await sendMessagingOutput(config, bridge.id, { text: "hi" }, { signal: controller.signal });
    const [, , opts] = calls[0]!.args as [string, string, { signal?: AbortSignal } | undefined];
    expect(opts?.signal).toBe(controller.signal);
  });

  test("sendMessagingOutput marks the message failed when Telegram throws", async () => {
    const config = testConfig("telegram-send-err");
    setMessagingDeps({
      telegramClientFactory: () =>
        stubClient({ sendMessage: async () => { throw new Error("Bad Request: chat not found"); } }).client
    });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });
    const outbound = await sendMessagingOutput(config, bridge.id, { text: "hello" });

    expect(outbound.status).toBe("failed");
    expect(outbound.error).toContain("chat not found");
  });

  test("photo input dispatches sendPhoto with the caption and MarkdownV2 parseMode", async () => {
    const config = testConfig("telegram-send-photo-url");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["55"],
      botToken: "TOK"
    });

    const outbound = await sendMessagingOutput(config, bridge.id, {
      text: "see **chart.png**",
      photo: { url: "https://example.com/c.png" }
    });

    expect(outbound.status).toBe("sent");
    expect(outbound.media).toEqual({ kind: "photo", url: "https://example.com/c.png" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendPhoto");
    const [chatId, source, opts] = calls[0]!.args as [
      string,
      { kind: string; url?: string },
      { caption?: string; parseMode?: string }
    ];
    expect(chatId).toBe("55");
    expect(source).toEqual({ kind: "url", url: "https://example.com/c.png" });
    expect(opts?.caption).toBe("see *chart\\.png*");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("photo input with no text sends a photo without a caption", async () => {
    const config = testConfig("telegram-send-photo-nocaption");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    await sendMessagingOutput(config, bridge.id, {
      photo: { fileId: "AgADX1Q" }
    });

    const [, source, opts] = calls[0]!.args as [string, unknown, { caption?: string; parseMode?: string }];
    expect(source).toEqual({ kind: "fileId", fileId: "AgADX1Q" });
    expect(opts?.caption).toBeUndefined();
    expect(opts?.parseMode).toBeUndefined();
  });

  test("send requires either text or a photo", async () => {
    const config = testConfig("telegram-send-empty");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await expect(sendMessagingOutput(config, bridge.id, {})).rejects.toThrow(/text or a photo/);
  });

  test("telegram inbound runs through a per-chat ChatSession (creates once, reuses on next message)", async () => {
    const config = testConfig("telegram-inbound-chat-session");
    const { client } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const { receiveMessagingInput, findTelegramChatSession } = await import("./messaging");
    const { readState } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await receiveMessagingInput(config, bridge.id, { text: "first", target: "555" });
    await receiveMessagingInput(config, bridge.id, { text: "second", target: "555" });

    const sessions = readState(config.instance).chatSessions;
    const telegramSessions = sessions.filter(
      (s) => s.source?.kind === "telegram" && s.source.bridgeId === bridge.id && s.source.chatId === 555
    );
    expect(telegramSessions).toHaveLength(1);
    expect(telegramSessions[0]?.source).toEqual({
      kind: "telegram",
      bridgeId: bridge.id,
      chatId: 555,
      target: "555"
    });

    const found = findTelegramChatSession(config, bridge.id, 555);
    expect(found?.id).toBe(telegramSessions[0]!.id);

    // Both user turns landed in the same session.
    const userMessages = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === telegramSessions[0]!.id && m.role === "user"
    );
    expect(userMessages.map((m) => m.content)).toEqual(["first", "second"]);
  });

  test("non-telegram bridges keep using the standalone-task path", async () => {
    const config = testConfig("messaging-demo-no-chat-session");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const { receiveMessagingInput } = await import("./messaging");
    const { readState } = await import("../state");

    // Demo bridges don't need a token and don't go through chat sessions.
    const bridge = await addMessagingBridge(config, {
      name: "local",
      kind: "demo",
      deliveryTargets: ["local"]
    });
    await receiveMessagingInput(config, bridge.id, { text: "hello", target: "local" });

    const sessions = readState(config.instance).chatSessions;
    expect(sessions.filter((s) => s.source !== undefined)).toEqual([]);
  });

  test("fresh bridge denies every chat — even the owner's first DM — until explicitly enrolled", async () => {
    const config = testConfig("telegram-no-tofu");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { authorizeTelegramChat, listAllowedChats } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    // The owner's first DM is denied. No trust-on-first-use.
    expect(await authorizeTelegramChat(config, bridge.id, 4242)).toBe(false);
    // Groups are denied for the same reason.
    expect(await authorizeTelegramChat(config, bridge.id, -987654321)).toBe(false);

    const view = listAllowedChats(config, bridge.id);
    expect(view.allowedChatIds).toEqual([]);
    expect(view.ownerChatId).toBeUndefined();
  });

  test("recordDeniedChatAttempt accumulates pending chats up to the cap, deduped by chatId", async () => {
    const config = testConfig("telegram-denied-attempts");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { listAllowedChats, recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    // Two attempts from the same chat collapse to one entry with the
    // newer timestamp.
    await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "@shelden"
    });
    await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "@shelden"
    });
    // Plus an attempt from a different chat.
    await recordDeniedChatAttempt(config, bridge.id, {
      chatId: -7000,
      chatType: "supergroup",
      sender: "@alice"
    });

    const view = listAllowedChats(config, bridge.id);
    expect(view.recentDeniedChats).toHaveLength(2);
    const byId = Object.fromEntries(view.recentDeniedChats.map((e) => [e.chatId, e]));
    expect(byId[4242]?.sender).toBe("@shelden");
    expect(byId[-7000]?.chatType).toBe("supergroup");
  });

  test("allowChat enrolls a chat and clears it from the recent-denied list; first enroll captures ownerChatId", async () => {
    const config = testConfig("telegram-allow-clears-denied");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { allowChat, authorizeTelegramChat, listAllowedChats, recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await recordDeniedChatAttempt(config, bridge.id, { chatId: 4242, chatType: "private", sender: "@shelden" });

    const enrolled = await allowChat(config, bridge.id, 4242);
    expect(enrolled.allowedChatIds).toEqual([4242]);
    expect(enrolled.ownerChatId).toBe(4242);
    // The enrolled chat is no longer "pending" — moved to the allowed
    // list, so the owner's view stays clean.
    expect(enrolled.recentDeniedChats.find((e) => e.chatId === 4242)).toBeUndefined();
    expect(await authorizeTelegramChat(config, bridge.id, 4242)).toBe(true);

    // A second allow (a group, say) doesn't overwrite ownerChatId.
    const withGroup = await allowChat(config, bridge.id, -7000);
    expect(withGroup.ownerChatId).toBe(4242);
    expect(withGroup.allowedChatIds.sort((a, b) => a - b)).toEqual([-7000, 4242]);

    expect(listAllowedChats(config, bridge.id).ownerChatId).toBe(4242);
  });

  test("allowChat is idempotent for an already-allowlisted chatId: no duplicate audit, no duplicate greeting", async () => {
    // A double-clicked Approve (or any caller invoking allowChat twice
    // on a chat that's already enrolled) would otherwise write a second
    // messaging.chat.allowed audit row, bump updatedAt, and re-send the
    // "Paired" greeting. None of those reflect a state change, and the
    // duplicate audit row pollutes the trail. Pin the idempotency.
    const config = testConfig("telegram-allow-idempotent");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });
    const { allowChat, recordDeniedChatAttempt } = await import("./messaging");
    const { readState: readStateLocal } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    await recordDeniedChatAttempt(config, bridge.id, { chatId: 4242, chatType: "private", sender: "@shelden" });

    await allowChat(config, bridge.id, 4242);
    const auditAfterFirst = readStateLocal(config.instance).audit.filter(
      (entry) => entry.action === "messaging.chat.allowed" && entry.target === bridge.id
    ).length;
    const greetingCallsAfterFirst = calls.filter((c) => c.method === "sendMessage").length;
    const updatedAtAfterFirst = readStateLocal(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.updatedAt;
    expect(auditAfterFirst).toBe(1);
    expect(greetingCallsAfterFirst).toBe(1);

    // Second allow on the same chatId — already enrolled — must no-op.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await allowChat(config, bridge.id, 4242);
    const auditAfterSecond = readStateLocal(config.instance).audit.filter(
      (entry) => entry.action === "messaging.chat.allowed" && entry.target === bridge.id
    ).length;
    const greetingCallsAfterSecond = calls.filter((c) => c.method === "sendMessage").length;
    const updatedAtAfterSecond = readStateLocal(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.updatedAt;
    expect(auditAfterSecond).toBe(1);
    expect(greetingCallsAfterSecond).toBe(1);
    expect(updatedAtAfterSecond).toBe(updatedAtAfterFirst);
  });

  test("rejectPendingChat clears the row from recentDeniedChats without granting allowlist access", async () => {
    const config = testConfig("telegram-reject-pending-keeps-allowlist");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { allowChat, authorizeTelegramChat, listAllowedChats, recordDeniedChatAttempt, rejectPendingChat } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    // Seed an existing allowlist entry so we can later assert it stays
    // untouched across the reject call — the failure mode we're guarding
    // against is reject accidentally removing or adding allowlist rows.
    await allowChat(config, bridge.id, 11);
    await recordDeniedChatAttempt(config, bridge.id, { chatId: 4242, chatType: "private", sender: "@shelden" });
    await recordDeniedChatAttempt(config, bridge.id, { chatId: 9999, chatType: "private", sender: "@iris" });

    const view = await rejectPendingChat(config, bridge.id, 4242);
    expect(view.recentDeniedChats.map((entry) => entry.chatId)).toEqual([9999]);
    expect(view.allowedChatIds).toEqual([11]);
    expect(view.ownerChatId).toBe(11);

    // The rejected chat is still denied — reject doesn't enrol it.
    expect(await authorizeTelegramChat(config, bridge.id, 4242)).toBe(false);

    // Idempotent: rejecting an already-cleared chatId is a no-op that
    // still returns the current allowlist view rather than throwing.
    const again = await rejectPendingChat(config, bridge.id, 4242);
    expect(again.recentDeniedChats.map((entry) => entry.chatId)).toEqual([9999]);

    expect(listAllowedChats(config, bridge.id).allowedChatIds).toEqual([11]);
  });

  test("recordDeniedChatAttempt no-ops when the chat became allowlisted before the deny write", async () => {
    // The Telegram poller authorizes outside mutateState, so an operator
    // approval that lands after the read but before recordDeniedChatAttempt
    // gets the lock must NOT cause the chat to re-appear in
    // recentDeniedChats. Simulate the race by allowlisting the chat
    // before recording the deny.
    const config = testConfig("telegram-deny-races-allow");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { allowChat, listAllowedChats, recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    await allowChat(config, bridge.id, 4242);

    await recordDeniedChatAttempt(config, bridge.id, { chatId: 4242, chatType: "private", sender: "@shelden" });

    const view = listAllowedChats(config, bridge.id);
    expect(view.allowedChatIds).toEqual([4242]);
    expect(view.recentDeniedChats.find((entry) => entry.chatId === 4242)).toBeUndefined();
  });

  test("denyChat removes a chat but keeps ownerChatId on metadata as audit history", async () => {
    const config = testConfig("telegram-deny-keeps-owner");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { allowChat, authorizeTelegramChat, denyChat, listAllowedChats } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await allowChat(config, bridge.id, 11);
    await allowChat(config, bridge.id, -7000);
    const after = await denyChat(config, bridge.id, -7000);
    expect(after.allowedChatIds).toEqual([11]);
    expect(after.ownerChatId).toBe(11);

    expect(await authorizeTelegramChat(config, bridge.id, -7000)).toBe(false);
    expect(listAllowedChats(config, bridge.id).allowedChatIds).toEqual([11]);
  });

  test("fresh telegram bridge does not pre-mint any enrollment code; verification codes are minted per DM", async () => {
    const config = testConfig("telegram-no-pre-mint");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    // No pre-minted code on a fresh bridge — the new flow waits for
    // a user DM and mints a verification code at that point.
    expect(bridge.metadata?.pairingCode).toBeUndefined();
    expect(bridge.metadata?.pairingCodeExpiresAt).toBeUndefined();
  });

  test("recordDeniedChatAttempt mints a verification code in AB-1A-22 format for private DMs", async () => {
    const config = testConfig("telegram-verify-mint");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const entry = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "alice"
    });

    expect(entry?.verificationCode).toMatch(/^[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}$/);
    expect(typeof entry?.verificationCodeExpiresAt).toBe("string");
    expect(Date.parse(String(entry?.verificationCodeExpiresAt))).toBeGreaterThan(Date.now());
  });

  test("recordDeniedChatAttempt reuses an unexpired code for repeated DMs from the same chat", async () => {
    const config = testConfig("telegram-verify-reuse");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const first = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "alice"
    });
    const second = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "alice"
    });

    expect(second?.verificationCode).toBe(first?.verificationCode);
    expect(second?.verificationCodeExpiresAt).toBe(first?.verificationCodeExpiresAt);
    // The poller uses mintedFreshCode to skip the outbound Telegram
    // send on the reuse leg — otherwise a single chat spamming DMs
    // would burn outbound quota and inflate audit / message rows.
    expect(first?.mintedFreshCode).toBe(true);
    expect(second?.mintedFreshCode).toBe(false);
    // mintedFreshCode is a caller-side hint, not persisted state.
    const { readState: readStateLocal } = await import("../state");
    const live = readStateLocal(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    const stored = (live?.metadata?.recentDeniedChats as Array<Record<string, unknown>>)?.find(
      (e) => e.chatId === 4242
    );
    expect(stored).toBeDefined();
    expect("mintedFreshCode" in (stored ?? {})).toBe(false);
  });

  test("recordDeniedChatAttempt mints a fresh code after the previous one expired", async () => {
    const config = testConfig("telegram-verify-expired");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { recordDeniedChatAttempt } = await import("./messaging");
    const { mutateState } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const first = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "alice"
    });

    // Backdate the recorded expiry so the next DM sees a stale code.
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      const meta = (live?.metadata ?? {}) as Record<string, unknown>;
      const entries = meta.recentDeniedChats as Array<Record<string, unknown>> | undefined;
      const match = entries?.find((e) => e.chatId === 4242);
      if (match) match.verificationCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
    });

    const second = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      sender: "alice"
    });

    expect(second?.verificationCode).not.toBe(first?.verificationCode);
    expect(Date.parse(String(second?.verificationCodeExpiresAt))).toBeGreaterThan(Date.now());
  });

  test("recordDeniedChatAttempt does not mint a verification code for group chats", async () => {
    const config = testConfig("telegram-verify-groups");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { recordDeniedChatAttempt } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const entry = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: -987654321,
      chatType: "supergroup",
      sender: "grouper"
    });

    // The entry still lands on the pending list so the operator can
    // approve by chat_id, but there's no per-user code to deliver
    // since groups have no safe per-user channel.
    expect(entry?.chatId).toBe(-987654321);
    expect(entry?.verificationCode).toBeUndefined();
    expect(entry?.verificationCodeExpiresAt).toBeUndefined();
  });

  test("deliverVerificationCode threads its signal through to the Telegram client", async () => {
    // The poller composes AbortSignal.timeout(10_000) with its loop
    // signal and passes the result down so a hung outbound Telegram
    // socket can't pin the poll loop. Without end-to-end threading,
    // the signal stops at sendMessagingOutputWithRetries and the
    // underlying fetch sits in `await response.json()` for the OS-
    // default window. Pin the threading at every hop.
    const config = testConfig("telegram-verify-signal");
    const observedSignals: Array<AbortSignal | undefined> = [];
    const { client } = stubClient({
      sendMessage: async (chatId, text, opts) => {
        observedSignals.push(opts?.signal);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      }
    });
    setMessagingDeps({ telegramClientFactory: () => client });
    const { deliverVerificationCode } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const controller = new AbortController();
    const result = await deliverVerificationCode(config, bridge.id, {
      chatId: 9001,
      code: "AB-CD-EF",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      signal: controller.signal
    });
    expect(result.ok).toBe(true);
    expect(observedSignals.length).toBe(1);
    expect(observedSignals[0]).toBe(controller.signal);
  });

  test("sendMessagingOutputWithRetries returns ok:false fast when the caller signal is already aborted", async () => {
    // A hung Telegram socket landing late shouldn't have the retry
    // helper keep spinning past the caller's abort — when the poller
    // shuts down or the per-call timeout fires, the helper exits with
    // ok:false on the very next attempt boundary instead of sleeping
    // through the backoff window.
    const config = testConfig("telegram-verify-aborted");
    const observedSignals: Array<AbortSignal | undefined> = [];
    const { client } = stubClient({
      sendMessage: async (chatId, text, opts) => {
        observedSignals.push(opts?.signal);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      }
    });
    setMessagingDeps({ telegramClientFactory: () => client });
    const { deliverVerificationCode } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const controller = new AbortController();
    controller.abort(new Error("test-cancel"));
    const result = await deliverVerificationCode(config, bridge.id, {
      chatId: 9002,
      code: "AB-CD-EF",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      signal: controller.signal
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/abort/i);
    }
    expect(observedSignals.length).toBe(0);
  });

  test("disableMessagingBridge erases the stored bot token", async () => {
    const config = testConfig("telegram-disable");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await disableMessagingBridge(config, bridge.id);
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);

    expect(live?.status).toBe("disabled");
    expect(live?.secretRefs ?? []).toEqual([]);
    // Reading a token after disable must fail (file gone), so the helper
    // returns undefined for a bridge with no refs.
    expect(readBridgeBotToken(config, live!)).toBeUndefined();
  });

  test("removeMessagingBridge drops the record + deletes secrets, leaves history alone, emits audit", async () => {
    const config = testConfig("telegram-remove");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { removeMessagingBridge } = await import("./messaging");
    const { readState: readStateLocal } = await import("../state");
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    // Confirm the secret file is on disk before remove.
    const secretsDir = join(config.stateRoot, "secrets");
    const beforeFiles = existsSync(secretsDir)
      ? readdirSync(secretsDir).filter((f) => f.startsWith(`messaging.${bridge.id}.`))
      : [];
    expect(beforeFiles.length).toBeGreaterThan(0);

    const result = await removeMessagingBridge(config, bridge.id);
    expect(result).toEqual({ id: bridge.id, removed: true });

    // State no longer carries the bridge.
    const live = readStateLocal(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live).toBeUndefined();

    // Secret files swept.
    const afterFiles = existsSync(secretsDir)
      ? readdirSync(secretsDir).filter((f) => f.startsWith(`messaging.${bridge.id}.`))
      : [];
    expect(afterFiles).toEqual([]);

    // Audit row recorded with the documented action + risk + evidence.
    const audit = readStateLocal(config.instance).audit.find(
      (e) => e.action === "messaging.removed" && e.target === bridge.id
    );
    expect(audit).toBeDefined();
    expect(audit?.risk).toBe("medium");
    expect((audit?.evidence as { kind?: string; name?: string } | undefined)?.kind).toBe("telegram");
    expect((audit?.evidence as { kind?: string; name?: string } | undefined)?.name).toBe("tg");
  });

  test("removeMessagingBridge throws on an unknown id and leaves state untouched", async () => {
    const config = testConfig("telegram-remove-unknown");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { removeMessagingBridge } = await import("./messaging");
    const { readState: readStateLocal } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    await expect(removeMessagingBridge(config, "bridge_does_not_exist"))
      .rejects.toThrow(/Messaging bridge not found/);
    // The real bridge is untouched.
    const live = readStateLocal(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.id).toBe(bridge.id);
  });

  test("concurrent removeMessagingBridge calls emit a single audit row", async () => {
    // Two callers racing on the same bridge id both pass the pre-lock
    // existence check (readState is unsynchronized). Before the fix, both
    // mutators would unconditionally write a `messaging.removed` audit row
    // and return removed:true, so the audit trail carried duplicates for
    // one logical removal. Now the second mutator sees index<0 inside the
    // lock and returns removed:false, leaving a single audit row.
    const config = testConfig("telegram-remove-concurrent");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { removeMessagingBridge } = await import("./messaging");
    const { readState: readStateLocal } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    const [first, second] = await Promise.all([
      removeMessagingBridge(config, bridge.id),
      removeMessagingBridge(config, bridge.id)
    ]);
    const outcomes = [first.removed, second.removed].sort();
    expect(outcomes).toEqual([false, true]);

    const state = readStateLocal(config.instance);
    expect(state.messagingBridges.find((b) => b.id === bridge.id)).toBeUndefined();
    const removalAudits = state.audit.filter(
      (entry) => entry.action === "messaging.removed" && entry.target === bridge.id
    );
    expect(removalAudits.length).toBe(1);
  });

  test("sendMessagingOutput rejects a disabled bridge up front (closes the disable-vs-send race)", async () => {
    // Without the status guard, sendMessagingOutput would proceed
    // to the photo-parse + agent-filter work and ultimately fail
    // with a "missing token" once it hit the (now-empty) secret
    // store. Worse, if the in-process token was cached anywhere,
    // a send could complete on a freshly-disabled bridge. The
    // guard rejects the call up front with a 400-mapped error.
    const config = testConfig("telegram-send-after-disable");
    const stub = stubClient();
    setMessagingDeps({ telegramClientFactory: () => stub.client });
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await disableMessagingBridge(config, bridge.id);
    await expect(
      sendMessagingOutput(config, bridge.id, { text: "should not send", target: "1" })
    ).rejects.toThrow(/Invalid input: Messaging bridge .* is not configured/);
    // And the underlying client was never called.
    expect(stub.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});

interface DiscordStubCall { method: string; args: unknown[] }

function stubDiscordClient(overrides: Partial<DiscordClient> = {}): { client: DiscordClient; calls: DiscordStubCall[] } {
  const calls: DiscordStubCall[] = [];
  const client: DiscordClient = {
    getMe: async () => {
      calls.push({ method: "getMe", args: [] });
      return { id: "100", username: "Gini", discriminator: "3715", bot: true };
    },
    sendMessage: async (channelId, content) => {
      calls.push({ method: "sendMessage", args: [channelId, content] });
      return {
        id: "msg-1",
        channel_id: channelId,
        content,
        timestamp: "2026-01-01T00:00:00Z",
        author: { id: "100", username: "Gini", bot: true }
      };
    },
    triggerTypingIndicator: async (channelId) => {
      calls.push({ method: "triggerTypingIndicator", args: [channelId] });
      return true as const;
    },
    fetchChannelMessages: async () => {
      calls.push({ method: "fetchChannelMessages", args: [] });
      return [];
    },
    ...overrides
  };
  return { client, calls };
}

describe("messaging discord wiring", () => {
  afterEach(() => resetMessagingDeps());

  test("addMessagingBridge requires a botToken for discord and persists it via the secret store", async () => {
    const config = testConfig("discord-add");

    await expect(
      addMessagingBridge(config, { name: "disc", kind: "discord", deliveryTargets: ["999"] })
    ).rejects.toThrow(/botToken/);

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "SECRET-TOKEN"
    });

    expect(bridge.kind).toBe("discord");
    expect(bridge.secretRefs?.[0]?.purpose).toBe("bot-token");
    expect(readBridgeBotToken(config, bridge)).toBe("SECRET-TOKEN");
  });

  test("addMessagingBridge does NOT mint a Telegram pairing code for discord bridges", async () => {
    // Discord uses channel-as-auth (per ADR discord-bridge.md) — minting a
    // pairing code would surface a misleading CLI hint suggesting the
    // operator DM the bot on Telegram, and would write Telegram-flavored
    // metadata onto a Discord record.
    const config = testConfig("discord-no-pairing");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    expect(bridge.kind).toBe("discord");
    // Discord uses channel-as-auth and never carries a per-user
    // enrollment surface. The verification-code flow is telegram-only.
    expect(bridge.metadata?.verificationCode).toBeUndefined();
  });

  test("allowChat / denyChat / listAllowedChats reject non-telegram bridges", async () => {
    // Allowlist + pairing surface is Telegram-only; calling it on a
    // Discord bridge with a stray chat-id argument must fail loudly
    // instead of silently writing Telegram metadata onto the Discord
    // record (or, worse, silently succeeding and confusing the operator).
    const config = testConfig("discord-allowlist-rejects");
    const { allowChat, denyChat, listAllowedChats } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const { rejectPendingChat } = await import("./messaging");
    await expect(allowChat(config, bridge.id, 1)).rejects.toThrow(/only applies to telegram/);
    await expect(denyChat(config, bridge.id, 1)).rejects.toThrow(/only applies to telegram/);
    await expect(rejectPendingChat(config, bridge.id, 1)).rejects.toThrow(/only applies to telegram/);
    expect(() => listAllowedChats(config, bridge.id)).toThrow(/only applies to telegram/);
  });

  test("checkMessagingBridge round-trips getMe and stores the bot identity on metadata", async () => {
    const config = testConfig("discord-health");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("configured");
    expect(String(checked.message)).toContain("Gini#3715");
    expect(checked.metadata?.botUsername).toBe("Gini");
    expect(checked.metadata?.botId).toBe("100");
    expect(calls.some((c) => c.method === "getMe")).toBe(true);
  });

  test("checkMessagingBridge surfaces the API error description on failure", async () => {
    const config = testConfig("discord-health-fail");
    const { client } = stubDiscordClient({
      getMe: async () => {
        throw new Error("401: Unauthorized");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).toContain("401: Unauthorized");
  });

  test("checkMessagingBridge handles the new global_name account shape (discriminator '0')", async () => {
    const config = testConfig("discord-health-globalname");
    const { client } = stubDiscordClient({
      getMe: async () => ({ id: "5", username: "raw.handle", discriminator: "0", global_name: "Display Name", bot: true })
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("configured");
    expect(String(checked.message)).toContain("Display Name");
    expect(String(checked.message)).not.toContain("#0");
  });

  test("sendMessagingOutput dispatches via REST and records the outbound message", async () => {
    const config = testConfig("discord-send");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const message = await sendMessagingOutput(config, bridge.id, { text: "hi gini" });
    expect(message.status).toBe("sent");
    expect(message.target).toBe("chan-1");

    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    expect(send?.args).toEqual(["chan-1", "hi gini"]);
  });

  test("sendMessagingOutput records 'failed' with the API description on send failure", async () => {
    const config = testConfig("discord-send-fail");
    const { client } = stubDiscordClient({
      sendMessage: async () => {
        throw new Error("Missing Access (code 50001)");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const message = await sendMessagingOutput(config, bridge.id, { text: "hi" });
    expect(message.status).toBe("failed");
    expect(String(message.error)).toContain("Missing Access");
  });

  test("sendMessagingOutput refuses empty text without hitting the API", async () => {
    const config = testConfig("discord-send-empty");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // sendMessagingOutput's top-level guard rejects empty text outright;
    // verify we never reach the API.
    await expect(
      sendMessagingOutput(config, bridge.id, { text: "" })
    ).rejects.toThrow(/text or a photo/);
    expect(calls.find((c) => c.method === "sendMessage")).toBeUndefined();
  });

  test("disableMessagingBridge clears secrets for discord-kind bridges", async () => {
    const config = testConfig("discord-disable");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    await disableMessagingBridge(config, bridge.id);
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.status).toBe("disabled");
    expect(live?.secretRefs ?? []).toEqual([]);
    expect(readBridgeBotToken(config, live!)).toBeUndefined();
  });

  test("discord inbound runs through a per-channel ChatSession (creates once, reuses on next message)", async () => {
    const config = testConfig("discord-inbound-chat-session");
    const { client } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const { receiveMessagingInput, findDiscordChatSession } = await import("./messaging");
    const { isTerminalTaskStatus } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const first = await receiveMessagingInput(config, bridge.id, { text: "first", target: "chan-1" });
    const second = await receiveMessagingInput(config, bridge.id, { text: "second", target: "chan-1" });

    const sessions = readState(config.instance).chatSessions;
    const discordSessions = sessions.filter(
      (s) => s.source?.kind === "discord" && s.source.bridgeId === bridge.id && s.source.channelId === "chan-1"
    );
    expect(discordSessions).toHaveLength(1);
    expect(discordSessions[0]?.source).toEqual({
      kind: "discord",
      bridgeId: bridge.id,
      channelId: "chan-1",
      target: "chan-1"
    });

    const found = findDiscordChatSession(config, bridge.id, "chan-1");
    expect(found?.id).toBe(discordSessions[0]!.id);

    const userMessages = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === discordSessions[0]!.id && m.role === "user"
    );
    expect(userMessages.map((m) => m.content)).toEqual(["first", "second"]);

    // Wait for the spawned chat tasks to reach a terminal state before
    // returning. submitTask runs runTask detached (.catch(failTask));
    // the next test file's testConfig rebinds GINI_STATE_ROOT, so a
    // task still in flight would resolve its state path against the
    // new root and throw "Task not found". Awaiting here keeps the
    // task lifecycle scoped to this test.
    await waitForTaskSettled(config, [first.taskId!, second.taskId!], isTerminalTaskStatus);
  });

  test("addMessagingBridge rejects bot tokens with non-printable / whitespace characters", async () => {
    // Without this gate, a token containing a control char would be
    // accepted, stored, and then leak via the eventual fetch error
    // (Bun echoes the auth header value in its rejection message,
    // which we'd persist to bridge.message).
    const config = testConfig("discord-bad-token");

    await expect(
      addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "valid-prefix\ninjected"
      })
    ).rejects.toThrow(/invalid characters/);

    await expect(
      addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "valid prefix space"
      })
    ).rejects.toThrow(/invalid characters/);

    // Same gate applies to Telegram tokens.
    await expect(
      addMessagingBridge(config, {
        name: "tg",
        kind: "telegram",
        deliveryTargets: ["1"],
        botToken: "valid-prefix\rinjected"
      })
    ).rejects.toThrow(/invalid characters/);
  });

  test("checkMessagingBridge marks status='error' when the underlying send error mentions the auth header (token is redacted)", async () => {
    // Belt-and-suspenders for the security fix: even if a future
    // code path lets a token reach a fetch and the underlying
    // transport echoes the auth header in its error, we redact it
    // before landing in state.
    const config = testConfig("discord-redact-error");
    const { client } = stubDiscordClient({
      getMe: async () => {
        throw new Error("Header 'authorization' has invalid value: 'Bot SUPER_SECRET_TOKEN_LEAK'");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "valid-prefix"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).not.toContain("SUPER_SECRET_TOKEN_LEAK");
    expect(String(checked.message)).toContain("Bot <redacted>");
  });

  test("checkMessagingBridge short-circuits on a disabled bridge — no network call, no metadata mutation", async () => {
    // A disabled bridge is one the user explicitly turned off; a
    // health probe must not touch its state or hit the API. Without
    // the short-circuit, the health flow would still merge a
    // metadata patch and emit a health audit row even though the
    // status guard correctly preserves "disabled".
    const config = testConfig("discord-disabled-noop");
    let getMeCalls = 0;
    const { client } = stubDiscordClient({
      getMe: async () => {
        getMeCalls += 1;
        return { id: "100", username: "Gini", bot: true };
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const { disableMessagingBridge } = await import("./messaging");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "valid-prefix"
    });

    await disableMessagingBridge(config, bridge.id);

    const before = readState(config.instance);
    const auditBefore = before.audit.length;
    const liveBefore = before.messagingBridges.find((b) => b.id === bridge.id)!;
    const checked = await checkMessagingBridge(config, bridge.id);
    const after = readState(config.instance);
    const liveAfter = after.messagingBridges.find((b) => b.id === bridge.id)!;

    expect(checked.status).toBe("disabled");
    expect(getMeCalls).toBe(0);
    expect(after.audit.length).toBe(auditBefore);
    // updatedAt didn't move because no mutation happened.
    expect(liveAfter.updatedAt).toBe(liveBefore.updatedAt);
  });

  test("checkMessagingBridge marks status='error' on a missing secret file instead of 500ing the API", async () => {
    // Before the readBridgeBotTokenQuiet fix, a missing on-disk
    // secret would throw ENOENT out of checkMessagingBridge, causing
    // the HTTP endpoint to 500 instead of producing a typed bridge
    // error the UI can surface.
    const config = testConfig("discord-missing-secret");
    setMessagingDeps({ discordClientFactory: () => stubDiscordClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "valid-prefix"
    });

    // Wipe the secret file out from under the bridge. The record
    // still references it via secretRefs, so a naive read throws.
    const { rmSync } = await import("node:fs");
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    const ref = live?.secretRefs?.[0];
    expect(ref).toBeDefined();
    rmSync(ref!.path);

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).toContain("Discord bot token is missing");
  });

  test("discord receiveMessagingInput refuses a missing target instead of silently routing to 'local'", async () => {
    // A missing Discord inbound target must throw, not silently
    // create a chat session keyed on the literal string "local"
    // via the demo/generic bridge default.
    const config = testConfig("discord-no-target");
    setMessagingDeps({ discordClientFactory: () => stubDiscordClient().client });

    const { receiveMessagingInput } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi" })
    ).rejects.toThrow(/channel id/);

    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi", target: "" })
    ).rejects.toThrow(/channel id/);

    // No chat session should have been created for the failed calls.
    const sessions = readState(config.instance).chatSessions.filter(
      (s) => s.source?.kind === "discord" && s.source.bridgeId === bridge.id
    );
    expect(sessions).toEqual([]);
  });
});
