import { afterEach, describe, expect, test } from "bun:test";
import {
  ScreencastBridge,
  ScreencastBusyError,
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
    // These tests exercise the page-level screencast, not popup-follow (covered
    // by followHarness). Disable discovery so start() never hits the real
    // /json/version fetch in defaultDeps.
    fetchBrowserWsUrl: async () => null,
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

  test("close notifies onClose subscribers so a viewer can tear down its stream", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    let closed = 0;
    bridge.subscribe(() => undefined, () => closed++);
    socket.close();
    expect(closed).toBe(1);
    // A broken/duplicate close fires the callback only once.
    await bridge.stop();
    expect(closed).toBe(1);
  });

  test("unsubscribe drops the onClose callback too", async () => {
    const { bridge, socket } = bridgeWith();
    await startWithOpen(bridge, socket);
    let closed = 0;
    const unsub = bridge.subscribe(() => undefined, () => closed++);
    unsub();
    socket.close();
    expect(closed).toBe(0); // unsubscribed before close → no notification
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

const BROWSER_WS = "ws://127.0.0.1:9333/devtools/browser/abc";

const mkPage = (
  id: string,
  url: string
): CdpVersionTarget & { id: string; webSocketDebuggerUrl: string } => ({
  id,
  type: "page",
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`
});

// A target list the test can rewrite between watcher polls, with a socket-per-URL
// factory so a switch dials a distinct socket the test can inspect. Also models
// the browser-level Target discovery socket: openPopup() adds a page to the
// target list AND fires Target.targetCreated carrying the openerId, so the
// bridge's opener-scoped follow can recognize it as part of the sign-in family.
function followHarness(initial: CdpVersionTarget[]) {
  let targets = initial;
  const sockets = new Map<string, FakeSocket>();
  const dialed: string[] = [];
  let browserSocket: FakeSocket | undefined;
  const openSocket = (url: string): WebSocketLike => {
    const socket = new FakeSocket();
    const origAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = (event, listener) => {
      origAdd(event, listener);
      // Auto-open so attachTo's startScreencast (and the discovery socket's
      // setDiscoverTargets) complete on their own.
      if (event === "open") queueMicrotask(() => socket.open());
    };
    if (url === BROWSER_WS) browserSocket = socket;
    sockets.set(url, socket);
    dialed.push(url);
    return socket;
  };
  const deps: Partial<ScreencastDeps> = {
    openSocket,
    fetchJson: async () => targets,
    resolvePort: () => 9333,
    fetchBrowserWsUrl: async () => BROWSER_WS
  };
  return {
    deps,
    dialed,
    sockets,
    setTargets(next: CdpVersionTarget[]) {
      targets = next;
    },
    // Simulate `openerPage` opening `popup`: the page appears in /json AND the
    // discovery socket reports its openerId.
    openPopup(openerId: string, popup: CdpVersionTarget & { id: string }) {
      targets = [...targets, popup];
      browserSocket?.fire("message", {
        data: JSON.stringify({
          method: "Target.targetCreated",
          params: { targetInfo: { targetId: popup.id, type: "page", openerId } }
        })
      });
    },
    // Simulate an UNRELATED page (e.g. another task's tab) appearing with no
    // opener in the sign-in family — discovery reports it, but the family
    // excludes it.
    openUnrelated(page: CdpVersionTarget & { id: string }, openerId?: string) {
      targets = [...targets, page];
      browserSocket?.fire("message", {
        data: JSON.stringify({
          method: "Target.targetCreated",
          params: { targetInfo: { targetId: page.id, type: "page", ...(openerId ? { openerId } : {}) } }
        })
      });
    }
  };
}

describe("ScreencastBridge target-follow (popup / new-tab)", () => {
  const page = mkPage;

  test("switches the screencast to a popup the watched page opened", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    expect(h.dialed).toContain(opener.webSocketDebuggerUrl);
    // OAuth pops a new tab opened BY the watched page (openerId === opener).
    const popup = page("popup", "https://idp.example/authorize");
    h.openPopup("opener", popup);
    await waitUntil(() => h.dialed.includes(popup.webSocketDebuggerUrl));
    expect(h.dialed.at(-1)).toBe(popup.webSocketDebuggerUrl);
    // The old opener socket was dropped during the deliberate switch, but the
    // bridge stays live (the swap guard suppresses its close handler).
    expect(bridge.isClosed()).toBe(false);
    expect(h.sockets.get(opener.webSocketDebuggerUrl)!.closed).toBe(true);
    await bridge.stop();
  });

  test("follows a popup exactly once and does not oscillate while both stay alive", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    const popup = page("popup", "https://idp.example/authorize");
    h.openPopup("opener", popup);
    await waitUntil(() => h.dialed.includes(popup.webSocketDebuggerUrl));
    // Both opener and popup stay alive across many watch ticks. The bridge must
    // NOT ping-pong back to the opener — it follows the popup once and stays.
    const dialsAfterPopup = h.dialed.length;
    await new Promise((r) => setTimeout(r, 60)); // 12 watch ticks at the 5ms interval
    expect(h.dialed.length).toBe(dialsAfterPopup); // no further switches
    expect(h.dialed.at(-1)).toBe(popup.webSocketDebuggerUrl);
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("does NOT switch to an unrelated task's tab (no opener in the family)", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    const dialsAfterStart = h.dialed.length;
    // A sibling task opens a tab — it appears in /json and discovery, but its
    // opener is NOT in the sign-in family (or it has none). Must be ignored.
    h.openUnrelated(page("sibling", "https://other-task.example/"), "some-other-page");
    h.openUnrelated(page("orphan", "https://orphan.example/")); // no opener at all
    await new Promise((r) => setTimeout(r, 40));
    expect(h.dialed.length).toBe(dialsAfterStart); // no new page socket dialed
    expect(h.dialed).not.toContain("ws://127.0.0.1:9333/devtools/page/sibling");
    expect(h.dialed).not.toContain("ws://127.0.0.1:9333/devtools/page/orphan");
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("falls back to the opener when the watched popup closes", async () => {
    const opener = page("opener", "https://app.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://app.example/");
    // Opener pops a popup; bridge follows it.
    const popup = page("popup", "https://idp.example/authorize");
    h.openPopup("opener", popup);
    await waitUntil(() => h.dialed.includes(popup.webSocketDebuggerUrl));
    // Popup closes after sign-in — only the opener remains in the family.
    h.setTargets([opener]);
    await waitUntil(() => h.dialed.lastIndexOf(opener.webSocketDebuggerUrl) > h.dialed.indexOf(popup.webSocketDebuggerUrl));
    expect(h.dialed.at(-1)).toBe(opener.webSocketDebuggerUrl);
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("does not switch when the target set is unchanged", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    const dialsAfterStart = h.dialed.length;
    // Let several poll ticks pass with no new/closed family target.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dialed.length).toBe(dialsAfterStart);
    await bridge.stop();
  });

  test("a transient /json fetch error is swallowed and polling continues", async () => {
    const opener = page("opener", "https://signin.example/");
    const popup = page("popup", "https://idp.example/authorize");
    let calls = 0;
    let targets: CdpVersionTarget[] = [opener];
    let browserSocket: FakeSocket | undefined;
    const dialed: string[] = [];
    const openSocket = (url: string): WebSocketLike => {
      const socket = new FakeSocket();
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      if (url === BROWSER_WS) browserSocket = socket;
      dialed.push(url);
      return socket;
    };
    const bridge = new ScreencastBridge(
      {
        openSocket,
        fetchJson: async () => {
          calls += 1;
          if (calls === 2) throw new Error("transient /json failure");
          return targets;
        },
        resolvePort: () => 9333,
        fetchBrowserWsUrl: async () => BROWSER_WS
      },
      20,
      5
    );
    await bridge.start("https://signin.example/");
    // The popup (opened by the watched page) appears after the transient error.
    targets = [opener, popup];
    browserSocket?.fire("message", {
      data: JSON.stringify({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "popup", type: "page", openerId: "opener" } }
      })
    });
    await waitUntil(() => dialed.includes(popup.webSocketDebuggerUrl));
    expect(dialed.at(-1)).toBe(popup.webSocketDebuggerUrl);
    await bridge.stop();
  });

  test("a dropped discovery socket disables follow but keeps the screencast alive", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    const browserSocket = h.sockets.get(BROWSER_WS)!;
    // Discovery socket errors then closes — popup-follow is now disabled, but
    // the page-level screencast must stay live.
    browserSocket.fire("error", {});
    browserSocket.close();
    expect(bridge.isClosed()).toBe(false);
    // A later family popup can no longer be followed (discovery is gone), but
    // the bridge does not crash on the event.
    h.openPopup("opener", page("popup", "https://idp.example/authorize"));
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("popup-follow is disabled when the browser wsUrl can't be resolved", async () => {
    const opener = page("opener", "https://signin.example/");
    const dialed: string[] = [];
    let targets: CdpVersionTarget[] = [opener];
    const openSocket = (url: string): WebSocketLike => {
      const socket = new FakeSocket();
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      dialed.push(url);
      return socket;
    };
    const bridge = new ScreencastBridge(
      {
        openSocket,
        fetchJson: async () => targets,
        resolvePort: () => 9333,
        fetchBrowserWsUrl: async () => null // can't resolve → no discovery socket
      },
      20,
      5
    );
    await bridge.start("https://signin.example/");
    // No browser ws was dialed (only the page socket).
    expect(dialed).toEqual([opener.webSocketDebuggerUrl]);
    // A new page appears, but with no discovery socket the family never grows,
    // so it is not followed.
    targets = [opener, page("popup", "https://idp.example/authorize")];
    await new Promise((r) => setTimeout(r, 30));
    expect(dialed).toEqual([opener.webSocketDebuggerUrl]);
    await bridge.stop();
  });

  test("the watcher stops polling once the bridge is closed", async () => {
    const opener = page("opener", "https://signin.example/");
    const h = followHarness([opener]);
    const bridge = new ScreencastBridge(h.deps, 20, 5);
    await bridge.start("https://signin.example/");
    await bridge.stop();
    const dialsAtStop = h.dialed.length;
    // A new family popup appears AFTER teardown — the cleared interval and the
    // closed discovery socket must ignore it.
    h.openPopup("opener", page("late", "https://idp.example/late"));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dialed.length).toBe(dialsAtStop);
  });

  test("recovers (does not permanently stall) when a popup dies mid-attach", async () => {
    const opener = page("opener", "https://app.example/");
    const popup = page("popup", "https://idp.example/authorize");
    const dialed: string[] = [];
    let browserSocket: FakeSocket | undefined;
    const openSocket = (url: string): WebSocketLike => {
      const socket = new FakeSocket();
      if (url === BROWSER_WS) browserSocket = socket;
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        // The popup's socket dies before it ever opens (target vanished
        // mid-handshake); every other socket opens normally.
        if (event === "open") {
          queueMicrotask(() => (url === popup.webSocketDebuggerUrl ? socket.close() : socket.open()));
        }
      };
      dialed.push(url);
      return socket;
    };
    let targets: CdpVersionTarget[] = [opener];
    const bridge = new ScreencastBridge(
      { openSocket, fetchJson: async () => targets, resolvePort: () => 9333, fetchBrowserWsUrl: async () => BROWSER_WS },
      20,
      5
    );
    await bridge.start("https://app.example/");
    // Family popup appears; its attach will fail. The bridge must NOT close, and
    // the switching flag must clear so the next tick can recover.
    targets = [opener, popup];
    browserSocket?.fire("message", {
      data: JSON.stringify({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "popup", type: "page", openerId: "opener" } }
      })
    });
    await waitUntil(() => dialed.includes(popup.webSocketDebuggerUrl));
    // Popup is gone now; only the opener remains in the family. The watcher must
    // re-point to it.
    targets = [opener];
    const dialsBeforeRecovery = dialed.length;
    await waitUntil(() => dialed.length > dialsBeforeRecovery && dialed.at(-1) === opener.webSocketDebuggerUrl);
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
  });

  test("an input command issued during a switch resolves instead of hanging", async () => {
    const opener = page("opener", "https://app.example/");
    const popup = page("popup", "https://idp.example/authorize");
    // The opener's socket never auto-replies, so a send() on it stays pending
    // until something drains this.pending — which the switch must do.
    let openerSocket: FakeSocket | undefined;
    let browserSocket: FakeSocket | undefined;
    const openSocket = (url: string): WebSocketLike => {
      const socket = new FakeSocket();
      if (url === opener.webSocketDebuggerUrl) openerSocket = socket;
      if (url === BROWSER_WS) browserSocket = socket;
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      return socket;
    };
    let targets: CdpVersionTarget[] = [opener];
    const bridge = new ScreencastBridge(
      { openSocket, fetchJson: async () => targets, resolvePort: () => 9333, fetchBrowserWsUrl: async () => BROWSER_WS },
      20,
      5
    );
    await bridge.start("https://app.example/");
    // Wedge the opener socket: stop auto-replying so the next send() stays open.
    openerSocket!.autoReply = false;
    // An operator click lands while a family popup is about to be switched to.
    const inputDone = bridge.dispatchInput({ kind: "move", x: 5, y: 5 });
    targets = [opener, popup];
    browserSocket?.fire("message", {
      data: JSON.stringify({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "popup", type: "page", openerId: "opener" } }
      })
    }); // triggers switchTo, which drains this.pending
    // The orphaned send must be resolved by the switch, so dispatchInput settles.
    await inputDone;
    expect(bridge.isClosed()).toBe(false);
    await bridge.stop();
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
    const b1 = await getOrStartBridge("setup-1", undefined, factory);
    const b2 = await getOrStartBridge("setup-1", undefined, factory);
    expect(b2).toBe(b1); // reused while alive
    await stopActiveBridge("setup-1");
    const b3 = await getOrStartBridge("setup-1", undefined, factory);
    expect(b3).not.toBe(b1); // recreated after teardown
    await stopActiveBridge("setup-1");
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
      getOrStartBridge("setup-1", undefined, factory),
      getOrStartBridge("setup-1", undefined, factory)
    ]);
    expect(a).toBe(b);
    expect(built).toBe(1); // only one bridge constructed despite two callers
    await stopActiveBridge("setup-1");
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
    const startP = getOrStartBridge("setup-1", undefined, factory);
    await Promise.resolve(); // getOrStartBridge builds the bridge + calls start()
    // Teardown fires while start() is parked at the fetchJson await.
    await stopActiveBridge("setup-1");
    // Release the launch; start() proceeds, opens the socket, and resolves.
    openGate();
    await startP;
    // The post-start guard fires `void bridge.stop()` (not awaited), so poll the
    // actual condition rather than racing a fixed delay.
    await waitUntil(() => built.length === 1 && built[0].isClosed());
    expect(built.length).toBe(1);
    expect(built[0].isClosed()).toBe(true);
    // Nothing is left installed: the next get builds a fresh bridge.
    const probe = new FakeSocket();
    const next = await getOrStartBridge("setup-1", undefined, () => {
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
    await stopActiveBridge("setup-1");
  });

  test("the default factory builds a real bridge (throws with no spawned browser)", async () => {
    // No factory arg → exercises the default `() => new ScreencastBridge()`
    // arrow. With no spawned Chrome the real start() throws and nothing is
    // installed as the active bridge.
    await expect(getOrStartBridge("setup-1")).rejects.toThrow(/No spawned browser/);
  });

  test("a different owner is rejected while the bridge is held (no cross-wiring)", async () => {
    const factory = () => {
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
    const held = await getOrStartBridge("setup-A", undefined, factory);
    // Setup B's frames/input must NOT bind to setup A's live bridge.
    await expect(getOrStartBridge("setup-B", undefined, factory)).rejects.toThrow(ScreencastBusyError);
    // Setup A keeps reusing it.
    expect(await getOrStartBridge("setup-A", undefined, factory)).toBe(held);
    await stopActiveBridge("setup-A");
  });

  test("teardown by a non-owner leaves the active bridge alone", async () => {
    let stopped = 0;
    const factory = () => {
      const socket = new FakeSocket();
      const origAdd = socket.addEventListener.bind(socket);
      socket.addEventListener = (event, listener) => {
        origAdd(event, listener);
        if (event === "open") queueMicrotask(() => socket.open());
      };
      const b = new ScreencastBridge({
        openSocket: () => socket,
        fetchJson: async () => [{ type: "page", webSocketDebuggerUrl: "ws://x" }],
        resolvePort: () => 9333
      });
      const origStop = b.stop.bind(b);
      b.stop = async () => {
        stopped += 1;
        return origStop();
      };
      return b;
    };
    const held = await getOrStartBridge("setup-A", undefined, factory);
    // Setup B cancelling/completing must not stop setup A's screencast.
    await stopActiveBridge("setup-B");
    expect(stopped).toBe(0);
    expect(held.isClosed()).toBe(false);
    // The owner's teardown does stop it.
    await stopActiveBridge("setup-A");
    expect(stopped).toBe(1);
  });

  test("a non-owner teardown during an in-flight start does not abort the starting bridge", async () => {
    // Hold setup A's start() pending at fetchJson, fire setup B's teardown in
    // that window (activeOwner is still unset, only startingOwner='setup-A'),
    // then release. A must install normally — B must not kill it.
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
          await gate;
          return [{ type: "page", webSocketDebuggerUrl: "ws://x" }];
        },
        resolvePort: () => 9333
      });
      built.push(b);
      return b;
    };
    const startP = getOrStartBridge("setup-A", undefined, factory);
    await Promise.resolve(); // start() is now parked at the fetchJson await
    await stopActiveBridge("setup-B"); // non-owner teardown in the in-flight window
    openGate();
    const bridge = await startP;
    expect(built.length).toBe(1);
    expect(bridge.isClosed()).toBe(false); // A survived B's teardown
    // A is the installed active bridge: A's own reuse returns it.
    expect(await getOrStartBridge("setup-A", undefined, factory)).toBe(bridge);
    await stopActiveBridge("setup-A");
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
