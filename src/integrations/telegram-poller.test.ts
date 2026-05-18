import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import { createTelegramPollerSupervisor } from "./telegram-poller";
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
      getUpdates(_offset, _timeout, signal) {
        return new Promise((resolve, reject) => {
          updateQueue.push({ resolve });
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };
    setMessagingDeps({ telegramClientFactory: () => client });

    await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

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
