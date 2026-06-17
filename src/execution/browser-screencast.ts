// Sign-in screencast bridge. When a chat task hits a login wall it calls
// browser_connect, which (after the user approves the standard "Connect to
// agent's browser" card) needs to show the user the live headless page so they
// can sign in. This bridge attaches a SCREENCAST to the agent's
// already-running spawned Chrome and relays the user's mouse/keyboard back.
//
// Transport: a single RAW CDP WebSocket to the spawned Chrome's debug port
// (Page.startScreencast → screencastFrame → ack), exactly the technique the
// standalone control panel uses. Raw CDP is used — NOT playwright
// connectOverCDP — because connectOverCDP hangs on the WebSocket handshake
// under playwright-core 1.60 + Bun, whereas a raw WebSocket to the same debug
// endpoint works. The agent's automation keeps driving the SAME Chrome over
// its pipe transport; this screencast is a SEPARATE read/drive channel on the
// same process, so the two never conflict.
//
// Security: the bridge dials ONLY a loopback debug port supplied by the
// browser manager (getScreencastPort → the spawned handle's port, always
// ≥ DEFAULT_CDP_PORT_BASE). It never accepts a port/URL from the client, so it
// can't be pointed at the user's personal :9222 or any other endpoint. Frames
// are raw JPEGs of the live page (they can show a typed password mid-sign-in),
// so they only ever travel over the bearer-gated gateway→BFF channel to the
// authenticated operator — never persisted, never sent to the model.
import { getScreencastPort } from "../tools/browser";

// CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. macOS Command maps to
// Meta so page-level Cmd shortcuts fire.
const CTRL_OR_META = 0b0110;

// The input events the modal can send. Deliberately does NOT include page
// navigation: the modal is for signing in on the page the agent already
// reached, and a free URL bar would bypass the agent's SSRF / domain-policy
// gate (which lives on browser_navigate). Sign-in links are followed by
// clicking them on the page, which Chrome routes normally.
export type ScreencastInput =
  | { kind: "click"; x: number; y: number; clickCount?: number; modifiers?: number }
  | { kind: "move"; x: number; y: number; modifiers?: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number; modifiers?: number }
  | { kind: "dragselect"; x0: number; y0: number; x1: number; y1: number; modifiers?: number }
  | { kind: "key"; text?: string; key?: string; code?: string; vk?: number; modifiers?: number };

interface CdpVersionTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface ScreencastFrame {
  // base64 JPEG, ready to drop into a data: URL.
  data: string;
  // CDP screencast frame metadata (deviceWidth/deviceHeight/etc.) for scaling.
  meta: Record<string, unknown>;
}

// Injection seam for tests: the raw WebSocket constructor and the /json fetch.
export interface ScreencastDeps {
  openSocket: (wsUrl: string) => WebSocketLike;
  fetchJson: (url: string) => Promise<CdpVersionTarget[]>;
  // Resolves the spawned Chrome's debug port (production: getScreencastPort).
  resolvePort: () => number | null;
}

// The minimal WebSocket surface we use, so a test can inject a fake.
export interface WebSocketLike {
  addEventListener(event: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

// Production externalities. Exported so a test can exercise the real
// openSocket / fetchJson wiring without standing up a Chrome.
export function defaultDeps(): ScreencastDeps {
  return {
    openSocket: (wsUrl) => new WebSocket(wsUrl) as unknown as WebSocketLike,
    fetchJson: async (url) => (await (await fetch(url)).json()) as CdpVersionTarget[],
    resolvePort: getScreencastPort
  };
}

// One live screencast attachment to the spawned Chrome's first page target.
// Holds the raw CDP socket, the latest frame, and a set of frame subscribers
// (the SSE responses). Translates ScreencastInput into CDP Input.* calls.
export class ScreencastBridge {
  private cdp: WebSocketLike | undefined;
  private cdpId = 0;
  private readonly pending = new Map<number, (v: unknown) => void>();
  private latest: ScreencastFrame | undefined;
  private readonly subscribers = new Set<(frame: ScreencastFrame) => void>();
  private readonly deps: ScreencastDeps;
  private closed = false;

  constructor(deps: Partial<ScreencastDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // Open the raw CDP socket to the spawned Chrome's first page target and start
  // the screencast. Throws when no spawned Chrome is live (the caller surfaces
  // that as "the agent's browser isn't running").
  async start(): Promise<void> {
    const port = this.deps.resolvePort();
    if (port === null) {
      throw new Error("No spawned browser is running to screencast.");
    }
    const targets = await this.deps.fetchJson(`http://127.0.0.1:${port}/json`);
    const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target available on the spawned browser.");
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = this.deps.openSocket(pageTarget.webSocketDebuggerUrl);
    this.cdp = socket;
    socket.addEventListener("open", () => {
      void (async () => {
        try {
          await this.send("Page.enable");
          // A backgrounded headless tab is throttled and won't paint, so bring
          // it to the foreground before starting the screencast or the stream
          // yields zero frames.
          await this.send("Page.bringToFront");
          await this.send("Page.startScreencast", {
            format: "jpeg",
            quality: 70,
            maxWidth: 1280,
            maxHeight: 800,
            everyNthFrame: 1
          });
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    socket.addEventListener("message", (ev) => this.onCdpMessage(ev.data));
    socket.addEventListener("close", () => this.handleClosed());
    socket.addEventListener("error", () => this.handleClosed());
    await promise;
  }

  private onCdpMessage(raw: unknown): void {
    let msg: { id?: number; method?: string; result?: unknown; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method === "Page.screencastFrame" && msg.params) {
      const sessionId = msg.params["sessionId"];
      // Ack immediately so Chrome keeps streaming.
      void this.send("Page.screencastFrameAck", { sessionId });
      const frame: ScreencastFrame = {
        data: String(msg.params["data"] ?? ""),
        meta: (msg.params["metadata"] as Record<string, unknown>) ?? {}
      };
      this.latest = frame;
      for (const fn of this.subscribers) {
        try {
          fn(frame);
        } catch {
          // a slow/broken subscriber must not break the others
        }
      }
    }
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.cdp = undefined;
    this.subscribers.clear();
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  // Fire-and-await a CDP method over the raw socket.
  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.cdp) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const id = ++this.cdpId;
    this.pending.set(id, resolve);
    this.cdp.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  // Subscribe to frames. Immediately replays the latest frame (if any) so a
  // newly-connected viewer paints without waiting for the next page change,
  // then streams subsequent frames. Returns an unsubscribe fn.
  subscribe(onFrame: (frame: ScreencastFrame) => void): () => void {
    this.subscribers.add(onFrame);
    if (this.latest) {
      try {
        onFrame(this.latest);
      } catch {
        // ignore
      }
    }
    return () => this.subscribers.delete(onFrame);
  }

  // Translate one modal input event into CDP Input.* calls. Mirrors the proven
  // control-panel mapping: printable chars with no Ctrl/Meta go through as
  // typed text; everything else (Enter/Tab/Backspace/arrows and any Cmd+<key>)
  // is a real key event carrying the modifier bitmask so page shortcuts fire.
  async dispatchInput(m: ScreencastInput): Promise<void> {
    const mods = m.modifiers ?? 0;
    switch (m.kind) {
      case "click": {
        const clickCount = m.clickCount ?? 1;
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        break;
      }
      case "move":
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x, y: m.y, modifiers: mods });
        break;
      case "scroll":
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy, modifiers: mods });
        break;
      case "dragselect":
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x0, y: m.y0, button: "left", clickCount: 1, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x1, y: m.y1, button: "left", modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x1, y: m.y1, button: "left", clickCount: 1, modifiers: mods });
        break;
      case "key":
        if (m.text && m.text.length === 1 && (mods & CTRL_OR_META) === 0) {
          await this.send("Input.dispatchKeyEvent", { type: "char", text: m.text, modifiers: mods });
        } else {
          const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: mods };
          await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
          await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        }
        break;
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Stop the screencast and drop the socket. Best-effort; never throws.
  async stop(): Promise<void> {
    if (this.cdp && !this.closed) {
      try {
        await this.send("Page.stopScreencast");
      } catch {
        // ignore — we're tearing down
      }
    }
    try {
      this.cdp?.close();
    } catch {
      // ignore
    }
    this.handleClosed();
  }
}

// One bridge per instance (the spawned Chrome is per-instance). Lazily created
// on first screencast request and reused across the frames-SSE and input-POST
// endpoints; torn down when the sign-in completes or the socket drops.
let activeBridge: ScreencastBridge | undefined;

// Get the live bridge, creating + starting one if none is active (or the
// previous one closed). Test seam: pass a factory to inject a fake bridge.
export async function getOrStartBridge(
  factory: () => ScreencastBridge = () => new ScreencastBridge()
): Promise<ScreencastBridge> {
  if (activeBridge && !activeBridge.isClosed()) return activeBridge;
  const bridge = factory();
  await bridge.start();
  activeBridge = bridge;
  return bridge;
}

// Tear down the active bridge (sign-in completed / cancelled / shutdown).
export async function stopActiveBridge(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = undefined;
  if (bridge) await bridge.stop();
}

// Test-only reset so a suite doesn't leak the module-level bridge.
export function __resetActiveBridgeForTest(): void {
  activeBridge = undefined;
}
