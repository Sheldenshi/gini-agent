import { afterEach, describe, expect, test } from "bun:test";
import {
  ScreencastBridge,
  defaultDeps,
  getOrStartBridge,
  stopActiveBridge,
  __resetActiveBridgeForTest,
  type CdpVersionTarget,
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
async function startWithOpen(bridge: ScreencastBridge, socket: FakeSocket, preferUrl?: string): Promise<void> {
  const p = bridge.start(preferUrl);
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

  test("rejects (does not hang) when the socket closes before open", async () => {
    const socket = new FakeSocket();
    const bridge = new ScreencastBridge({
      openSocket: () => socket,
      fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
      resolvePort: () => 9333
    });
    const p = bridge.start();
    await Promise.resolve();
    // Chrome dies mid-attach: close fires before open ever does.
    socket.close();
    await expect(p).rejects.toThrow(/closed before the screencast started/);
    expect(bridge.isClosed()).toBe(true);
  });

  test("rejects when the socket errors before open", async () => {
    const socket = new FakeSocket();
    const bridge = new ScreencastBridge({
      openSocket: () => socket,
      fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
      resolvePort: () => 9333
    });
    const p = bridge.start();
    await Promise.resolve();
    socket.fire("error", {});
    await expect(p).rejects.toThrow(/errored before the screencast started/);
  });

  test("attaches to the page matching preferUrl, not the first page", async () => {
    const socket = new FakeSocket();
    let dialed = "";
    const bridge = new ScreencastBridge({
      openSocket: (url) => { dialed = url; return socket; },
      fetchJson: async () => [
        { type: "page", url: "https://other.example/", webSocketDebuggerUrl: "ws://first" },
        { type: "page", url: "https://signin.example/", webSocketDebuggerUrl: "ws://wanted" }
      ],
      resolvePort: () => 9333
    });
    await startWithOpen(bridge, socket, "https://signin.example/");
    expect(dialed).toBe("ws://wanted");
  });

  test("falls back to the first page when preferUrl matches nothing", async () => {
    const socket = new FakeSocket();
    let dialed = "";
    const bridge = new ScreencastBridge({
      openSocket: (url) => { dialed = url; return socket; },
      fetchJson: async () => [
        { type: "page", url: "https://a.example/", webSocketDebuggerUrl: "ws://first" },
        { type: "page", url: "https://b.example/", webSocketDebuggerUrl: "ws://second" }
      ],
      resolvePort: () => 9333
    });
    await startWithOpen(bridge, socket, "https://nomatch.example/");
    expect(dialed).toBe("ws://first");
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

  test("stop returns within the timeout even when stopScreencast never responds", async () => {
    // A wedged CDP socket: opens, but never replies to any send. stop() must
    // still resolve (bounded by stopTimeoutMs) and force the socket shut, so
    // /complete and /cancel can't hang on it.
    const socket = new FakeSocket();
    socket.autoReply = false; // sends never resolve on their own
    const origAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = (event, listener) => {
      origAdd(event, listener);
      if (event === "open") queueMicrotask(() => socket.open());
    };
    const bridge = new ScreencastBridge(
      {
        openSocket: () => socket,
        fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
        resolvePort: () => 9333
      },
      20 // tiny stopTimeoutMs so the test doesn't wait the production budget
    );
    // start() itself awaits sends, so with autoReply off it would hang — open
    // the socket and let start() race; instead drive start to its open then
    // flip autoReply for the startup sends only.
    socket.autoReply = true;
    await startWithOpen(bridge, socket);
    socket.autoReply = false; // now wedge: stopScreencast will never respond
    const t0 = Date.now();
    await bridge.stop();
    expect(Date.now() - t0).toBeLessThan(1000); // bounded, not the full hang
    expect(bridge.isClosed()).toBe(true);
    expect(socket.closed).toBe(true);
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

// Poll until a predicate holds (or time out) — drives the unref'd target watcher
// without sleeping a fixed amount.
async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

// A target list the test can rewrite between watcher polls, with a socket-per-URL
// factory so a switch dials a distinct socket the test can inspect.
function followHarness(initial: CdpVersionTarget[]) {
  let targets = initial;
  const sockets = new Map<string, FakeSocket>();
  const dialed: string[] = [];
  const openSocket = (url: string): WebSocketLike => {
    const socket = new FakeSocket();
    // Auto-open so attachTo's startScreencast sends complete on their own.
    const origAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = (event, listener) => {
      origAdd(event, listener);
      if (event === "open") queueMicrotask(() => socket.open());
    };
    sockets.set(url, socket);
    dialed.push(url);
    return socket;
  };
  const deps: Partial<ScreencastDeps> = {
    openSocket,
    fetchJson: async () => targets,
    resolvePort: () => 9333
  };
  return {
    deps,
    dialed,
    sockets,
    setTargets(next: CdpVersionTarget[]) {
      targets = next;
    }
  };
}

describe("ScreencastBridge target-follow (popup / new-tab)", () => {
  const page = (
    id: string,
    url: string
  ): CdpVersionTarget & { id: string; webSocketDebuggerUrl: string } => ({
    id,
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`
  });

  test("switches the screencast to a freshly-opened popup target", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    expect(h.dialed).toEqual([opener.webSocketDebuggerUrl]);
    // OAuth pops a new tab the user must complete in.
    const popup = page("popup", "https://idp.example/authorize");
    h.setTargets([opener, popup]);
    await waitUntil(() => h.dialed.includes(popup.webSocketDebuggerUrl));
    expect(h.dialed.at(-1)).toBe(popup.webSocketDebuggerUrl);
    // The old opener socket was dropped during the deliberate switch, but the
    // bridge stays live (the swap guard suppresses its close handler).
    expect(bridge.isClosed()).toBe(false);
    expect(h.sockets.get(opener.webSocketDebuggerUrl)!.closed).toBe(true);
    await bridge.stop();
  });

  test("falls back to the remaining page when the watched target closes", async () => {
    const opener = page("opener", "https://app.example/");
    const popup = page("popup", "https://idp.example/authorize");
    const h = followHarness([opener, popup]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    // Attach to the popup (preferUrl matches it); both are "known" at attach.
    await bridge.start("https://idp.example/authorize");
    expect(h.dialed).toEqual([popup.webSocketDebuggerUrl]);
    // Popup closes after sign-in — only the opener remains.
    h.setTargets([opener]);
    await waitUntil(() => h.dialed.includes(opener.webSocketDebuggerUrl));
    expect(h.dialed.at(-1)).toBe(opener.webSocketDebuggerUrl);
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("does not switch when the target set is unchanged", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    // Let several poll ticks pass with no new/closed target.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dialed).toEqual([opener.webSocketDebuggerUrl]);
    await bridge.stop();
  });

  test("a transient /json fetch error is swallowed and polling continues", async () => {
    const opener = page("opener", "https://signin.example/");
    const popup = page("popup", "https://idp.example/authorize");
    let calls = 0;
    const sockets = new Map<string, FakeSocket>();
    const dialed: string[] = [];
    const openSocket = (url: string): WebSocketLike => {
      const socket = new FakeSocket();
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      sockets.set(url, socket);
      dialed.push(url);
      return socket;
    };
    const bridge = new ScreencastBridge(
      {
        openSocket,
        fetchJson: async () => {
          calls += 1;
          if (calls === 1) return [opener]; // start()'s initial enumeration
          if (calls === 2) throw new Error("transient /json failure");
          return [opener, popup]; // recovers next tick
        },
        resolvePort: () => 9333
      },
      20,
      5
    );
    await bridge.start("https://signin.example/");
    await waitUntil(() => dialed.includes(popup.webSocketDebuggerUrl));
    expect(dialed.at(-1)).toBe(popup.webSocketDebuggerUrl);
    await bridge.stop();
  });

  test("the watcher stops polling once the bridge is closed", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    await bridge.stop();
    const dialsAtStop = h.dialed.length;
    // A new popup appears AFTER teardown — the cleared interval must ignore it.
    h.setTargets([opener, page("late", "https://idp.example/late")]);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dialed.length).toBe(dialsAtStop);
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
    const b1 = await getOrStartBridge(undefined, factory);
    const b2 = await getOrStartBridge(undefined, factory);
    expect(b2).toBe(b1); // reused while alive
    await stopActiveBridge();
    const b3 = await getOrStartBridge(undefined, factory);
    expect(b3).not.toBe(b1); // recreated after teardown
    await stopActiveBridge();
  });

  test("concurrent first-callers share a single bridge (single-flight)", async () => {
    // Two requests racing the first start() must not each launch a CDP socket.
    let built = 0;
    const factory = () => {
      built += 1;
      const socket = new FakeSocket();
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
    const [a, b] = await Promise.all([
      getOrStartBridge(undefined, factory),
      getOrStartBridge(undefined, factory)
    ]);
    expect(a).toBe(b);
    expect(built).toBe(1); // only one bridge constructed despite two callers
    await stopActiveBridge();
  });

  test("stopActiveBridge with no active bridge is a no-op", async () => {
    await stopActiveBridge();
    expect(true).toBe(true);
  });

  test("a stopActiveBridge during an in-flight start tears down the started bridge (no orphan)", async () => {
    // Hold start() pending at its fetchJson await via a deferred the test
    // controls, fire stopActiveBridge in that window (the "I've signed in"
    // racing the still-connecting frames request), then release the launch.
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    const socket = new FakeSocket();
    const origAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = (event, listener) => {
      origAdd(event, listener);
      if (event === "open") queueMicrotask(() => socket.open());
    };
    const built: ScreencastBridge[] = [];
    const factory = () => {
      const b = new ScreencastBridge({
        openSocket: () => socket,
        fetchJson: async () => {
          await gate; // hold start() pending until the test releases it
          return [{ type: "page", webSocketDebuggerUrl: "ws://x" }];
        },
        resolvePort: () => 9333
      });
      built.push(b);
      return b;
    };
    const startP = getOrStartBridge(undefined, factory);
    await Promise.resolve(); // getOrStartBridge builds the bridge + calls start()
    // Teardown fires while start() is parked at the fetchJson await.
    await stopActiveBridge();
    // Release the launch; start() proceeds, opens the socket, and resolves.
    openGate();
    await startP;
    // The post-start guard fires `void bridge.stop()` (not awaited), so let it
    // settle before asserting the bridge was torn down rather than installed.
    await new Promise((r) => setTimeout(r, 10));
    expect(built.length).toBe(1);
    expect(built[0].isClosed()).toBe(true);
    // Nothing is left installed: the next get builds a fresh bridge.
    const probe = new FakeSocket();
    const next = await getOrStartBridge(undefined, () => {
      const b = new ScreencastBridge({
        openSocket: () => probe,
        fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://y" }],
        resolvePort: () => 9333
      });
      const padd = probe.addEventListener.bind(probe);
      probe.addEventListener = (event, listener) => {
        padd(event, listener);
        if (event === "open") queueMicrotask(() => probe.open());
      };
      return b;
    });
    expect(next).not.toBe(built[0]); // a fresh bridge, not the orphaned one
    await stopActiveBridge();
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
