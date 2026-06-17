import { afterEach, describe, expect, test } from "bun:test";
import {
  ScreencastBridge,
  defaultDeps,
  getOrStartBridge,
  stopActiveBridge,
  __resetActiveBridgeForTest,
  type ScreencastDeps,
  type WebSocketLike
} from "./browser-screencast";

// A fake raw-CDP WebSocket: records sent messages, lets the test fire open /
// message / close, and auto-replies to CDP RPCs (any {id} message) so the
// bridge's send() promises resolve.
class FakeSocket implements WebSocketLike {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  autoReply = true;
  closed = false;

  addEventListener(event: string, listener: (ev: { data?: unknown }) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { id?: number; method?: string };
    this.sent.push(msg as Record<string, unknown>);
    // Auto-resolve RPCs so awaited sends complete.
    if (this.autoReply && typeof msg.id === "number") {
      queueMicrotask(() => this.fire("message", { data: JSON.stringify({ id: msg.id, result: {} }) }));
    }
  }
  close(): void {
    this.closed = true;
    this.fire("close", {});
  }
  fire(event: string, ev: { data?: unknown }): void {
    for (const l of this.listeners[event] ?? []) l(ev);
  }
  // Convenience: simulate Chrome opening the socket.
  open(): void {
    this.fire("open", {});
  }
  // Simulate an inbound screencast frame.
  frame(data: string, meta: Record<string, unknown> = { deviceWidth: 1280 }): void {
    this.fire("message", {
      data: JSON.stringify({ method: "Page.screencastFrame", params: { data, metadata: meta, sessionId: 7 } })
    });
  }
}

function bridgeWith(over: Partial<ScreencastDeps> = {}): { bridge: ScreencastBridge; socket: FakeSocket } {
  const socket = new FakeSocket();
  const deps: Partial<ScreencastDeps> = {
    openSocket: () => socket,
    fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/abc" }],
    resolvePort: () => 9333,
    ...over
  };
  return { bridge: new ScreencastBridge(deps), socket };
}

// start() awaits the open handler, which fires async CDP sends. Drive it by
// opening the socket on the next tick.
async function startWithOpen(bridge: ScreencastBridge, socket: FakeSocket): Promise<void> {
  const p = bridge.start();
  await Promise.resolve();
  socket.open();
  await p;
}

afterEach(() => {
  __resetActiveBridgeForTest();
});

describe("ScreencastBridge.start", () => {
  test("opens the page target and starts the screencast", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    const methods = socket.sent.map((m) => m["method"]);
    expect(methods).toContain("Page.enable");
    expect(methods).toContain("Page.bringToFront");
    expect(methods).toContain("Page.startScreencast");
  });

  test("throws when no spawned browser is running", async () => {
    const { bridge } = bridgeWith({ resolvePort: () => null });
    await expect(bridge.start()).rejects.toThrow(/No spawned browser/);
  });

  test("throws when there is no page target", async () => {
    const { bridge } = bridgeWith({ fetchJson: async () => [{ type: "background_page" }] });
    await expect(bridge.start()).rejects.toThrow(/No page target/);
  });

  test("rejects when a startup CDP call throws", async () => {
    const socket = new FakeSocket();
    socket.autoReply = false; // sends never resolve on their own
    const bridge = new ScreencastBridge({
      openSocket: () => socket,
      fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
      resolvePort: () => 9333
    });
    // Make send throw by closing the socket's send path: override after open.
    const p = bridge.start();
    await Promise.resolve();
    // Replace send to throw, then open.
    socket.send = () => {
      throw new Error("socket dead");
    };
    socket.open();
    await expect(p).rejects.toThrow(/socket dead/);
  });
});

describe("ScreencastBridge frames", () => {
  test("subscribe replays the latest frame and streams new ones, acking each", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    socket.sent.length = 0; // ignore the startup RPCs

    socket.frame("AAAA"); // arrives before any subscriber
    const seen: string[] = [];
    const unsub = bridge.subscribe((f) => seen.push(f.data));
    // Latest frame replayed immediately.
    expect(seen).toEqual(["AAAA"]);
    socket.frame("BBBB");
    expect(seen).toEqual(["AAAA", "BBBB"]);
    // Each inbound frame was acked.
    const acks = socket.sent.filter((m) => m["method"] === "Page.screencastFrameAck");
    expect(acks.length).toBe(2);
    unsub();
    socket.frame("CCCC");
    expect(seen).toEqual(["AAAA", "BBBB"]); // no more after unsubscribe
  });

  test("ignores malformed CDP messages", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    // Should not throw.
    socket.fire("message", { data: "not json {" });
    socket.fire("message", { data: JSON.stringify({ method: "Other.event" }) });
    expect(bridge.isClosed()).toBe(false);
  });

  test("a throwing subscriber does not break sibling subscribers", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    const good: string[] = [];
    bridge.subscribe(() => {
      throw new Error("bad subscriber");
    });
    bridge.subscribe((f) => good.push(f.data));
    socket.frame("ZZ");
    expect(good).toEqual(["ZZ"]);
  });

  test("a throwing subscriber on the immediate replay is swallowed", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    socket.frame("RP");
    expect(() =>
      bridge.subscribe(() => {
        throw new Error("replay boom");
      })
    ).not.toThrow();
  });
});

describe("ScreencastBridge.dispatchInput", () => {
  async function ready() {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    socket.sent.length = 0;
    return { bridge, socket };
  }

  test("click sends press + release with clickCount", async () => {
    const { bridge, socket } = await ready();
    await bridge.dispatchInput({ kind: "click", x: 10, y: 20, clickCount: 2 });
    const mouse = socket.sent.filter((m) => m["method"] === "Input.dispatchMouseEvent");
    expect(mouse.length).toBe(2);
    expect((mouse[0]["params"] as Record<string, unknown>)["type"]).toBe("mousePressed");
    expect((mouse[0]["params"] as Record<string, unknown>)["clickCount"]).toBe(2);
  });

  test("move, scroll, dragselect map to the right mouse events", async () => {
    const { bridge, socket } = await ready();
    await bridge.dispatchInput({ kind: "move", x: 1, y: 2 });
    await bridge.dispatchInput({ kind: "scroll", x: 1, y: 2, dx: 0, dy: 40 });
    await bridge.dispatchInput({ kind: "dragselect", x0: 0, y0: 0, x1: 5, y1: 5 });
    const types = socket.sent
      .filter((m) => m["method"] === "Input.dispatchMouseEvent")
      .map((m) => (m["params"] as Record<string, unknown>)["type"]);
    expect(types).toEqual(["mouseMoved", "mouseWheel", "mousePressed", "mouseMoved", "mouseReleased"]);
  });

  test("a printable char with no command modifier inserts as text", async () => {
    const { bridge, socket } = await ready();
    await bridge.dispatchInput({ kind: "key", text: "a", key: "a", code: "KeyA", vk: 65 });
    const keys = socket.sent.filter((m) => m["method"] === "Input.dispatchKeyEvent");
    expect(keys.length).toBe(1);
    expect((keys[0]["params"] as Record<string, unknown>)["type"]).toBe("char");
  });

  test("a non-printable / modified key sends keyDown + keyUp", async () => {
    const { bridge, socket } = await ready();
    await bridge.dispatchInput({ kind: "key", key: "Enter", code: "Enter", vk: 13 });
    await bridge.dispatchInput({ kind: "key", text: "a", key: "a", vk: 65, modifiers: 0b0100 }); // Meta+a
    const keys = socket.sent.filter((m) => m["method"] === "Input.dispatchKeyEvent");
    const types = keys.map((m) => (m["params"] as Record<string, unknown>)["type"]);
    expect(types).toEqual(["keyDown", "keyUp", "keyDown", "keyUp"]);
  });

  test("dispatchInput is a no-op once the socket is gone", async () => {
    const { bridge, socket } = await ready();
    socket.close();
    await bridge.dispatchInput({ kind: "move", x: 1, y: 1 });
    // No new sends after close.
    expect(socket.sent.filter((m) => m["method"] === "Input.dispatchMouseEvent").length).toBe(0);
  });
});

describe("ScreencastBridge.stop + close", () => {
  test("stop stops the screencast and marks closed", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    await bridge.stop();
    expect(bridge.isClosed()).toBe(true);
    expect(socket.closed).toBe(true);
    expect(socket.sent.some((m) => m["method"] === "Page.stopScreencast")).toBe(true);
  });

  test("close event clears subscribers and resolves pending", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    let frames = 0;
    bridge.subscribe(() => frames++);
    socket.close();
    expect(bridge.isClosed()).toBe(true);
    socket.frame("late");
    expect(frames).toBe(0); // subscribers cleared on close
  });

  test("an error event closes the bridge", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    socket.fire("error", {});
    expect(bridge.isClosed()).toBe(true);
  });

  test("stop is safe to call twice and on an already-closed bridge", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    socket.close();
    await bridge.stop();
    await bridge.stop();
    expect(bridge.isClosed()).toBe(true);
  });
});

describe("getOrStartBridge / stopActiveBridge", () => {
  test("creates, reuses, and recreates after close", async () => {
    const factory = () => {
      const socket = new FakeSocket();
      // Fire "open" the moment start() attaches its open listener, so start()
      // resolves without the test having to drive the socket by hand.
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      return new ScreencastBridge({
        openSocket: () => socket,
        fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
        resolvePort: () => 9333
      });
    };
    const b1 = await getOrStartBridge(factory);
    const b2 = await getOrStartBridge(factory);
    expect(b2).toBe(b1); // reused while alive
    await stopActiveBridge();
    const b3 = await getOrStartBridge(factory);
    expect(b3).not.toBe(b1); // recreated after teardown
    await stopActiveBridge();
  });

  test("stopActiveBridge with no active bridge is a no-op", async () => {
    await stopActiveBridge();
    expect(true).toBe(true);
  });

  test("the default factory builds a real bridge (throws with no spawned browser)", async () => {
    // No factory arg → exercises the default `() => new ScreencastBridge()`
    // arrow. With no spawned Chrome the real start() throws and nothing is
    // installed as the active bridge.
    await expect(getOrStartBridge()).rejects.toThrow(/No spawned browser/);
  });
});

describe("default deps wiring", () => {
  test("a bridge with no injected deps uses the real port resolver (null → throws)", async () => {
    // No spawned browser is running in this unit-test context, so the real
    // getScreencastPort resolves null and start() throws — exercising the
    // production defaultDeps() construction (openSocket/fetchJson/resolvePort)
    // without standing up a real Chrome.
    const bridge = new ScreencastBridge();
    await expect(bridge.start()).rejects.toThrow(/No spawned browser/);
  });

  test("defaultDeps exposes the real externalities", async () => {
    const deps = defaultDeps();
    expect(typeof deps.resolvePort).toBe("function");
    // resolvePort is the real getScreencastPort; null in a unit-test context.
    expect(deps.resolvePort()).toBeNull();
    // fetchJson is the real fetch — hitting a dead port rejects, proving the
    // arrow ran (exercises the production fetchJson body).
    await expect(deps.fetchJson("http://127.0.0.1:1/json")).rejects.toBeDefined();
    // openSocket constructs a real WebSocket against a bogus URL; close it so
    // the connection attempt doesn't dangle. Constructing it runs the arrow.
    const sock = deps.openSocket("ws://127.0.0.1:1/devtools/none");
    expect(typeof sock.close).toBe("function");
    sock.close();
  });
});
