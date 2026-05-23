import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import { createDiscordPollerSupervisor, __internalsForTests as discordInternals } from "./discord-poller";
import type { DiscordGatewayHandle } from "./discord-gateway";

// No-op Gateway connector for tests so the supervisor doesn't open a
// live WebSocket to gateway.discord.gg on every test bring-up. The
// production code's gateway lifecycle (close on loop exit, reconnect
// on close) is covered by discord-gateway.test.ts in isolation; the
// poller tests just need a `close()`-able handle.
function stubGateway(): DiscordGatewayHandle {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { done: promise, close: () => resolve() };
}

// Gateway connector that captures the `onMessageCreate` callback so
// a test can simulate a Discord-pushed event and prove the wake
// collapses the next poll-cycle sleep.
function capturingGateway(slot: { fire?: (event: { channelId: string }) => void }) {
  return (options: { onMessageCreate?: (event: { channelId: string }) => void }) => {
    if (options.onMessageCreate) slot.fire = options.onMessageCreate;
    const { promise, resolve } = Promise.withResolvers<void>();
    return { done: promise, close: () => resolve() };
  };
}
import { setMaxTaskWaitMsForTests } from "./messaging-poller-helpers";
import { mutateState } from "../state";
import type { ChatSessionRecord } from "../types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "../paths";
import type { DiscordClient, DiscordMessage } from "./discord";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-discord-poller-tests";
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

// Programmable Discord client. Tests script per-channel fetch
// responses, then assert on state after the poller's tight-loop
// cadence has had a chance to run them. sendMessage / typing / getMe
// are no-ops that capture their inputs so the reply mirror + typing
// pulse can be observed in assertions.
//
// Two stub flavors:
//   - `enqueue(channelId, messages)` — blind FIFO queue, used by
//     tests where the order of returned batches doesn't depend on
//     the `afterId` cursor.
//   - `installStore(channelId, messages)` — cursor-honoring store
//     that derives responses from `(afterId, limit)`, mirroring
//     Discord's actual REST contract. Used by the pagination test
//     so a broken cursor in production would fail the assertion.
function programmableClient(): {
  client: DiscordClient;
  enqueue: (channelId: string, messages: DiscordMessage[]) => void;
  failNext: (channelId: string, message: string) => void;
  installStore: (channelId: string, messages: DiscordMessage[]) => void;
  sendCalls: Array<{ channelId: string; content: string }>;
  typingCalls: string[];
} {
  type QueueEntry = { kind: "ok"; messages: DiscordMessage[] } | { kind: "err"; message: string };
  const perChannel = new Map<string, QueueEntry[]>();
  const perChannelStore = new Map<string, DiscordMessage[]>();
  const sendCalls: Array<{ channelId: string; content: string }> = [];
  const typingCalls: string[] = [];
  const client: DiscordClient = {
    async getMe() {
      return { id: "100", username: "Gini", discriminator: "3715", bot: true };
    },
    async sendMessage(channelId, content) {
      sendCalls.push({ channelId, content });
      return {
        id: `reply-${sendCalls.length}`,
        channel_id: channelId,
        content,
        timestamp: "2026-01-01T00:00:00Z",
        author: { id: "100", username: "Gini", bot: true }
      };
    },
    async triggerTypingIndicator(channelId) {
      typingCalls.push(channelId);
      return true as const;
    },
    async fetchChannelMessages(channelId, options) {
      // Cursor-honoring store wins when one is installed for this
      // channel. The store mirrors Discord's REST contract:
      //   - with `after=X&limit=N`: NEWEST N messages whose id > X,
      //     sorted newest-first
      //   - with `before=X&limit=N`: NEWEST N messages whose id < X,
      //     sorted newest-first
      //   - with neither: NEWEST N messages overall, newest-first
      const store = perChannelStore.get(channelId);
      if (store) {
        const limit = options?.limit ?? 50;
        let filtered = store;
        if (options?.beforeId !== undefined) {
          const before = BigInt(options.beforeId);
          filtered = store.filter((m) => BigInt(m.id) < before);
        } else if (options?.afterId !== undefined) {
          const after = BigInt(options.afterId);
          filtered = store.filter((m) => BigInt(m.id) > after);
        }
        const sorted = [...filtered].sort((a, b) =>
          BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0
        );
        return sorted.slice(0, limit);
      }
      const queue = perChannel.get(channelId) ?? [];
      const next = queue.shift();
      perChannel.set(channelId, queue);
      if (!next) return [];
      if (next.kind === "err") throw new Error(next.message);
      return next.messages;
    }
  };
  return {
    client,
    enqueue(channelId, messages) {
      const queue = perChannel.get(channelId) ?? [];
      queue.push({ kind: "ok", messages });
      perChannel.set(channelId, queue);
    },
    failNext(channelId, message) {
      const queue = perChannel.get(channelId) ?? [];
      queue.push({ kind: "err", message });
      perChannel.set(channelId, queue);
    },
    installStore(channelId, messages) {
      perChannelStore.set(channelId, messages);
    },
    sendCalls,
    typingCalls
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// Wrap supervisor lifecycle in try/finally so a failed assertion can
// never leak the loop into the next test — a leaked loop would keep
// polling against the (next test's) GINI_STATE_ROOT and surface as
// spurious failures.
async function withSupervisor<T>(
  supervisor: { stopAll: () => Promise<void> },
  body: () => Promise<T>
): Promise<T> {
  try {
    return await body();
  } finally {
    await supervisor.stopAll().catch(() => {});
  }
}

function makeMessage(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: "100",
    channel_id: "chan-1",
    content: "hello",
    timestamp: "2026-01-01T00:00:00Z",
    author: { id: "user-1", username: "lo", bot: false },
    ...overrides
  };
}

describe("discord poller supervisor", () => {
  afterEach(() => {
    resetMessagingDeps();
    // Belt-and-suspenders reset: if a test crashes mid-flight or a
    // future change moves to `bun test --concurrent`, a process-global
    // wait-cap override could otherwise leak into the next test.
    setMaxTaskWaitMsForTests(undefined);
  });

  test("reconcile starts a loop for a configured bridge; stopAll cancels it", async () => {
    const config = testConfig("disc-start-stop");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    await supervisor.stopAll();
    expect(supervisor.size()).toBe(0);
  });

  test("first contact on a non-empty channel seeds the watermark from wall-clock NOW, NOT from the newest observed snowflake (closes mid-fetch race)", async () => {
    // The naive "seed to newest observed" path had a real race: if a
    // user posted a message during the very first fetch's request
    // window, that message would be included in the response, pinned
    // as the seed, and silently dropped (the next poll with
    // afterId=<their_id> finds nothing). Seeding to a wall-clock
    // snowflake closes the window — any real-time message is strictly
    // newer than (now - 5s) so it routes on the next poll.
    const config = testConfig("disc-seed");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // History returned newest-first by Discord. Historical snowflakes
    // are tiny ("300" etc.) compared to a real now-derived snowflake
    // (which is ~10^18 today).
    enqueue("chan-1", [
      makeMessage({ id: "300", content: "old c" }),
      makeMessage({ id: "200", content: "old b" }),
      makeMessage({ id: "100", content: "old a" })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => {
        const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
        const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
        return Boolean(watermark);
      },
      "watermark to advance"
    );

    // The watermark must NOT be the newest historical snowflake — that's
    // the OLD buggy behavior the race fix replaced. It must be a
    // wall-clock-derived snowflake (BigInt orders of magnitude larger
    // than any historical id in this fixture).
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
    expect(watermark).toBeDefined();
    expect(watermark).not.toBe("300");
    expect(BigInt(watermark!)).toBeGreaterThan(BigInt("1000000000000000")); // 10^15, much larger than historical "300"
    // Sanity: a snowflake derived from wall-clock NOW should be less
    // than a snowflake derived from NOW + 1 day. This pins that the
    // seed is in the present, not some far-future sentinel.
    const oneDayFromNow = (BigInt(Date.now() + 24 * 60 * 60 * 1000) - 1420070400000n) << 22n;
    expect(BigInt(watermark!)).toBeLessThan(oneDayFromNow);

    // No history messages should have been routed.
    expect(sendCalls).toEqual([]);
    expect(readState(config.instance).tasks).toEqual([]);

    await supervisor.stopAll();
  });

  test("a user message arriving during the first fetch window is NOT consumed as the seed and routes on the next poll (mid-fetch race)", async () => {
    // Exact regression test for the race the wall-clock seed fix
    // closes. Scenario: bridge attaches, fires first fetch. Discord's
    // response includes a real user message (simulating a user who
    // typed during the request window). The old code would have
    // pinned that message's snowflake as the seed and dropped it.
    // The new code seeds to wall-clock NOW (which is larger than any
    // realistic real-time snowflake from this moment), so the user's
    // message is strictly NEWER than the seed and routes on the next
    // poll. We use a synthetic snowflake = (now-1s) so it's older than
    // the seed; routing therefore depends on the next poll picking it
    // up via afterId. To make that work we enqueue it again on the
    // second batch (simulating Discord returning the same message
    // when re-queried with afterId<that_snowflake>).
    //
    // Without the fix, this test would deadlock waiting for the
    // routing because the first-contact seed would have already
    // pinned the user's snowflake as the watermark and the second
    // poll would find nothing newer.
    const config = testConfig("disc-mid-fetch-race");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Build a "real-time" snowflake (~now): timestamp 1s in the past,
    // shifted into snowflake position. This is the snowflake Discord
    // would assign to a message arriving during our first fetch.
    const realtimeSnowflake = ((BigInt(Date.now() - 1000) - 1420070400000n) << 22n).toString();

    // First fetch returns the user's message (the mid-fetch arrival).
    enqueue("chan-1", [
      makeMessage({
        id: realtimeSnowflake,
        content: "user typed during the fetch",
        author: { id: "user-1", username: "lo", bot: false }
      })
    ]);
    // Second fetch returns the same message again (afterId=<seed> will
    // be older than the user's snowflake, so Discord re-includes it).
    enqueue("chan-1", [
      makeMessage({
        id: realtimeSnowflake,
        content: "user typed during the fetch",
        author: { id: "user-1", username: "lo", bot: false }
      })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    // The fix means the user's message survives the first-contact
    // seed and gets routed on the second poll. Without the fix this
    // wait would time out.
    await waitFor(() => sendCalls.length >= 1, "mid-fetch user message to route despite first-contact seeding");
    void bridge;

    await supervisor.stopAll();
  });

  test("non-bot inbound message produces a task, advances the watermark, and triggers a reply", async () => {
    const config = testConfig("disc-incoming");
    const { client, enqueue, sendCalls, typingCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Empty first batch → seeds to the "0" sentinel (empty-channel
    // branch). Subsequent batch carries the real user message; any
    // snowflake > "0" routes normally. The other "non-empty first
    // contact" branch uses wall-clock seeding, so a small synthetic
    // id like "500" would be filtered out as "older than NOW" — we
    // explicitly use the empty seeding path here to keep the test
    // independent of wall-clock math.
    enqueue("chan-1", []);
    enqueue("chan-1", [
      makeMessage({ id: "500", content: "hi gini", author: { id: "user-1", username: "lo", bot: false } })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.direction === "inbound" && m.target === "chan-1"),
      "inbound message to land"
    );

    await waitFor(
      () => sendCalls.length >= 1,
      "reply dispatch to fire after task settles"
    );

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.direction === "inbound");
    // The poller prefixes the author handle so multi-user channels
    // don't blend turns. `lo` is the test author's username.
    expect(inbound?.text).toBe("lo: hi gini");
    expect(inbound?.target).toBe("chan-1");

    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
    expect(watermark).toBe("500");

    // The reply mirror dispatches back through sendMessagingOutput,
    // which calls client.sendMessage with the assistant text.
    expect(sendCalls[0]?.channelId).toBe("chan-1");
    expect(sendCalls[0]?.content.length).toBeGreaterThan(0);

    // Typing indicator fired at least once before the task settled.
    expect(typingCalls.length).toBeGreaterThanOrEqual(1);

    await supervisor.stopAll();
  });

  test("bot-authored messages advance the watermark without spawning a task", async () => {
    const config = testConfig("disc-skip-bot");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Empty first batch → "0" sentinel seed (see other tests). Then a
    // bot-authored message that the poller must skip while still
    // advancing the watermark.
    enqueue("chan-1", []);
    enqueue("chan-1", [
      makeMessage({ id: "700", content: "i am a bot", author: { id: "100", username: "Gini", bot: true } })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => {
        const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
        const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
        return watermark === "700";
      },
      "watermark to advance past the bot message"
    );

    expect(readState(config.instance).tasks).toEqual([]);
    expect(sendCalls).toEqual([]);

    await supervisor.stopAll();
  });

  test("reconcile aborts the loop for a bridge that no longer matches shouldRun (status disabled)", async () => {
    const config = testConfig("disc-disable");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    // Flip the bridge to disabled without going through
    // disableMessagingBridge so the test isolates the reconcile path.
    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.status = "disabled";
    });

    // reconcile sees the bridge no longer matches shouldRun and calls
    // stopLoop → controller.abort(). The loop exits via the abort
    // path. This test deliberately covers the supervisor-driven path,
    // not the runLoop self-exit guard — that path is covered below.
    supervisor.reconcile();
    await waitFor(() => supervisor.size() === 0, "loop to exit after reconcile-driven abort");

    await supervisor.stopAll();
  });

  test("runLoop self-exits when bridge status flips between poll cycles (no reconcile)", async () => {
    // Distinct from the reconcile-driven test above: here we never
    // call reconcile() after the status flip. The loop must observe
    // the new status on its next iteration and self-exit via the
    // guard at the top of runLoop. If the guard were removed, the
    // loop would keep polling against a disabled bridge until
    // supervisor.stopAll() forces it.
    const config = testConfig("disc-self-exit");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.status = "disabled";
    });

    // No reconcile() call. The loop should self-exit on its next
    // iteration when the top-of-loop guard observes status !==
    // "configured". The supervisor's `.finally` cleans up the map.
    await waitFor(() => supervisor.size() === 0, "loop to self-exit without reconcile");

    await supervisor.stopAll();
  });

  test("empty channel seeds a sentinel watermark, then routes the next real message", async () => {
    // Regression: a bridge attached to an empty channel must NOT
    // consume the first user message as its seed. Without the "0"
    // sentinel, an empty first poll bails without seeding, the next
    // poll finds watermark === undefined, and treats the first real
    // message as the seed (and never routes it).
    const config = testConfig("disc-empty-seed");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // First poll: channel is empty. Watermark must seed to "0".
    enqueue("chan-1", []);
    // Second poll: a real user message arrives. It must be routed,
    // not consumed as the seed.
    enqueue("chan-1", [
      makeMessage({ id: "999000000000000000", content: "first real message" })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });

    await withSupervisor(supervisor, async () => {
      supervisor.reconcile();
      await waitFor(
        () => {
          const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
          const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
          return watermark === "999000000000000000";
        },
        "watermark to advance past the first real user message"
      );
      await waitFor(() => sendCalls.length >= 1, "reply to dispatch after seeding from empty");
    });

    const inbound = readState(config.instance).messagingMessages.find(
      (m) => m.direction === "inbound" && m.target === "chan-1"
    );
    // Author-handle prefix; the test fixture's author is `lo`.
    expect(inbound?.text).toBe("lo: first real message");
  });

  test("pagination catches up when more than FETCH_BATCH_LIMIT messages land between polls", async () => {
    // Discord's REST `after` returns the NEWEST FETCH_BATCH_LIMIT
    // messages above the cursor (not the oldest), so a single fetch
    // call would skip the older messages in a burst >limit. The
    // pagination loop in pollChannel must keep advancing the cursor
    // and re-fetching until a partial batch lands or the per-tick
    // safety cap fires.
    //
    // Strong shape: the stub here is cursor-honoring (installStore),
    // not a blind FIFO. A user-authored message sits in the OLDER
    // page of the burst — a broken implementation that pinned the
    // cursor to the newest of the first 50 would skip the user
    // message and the final task assertion would fail.
    const config = testConfig("disc-pagination");
    const { client, enqueue, installStore, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Empty first batch → "0" sentinel seed. Subsequent polls walk the
    // cursor-honoring store; every message id > "0" routes normally.
    enqueue("chan-1", []);

    // Build a 75-message burst. Ids 1000..1074. The user-authored
    // message sits at id 1010 — well below the 50th-newest cutoff
    // (1025) so a broken single-fetch poller would drop it.
    const burst: DiscordMessage[] = [];
    for (let i = 0; i < 75; i += 1) {
      const isUser = i === 10;
      burst.push(makeMessage({
        id: String(1000 + i),
        content: isUser ? "user-in-older-page" : `bot burst ${i}`,
        author: isUser
          ? { id: "user-1", username: "lo", bot: false }
          : { id: "bot-1", username: "OtherBot", bot: true }
      }));
    }

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: stubGateway,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });

    await withSupervisor(supervisor, async () => {
      // First reconcile burns the empty seed batch → watermark "0".
      supervisor.reconcile();
      await waitFor(
        () => {
          const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
          const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
          return watermark === "0";
        },
        "watermark to land on '0' sentinel before burst arrives"
      );

      // Now install the cursor-honoring store with the 75-message
      // burst. The next poll cycle will paginate through it.
      installStore("chan-1", burst);

      // The user-authored message at id 1010 must be routed — that
      // requires the pagination loop to keep going past the first
      // 50 messages (which are all bot-authored above id 1025).
      await waitFor(
        () => readState(config.instance).messagingMessages.some(
          (m) => m.direction === "inbound" && m.text === "lo: user-in-older-page"
        ),
        "user-authored message in the older page to land via pagination catch-up"
      );

      // And the watermark must reach the newest id in the burst
      // (1074), not stop at the first page boundary.
      await waitFor(
        () => {
          const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
          const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
          return watermark === "1074";
        },
        "watermark to advance to newest of the burst (1074)"
      );

      // Reply mirror runs for the user message — sendCalls captures
      // the dispatch.
      await waitFor(() => sendCalls.length >= 1, "reply dispatch for the older-page user message");
    });
  });

  test("markBridgeError respects a disable that races with a secret read", async () => {
    // Direct unit test for the helper: simulate a loop catching
    // ENOENT after a concurrent disable has flipped the bridge to
    // "disabled". Calling markBridgeError must NOT overwrite the
    // user's explicit disable with "error". The previous shape of
    // this test relied on a reconcile-driven exit path that bypassed
    // markBridgeError entirely; this version calls the helper
    // directly so the disable-respect guard is the only thing under
    // test.
    const config = testConfig("disc-disable-race");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const { disableMessagingBridge } = await import("./messaging");
    const { markBridgeError } = await import("./messaging-poller-helpers");

    // Step 1: user disables the bridge.
    await disableMessagingBridge(config, bridge.id);
    expect(
      readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.status
    ).toBe("disabled");

    // Step 2: a poll loop, mid-tick when disable landed, catches
    // its ENOENT and calls markBridgeError. The helper must observe
    // the now-disabled status and refuse to write.
    await markBridgeError(
      config,
      bridge.id,
      "messaging.discord.token_error",
      "messaging.discord.mark_error_failed",
      new Error("ENOENT: no such file or directory, open '/.../secrets/bridge.bot-token.json'")
    );

    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.status).toBe("disabled");
    // The disable's status message must also be preserved — markBridgeError
    // didn't overwrite it.
    expect(live?.message ?? "").not.toContain("ENOENT");
  });

  test("reply mirror logs reply_skip_non_terminal and tears down the typing pulse when the task wait cap fires", async () => {
    // Direct exercise of maintainTypingAndMirrorReply: pre-populate a
    // stuck task + chat session, run the mirror with a 50ms cap, and
    // confirm that
    //   1. the skip log fires (without the typingController + finally
    //      pattern, `await typingDone` would block forever on a task
    //      whose typing kept succeeding); and
    //   2. typing calls stop the moment the cap fires (no further
    //      triggerTypingIndicator calls after the function returns).
    const config = testConfig("disc-skip-non-terminal");
    const { client, typingCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Plant a non-terminal task and a chat session matching the
    // (bridge, channel) the mirror will look up.
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_stuck",
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
        id: "session_stuck",
        instance: config.instance,
        title: "t",
        createdAt: "",
        updatedAt: "",
        messageIds: [],
        taskIds: [],
        runIds: [],
        source: { kind: "discord", bridgeId: bridge.id, channelId: "chan-1", target: "chan-1" }
      };
      state.chatSessions.push(session);
    });

    setMaxTaskWaitMsForTests(50);
    try {
      const controller = new AbortController();
      await discordInternals.maintainTypingAndMirrorReply(
        config,
        bridge.id,
        "task_stuck",
        "chan-1",
        client,
        controller.signal,
        20
      );

      // The skip log must fire because the task never reached terminal
      // state. Read the runtime log file directly so the test makes no
      // assumptions about reverse-lookup helpers.
      const logPath = join(logDir(config.instance), "runtime.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      // Filter by bridgeId so this test is robust against any
      // accumulated log entries from earlier runs that share the
      // log root.
      const skip = entries.find(
        (entry) =>
          entry.message === "messaging.discord.reply_skip_non_terminal" &&
          (entry.data as Record<string, unknown> | undefined)?.bridgeId === bridge.id
      );
      expect(skip).toBeDefined();
      const data = skip?.data as Record<string, unknown> | undefined;
      expect(data?.bridgeId).toBe(bridge.id);
      expect(data?.taskId).toBe("task_stuck");
      expect(data?.status).toBe("running");

      // Capture how many typing calls fired by the time the mirror
      // returned, then wait a couple of typing-refresh cycles. The
      // count must NOT grow — proving the typing controller's abort
      // shut the pulse down rather than leaking past the function
      // boundary.
      const settledCount = typingCalls.length;
      await Bun.sleep(80);
      expect(typingCalls.length).toBe(settledCount);
    } finally {
      setMaxTaskWaitMsForTests(undefined);
    }
  });

  test("gateway-pushed MESSAGE_CREATE for a delivery-target channel collapses the next poll sleep", async () => {
    // Configure the poller with a long pollIntervalMs so the test
    // doesn't accidentally pass by simply waiting out the periodic
    // tick. With pollIntervalMs=5000ms and the wake fired ~50ms after
    // the first poll cycle, the inbound message should land in well
    // under 1s — proof that the gateway push is what drove the
    // re-poll, not the periodic timer.
    const config = testConfig("disc-push-wake");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const slot: { fire?: (event: { channelId: string }) => void } = {};
    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: capturingGateway(slot),
      pollIntervalMs: 5000,
      typingRefreshMs: 20
    });

    // Seed batch (so first-contact pins the watermark and the next
    // poll routes real messages).
    enqueue("chan-1", []);
    supervisor.reconcile();
    await waitFor(
      () => Boolean(readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.metadata?.lastInboundExternalIds),
      "first-contact watermark seed"
    );

    // Queue the real inbound, then fire the gateway push. The poller
    // is currently mid-sleep (5s); the wake must collapse it.
    enqueue("chan-1", [
      makeMessage({ id: "500", content: "pushed", author: { id: "user-1", username: "lo", bot: false } })
    ]);
    const wakeStart = Date.now();
    slot.fire?.({ channelId: "chan-1" });
    await waitFor(() => sendCalls.length >= 1, "reply dispatched after gateway-pushed wake");
    const elapsed = Date.now() - wakeStart;
    expect(elapsed).toBeLessThan(2500);

    await supervisor.stopAll();
  });

  test("gateway-pushed MESSAGE_CREATE for an unrelated channel does NOT wake the poller", async () => {
    // Wake controller filtering: a push for a channel that is NOT
    // in the bridge's deliveryTargets must be ignored so we don't
    // burn an extra REST round trip for events we don't care about.
    const config = testConfig("disc-push-wake-ignore");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });
    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const slot: { fire?: (event: { channelId: string }) => void } = {};
    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      gatewayConnector: capturingGateway(slot),
      pollIntervalMs: 5000,
      typingRefreshMs: 20
    });
    enqueue("chan-1", []);
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "gateway connector captured the callback");

    // Queue an inbound for chan-1 but fire a push for an unrelated
    // channel. The wake must NOT collapse the sleep; the reply
    // dispatch should NOT arrive in the next ~500ms.
    enqueue("chan-1", [
      makeMessage({ id: "500", content: "should not wake", author: { id: "user-1", username: "lo", bot: false } })
    ]);
    slot.fire?.({ channelId: "unrelated-9999" });
    await Bun.sleep(500);
    expect(sendCalls.length).toBe(0);

    await supervisor.stopAll();
  });

  test("markBridgeError flips a configured bridge to 'error' and sanitizes the file path", async () => {
    // Companion test: when the bridge IS still configured, the
    // helper does flip status to "error", and the persisted
    // bridge.message scrubs the absolute secret-file path so the
    // state surface doesn't leak the encrypted-store layout.
    const config = testConfig("disc-mark-error-sanitized");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const { markBridgeError } = await import("./messaging-poller-helpers");
    await markBridgeError(
      config,
      bridge.id,
      "messaging.discord.token_error",
      "messaging.discord.mark_error_failed",
      new Error("ENOENT: no such file or directory, open '/tmp/some-instance/secrets/bridge_x.bot-token.json'")
    );

    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.status).toBe("error");
    expect(String(live?.message)).toContain("ENOENT");
    expect(String(live?.message)).toContain("<secret-path>");
    expect(String(live?.message)).not.toContain("/tmp/some-instance/secrets/");
  });
});
