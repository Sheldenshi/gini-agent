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

  test("fresh telegram bridge auto-mints a pairing code with an expiry in the future", async () => {
    const config = testConfig("telegram-pair-mint");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const code = bridge.metadata?.pairingCode;
    const expires = bridge.metadata?.pairingCodeExpiresAt;
    expect(typeof code).toBe("string");
    expect(String(code).startsWith("pair-")).toBe(true);
    expect(typeof expires).toBe("string");
    expect(Date.parse(String(expires))).toBeGreaterThan(Date.now());
  });

  test("tryClaimPairingCode enrolls a private chat that sends the right code, then consumes it", async () => {
    const config = testConfig("telegram-pair-claim");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { authorizeTelegramChat, listAllowedChats, tryClaimPairingCode } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    const code = String(bridge.metadata!.pairingCode);

    // Wrong code → no enrollment.
    expect(
      await tryClaimPairingCode(config, bridge.id, { chatId: 4242, chatType: "private", text: "pair-deadbeef" })
    ).toBe(false);
    expect(await authorizeTelegramChat(config, bridge.id, 4242)).toBe(false);

    // Right code with surrounding whitespace and different case → enroll.
    const ok = await tryClaimPairingCode(config, bridge.id, {
      chatId: 4242,
      chatType: "private",
      text: `  ${code.toUpperCase()}  `
    });
    expect(ok).toBe(true);

    const view = listAllowedChats(config, bridge.id);
    expect(view.allowedChatIds).toEqual([4242]);
    expect(view.ownerChatId).toBe(4242);
    // Code consumed.
    const refreshed = listAllowedChats(config, bridge.id);
    expect(refreshed).toBeDefined();
    const bridges = (await import("../state")).readState(config.instance).messagingBridges;
    const live = bridges.find((b) => b.id === bridge.id)!;
    expect(live.metadata?.pairingCode).toBeUndefined();
    expect(live.metadata?.pairingCodeExpiresAt).toBeUndefined();

    // Replay of the same code does nothing now.
    const replay = await tryClaimPairingCode(config, bridge.id, { chatId: 9999, chatType: "private", text: code });
    expect(replay).toBe(false);
  });

  test("group chats never pair — the code is private-only", async () => {
    const config = testConfig("telegram-pair-group-reject");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { authorizeTelegramChat, tryClaimPairingCode } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    const code = String(bridge.metadata!.pairingCode);

    const tried = await tryClaimPairingCode(config, bridge.id, {
      chatId: -987654321,
      chatType: "supergroup",
      text: code
    });
    expect(tried).toBe(false);
    expect(await authorizeTelegramChat(config, bridge.id, -987654321)).toBe(false);
  });

  test("expired pairing codes are rejected and cleaned up off metadata", async () => {
    const config = testConfig("telegram-pair-expired");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { tryClaimPairingCode } = await import("./messaging");
    const { mutateState, readState } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    const code = String(bridge.metadata!.pairingCode);

    // Backdate the expiry so the code is stale.
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.metadata!.pairingCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
    });

    const tried = await tryClaimPairingCode(config, bridge.id, { chatId: 4242, chatType: "private", text: code });
    expect(tried).toBe(false);

    // The stale code+expiry were cleaned up so the field doesn't
    // linger on metadata after a failed attempt.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.metadata?.pairingCode).toBeUndefined();
    expect(live?.metadata?.pairingCodeExpiresAt).toBeUndefined();
  });

  test("explicit allowChat closes the pairing window (CLI trust supersedes the code)", async () => {
    const config = testConfig("telegram-pair-allow-clears");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { allowChat, hasActivePairingCode } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    expect(hasActivePairingCode(config, bridge.id)).toBe(true);

    await allowChat(config, bridge.id, 4242);
    expect(hasActivePairingCode(config, bridge.id)).toBe(false);
  });

  test("pairMessagingBridge regenerates the code with a fresh expiry", async () => {
    const config = testConfig("telegram-pair-regen");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const { pairMessagingBridge } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    const initialCode = String(bridge.metadata!.pairingCode);

    const refreshed = await pairMessagingBridge(config, bridge.id);
    expect(typeof refreshed.metadata?.pairingCode).toBe("string");
    expect(refreshed.metadata?.pairingCode).not.toBe(initialCode);
    expect(Date.parse(String(refreshed.metadata?.pairingCodeExpiresAt))).toBeGreaterThan(Date.now());
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
});
