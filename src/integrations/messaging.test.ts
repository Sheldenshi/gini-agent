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
