import { describe, expect, test } from "bun:test";
import { connectDiscordGateway } from "./discord-gateway";

// Stub WebSocket that captures sent frames and lets the test drive
// open/message/close events. Keeps the test off the real Gateway
// while still exercising the IDENTIFY / HEARTBEAT / RECONNECT shape
// the production code emits.
class StubSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 1; // OPEN — production code only sends when open
  sent: string[] = [];

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(public url: string) {
    StubSocket.lastInstance = this;
    StubSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = StubSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  static lastInstance: StubSocket | null = null;
  static instances: StubSocket[] = [];
  static reset(): void {
    StubSocket.lastInstance = null;
    StubSocket.instances = [];
  }
}

// Bridge between StubSocket and the production code's WebSocket
// constructor signature. The cast lets us pass it as the test seam
// without dragging in lib.dom WebSocket type plumbing.
const StubCtor = StubSocket as unknown as new (url: string) => WebSocket;

function lastInstance(): StubSocket {
  const inst = StubSocket.lastInstance;
  if (!inst) throw new Error("no socket created");
  return inst;
}

describe("discord-gateway", () => {
  test("connects, sends IDENTIFY with GUILD_MESSAGES|DIRECT_MESSAGES intents and a presence object, then heartbeats on the HELLO interval", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      statusText: "test-presence"
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    // Server sends HELLO with a tiny heartbeat interval so the test
    // can observe the first scheduled heartbeat without waiting the
    // production ~41s.
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 20 }, s: null, t: null }) });

    // The first frame sent should be an immediate heartbeat (op 1)
    // followed by IDENTIFY (op 2). The order is implementation
    // detail — assert by op code, not index.
    const ops = sock.sent.map((raw) => JSON.parse(raw).op as number);
    expect(ops).toContain(1);
    expect(ops).toContain(2);

    const identify = sock.sent
      .map((raw) => JSON.parse(raw) as { op: number; d: Record<string, unknown> })
      .find((frame) => frame.op === 2)!;
    expect(identify.d.token).toBe("TOK");
    // GUILD_MESSAGES (1 << 9) | DIRECT_MESSAGES (1 << 12) = 4608.
    // MESSAGE_CONTENT (1 << 15) is intentionally NOT requested:
    // event content arrives empty and REST polling fills it in.
    expect(identify.d.intents).toBe(4608);
    const presence = identify.d.presence as {
      activities: Array<{ name: string; type: number }>;
      status: string;
    };
    expect(presence.status).toBe("online");
    expect(presence.activities[0]?.name).toBe("test-presence");
    expect(presence.activities[0]?.type).toBe(4);

    // Wait for a heartbeat interval and confirm at least one more
    // heartbeat went out beyond the initial one.
    const before = sock.sent.filter((raw) => JSON.parse(raw).op === 1).length;
    await Bun.sleep(60);
    const after = sock.sent.filter((raw) => JSON.parse(raw).op === 1).length;
    expect(after).toBeGreaterThan(before);

    handle.close();
    await handle.done;
  });

  test("close() stops heartbeats, closes the socket cleanly, and resolves done", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 20 }, s: null, t: null }) });
    await Bun.sleep(30);
    handle.close();
    await handle.done;
    expect(sock.readyState).toBe(StubSocket.CLOSED);
    // After close, no further heartbeats should land even if we wait
    // past several intervals.
    const after = sock.sent.length;
    await Bun.sleep(80);
    expect(sock.sent.length).toBe(after);
  });

  test("server-initiated close triggers a reconnect; close() during reconnect prevents the new socket from opening", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      reconnectDelayMs: 5
    });
    const first = lastInstance();
    first.dispatch("open", {});
    first.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 20 }, s: null, t: null }) });
    // Server drops the socket (close code 4000 is a "we want you to
    // reconnect" code in Discord's vocabulary, but for the lifecycle
    // it doesn't matter — any unexpected close triggers reconnect).
    first.close(4000, "server reset");
    // Allow the reconnect timer to fire.
    await Bun.sleep(25);
    expect(StubSocket.instances.length).toBe(2);

    // Caller closes — second socket must close cleanly and done
    // resolves.
    handle.close();
    await handle.done;
    expect(StubSocket.instances[1]?.readyState).toBe(StubSocket.CLOSED);
  });

  test("non-reconnectable close codes (4004 auth-failed, 4014 disallowed-intents) give up instead of looping forever", async () => {
    // Discord's gateway returns close codes 4004 / 4010-4014 for
    // setup-level failures: bad token, invalid intents, etc. A naive
    // reconnect on every close would loop forever against an
    // un-fixable error. The handle should mark itself closed and
    // resolve done so the supervisor can move on.
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "BAD-TOKEN",
      webSocketImpl: StubCtor,
      reconnectDelayMs: 5
    });
    const first = lastInstance();
    first.dispatch("open", {});
    const beforeCount = StubSocket.instances.length;
    // Server rejects auth.
    first.close(4004, "Authentication failed");
    // Give the reconnect timer plenty of room to fire IF the code is
    // buggy — but we expect NO new socket to be created.
    await Bun.sleep(40);
    expect(StubSocket.instances.length).toBe(beforeCount);
    // The handle's done promise resolves on terminal teardown.
    await handle.done;
  });

  test("op 7 RECONNECT triggers a clean socket close so the reconnect loop can re-identify", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      reconnectDelayMs: 5
    });
    const first = lastInstance();
    first.dispatch("open", {});
    first.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    // Server requests reconnect.
    first.dispatch("message", { data: JSON.stringify({ op: 7, d: null, s: null, t: null }) });
    expect(first.readyState).toBe(StubSocket.CLOSED);
    await Bun.sleep(25);
    expect(StubSocket.instances.length).toBeGreaterThanOrEqual(2);
    handle.close();
    await handle.done;
  });

  test("op 11 HEARTBEAT_ACK is a no-op (does not throw or send anything)", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    const before = sock.sent.length;
    sock.dispatch("message", { data: JSON.stringify({ op: 11, d: null, s: null, t: null }) });
    // HEARTBEAT_ACK should not provoke any reply.
    expect(sock.sent.length).toBe(before);
    handle.close();
    await handle.done;
  });

  test("MESSAGE_CREATE dispatch invokes onMessageCreate with the channel id (push-driven poll wake)", async () => {
    // The poller wires this callback to its wake controller so a
    // Discord-pushed event collapses the next REST-poll sleep down
    // to ~0ms. The gateway delivers no content (MESSAGE_CONTENT
    // intent is not requested) — we just need the channelId so the
    // poller can decide whether the message lives in one of its
    // delivery targets.
    StubSocket.reset();
    const events: Array<{ channelId: string }> = [];
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      onMessageCreate: (event) => {
        events.push(event);
      }
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    sock.dispatch("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: { id: "100", channel_id: "chan-1", content: "" }
      })
    });
    expect(events).toEqual([{ channelId: "chan-1" }]);
    handle.close();
    await handle.done;
  });

  test("MESSAGE_CREATE without a channel_id is ignored (no callback fired, no throw)", async () => {
    // Defensive: a Discord schema drift or unexpected event shape
    // must not cause the callback to fire with bogus data or take
    // the gateway down. The poller relies on the callback being
    // accurate so an undefined channelId would mean a wasted poll
    // and (worse) a wake on a channel the bridge doesn't own.
    StubSocket.reset();
    const events: Array<{ channelId: string }> = [];
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      onMessageCreate: (event) => {
        events.push(event);
      }
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    sock.dispatch("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: { id: "100", content: "" }
      })
    });
    expect(events).toEqual([]);
    expect(sock.readyState).toBe(StubSocket.OPEN);
    handle.close();
    await handle.done;
  });

  test("a throw inside onMessageCreate is swallowed so the socket stays alive", async () => {
    // A stale poller wake controller calling abort on a closed
    // signal won't throw, but defense-in-depth — the callback is
    // best-effort and a single bad consumer can't be allowed to
    // tear down the gateway socket.
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor,
      onMessageCreate: () => {
        throw new Error("simulated bad consumer");
      }
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    sock.dispatch("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 1,
        d: { id: "100", channel_id: "chan-1" }
      })
    });
    expect(sock.readyState).toBe(StubSocket.OPEN);
    handle.close();
    await handle.done;
  });

  test("malformed JSON frame is dropped silently without disturbing the connection", async () => {
    StubSocket.reset();
    const handle = connectDiscordGateway({
      token: "TOK",
      webSocketImpl: StubCtor
    });
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 200 }, s: null, t: null }) });
    // Garbage frame — must not throw out of handleFrame; the
    // gateway stays connected.
    sock.dispatch("message", { data: "not json" });
    expect(sock.readyState).toBe(StubSocket.OPEN);
    handle.close();
    await handle.done;
  });
});
