import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatSessionRecord, RuntimeConfig } from "../types";
import { mutateState, readState } from "../state";
import { logDir } from "../paths";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import {
  createTelegramPollerSupervisor,
  __internalsForTests as telegramInternals
} from "./telegram-poller";
import { setMaxTaskWaitMsForTests } from "./messaging-poller-helpers";
import type { TelegramClient, TelegramUpdate } from "./telegram";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-telegram-poller-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7339,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

// Drive the poller from a deferred queue so tests can step it
// deterministically: the loop blocks on getUpdates until we resolve the
// pending promise with a fresh batch.
function deferredClient(): {
  client: TelegramClient;
  nextUpdates: (updates: TelegramUpdate[]) => void;
  failNext: (message: string) => void;
} {
  type Pending = { resolve: (u: TelegramUpdate[]) => void; reject: (e: Error) => void };
  const queue: Pending[] = [];
  const client: TelegramClient = {
    async getMe() {
      return { id: 1, is_bot: true, username: "ginibot" };
    },
    async sendMessage(chatId, text) {
      return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
    },
    async sendChatAction() {
      return true as const;
    },
    async sendPhoto(chatId) {
      return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
    },
    async getFile(fileId) {
      return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
    },
    async downloadFile() {
      return new Uint8Array([1, 2, 3]).buffer;
    },
    getUpdates(_offset, _timeout, signal) {
      return new Promise<TelegramUpdate[]>((resolve, reject) => {
        const entry: Pending = { resolve, reject };
        queue.push(entry);
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  };
  return {
    client,
    nextUpdates(updates) {
      const next = queue.shift();
      if (!next) throw new Error("no pending getUpdates call to satisfy");
      next.resolve(updates);
    },
    failNext(message) {
      const next = queue.shift();
      if (!next) throw new Error("no pending getUpdates call to satisfy");
      next.reject(new Error(message));
    }
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("telegram poller supervisor", () => {
  afterEach(() => resetMessagingDeps());

  test("reconcile starts a loop for a configured telegram bridge and stopAll cancels it", async () => {
    const config = testConfig("poller-start-stop");
    setMessagingDeps({ telegramClientFactory: () => deferredClient().client });

    await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => deferredClient().client });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    await supervisor.stopAll();
    expect(supervisor.size()).toBe(0);
  });

  test("incoming text messages are routed through receiveMessagingInput and advance the offset", async () => {
    const config = testConfig("poller-incoming");
    const { client, nextUpdates } = deferredClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    // Pre-enroll the chat — no TOFU, so the poller would otherwise
    // drop this update silently as a denied stranger.
    const { allowChat } = await import("./messaging");
    await allowChat(config, bridge.id, 42);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    nextUpdates([
      {
        update_id: 10,
        message: { message_id: 1, date: 0, chat: { id: 42, type: "private" }, text: "ping" }
      }
    ]);

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id),
      "inbound message recorded"
    );

    const inbound = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id);
    expect(inbound?.direction).toBe("inbound");
    expect(inbound?.text).toBe("ping");
    expect(inbound?.target).toBe("42");

    await waitFor(
      () => readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.metadata?.lastOffset === 11,
      "offset advanced"
    );

    await supervisor.stopAll();
  });

  test("fires sendChatAction(typing) for the originating chat while the task is non-terminal", async () => {
    const config = testConfig("poller-typing");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const updateQueue: Pending[] = [];
    let chatActionCalls = 0;
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true }; },
      async sendMessage(chatId, text) {
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async sendChatAction() {
        chatActionCalls += 1;
        return true as const;
      },
      async getFile(fileId) {
        return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
      },
      async downloadFile() {
        return new Uint8Array().buffer;
      },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          updateQueue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridgeForTyping = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const { allowChat: allowChatTyping } = await import("./messaging");
    await allowChatTyping(config, bridgeForTyping.id, 88);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    updateQueue.shift()?.resolve([
      {
        update_id: 5,
        message: { message_id: 1, date: 0, chat: { id: 88, type: "private" }, text: "hello" }
      }
    ]);

    await waitFor(() => chatActionCalls >= 1, "typing indicator fired at least once");

    await supervisor.stopAll();
  });

  test("inbound photo updates are downloaded to disk and the saved path is folded into the task input", async () => {
    const config = testConfig("poller-photo");
    const downloadedBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const downloadedPaths: string[] = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true }; },
      async sendMessage(chatId, text) {
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async sendChatAction() { return true as const; },
      async getFile(fileId) {
        return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
      },
      async downloadFile(path) {
        downloadedPaths.push(path);
        return downloadedBytes.buffer.slice(0);
      },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const { allowChat: allowChatPhoto } = await import("./messaging");
    await allowChatPhoto(config, bridge.id, 77);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    queue.shift()?.resolve([
      {
        update_id: 20,
        message: {
          message_id: 4,
          date: 0,
          chat: { id: 77, type: "private" },
          photo: [
            { file_id: "small", file_unique_id: "small", width: 90, height: 60 },
            { file_id: "BIG", file_unique_id: "BIG", width: 1280, height: 960 }
          ],
          caption: "look at this"
        }
      }
    ]);

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id),
      "inbound message recorded"
    );
    const record = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id);

    expect(downloadedPaths).toEqual(["photos/BIG.jpg"]);
    expect(record?.media?.kind).toBe("photo");
    expect(record?.media?.fileId).toBe("BIG");
    expect(String(record?.media?.path ?? "")).toContain("inbound");
    expect(String(record?.media?.path ?? "")).toContain("BIG.jpg");
    expect(record?.text ?? "").toContain("[photo:");
    expect(record?.text ?? "").toContain("look at this");

    // The bytes really landed on disk.
    const onDisk = await Bun.file(record!.media!.path!).arrayBuffer();
    expect(new Uint8Array(onDisk)).toEqual(downloadedBytes);

    await supervisor.stopAll();
  });

  test("group chats prefix sender attribution and pass replyToMessageId through the mirror", async () => {
    const config = testConfig("poller-group");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const sendCalls: Array<{ chatId: string | number; text: string; opts?: { replyToMessageId?: number } }> = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text, opts) {
        sendCalls.push({ chatId, text, opts });
        return { message_id: 100, date: 0, chat: { id: Number(chatId), type: "supergroup" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 101, date: 0, chat: { id: Number(chatId), type: "supergroup" } };
      },
      async sendChatAction() { return true as const; },
      async getFile(fileId) { return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` }; },
      async downloadFile() { return new Uint8Array().buffer; },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    // Health probe seeds bridge.metadata.botUsername so the poller can
    // pass it to extractIncomingPayload for mention stripping. Then
    // enroll the group on the allowlist — groups never auto-pair, so
    // without this the chat would be silently denied.
    const { allowChat, checkMessagingBridge } = await import("./messaging");
    await checkMessagingBridge(config, bridge.id);
    await allowChat(config, bridge.id, -987654321);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    queue.shift()?.resolve([
      {
        update_id: 50,
        message: {
          message_id: 222,
          date: 0,
          chat: { id: -987654321, type: "supergroup", title: "team" },
          text: "@gini_agent_bot ship it please",
          from: { id: 42, is_bot: false, first_name: "Shelden", username: "shelden" }
        }
      }
    ]);

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id),
      "inbound message recorded"
    );

    // Mention stripped + sender prefix in the task input.
    const inbound = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id);
    expect(inbound?.text).toBe("@shelden: ship it please");
    expect(inbound?.target).toBe("-987654321");

    // A chat session was created for the group, keyed on the group's
    // negative chat_id, with the source tag carrying type info.
    const session = readState(config.instance).chatSessions.find(
      (s) => s.source?.kind === "telegram" && s.source.chatId === -987654321
    );
    expect(session?.source?.target).toBe("-987654321");

    // Wait for the agent's mirror reply to land. The echo provider
    // makes this fast; the typing-and-mirror loop will fire sendMessage
    // with reply_to_message_id pointing at the originating update.
    await waitFor(() => sendCalls.length > 0, "assistant reply mirrored to Telegram", 5000);
    expect(sendCalls[0]?.chatId).toBe("-987654321");
    expect(sendCalls[0]?.opts?.replyToMessageId).toBe(222);

    await supervisor.stopAll();
  });

  test("strangers' updates are silently dropped (no inbound record), but the offset still advances", async () => {
    const config = testConfig("poller-stranger-deny");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    let sendCalls = 0;
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text) {
        sendCalls += 1;
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async sendChatAction() { return true as const; },
      async getFile(fileId) { return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` }; },
      async downloadFile() { return new Uint8Array().buffer; },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    // Owner enrolls themselves explicitly. The allowlist contains
    // just [11], so any subsequent chat is a stranger.
    const { allowChat } = await import("./messaging");
    await allowChat(config, bridge.id, 11);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    queue.shift()?.resolve([
      {
        update_id: 70,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 9999, type: "private" },
          text: "hi can I use this bot",
          from: { id: 99, is_bot: false, first_name: "Stranger" }
        }
      }
    ]);

    // Wait until the offset advances — the only deterministic signal
    // that the loop processed the denied update without producing a
    // messagingMessage record.
    await waitFor(() => {
      const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
      return live?.metadata?.lastOffset === 71;
    }, "offset advanced past denied update", 3000);

    expect(readState(config.instance).messagingMessages.filter((m) => m.bridgeId === bridge.id)).toEqual([]);
    expect(sendCalls).toBe(0);

    // The denied attempt is recorded on the bridge metadata so the
    // owner can find the chat_id via `gini messaging chats` without
    // tailing the log.
    const { listAllowedChats } = await import("./messaging");
    const view = listAllowedChats(config, bridge.id);
    const stranger = view.recentDeniedChats.find((entry) => entry.chatId === 9999);
    expect(stranger).toBeDefined();
    expect(stranger?.sender).toBe("Stranger");

    await supervisor.stopAll();
  });

  test("first DM containing the pairing code auto-enrolls the chat and sends a confirmation", async () => {
    const config = testConfig("poller-pair-claim");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text) {
        sendCalls.push({ chatId, text });
        return { message_id: 50, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 51, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async sendChatAction() { return true as const; },
      async getFile(fileId) { return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` }; },
      async downloadFile() { return new Uint8Array().buffer; },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    const code = String(bridge.metadata!.pairingCode);

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    queue.shift()?.resolve([
      {
        update_id: 80,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 7777, type: "private" },
          text: code,
          from: { id: 7, is_bot: false, first_name: "Shelden", username: "shelden" }
        }
      }
    ]);

    // Wait until the bridge metadata reflects the enrolled chat.
    await waitFor(() => {
      const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
      const allowed = (live?.metadata?.allowedChatIds ?? []) as number[];
      return allowed.includes(7777);
    }, "chat enrolled via pairing code", 3000);

    // Confirmation message went out, NOT a task-derived reply — the
    // pairing message is consumed, not turned into a task input.
    expect(sendCalls.some((c) => c.text.startsWith("Paired"))).toBe(true);
    expect(readState(config.instance).messagingMessages.some(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    )).toBe(false);

    // Code was consumed.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.metadata?.pairingCode).toBeUndefined();
    expect(live?.metadata?.pairingCodeExpiresAt).toBeUndefined();

    await supervisor.stopAll();
  });

  test("unpaired DM during a pairing window gets a hint reply instead of silence", async () => {
    const config = testConfig("poller-pair-hint");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text) {
        sendCalls.push({ chatId, text });
        return { message_id: 60, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 61, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async sendChatAction() { return true as const; },
      async getFile(fileId) { return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` }; },
      async downloadFile() { return new Uint8Array().buffer; },
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });
    // Bridge auto-minted a pairing code; we don't claim it. The DM
    // that arrives is plain "hi" — denied, but should receive a hint
    // because the pairing window is open.

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    queue.shift()?.resolve([
      {
        update_id: 90,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 12345, type: "private" },
          text: "hi",
          from: { id: 9, is_bot: false, first_name: "Shelden", username: "shelden" }
        }
      }
    ]);

    await waitFor(() => sendCalls.length > 0, "hint reply dispatched", 3000);
    expect(sendCalls[0]?.chatId).toBe("12345");
    expect(sendCalls[0]?.text.toLowerCase()).toContain("pairing code");

    // The chat was still denied (not enrolled, no task created), and
    // the attempt is recorded on recentDeniedChats.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect((live?.metadata?.allowedChatIds ?? []) as number[]).toEqual([]);
    expect(readState(config.instance).messagingMessages.some(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    )).toBe(false);

    await supervisor.stopAll();
  });

  test("reply mirror logs reply_skip_non_terminal and threads abort into sendChatAction when the task wait cap fires", async () => {
    // Pre-populate a stuck task + chat session, run the mirror with a
    // 50ms cap, and confirm
    //   1. the skip log fires (without the typingController + finally
    //      pattern, `await typingDone` would block forever on a task
    //      whose typing kept succeeding);
    //   2. the typing pulse stops the moment the cap fires;
    //   3. sendChatAction observed the abort signal end-to-end, so a
    //      hung Telegram fetch could be cancelled.
    const config = testConfig("tg-skip-non-terminal");
    const typingCalls: Array<{ chatId: string | number; signaled: boolean }> = [];
    let observedAbort = false;
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction(chatId, _action, signal) {
        typingCalls.push({ chatId, signaled: signal !== undefined });
        if (signal?.aborted) observedAbort = true;
        signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
          },
          { once: true }
        );
        return true as const;
      },
      async sendPhoto(chatId) {
        return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async getFile(fileId) {
        return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
      },
      async downloadFile() {
        return new Uint8Array().buffer;
      },
      async getUpdates() {
        return [];
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["42"],
      botToken: "TOK"
    });

    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_stuck_tg",
        instance: config.instance,
        title: "t",
        input: "t",
        status: "running",
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        memoryIds: [],
        skillIds: []
      });
      const session: ChatSessionRecord = {
        id: "session_stuck_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: [],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 42, target: "42" }
      };
      state.chatSessions.push(session);
    });

    setMaxTaskWaitMsForTests(50);
    try {
      const controller = new AbortController();
      await telegramInternals.maintainTypingAndMirrorReply(
        config,
        bridge.id,
        "task_stuck_tg",
        42,
        client,
        controller.signal
      );

      const logPath = join(logDir(config.instance), "runtime.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const skip = entries.find(
        (entry) =>
          entry.message === "messaging.telegram.reply_skip_non_terminal" &&
          (entry.data as Record<string, unknown> | undefined)?.bridgeId === bridge.id
      );
      expect(skip).toBeDefined();
      const data = skip?.data as Record<string, unknown> | undefined;
      expect(data?.bridgeId).toBe(bridge.id);
      expect(data?.taskId).toBe("task_stuck_tg");
      expect(data?.status).toBe("running");

      // Every typing call must have received a signal — proves the
      // poller now threads abort into the Telegram client.
      expect(typingCalls.length).toBeGreaterThanOrEqual(1);
      expect(typingCalls.every((c) => c.signaled)).toBe(true);
      // The mirror's finally block aborts the typing controller before
      // returning, so the abort listener should have fired even
      // though the supervisor signal never aborted.
      expect(observedAbort).toBe(true);

      const settledCount = typingCalls.length;
      await Bun.sleep(80);
      expect(typingCalls.length).toBe(settledCount);
    } finally {
      setMaxTaskWaitMsForTests(undefined);
    }
  });

  test("disabled bridges have their loop stopped on next reconcile", async () => {
    const config = testConfig("poller-disable");
    setMessagingDeps({ telegramClientFactory: () => deferredClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    const supervisor = createTelegramPollerSupervisor(config, { clientFactory: () => deferredClient().client });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    const { disableMessagingBridge } = await import("./messaging");
    await disableMessagingBridge(config, bridge.id);

    supervisor.reconcile();
    await waitFor(() => supervisor.size() === 0, "loop stopped after disable");
  });
});
