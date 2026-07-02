// Sign-in screencast bridge. When a chat task hits a login wall it calls
// browser_connect, which (after the user approves the standard "Connect to
// agent's browser" card) needs to show the user the live headless page so they
// can sign in. This bridge attaches a SCREENCAST to the agent's
// already-running spawned Chrome and relays the user's mouse/keyboard back.
//
// Transport: a single RAW CDP WebSocket to the spawned Chrome's debug port
// (Page.startScreencast → screencastFrame → ack), exactly the technique the
// standalone control panel uses. Raw CDP is the right tool here regardless of
// Playwright: the screencast (Page.startScreencast + Input.* relay) is its own
// purpose-built channel, not a Playwright session. The raw WebSocket uses Bun's
// native WebSocket, which is why this path always worked under Bun even when
// playwright's connectOverCDP did not (that hang — playwright-core's bundled
// `ws` — is fixed separately by patches/playwright-core@1.61.1.patch). The
// agent's automation keeps driving the SAME Chrome over its pipe transport;
// this screencast is a SEPARATE read/drive channel on the same process, so the
// two never conflict.
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

// Upper bound on the Page.stopScreencast teardown send, so a wedged CDP socket
// can't hang the /complete or /cancel HTTP response.
const STOP_SCREENCAST_TIMEOUT_MS = 2_000;

// How often the bridge re-polls /json to follow a popup / new-tab sign-in. The
// watch interval is unref'd so it never holds the process open.
const TARGET_WATCH_INTERVAL_MS = 700;

// The input events the modal can send. Deliberately does NOT include page
// navigation: the modal is for signing in on the page the agent already
// reached, and a free URL bar would bypass the agent's SSRF / domain-policy
// gate (which lives on browser_navigate). Sign-in links are followed by
// clicking them on the page, which Chrome routes normally.
//
// The clipboard kinds (paste/copy/cut/selectall) cross the operator↔page
// boundary as TEXT only — `paste` inserts the operator's local clipboard text
// via Input.insertText; `copy`/`cut`/`selectall` read the remote page's current
// selection so the modal can write it to the operator's clipboard. None of them
// carry a URL or trigger navigation, so the SSRF/no-navigate invariant holds.
export type ScreencastInput =
  | { kind: "click"; x: number; y: number; clickCount?: number; modifiers?: number }
  | { kind: "move"; x: number; y: number; modifiers?: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number; modifiers?: number }
  | { kind: "dragselect"; x0: number; y0: number; x1: number; y1: number; modifiers?: number }
  | { kind: "key"; text?: string; key?: string; code?: string; vk?: number; modifiers?: number }
  | { kind: "paste"; text: string }
  | { kind: "copy" }
  | { kind: "cut" }
  | { kind: "selectall" };

export interface CdpVersionTarget {
  id?: string;
  type?: string;
  url?: string;
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
  // The BROWSER-level CDP wsUrl (from /json/version) for the Target discovery
  // socket that tells us a new page target's openerId — /json/list omits it.
  // Returns null when it can't be resolved (the bridge then never follows a
  // popup, the safe default).
  fetchBrowserWsUrl: (port: number) => Promise<string | null>;
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
    resolvePort: getScreencastPort,
    fetchBrowserWsUrl: async (port) => {
      try {
        const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
          webSocketDebuggerUrl?: string;
        };
        return typeof info.webSocketDebuggerUrl === "string" ? info.webSocketDebuggerUrl : null;
      } catch {
        return null;
      }
    }
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
  // Callbacks fired once when the bridge closes, so an SSE route can close its
  // stream (and the modal's EventSource reconnects / re-evaluates the gate)
  // instead of dangling on a stale frame behind keepalives.
  private readonly closeSubscribers = new Set<() => void>();
  // The URL of the page currently being screencast, surfaced to viewers so the
  // operator can see the origin they're signing into (the modal has no address
  // bar). Tracked at attach and refreshed each watch tick (same-tab redirects
  // and popup switches change it). onUrl subscribers get the latest immediately.
  private currentUrl: string | undefined;
  private readonly urlSubscribers = new Set<(url: string) => void>();
  private readonly deps: ScreencastDeps;
  private closed = false;
  // How long stop() waits for Page.stopScreencast before forcing the socket
  // shut. Bounded so a wedged CDP socket can't hang the /complete or /cancel
  // HTTP response (those await stopActiveBridge → stop()). Test-injectable.
  private readonly stopTimeoutMs: number;
  // Target-follow state (popup / new-tab sign-in support).
  private currentWsUrl: string | undefined;
  private targetWatch: ReturnType<typeof setInterval> | undefined;
  // True for the whole switchTo window: suppresses the dropped socket's close
  // handler from tearing the whole bridge down, and pauses the watcher.
  private switching = false;
  private readonly targetWatchMs: number;
  // Opener-scoped target-follow. The shared per-instance Chrome holds pages for
  // EVERY concurrent task, so following any new page target would let a sibling
  // task's tab steal the operator's sign-in screencast (and their keystrokes).
  // We instead follow only the sign-in's OWN target family: the watched page
  // plus popups it (transitively) opened. openerId comes from a browser-level
  // Target.targetCreated stream (/json/list omits it). signInFamily holds the
  // CDP targetIds in that family.
  private browserCdp: WebSocketLike | undefined;
  private browserCdpId = 0;
  private readonly signInFamily = new Set<string>();
  private currentTargetId: string | undefined;
  // Family targets the screencast has already shown. The watcher follows a
  // family member only ONCE (when it first appears) — otherwise, with the
  // opener and its popup both alive, it would ping-pong between them every tick.
  private readonly visitedTargetIds = new Set<string>();

  constructor(
    deps: Partial<ScreencastDeps> = {},
    stopTimeoutMs = STOP_SCREENCAST_TIMEOUT_MS,
    targetWatchMs = TARGET_WATCH_INTERVAL_MS
  ) {
    this.deps = { ...defaultDeps(), ...deps };
    this.stopTimeoutMs = stopTimeoutMs;
    this.targetWatchMs = targetWatchMs;
  }

  // Open the raw CDP socket to the page target the requesting task is driving
  // and start the screencast. Throws when no spawned Chrome is live (the caller
  // surfaces that as "the agent's browser isn't running").
  //
  // The spawned Chrome is a single shared context that can hold several page
  // targets (other concurrent tasks, agent-opened tabs). To show the operator
  // the SAME page the agent's task is on — never a sibling task's tab — we bind
  // by the task's CDP `targetId` (from peekCurrentBrowserTargetId, the id of
  // session.page). That is unambiguous even when two tabs share a URL. `preferUrl`
  // is a fallback hint (used when the targetId couldn't be resolved); the first
  // page target is the last resort.
  async start(preferUrl?: string, preferTargetId?: string): Promise<void> {
    const port = this.deps.resolvePort();
    if (port === null) {
      throw new Error("No spawned browser is running to screencast.");
    }
    const targets = await this.deps.fetchJson(`http://127.0.0.1:${port}/json`);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const pageTarget =
      (preferTargetId ? pages.find((t) => t.id === preferTargetId) : undefined) ??
      (preferUrl ? pages.find((t) => t.url === preferUrl) : undefined) ??
      pages[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target available on the spawned browser.");
    }
    // Seed the sign-in target family with the watched page so the watcher only
    // follows popups THIS page opens — never a sibling task's tab in the shared
    // context. Record its id ↔ wsUrl so we can match targetCreated events.
    this.setUrl(pageTarget.url);
    if (typeof pageTarget.id === "string") {
      this.currentTargetId = pageTarget.id;
      this.signInFamily.add(pageTarget.id);
      this.visitedTargetIds.add(pageTarget.id);
    }
    // If any startup step fails (a wedged CDP send, the page target vanishing
    // mid-attach), tear down the partially-built bridge before propagating, or
    // the open page socket leaks — the caller discards this bridge and never
    // reaches it for teardown. stop()/handleClosed are idempotent.
    try {
      await this.attachTo(pageTarget.webSocketDebuggerUrl);
      // Follow popup / new-tab sign-in: many OAuth flows open a popup the user
      // must complete in. A browser-level Target.targetCreated stream tells us
      // each new page target's openerId; the watcher re-points the screencast to
      // a fresh page ONLY when it belongs to this sign-in's opener family, and
      // falls back within the family when the watched page closes. Same-tab
      // redirect sign-in needs no switch (the screencast follows the page target
      // through its own navigations).
      await this.startTargetDiscovery(port);
      this.startTargetWatch(port);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  // Open a raw CDP socket to one page target's wsUrl and start its screencast.
  // The returned promise ALWAYS settles: it resolves once the screencast starts,
  // and rejects if the socket closes/errors before that. Both start() (the
  // initial attach) and switchTo() (a target swap) await it, so neither can hang
  // on a target that dies mid-attach — a rejected switch is caught and leaves
  // the prior frame. A reject after a post-open resolve is a no-op, so this also
  // stays correct for steady-state teardown.
  private attachTo(wsUrl: string): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = this.deps.openSocket(wsUrl);
    this.cdp = socket;
    this.currentWsUrl = wsUrl;
    socket.addEventListener("open", () => {
      void (async () => {
        try {
          await this.send("Page.enable");
          // Runtime is needed for the clipboard copy/cut/selectall path, which
          // reads the page's current selection via Runtime.evaluate.
          await this.send("Runtime.enable");
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
    // A close/error BEFORE open (Chrome died mid-attach, the page target
    // vanished, the handshake dropped) must settle this promise unconditionally,
    // or the awaiting caller (start() or switchTo()) hangs forever.
    socket.addEventListener("close", () => {
      reject(new Error("CDP socket closed before the screencast started."));
      // A deliberate switch closes the old socket and may attach a new one that
      // dies mid-handshake — neither should tear the whole bridge down (the
      // watcher falls back on its next tick). Only an unexpected drop of the
      // live socket outside a swap does. A stale socket (already replaced) is
      // likewise ignored.
      if (this.switching || socket !== this.cdp) return;
      this.handleClosed();
    });
    socket.addEventListener("error", () => {
      reject(new Error("CDP socket errored before the screencast started."));
      if (this.switching || socket !== this.cdp) return;
      this.handleClosed();
    });
    return promise;
  }

  // Open a browser-level CDP socket and subscribe to Target lifecycle events so
  // we learn each new page target's openerId (the /json/list REST endpoint the
  // watcher polls omits it). A target whose openerId is already in the sign-in
  // family joins the family — that's how a popup the watched page opened (and a
  // popup THAT popup opens) is recognized, while a sibling task's freshly opened
  // tab, which has no opener in the family, is excluded. Best-effort: if the
  // browser wsUrl can't be resolved or the socket fails, the family stays just
  // the watched page and the bridge simply never follows a popup (safe default).
  private async startTargetDiscovery(port: number): Promise<void> {
    let wsUrl: string | null;
    try {
      wsUrl = await this.deps.fetchBrowserWsUrl(port);
    } catch {
      wsUrl = null;
    }
    if (!wsUrl) return;
    const socket = this.deps.openSocket(wsUrl);
    this.browserCdp = socket;
    socket.addEventListener("open", () => {
      // setDiscoverTargets makes Chrome emit Target.targetCreated/targetInfoChanged
      // for every target, each carrying targetId + openerId + type + url.
      try {
        socket.send(JSON.stringify({ id: ++this.browserCdpId, method: "Target.setDiscoverTargets", params: { discover: true } }));
      } catch {
        // ignore — discovery is best-effort
      }
    });
    socket.addEventListener("message", (ev) => this.onBrowserCdpMessage(ev.data));
    // A dropped discovery socket just disables popup-follow; it must NOT tear
    // the screencast down (that's the page-level socket's job).
    socket.addEventListener("close", () => {
      if (socket === this.browserCdp) this.browserCdp = undefined;
    });
    socket.addEventListener("error", () => {
      if (socket === this.browserCdp) this.browserCdp = undefined;
    });
  }

  // Fold a Target.targetCreated/targetInfoChanged event into the sign-in family:
  // a page target whose opener is already in the family joins it. Pure
  // bookkeeping — the watcher does the actual screencast switch.
  private onBrowserCdpMessage(raw: unknown): void {
    let msg: { method?: string; params?: { targetInfo?: { targetId?: string; type?: string; openerId?: string } } };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.method !== "Target.targetCreated" && msg.method !== "Target.targetInfoChanged") return;
    const info = msg.params?.targetInfo;
    if (!info || info.type !== "page" || typeof info.targetId !== "string") return;
    if (typeof info.openerId === "string" && this.signInFamily.has(info.openerId)) {
      this.signInFamily.add(info.targetId);
    }
  }

  // Poll /json and switch the screencast to a popup the sign-in opened, or back
  // to a surviving family page when the watched one closes. Only ever switches
  // among the sign-in's OWN target family (seeded in start(), grown by opener in
  // onBrowserCdpMessage), so a sibling task's tab can't steal the screencast.
  // Best-effort; the interval is unref'd so it never holds the process open.
  private startTargetWatch(port: number): void {
    this.targetWatch = setInterval(() => {
      void (async () => {
        if (this.closed || this.switching) return;
        let pages: CdpVersionTarget[];
        try {
          const targets = await this.deps.fetchJson(`http://127.0.0.1:${port}/json`);
          pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        } catch {
          return; // transient; try again next tick
        }
        const live = (id: string): CdpVersionTarget | undefined =>
          pages.find((p) => p.id === id && p.webSocketDebuggerUrl);
        // A family page we haven't shown yet is a popup the sign-in just opened
        // — switch to it ONCE. Filtering on visited (not merely "!= current")
        // stops the opener↔popup ping-pong when both stay alive.
        const fresh = [...this.signInFamily]
          .map(live)
          .find(
            (p): p is CdpVersionTarget =>
              !!p && typeof p.id === "string" && !this.visitedTargetIds.has(p.id) && !!p.webSocketDebuggerUrl
          );
        if (fresh?.webSocketDebuggerUrl && typeof fresh.id === "string") {
          this.currentTargetId = fresh.id;
          this.visitedTargetIds.add(fresh.id);
          this.setUrl(fresh.url);
          await this.switchTo(fresh.webSocketDebuggerUrl);
          return;
        }
        // The watched page is gone (popup dismissed / tab closed) — fall back to
        // any surviving FAMILY page so the operator isn't left on a dead frame,
        // never to an unrelated task's tab.
        const currentAlive = this.currentTargetId ? live(this.currentTargetId) : undefined;
        if (!currentAlive) {
          const survivor = [...this.signInFamily]
            .map(live)
            .find((p): p is CdpVersionTarget => !!p && !!p.webSocketDebuggerUrl);
          if (survivor?.webSocketDebuggerUrl && typeof survivor.id === "string") {
            this.currentTargetId = survivor.id;
            this.visitedTargetIds.add(survivor.id);
            this.setUrl(survivor.url);
            await this.switchTo(survivor.webSocketDebuggerUrl);
          }
          return;
        }
        // No switch this tick — refresh the URL so a same-tab redirect (the page
        // navigating itself, e.g. OAuth bouncing through an identity provider)
        // is reflected to the operator.
        this.setUrl(currentAlive.url);
      })();
    }, this.targetWatchMs);
    if (typeof this.targetWatch.unref === "function") this.targetWatch.unref();
  }

  // Re-point the live screencast to a different page target: drop the current
  // socket (without tearing the whole bridge down) and attach to the new one.
  private async switchTo(wsUrl: string): Promise<void> {
    if (this.closed || wsUrl === this.currentWsUrl) return;
    this.switching = true;
    try {
      const old = this.cdp;
      this.cdp = undefined;
      // The old socket's close handler is bypassed during a deliberate switch,
      // so it never drains this.pending. Resolve any in-flight send awaiting the
      // old socket now (its reply can never arrive on the new session) — mirrors
      // handleClosed's resolve(undefined) so a dispatchInput await can't hang.
      for (const resolve of this.pending.values()) resolve(undefined);
      this.pending.clear();
      // The old socket's close handler is suppressed for the whole swap window
      // (this.switching stays true, and this.cdp is already nulled), so closing
      // it can't tear the bridge down.
      try {
        old?.close();
      } catch {
        // ignore
      }
      // A new target that dies mid-attach rejects here; swallow it so switching
      // always clears and the next watch tick can fall back to a live page. Null
      // the dead socket so send() short-circuits until that fallback re-attaches.
      await this.attachTo(wsUrl).catch(() => {
        if (this.currentWsUrl === wsUrl) this.cdp = undefined;
      });
    } finally {
      this.switching = false;
    }
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
    if (this.targetWatch) {
      clearInterval(this.targetWatch);
      this.targetWatch = undefined;
    }
    if (this.browserCdp) {
      try {
        this.browserCdp.close();
      } catch {
        // ignore
      }
      this.browserCdp = undefined;
    }
    // Tell SSE viewers the channel is dead so they close their stream (the
    // client reconnects and re-evaluates the gate) instead of dangling on a
    // stale frame behind keepalives. Fire before clearing frame subscribers.
    for (const onClose of this.closeSubscribers) {
      try {
        onClose();
      } catch {
        // a broken close subscriber must not break the others
      }
    }
    this.closeSubscribers.clear();
    this.subscribers.clear();
    this.urlSubscribers.clear();
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

  // Update the URL being screencast and notify URL subscribers on change, so
  // the modal can show the operator which origin they're signing into.
  private setUrl(url: string | undefined): void {
    if (!url || url === this.currentUrl) return;
    this.currentUrl = url;
    for (const fn of this.urlSubscribers) {
      try {
        fn(url);
      } catch {
        // a broken url subscriber must not break the others
      }
    }
  }

  // Subscribe to frames. Immediately replays the latest frame (if any) so a
  // newly-connected viewer paints without waiting for the next page change,
  // then streams subsequent frames. onClose fires once if the bridge closes
  // while subscribed (so the caller can tear down its stream); onUrl fires with
  // the current page URL immediately and on each change (the trusted origin the
  // operator is signing into). Returns an unsubscribe fn that drops all three.
  subscribe(
    onFrame: (frame: ScreencastFrame) => void,
    onClose?: () => void,
    onUrl?: (url: string) => void
  ): () => void {
    // If the bridge already closed between the caller acquiring it and this
    // subscribe (e.g. the CDP socket dropped in the await gap before the SSE
    // ReadableStream's start() ran), handleClosed already fired and cleared
    // closeSubscribers — a callback registered now would never fire and the
    // SSE stream would dangle on keepalives. Fire onClose synchronously and
    // hand back a no-op unsubscribe so the caller tears its stream down at once.
    if (this.closed) {
      if (onClose) {
        try {
          onClose();
        } catch {
          // ignore
        }
      }
      return () => undefined;
    }
    this.subscribers.add(onFrame);
    if (onClose) this.closeSubscribers.add(onClose);
    if (onUrl) {
      this.urlSubscribers.add(onUrl);
      if (this.currentUrl) {
        try {
          onUrl(this.currentUrl);
        } catch {
          // ignore
        }
      }
    }
    if (this.latest) {
      try {
        onFrame(this.latest);
      } catch {
        // ignore
      }
    }
    return () => {
      this.subscribers.delete(onFrame);
      if (onClose) this.closeSubscribers.delete(onClose);
      if (onUrl) this.urlSubscribers.delete(onUrl);
    };
  }

  // Translate one modal input event into CDP Input.* calls. Mirrors the proven
  // control-panel mapping: printable chars with no Ctrl/Meta go through as
  // typed text; everything else (Enter/Tab/Backspace/arrows and any Cmd+<key>)
  // is a real key event carrying the modifier bitmask so page shortcuts fire.
  // Returns the remote page's current text selection for the selection-causing
  // kinds (double/triple-click, dragselect, copy, cut, selectall), so the modal
  // can write it to the operator's clipboard on a native copy/cut. Other kinds
  // return undefined.
  async dispatchInput(m: ScreencastInput): Promise<{ selection?: string }> {
    const mods = "modifiers" in m ? (m.modifiers ?? 0) : 0;
    switch (m.kind) {
      case "click": {
        const clickCount = m.clickCount ?? 1;
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        // A double/triple-click selects a word/line — surface the selection so a
        // following operator Cmd+C copies it (mirrors the control panel).
        if (clickCount >= 2) return { selection: await this.readSelection() };
        return {};
      }
      case "move":
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x, y: m.y, modifiers: mods });
        return {};
      case "scroll":
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy, modifiers: mods });
        return {};
      case "dragselect":
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x0, y: m.y0, button: "left", clickCount: 1, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x1, y: m.y1, button: "left", modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x1, y: m.y1, button: "left", clickCount: 1, modifiers: mods });
        return { selection: await this.readSelection() };
      case "key":
        if (m.text && m.text.length === 1 && (mods & CTRL_OR_META) === 0) {
          await this.send("Input.dispatchKeyEvent", { type: "char", text: m.text, modifiers: mods });
        } else {
          const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: mods };
          await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
          await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        }
        return {};
      case "paste":
        // Operator's LOCAL clipboard text, inserted into the remote page's
        // focused field. Text only — no navigation, no SSRF surface.
        await this.send("Input.insertText", { text: m.text });
        return {};
      case "selectall":
        await this.selectAllRemote();
        return { selection: await this.readSelection() };
      case "copy":
        return { selection: await this.readSelection() };
      case "cut": {
        const selection = await this.readSelection();
        // Replace the selection with nothing = delete it (the "cut" half).
        await this.send("Input.insertText", { text: "" });
        return { selection };
      }
    }
  }

  // Read the page's current selection — works for <input>/<textarea>
  // (selectionStart/End) and ordinary DOM selection. Best-effort: returns "" on
  // any evaluation failure so a clipboard action never throws.
  private async readSelection(): Promise<string> {
    try {
      const res = (await this.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.selectionStart != null)
            return el.value.substring(el.selectionStart, el.selectionEnd);
          const s = window.getSelection();
          return s ? s.toString() : '';
        })()`,
        returnByValue: true
      })) as { result?: { value?: unknown } } | undefined;
      const value = res?.result?.value;
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  // Select all in the focused field (or the whole document) on the remote page.
  private async selectAllRemote(): Promise<void> {
    await this.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { el.select(); return; }
        if (document.execCommand) document.execCommand('selectAll', false, null);
      })()`
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Stop the screencast and drop the socket. Best-effort; never throws. The
  // stopScreencast send is bounded by stopTimeoutMs: if the CDP socket is
  // wedged (an unresponsive renderer on a heavy login page) the send never
  // resolves, so we race it against a timer and force the socket shut
  // regardless — otherwise /complete and /cancel, which await this, would hang.
  async stop(): Promise<void> {
    if (this.cdp && !this.closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.stopTimeoutMs);
      });
      try {
        await Promise.race([this.send("Page.stopScreencast").then(() => undefined), timeout]);
      } catch {
        // ignore — we're tearing down
      } finally {
        // Clear the bound so the fast path (stopScreencast replied first) doesn't
        // leave a ref'd timer pending until it fires.
        if (timer) clearTimeout(timer);
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
// The setupRequest id that owns the active/starting bridge. The screencast is a
// single per-instance channel, but two concurrent browser.connect sign-ins (two
// tasks, or one task on two hosts) can be pending at once. Without an owner, the
// second sign-in's frames/input would bind to the FIRST sign-in's page (the
// operator would see and type into the wrong task's login), and completing or
// cancelling either would tear down the other's live screencast. So the bridge
// is claimed by one setup id; a different owner is rejected (the HTTP layer
// turns the throw into a 409) until the holder finishes.
let activeOwner: string | undefined;
let startingOwner: string | undefined;
// In-flight start promise so concurrent first-callers (the frames-SSE GET and
// the input-POST arriving together on the first request) share ONE bridge
// instead of each launching a CDP socket and leaking the loser's. Cleared once
// the start settles.
let startingBridge: Promise<ScreencastBridge> | undefined;
// Identity of the in-flight start that owns startingBridge/startingOwner. The
// settling start clears the slot only if this still matches its own token, so
// a stale start that resolves after a newer start took over doesn't wipe the
// newer start's slot. Bumped to undefined by stopActiveBridge.
let startingToken: symbol | undefined;
// Monotonic teardown counter. Bumped by stopActiveBridge so a start() that is
// in flight when teardown fires doesn't install (and orphan) a now-unwanted
// bridge: the start captures the generation up front and, if it changed by the
// time start() resolves, stops the freshly-built bridge instead of installing
// it. Without this, "I've signed in" (which calls stopActiveBridge) racing the
// modal's still-connecting frames request would leave a live CDP socket that
// nothing ever closes.
let bridgeGeneration = 0;

// Raised when a screencast request targets the instance's bridge while another
// sign-in setup already owns it. The HTTP layer maps this to a 409.
export class ScreencastBusyError extends Error {
  constructor() {
    super("Another sign-in is using the agent's browser screencast.");
    this.name = "ScreencastBusyError";
  }
}

// Raised when a bridge start resolves AFTER a teardown bumped the generation:
// the freshly-built bridge was stopped instead of installed, so the caller must
// not receive it. The HTTP layer maps this to a 409 (the modal reconnects and
// re-hits the now-non-pending gate).
export class ScreencastStaleStartError extends Error {
  constructor() {
    super("The sign-in screencast was torn down while connecting.");
    this.name = "ScreencastStaleStartError";
  }
}

// Get the live bridge for `owner` (the setupRequest id), creating + starting one
// if none is active (or the previous one closed). A request from a DIFFERENT
// owner while the bridge is held throws ScreencastBusyError → 409, so two
// concurrent sign-ins can't cross-wire onto one page. `prefer` (targetId +/or
// url) is forwarded to start() so the bridge binds to the requesting task's
// exact page. Test seam: pass a factory to inject a fake bridge.
export async function getOrStartBridge(
  owner: string,
  prefer?: { preferUrl?: string; preferTargetId?: string },
  factory: () => ScreencastBridge = () => new ScreencastBridge()
): Promise<ScreencastBridge> {
  if (activeBridge && !activeBridge.isClosed()) {
    if (activeOwner !== owner) throw new ScreencastBusyError();
    return activeBridge;
  }
  if (startingBridge) {
    if (startingOwner !== owner) throw new ScreencastBusyError();
    return startingBridge;
  }
  const bridge = factory();
  const startedAtGeneration = bridgeGeneration;
  // Per-start token. The .finally() below must clear the module slot ONLY if
  // it still belongs to THIS start: after a teardown bumps the generation and
  // a LATER start re-populates startingBridge/startingOwner, this start's
  // settle would otherwise wipe the newer start's slot and break the
  // single-flight guard (a third caller would launch a concurrent bridge).
  const startToken = Symbol("screencast-start");
  startingToken = startToken;
  startingOwner = owner;
  startingBridge = bridge
    .start(prefer?.preferUrl, prefer?.preferTargetId)
    .then(() => {
      // A teardown landed while we were starting — don't install this bridge;
      // stop it so its CDP socket isn't orphaned, and REJECT rather than handing
      // back the now-dead bridge. Returning it would let the frames/input
      // handler subscribe to a closed bridge (its onClose already fired and
      // cleared subscribers), leaving the SSE stream dangling on keepalives and
      // input calls silently no-op'ing. The reject surfaces as a 409 so the
      // modal's EventSource reconnects and re-hits the now-non-pending gate.
      if (bridgeGeneration !== startedAtGeneration) {
        void bridge.stop();
        throw new ScreencastStaleStartError();
      }
      activeBridge = bridge;
      activeOwner = owner;
      return bridge;
    })
    .finally(() => {
      // Only clear if a newer start (or a teardown) hasn't already taken over
      // the slot — otherwise we'd forget the in-flight newer start.
      if (startingToken === startToken) {
        startingBridge = undefined;
        startingOwner = undefined;
        startingToken = undefined;
      }
    });
  return startingBridge;
}

// True when a live (or still-starting) bridge is already held by `owner`. Lets
// the HTTP layer skip the relaunch-the-spawned-Chrome step when a reusable
// bridge already exists for this setup — a getScreencastPort() null reading is
// only a "no browser, must relaunch" signal when there's also no active bridge
// to reuse (e.g. a test that installs a fake bridge without a spawned handle,
// or a bridge that outlived a transient port blip).
export function hasLiveBridgeForOwner(owner: string): boolean {
  if (activeBridge && !activeBridge.isClosed() && activeOwner === owner) return true;
  if (startingBridge && startingOwner === owner) return true;
  return false;
}

// Tear down the active bridge (sign-in completed / cancelled / shutdown). Bumps
// the generation so any start() still in flight tears its own bridge down
// instead of installing it after this returns. When `owner` is given, only the
// bridge OWNED by that setup is torn down — completing or cancelling one sign-in
// must not kill another's live screencast; a mismatch is a no-op. Pass no owner
// for an unconditional teardown (shutdown / closeAll).
export async function stopActiveBridge(owner?: string): Promise<void> {
  // No-op when a DIFFERENT setup holds the bridge — whether it's already active
  // OR still starting (activeOwner is unset during the in-flight window, so we
  // must also consult startingOwner or a non-owner teardown could abort another
  // setup's still-connecting bridge).
  if (
    owner !== undefined &&
    (activeOwner !== undefined || startingOwner !== undefined) &&
    activeOwner !== owner &&
    startingOwner !== owner
  ) {
    return;
  }
  bridgeGeneration += 1;
  const bridge = activeBridge;
  activeBridge = undefined;
  activeOwner = undefined;
  startingBridge = undefined;
  startingOwner = undefined;
  // Bump the token so an in-flight start's .finally() (which checks
  // startingToken === its own) becomes a no-op and can't clear a slot a newer
  // start later installs.
  startingToken = undefined;
  if (bridge) await bridge.stop();
}

// Test-only: install a ready bridge as the active one so the HTTP endpoints
// reuse it (exercises the success-path wiring without launching Chrome). The
// owner must match the setup id the reusing request carries, or it would 409.
export function __setActiveBridgeForTest(bridge: ScreencastBridge, owner?: string): void {
  activeBridge = bridge;
  activeOwner = owner;
  startingBridge = undefined;
  startingOwner = undefined;
  startingToken = undefined;
}

// Test-only reset so a suite doesn't leak the module-level bridge.
export function __resetActiveBridgeForTest(): void {
  activeBridge = undefined;
  activeOwner = undefined;
  startingBridge = undefined;
  startingOwner = undefined;
  startingToken = undefined;
}
