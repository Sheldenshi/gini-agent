import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatSessionRecord, RuntimeConfig } from "../types";
import { assertInsideWorkspace, mutateState, readState } from "../state";
import { logDir } from "../paths";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import {
  createTelegramPollerSupervisor,
  __internalsForTests as telegramInternals,
  type PollerSupervisor
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

// Wait until the poller has armed (pushed a deferred into the queue),
// then pop and return it. Each test was previously doing
// `queue.shift()?.resolve(...)`, which silently no-ops if the queue is
// empty — the poller's first getUpdates is scheduled by reconcile()
// but only enqueued on the next microtask tick, so the optional chain
// hid a real race on slow schedulers. Throwing on empty after the
// waitFor closes that race loudly.
async function popPending<T extends { resolve: unknown }>(
  q: T[],
  label = "poller armed"
): Promise<T> {
  await waitFor(() => q.length > 0, label, 3000);
  const pending = q.shift();
  if (!pending) throw new Error(`queue empty after waitFor (${label}) — poller did not arm`);
  return pending;
}

describe("telegram poller supervisor", () => {
  // Track every supervisor a test creates so a failed assertion before
  // the in-body stopAll() can't strand a poll loop. Without this, a
  // leaked loop would keep calling getUpdates against the previous
  // test's stub client and racing against the next test's state
  // teardown (testConfig() rmSyncs the instance dir each call).
  const liveSupervisors: PollerSupervisor[] = [];
  function createTrackedSupervisor(
    ...args: Parameters<typeof createTelegramPollerSupervisor>
  ): PollerSupervisor {
    const s = createTelegramPollerSupervisor(...args);
    liveSupervisors.push(s);
    return s;
  }

  afterEach(async () => {
    // Stop newest-first so the most-recently-created loop unwinds first,
    // matching the LIFO shape the tests would have used with their own
    // in-body stopAll() at the bottom.
    while (liveSupervisors.length > 0) {
      const s = liveSupervisors.pop();
      if (s) {
        try { await s.stopAll(); } catch { /* shutdown best-effort */ }
      }
    }
    resetMessagingDeps();
    // Belt-and-suspenders reset: if a test crashes mid-flight or a
    // future change moves to `bun test --concurrent`, a process-global
    // wait-cap override could otherwise leak into the next test.
    setMaxTaskWaitMsForTests(undefined);
  });

  test("reconcile starts a loop for a configured telegram bridge and stopAll cancels it", async () => {
    const config = testConfig("poller-start-stop");
    setMessagingDeps({ telegramClientFactory: () => deferredClient().client });

    await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => deferredClient().client });
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
    // drop this update silently as a denied stranger. allowChat also
    // sends a greeting back to the chat as an outbound record; the
    // assertions below filter by direction so the greeting doesn't
    // mask the actual inbound.
    const { allowChat } = await import("./messaging");
    await allowChat(config, bridge.id, 42);

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    nextUpdates([
      {
        update_id: 10,
        message: { message_id: 1, date: 0, chat: { id: 42, type: "private" }, text: "ping" }
      }
    ]);

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id && m.direction === "inbound"),
      "inbound message recorded"
    );

    const inbound = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
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

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    (await popPending(updateQueue, "typing-test poller armed")).resolve([
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
    // Pin workspaceRoot to a narrow per-test directory (NOT /tmp) so the
    // photo path's containment check matches production semantics. In
    // production, workspaceRoot is <instanceRoot>/workspace and the
    // legacy <instanceRoot>/inbound/ path was a sibling outside the
    // workspace — that's what made the file-read tool reject it. See
    // issue #69.
    const isolatedWorkspace = `/tmp/gini-telegram-poller-tests/instances/poller-photo/workspace`;
    rmSync(isolatedWorkspace, { recursive: true, force: true });
    config.workspaceRoot = isolatedWorkspace;
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

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    (await popPending(queue, "photo-update poller armed")).resolve([
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
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id && m.direction === "inbound"),
      "inbound message recorded"
    );
    const record = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");

    expect(downloadedPaths).toEqual(["photos/BIG.jpg"]);
    expect(record?.media?.kind).toBe("photo");
    expect(record?.media?.fileId).toBe("BIG");
    // Must land under workspaceRoot/.gini/inbound/<bridgeId>/ so the
    // agent's file-read tool (workspace-containment-gated) can pick the
    // attachment up via the [photo: <path>] task-input prefix.
    expect(String(record?.media?.path ?? "")).toContain(`${config.workspaceRoot}/.gini/inbound/${bridge.id}/`);
    expect(String(record?.media?.path ?? "")).toContain("BIG.jpg");
    expect(record?.text ?? "").toContain("[photo:");
    expect(record?.text ?? "").toContain("look at this");

    // The bytes really landed on disk.
    const onDisk = await Bun.file(record!.media!.path!).arrayBuffer();
    expect(new Uint8Array(onDisk)).toEqual(downloadedBytes);

    // The injected `[photo: <path>]` prefix must survive the file-read
    // tool's workspace-containment gate (issue #69). Parse the path out
    // of the task input the same way the agent would, then run it
    // through `assertInsideWorkspace` — the exact check `fileRead`
    // performs before reading bytes.
    const photoMatch = /\[photo: ([^\]]+)\]/.exec(record!.text ?? "");
    expect(photoMatch).not.toBeNull();
    const injectedPath = photoMatch![1];
    expect(injectedPath).toBe(record!.media!.path!);
    expect(() => assertInsideWorkspace(config.workspaceRoot, injectedPath)).not.toThrow();

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
    // allowChat queues an outbound greeting through the stub; drop it
    // from the recorded send-call list so the agent-reply assertions
    // below read sendCalls[0] as the actual mirrored reply.
    sendCalls.length = 0;

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    (await popPending(queue, "update-50 poller armed")).resolve([
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
      () => readState(config.instance).messagingMessages.some((m) => m.bridgeId === bridge.id && m.direction === "inbound"),
      "inbound message recorded"
    );

    // Mention stripped + sender prefix in the task input.
    const inbound = readState(config.instance).messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound?.text).toBe("@shelden: ship it please");
    expect(inbound?.target).toBe("-987654321");

    // A chat session was created for the group, keyed on the group's
    // negative chat_id, with the source tag carrying type info.
    const session = readState(config.instance).chatSessions.find(
      (s) => s.source?.kind === "telegram" && s.source.chatId === -987654321
    );
    // Narrow back to the telegram variant for the target access — the
    // ChatSessionSource union also includes a non-target-carrying
    // openclaw kind since the migration provenance work.
    expect(session?.source?.kind === "telegram" ? session.source.target : null).toBe(
      "-987654321"
    );

    // Wait for the agent's mirror reply to land. The echo provider
    // makes this fast; the typing-and-mirror loop will fire sendMessage
    // with reply_to_message_id pointing at the originating update.
    await waitFor(() => sendCalls.length > 0, "assistant reply mirrored to Telegram", 5000);
    expect(sendCalls[0]?.chatId).toBe("-987654321");
    expect(sendCalls[0]?.opts?.replyToMessageId).toBe(222);

    await supervisor.stopAll();
  });

  test("stranger DMs from a private chat receive a verification code reply and land on the pending list; the offset still advances", async () => {
    const config = testConfig("poller-stranger-verify");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text) {
        sendCalls.push({ chatId, text });
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
    // just [11], so any subsequent chat is a stranger. allowChat
    // queues an outbound greeting through the stub; drop it from the
    // recorded send-call list so the assertions below only see the
    // stranger-path activity.
    const { allowChat } = await import("./messaging");
    await allowChat(config, bridge.id, 11);
    sendCalls.length = 0;

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    (await popPending(queue, "update-70 poller armed")).resolve([
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

    await waitFor(() => {
      const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
      return live?.metadata?.lastOffset === 71;
    }, "offset advanced past denied update", 3000);

    // No inbound message lands because the chat is still unauthorized,
    // but the verification-code reply is sent and recorded as outbound.
    expect(readState(config.instance).messagingMessages.filter(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    )).toEqual([]);
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(sendCalls[0]?.chatId).toBe("9999");
    expect(sendCalls[0]?.text.toLowerCase()).toContain("verification code");

    // The denied attempt is recorded on the bridge metadata with the
    // matching verification code so the operator can confirm before
    // clicking Approve.
    const { listAllowedChats } = await import("./messaging");
    const view = listAllowedChats(config, bridge.id);
    const stranger = view.recentDeniedChats.find((entry) => entry.chatId === 9999);
    expect(stranger).toBeDefined();
    expect(stranger?.sender).toBe("Stranger");
    expect(stranger?.verificationCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    await supervisor.stopAll();
  });

  test("denied DMs in private chats get the verification code text in the bot reply", async () => {
    const config = testConfig("poller-verify-text");
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

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    (await popPending(queue, "update-90 poller armed")).resolve([
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

    await waitFor(() => sendCalls.length > 0, "verification code reply dispatched", 3000);
    expect(sendCalls[0]?.chatId).toBe("12345");
    const text = sendCalls[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("verification code");
    expect(text).toMatch(/[0-9A-F]{4}-[0-9A-F]{4}/);
    expect(text.toLowerCase()).toContain("minute");

    // The chat is still denied (not enrolled, no task created); the
    // pending entry on metadata carries the same code.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect((live?.metadata?.allowedChatIds ?? []) as number[]).toEqual([]);
    expect(readState(config.instance).messagingMessages.some(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    )).toBe(false);

    await supervisor.stopAll();
  });

  test("a second denied DM from the same chat within the TTL window does not re-send the verification code", async () => {
    // Without the mintedFreshCode gate, a chat spamming the bot would
    // drive one verification-code send per inbound DM — burning Telegram
    // outbound quota and inflating the messages + audit tables one row
    // per attempt. The user only needs the code once; subsequent DMs
    // can reuse what they already received.
    const config = testConfig("poller-verify-no-resend");
    type Pending = { resolve: (u: import("./telegram").TelegramUpdate[]) => void };
    const queue: Pending[] = [];
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    const client: TelegramClient = {
      async getMe() { return { id: 1, is_bot: true, username: "gini_agent_bot" }; },
      async sendMessage(chatId, text) {
        sendCalls.push({ chatId, text });
        return { message_id: 70, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendPhoto(chatId) {
        return { message_id: 71, date: 0, chat: { id: Number(chatId), type: "private" } };
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

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => client });
    supervisor.reconcile();

    // Wait for the first getUpdates promise to land in the queue before
    // resolving it. Without this, the poller may not have armed yet on a
    // slow scheduler tick and the shift returns undefined silently.
    await waitFor(() => queue.length > 0, "poller armed for first update", 3000);
    const firstPending = queue.shift();
    if (!firstPending) throw new Error("queue empty after waitFor — poller did not arm");
    firstPending.resolve([
      {
        update_id: 100,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 4242, type: "private" },
          text: "hi",
          from: { id: 9, is_bot: false, first_name: "Alice", username: "alice" }
        }
      }
    ]);

    await waitFor(() => sendCalls.length === 1, "first verification code reply dispatched", 3000);
    const firstCode = sendCalls[0]?.text.match(/[0-9A-F]{4}-[0-9A-F]{4}/)?.[0];
    expect(firstCode).toBeDefined();

    // Second DM from the same chat — within the TTL window so the prior
    // code is still valid. The poller mints nothing new and skips the
    // outbound send. sendCalls.length === 1 going true does not prove the
    // poller has looped back and pushed its next getUpdates promise into
    // the queue (the push happens after the deliverVerificationCode that
    // increments sendCalls, but inside the same iteration's tail). Wait
    // for queue.length > 0 so the second shift can't silently no-op.
    await waitFor(() => queue.length > 0, "poller re-armed for second update", 3000);
    const secondPending = queue.shift();
    if (!secondPending) throw new Error("queue empty after waitFor — poller did not re-arm");
    secondPending.resolve([
      {
        update_id: 101,
        message: {
          message_id: 2,
          date: 0,
          chat: { id: 4242, type: "private" },
          text: "still waiting",
          from: { id: 9, is_bot: false, first_name: "Alice", username: "alice" }
        }
      }
    ]);

    // Wait long enough for a second poll cycle to land if it were going
    // to. Without this delay the test would race against the gate.
    await waitFor(
      () => readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.metadata?.lastOffset === 102,
      "second update processed",
      3000
    );
    expect(sendCalls.length).toBe(1);

    // The pending entry on metadata still carries the original code
    // (untouched expiry) so the operator UI doesn't churn.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    const pending = (live?.metadata?.recentDeniedChats as Array<{ chatId: number; verificationCode?: string }>)?.find(
      (entry) => entry.chatId === 4242
    );
    expect(pending?.verificationCode).toBe(firstCode);

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

  test("reply mirror forwards an inline image ref as a Telegram photo and strips the tag from the text", async () => {
    const config = testConfig("tg-outbound-photo");
    const { storeUpload } = await import("../state");
    const sendPhotoCalls: Array<{ chatId: string | number; source: unknown; caption?: string }> = [];
    const sendMessageCalls: string[] = [];
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        sendMessageCalls.push(text);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction() {
        return true as const;
      },
      async sendPhoto(chatId, source, options) {
        sendPhotoCalls.push({ chatId, source, caption: options?.caption });
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
      deliveryTargets: ["55"],
      botToken: "TOK"
    });

    // Store a real upload so uploadPathFor resolves a path the mirror sends.
    const upload = storeUpload(config.instance, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "shot.png");

    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_photo_tg",
        instance: config.instance,
        title: "screenshot",
        input: "screenshot lego.com",
        status: "completed",
        // The agent embeds the image as a gini-upload:// markdown ref in its
        // reply text — the mirror pulls the id out and sends the photo.
        summary: `Here's the screenshot. ![screenshot](gini-upload://${upload.id})`,
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: "session_photo_tg"
      });
      const session: ChatSessionRecord = {
        id: "session_photo_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: ["task_photo_tg"],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 55, target: "55" }
      };
      state.chatSessions.push(session);
    });

    const controller = new AbortController();
    await telegramInternals.maintainTypingAndMirrorReply(
      config,
      bridge.id,
      "task_photo_tg",
      55,
      client,
      controller.signal
    );

    // The image ref is sent as a caption-less photo, and the text (with the
    // markdown tag stripped) goes as its own message. Two separate sends so
    // the reply can never be lost to a caption-length limit or photo failure.
    expect(sendPhotoCalls.length).toBe(1);
    expect(sendMessageCalls.length).toBe(1);
    const call = sendPhotoCalls[0]!;
    expect(call.caption).toBeUndefined();
    // The raw gini-upload:// tag must NOT appear in the user-facing text.
    expect(sendMessageCalls[0]).toContain("Here's the screenshot");
    expect(sendMessageCalls[0]).not.toContain("gini-upload://");
    const source = call.source as { kind?: string; path?: string };
    expect(source.kind).toBe("path");
    expect(source.path?.endsWith(`${upload.id}.png`)).toBe(true);
  });

  test("reply mirror keeps a NON-image attachment's filename in the text (not silently dropped)", async () => {
    const config = testConfig("tg-outbound-doc");
    const { storeUpload } = await import("../state");
    const sendPhotoCalls: unknown[] = [];
    const sendMessageCalls: string[] = [];
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        sendMessageCalls.push(text);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction() {
        return true as const;
      },
      async sendPhoto(chatId) {
        sendPhotoCalls.push({ chatId });
        return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
      },
      async getFile(fileId) {
        return { file_id: fileId, file_unique_id: fileId, file_path: `f/${fileId}` };
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
      deliveryTargets: ["55"],
      botToken: "TOK"
    });

    // A non-image upload (PDF). Telegram sendDocument isn't wired yet, so the
    // file isn't sent — but its filename label must survive in the text so the
    // attachment doesn't vanish without a trace.
    const upload = storeUpload(
      config.instance,
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      "application/pdf",
      "release-notes.pdf"
    );

    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_doc_tg",
        instance: config.instance,
        title: "send pdf",
        input: "send me the pdf",
        status: "completed",
        summary: `Here are the files: [release-notes.pdf](gini-upload://${upload.id})`,
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: "session_doc_tg"
      });
      const session: ChatSessionRecord = {
        id: "session_doc_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: ["task_doc_tg"],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 55, target: "55" }
      };
      state.chatSessions.push(session);
    });

    const controller = new AbortController();
    await telegramInternals.maintainTypingAndMirrorReply(
      config,
      bridge.id,
      "task_doc_tg",
      55,
      client,
      controller.signal
    );

    // No photo (it's not an image), but the text is sent with the FILENAME
    // visible and only the unusable gini-upload:// link target removed. The
    // outbound text is MarkdownV2-escaped (`-` and `.` get backslash-escaped),
    // so match the filename with the escaping the send layer applies.
    expect(sendPhotoCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toContain("release\\-notes\\.pdf");
    expect(sendMessageCalls[0]).not.toContain("gini-upload://");
  });

  test("a FAILED image photo send keeps the image's alt label in the mirrored text", async () => {
    const config = testConfig("tg-outbound-photo-fail");
    const { storeUpload } = await import("../state");
    const sendMessageCalls: string[] = [];
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        sendMessageCalls.push(text);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction() {
        return true as const;
      },
      // The photo send FAILS. sendMessagingOutput swallows this into a
      // status:"failed" record (it does not throw), so the mirror must NOT
      // treat the image as delivered.
      async sendPhoto() {
        throw new Error("telegram 413: photo too large");
      },
      async getFile(fileId) {
        return { file_id: fileId, file_unique_id: fileId, file_path: `f/${fileId}` };
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
      deliveryTargets: ["55"],
      botToken: "TOK"
    });

    const upload = storeUpload(config.instance, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "shot.png");

    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_photofail_tg",
        instance: config.instance,
        title: "screenshot",
        input: "screenshot it",
        status: "completed",
        summary: `Here's the shot: ![the-screenshot](gini-upload://${upload.id})`,
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: "session_photofail_tg"
      });
      const session: ChatSessionRecord = {
        id: "session_photofail_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: ["task_photofail_tg"],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 55, target: "55" }
      };
      state.chatSessions.push(session);
    });

    const controller = new AbortController();
    await telegramInternals.maintainTypingAndMirrorReply(
      config,
      bridge.id,
      "task_photofail_tg",
      55,
      client,
      controller.signal
    );

    // The photo didn't deliver, so its tag is NOT stripped — the alt label
    // survives in the text (MarkdownV2-escaped) so the attachment isn't lost.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toContain("the\\-screenshot");
    expect(sendMessageCalls[0]).not.toContain("gini-upload://");
  });

  test("a [SILENT]-suppressed turn does NOT leak its outbound image to Telegram", async () => {
    const config = testConfig("tg-silent-photo");
    const { storeUpload } = await import("../state");
    const sendPhotoCalls: unknown[] = [];
    const sendMessageCalls: string[] = [];
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        sendMessageCalls.push(text);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction() {
        return true as const;
      },
      async sendPhoto(chatId) {
        sendPhotoCalls.push({ chatId });
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
      deliveryTargets: ["56"],
      botToken: "TOK"
    });
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_silent_tg",
        instance: config.instance,
        title: "watch",
        input: "watch",
        status: "completed",
        // The [SILENT] sentinel — syncChatTaskResult returns null and the
        // reply is suppressed. The image must be suppressed with it.
        summary: "[SILENT]",
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: "session_silent_tg"
      });
      const session: ChatSessionRecord = {
        id: "session_silent_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: ["task_silent_tg"],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 56, target: "56" }
      };
      state.chatSessions.push(session);
    });

    const controller = new AbortController();
    await telegramInternals.maintainTypingAndMirrorReply(
      config,
      bridge.id,
      "task_silent_tg",
      56,
      client,
      controller.signal
    );

    // Fully silent: a [SILENT] reply is suppressed (syncChatTaskResult returns
    // null), and since any image ref would live INSIDE that suppressed reply
    // text, nothing — neither text nor photo — goes out.
    expect(sendPhotoCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(0);
  });

  test("a reply longer than Telegram's caption limit sends the photo caption-less + the text as a separate message", async () => {
    const config = testConfig("tg-long-caption");
    const { storeUpload } = await import("../state");
    const sendPhotoCalls: Array<{ caption?: string }> = [];
    const sendMessageCalls: string[] = [];
    const client: TelegramClient = {
      async getMe() {
        return { id: 1, is_bot: true, username: "ginibot" };
      },
      async sendMessage(chatId, text) {
        sendMessageCalls.push(text);
        return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
      },
      async sendChatAction() {
        return true as const;
      },
      async sendPhoto(chatId, _source, options) {
        sendPhotoCalls.push({ caption: options?.caption });
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
      deliveryTargets: ["57"],
      botToken: "TOK"
    });
    const upload = storeUpload(config.instance, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "shot.png");
    // A reply well past Telegram's 1024-char caption cap, with the image ref
    // embedded inline.
    const longReply = "x".repeat(1500) + ` ![shot](gini-upload://${upload.id})`;
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_long_tg",
        instance: config.instance,
        title: "screenshot",
        input: "screenshot",
        status: "completed",
        summary: longReply,
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: "session_long_tg"
      });
      const session: ChatSessionRecord = {
        id: "session_long_tg",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: ["task_long_tg"],
        runIds: [],
        source: { kind: "telegram", bridgeId: bridge.id, chatId: 57, target: "57" }
      };
      state.chatSessions.push(session);
    });

    const controller = new AbortController();
    await telegramInternals.maintainTypingAndMirrorReply(
      config,
      bridge.id,
      "task_long_tg",
      57,
      client,
      controller.signal
    );

    // The photo went out caption-less, and the full text (tag stripped) went as
    // its own message — nothing was lost to the 1024-char caption ceiling, and
    // the >1024-char body proves we never tried to ride it as a caption.
    expect(sendPhotoCalls.length).toBe(1);
    expect(sendPhotoCalls[0]!.caption).toBeUndefined();
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]!.length).toBeGreaterThan(1024);
    expect(sendMessageCalls[0]!).not.toContain("gini-upload://");
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

    const supervisor = createTrackedSupervisor(config, { clientFactory: () => deferredClient().client });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    const { disableMessagingBridge } = await import("./messaging");
    await disableMessagingBridge(config, bridge.id);

    supervisor.reconcile();
    await waitFor(() => supervisor.size() === 0, "loop stopped after disable");
  });
});
