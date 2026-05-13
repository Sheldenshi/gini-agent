// Browser automation tools. Drives Chromium via playwright-core in one of
// two modes:
//
//   - "persistent" (default): chromium.launchPersistentContext(dataDir, {
//     headless }) — one BrowserContext backed by the per-instance profile
//     directory at ~/.gini/instances/<inst>/chrome-profile/. Used for BOTH
//     the headless default (no state.browser record) and the visible window
//     (state.browser.mode === "managed") — the only difference is the
//     `headless` flag at launch. Sign-ins land on disk under the profile dir
//     and persist across Connect/Disconnect cycles and across runtime
//     restarts. All tasks share the single context (cookies bleed across
//     tasks within an instance, per the explicit product decision).
//   - "cdp": chromium.connectOverCDP(url) — attach to an external Chrome
//     the user started themselves. We reuse browser.contexts()[0] for the
//     same shared-cookie reason.
//
// "Connect" and "Disconnect" are visibility toggles. They tear down the
// current shared handle so the next call relaunches with the right
// `headless` flag against the same profile dir.
//
// Tasks are keyed by taskId and idle-swept after 5 minutes. Side-effecting
// actions (click/type) skip the approval gate; the snapshot itself is the
// trace evidence.
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { join } from "node:path";
import { instanceRoot } from "../paths";
import { readState } from "../state";
import type { BrowserConnectionRecord, Instance } from "../types";

// Per-instance Chrome profile directory. The agent persists ALL sign-ins
// and cookies here; the directory survives Connect/Disconnect cycles and
// runtime restarts. Wiped only by the explicit wipe-profile action.
export function chromeProfileDirFor(instance: Instance): string {
  return join(instanceRoot(instance), "chrome-profile");
}

const SNAPSHOT_CHAR_BUDGET = 32_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

interface Session {
  context: BrowserContext;
  page: Page;
  refs: Map<string, Locator>;
  lastActivity: number;
  // In-flight call counter. Incremented by withSession around each tool
  // invocation so the idle sweeper can skip sessions that are mid-call
  // (e.g. a slow page.goto exceeding the 5-minute idle window).
  inFlight: number;
  // We never own the BrowserContext anymore — the persistent and CDP modes
  // both share a single BrowserContext across tasks. closeSession() closes
  // just the page so we don't kill the user's tabs or the shared context.
  // The field is retained to keep the test helpers stable; it's always
  // false in production code paths.
  ownsContext: boolean;
}

// Discriminated union describing the currently-installed shared handle.
// Persistent mode is used for BOTH the headless default and the visible
// window — the only difference is whether `headed` is true. CDP attach
// keeps its own variant because it carries a Browser handle (returned by
// connectOverCDP) alongside the borrowed context.
type SharedHandle =
  | { kind: "persistent"; context: BrowserContext; headed: boolean }
  | { kind: "cdp"; browser: Browser; context: BrowserContext };

let shared: SharedHandle | null = null;
let chromiumImport: Promise<typeof import("playwright-core").chromium> | undefined;
// In-flight launch/attach promise so concurrent ensureShared callers share
// one chromium.launch() / launchPersistentContext() / connectOverCDP()
// instead of orphaning the loser's handle.
let pendingShared: Promise<SharedHandle> | null = null;
// Monotonically-increasing disconnect counter. Bumped at the start of
// every disconnectSharedBrowser call. Replaces an earlier boolean
// `disconnecting` flag whose two-state design lost information across
// re-entrant disconnects and exceeded-drain-deadline races: a slow
// getOrCreate / connectOverCDP that breached the 5s cap would resume
// after teardown, observe `disconnecting === false`, and proceed against
// a torn-down browser. With a generation counter the resuming caller
// compares its captured epoch to the current one and bails on any
// change. Callers that need "is teardown in progress right now?" can
// read the wider `inFlightDisconnects` boolean below.
let disconnectGeneration = 0;
// True while one or more disconnectSharedBrowser calls are mid-flight.
// withSession uses this to short-circuit new admissions cheaply without
// racing the generation counter on every entry. Cleared back to false
// when the last in-flight disconnect's finally block runs.
let inFlightDisconnects = 0;
// Counts admissions that have captured a generation but have not yet
// bumped their session's `inFlight`. Without this, a tool call could
// pass the initial check, suspend inside getOrCreate / ensureBrowser
// (e.g. on the dynamic playwright-core import or a slow CDP attach),
// disconnectSharedBrowser could observe an empty drain and tear down,
// and the suspended call would resume against a closed browser. The
// drain loop in disconnectSharedBrowser waits for this to fall to zero
// in addition to summing per-session inFlight.
let pendingAdmissions = 0;
// How long disconnectSharedBrowser waits for inFlight sessions to drain
// before forcing teardown. Better to risk tearing down a slow in-flight
// call than to wedge disconnect forever waiting on a hung page.goto.
const DISCONNECT_DRAIN_DEADLINE_MS = 5_000;
const sessions = new Map<string, Session>();
// Set at runtime startup via setBrowserInstance(). Lets ensureBrowser()
// look up state.browser to decide between connectOverCDP() and launch().
// Stays undefined in standalone test contexts that import the tools
// directly without going through the runtime — the launch path then
// behaves exactly as before.
let runtimeInstance: Instance | undefined;
// Same idea per task — concurrent getOrCreate() calls for the same taskId
// share one Promise<Session> so we never create two contexts for one task.
const pendingSessions = new Map<string, Promise<Session>>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let exitHookRegistered = false;

function loadChromium(): Promise<typeof import("playwright-core").chromium> {
  if (!chromiumImport) {
    chromiumImport = import("playwright-core").then((mod) => mod.chromium);
  }
  return chromiumImport;
}

// Called by the runtime (src/server.ts) right after loadConfig so the
// session manager can resolve which instance's state.browser to consult.
// Safe to call repeatedly — only the last value is used.
export function setBrowserInstance(instance: Instance): void {
  runtimeInstance = instance;
}

// Read the active CDP connection record if one is registered. Returns
// undefined when no instance is set (tests / direct tool callers) or
// when the user hasn't connected a browser. The lookup is synchronous
// and cheap (readState already memoizes the JSON parse via writeState's
// atomic rename), so we don't memoize here.
function activeBrowserRecord(): BrowserConnectionRecord | undefined {
  if (!runtimeInstance) return undefined;
  try {
    const state = readState(runtimeInstance);
    return state.browser ?? undefined;
  } catch {
    // readState can throw on a state-file corruption — better to fall
    // back to the headless launch than to wedge every browser tool call.
    return undefined;
  }
}

// Mode decided from state.browser. We resolve the record before the await
// chain starts so two concurrent cold-start callers see the same decision;
// if the record changes mid-launch the result is a stale handle, but the
// disconnect-generation re-check below catches that and forces a retry.
type Mode = "persistent" | "cdp";

function modeFromRecord(record: BrowserConnectionRecord | undefined): Mode {
  // Both "no record" (headless persistent) and "managed" (visible
  // persistent) take the persistent branch; only an explicit cdp record
  // diverges. The headed/headless distinction is decided inside
  // ensureShared from the record's mode.
  if (!record) return "persistent";
  return record.mode === "managed" ? "persistent" : "cdp";
}

// Cheap "is this handle still alive?" probe used to short-circuit
// ensureShared when the previously-installed handle survives. For cdp we
// ask the Browser; for persistent we ask the BrowserContext (its
// underlying Browser may not always be exposed publicly across Playwright
// versions, but `pages()` throws after close, so a try/catch covers it).
function isHandleAlive(handle: SharedHandle): boolean {
  try {
    switch (handle.kind) {
      case "cdp":
        return handle.browser.isConnected();
      case "persistent":
        // Touch a cheap property — if the context was closed the
        // underlying Playwright object throws on access.
        handle.context.pages();
        return true;
    }
  } catch {
    return false;
  }
}

async function ensureShared(): Promise<SharedHandle> {
  if (shared && isHandleAlive(shared)) return shared;
  if (pendingShared) return pendingShared;
  const record = activeBrowserRecord();
  const mode: Mode = modeFromRecord(record);
  // headed is the only difference between "no record" (default agent
  // tooling) and "managed" (user clicked Connect). Same profile dir is
  // used in both, so signed-in cookies survive the toggle.
  const headed: boolean = record?.mode === "managed";
  // Capture the current disconnect generation at the START of the launch.
  // If a disconnect bumps the counter while chromium.launch /
  // launchPersistentContext / connectOverCDP is in flight, we don't want
  // to install the resulting handle on the shared slot — disconnect
  // already cleared `shared`, so installing the freshly-built handle
  // would silently re-attach the agent to the soon-to-be-dead remote
  // (or a stale headless Chromium). Throwing inside the IIFE lets the
  // natural pendingShared rejection carry up to the caller, and the
  // resulting handle is closed/disconnected so we don't leak the process.
  const launchGeneration = disconnectGeneration;
  pendingShared = (async () => {
    const chromium = await loadChromium();
    let built: SharedHandle;
    if (mode === "persistent") {
      // Persistent mode is used for BOTH the headless default and the
      // visible "managed" connect. The profile dir is per-instance, so
      // sign-ins stored during a headed session remain available the next
      // time the agent relaunches headless against the same dir.
      //
      // Determine the data dir:
      //   - When a managed record exists and supplies dataDir, prefer that
      //     (covers explicit Connect flows that already materialized a
      //     specific dir).
      //   - Otherwise, derive from the active instance — this is the
      //     normal path the agent takes when no Connect record exists.
      //   - If no instance has been registered (raw test imports), refuse
      //     to launch. Tests should install a fake handle via the __test
      //     helpers; production callers always set the instance via
      //     setBrowserInstance() during server boot.
      let dataDir: string | undefined;
      if (record?.dataDir) {
        dataDir = record.dataDir;
      } else if (runtimeInstance) {
        dataDir = chromeProfileDirFor(runtimeInstance);
      }
      if (!dataDir) {
        throw new Error(
          "No instance registered for the browser session manager; call setBrowserInstance() before triggering a browser tool."
        );
      }
      const chromePath = record?.chromePath ?? undefined;
      const context = await chromium.launchPersistentContext(dataDir, {
        headless: !headed,
        executablePath: chromePath,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=ChromeWhatsNewUI,Translate"
        ]
      });
      built = { kind: "persistent", context, headed };
    } else {
      // cdp
      if (!record?.cdpUrl) {
        throw new Error(
          "CDP browser connection record is missing cdpUrl; reconnect via /api/browser/connect."
        );
      }
      // connectOverCDP returns a Browser handle scoped to the remote
      // process. The remote Chrome's default BrowserContext shows up
      // under browser.contexts() — we reuse it so signed-in cookies are
      // visible. Note: CDP attach is known-flaky under playwright-core
      // 1.60 + Bun; we keep it for users who explicitly attach to their
      // own Chrome but warn them in the UI.
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(record.cdpUrl, { timeout: 60_000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout|websocket|protocol/i.test(message)) {
          throw new Error(
            `Failed to attach over CDP: ${message}. ` +
              "CDP attach can hang under the current Playwright + Bun stack. " +
              "Prefer the managed browser launch (visible Chrome window) via " +
              "/api/browser/connect without a cdpUrl."
          );
        }
        throw error instanceof Error ? error : new Error(message);
      }
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      built = { kind: "cdp", browser, context: ctx };
    }
    if (disconnectGeneration !== launchGeneration) {
      // Disconnect bumped the generation while we were launching. Clean
      // up the freshly-built handle and surface a clear error to the
      // caller.
      await teardownHandle(built).catch(() => undefined);
      throw new Error("Browser disconnecting, retry shortly.");
    }
    return built;
  })()
    .then((handle) => {
      // Re-check inside the .then so we never install a stale handle on
      // the shared slot. The IIFE above already throws in this case, but
      // the belt-and-braces check covers a future refactor where the
      // generation could change between the IIFE return and this handler.
      if (disconnectGeneration !== launchGeneration) {
        void teardownHandle(handle).catch(() => undefined);
        throw new Error("Browser disconnecting, retry shortly.");
      }
      shared = handle;
      registerExitHook();
      startSweeper();
      return handle;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Don't wrap the "Browser disconnecting" sentinel — withSession
      // matches on its prefix and we want callers to see the same
      // message regardless of where the bail happened.
      if (message.startsWith("Browser disconnecting")) {
        throw error instanceof Error ? error : new Error(message);
      }
      if (mode === "cdp") {
        throw new Error(
          `Failed to attach over CDP: ${message}. ` +
            "Disconnect and reconnect via /api/browser/connect, or start a fresh Chrome session."
        );
      }
      // persistent (headless default or managed visible window)
      throw new Error(
        `Failed to launch Chromium: ${message}. ` +
          (headed
            ? "Confirm Chrome / Chromium is installed (or set GINI_CHROME_PATH) and retry."
            : "Run `bunx playwright install chromium` to install the browser.")
      );
    })
    .finally(() => {
      pendingShared = null;
    });
  return pendingShared;
}

// Called by the browser-connect capability after it builds the visible
// persistent BrowserContext via chromium.launchPersistentContext. We
// install the context directly into the shared slot so the first browser_*
// tool call doesn't have to re-launch Chrome (and so the user sees the
// window open immediately at connect time). Any pre-existing shared handle
// is torn down first to avoid leaking a previous Chromium process pointing
// at the same profile dir (Chromium will lock the profile otherwise).
export async function materializeManagedForConnect(context: BrowserContext): Promise<void> {
  if (shared) {
    await teardownHandle(shared).catch(() => undefined);
    shared = null;
  }
  shared = { kind: "persistent", context, headed: true };
  registerExitHook();
  startSweeper();
}

// Mode-aware teardown of a SharedHandle. Persistent: close the
// BrowserContext, which also terminates the Chromium child Playwright
// launched. The profile dir on disk stays put (sign-ins persist).
// CDP: disconnect the Playwright handle without closing the remote Chrome
// (close() over CDP would kill the user's browser; falling back to close()
// when disconnect() is missing is the lesser of two evils only if the
// user's process is acceptable collateral — we deliberately leak the
// in-process handle instead).
async function teardownHandle(handle: SharedHandle): Promise<void> {
  switch (handle.kind) {
    case "persistent":
      await handle.context.close().catch(() => undefined);
      return;
    case "cdp": {
      const candidate = handle.browser as unknown as { disconnect?: () => Promise<void> };
      if (typeof candidate.disconnect === "function") {
        await candidate.disconnect().catch(() => undefined);
      }
      // If disconnect() isn't available on this CDP-attached Browser, do
      // NOT fall back to close() — close() over CDP terminates the user's
      // Chrome. Leaking the in-process handle is strictly better than
      // killing the user's browser; it'll be garbage-collected once
      // nothing references it.
      return;
    }
  }
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  // Only beforeExit. The runtime's own SIGTERM handler in src/server.ts
  // calls closeAll() as part of its drain; intercepting SIGINT/SIGTERM
  // here would either swallow the signal (no process.exit) or race the
  // server's drain. beforeExit covers non-server callers (CLI, tests).
  process.on("beforeExit", () => {
    void closeAll();
  });
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [taskId, session] of sessions.entries()) {
      // Skip sessions with in-flight calls so a slow page.goto doesn't
      // get killed under the agent's feet just because it crossed the
      // idle threshold mid-await.
      if (session.inFlight > 0) continue;
      if (session.lastActivity < cutoff) {
        void closeSession(taskId);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

async function getOrCreate(taskId: string): Promise<Session> {
  const existing = sessions.get(taskId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const inflight = pendingSessions.get(taskId);
  if (inflight) return inflight;
  const promise = (async () => {
    const handle = await ensureShared();
    // Both persistent and cdp share a single BrowserContext across tasks
    // (cookies bleed by design — one profile per instance). The first task
    // claims any existing page (e.g. the about:blank Playwright opens at
    // launch); subsequent tasks each get a fresh tab so they don't trample
    // each other.
    const context = handle.context;
    const reusable = sessions.size === 0 ? context.pages()[0] : undefined;
    const page = reusable ?? (await context.newPage());
    const session: Session = {
      context,
      page,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownsContext: false
    };
    sessions.set(taskId, session);
    // Attach console capture eagerly so page.goto errors before the
    // agent's first browser_console call are still observable.
    attachConsole(taskId, page);
    return session;
  })().finally(() => {
    pendingSessions.delete(taskId);
  });
  pendingSessions.set(taskId, promise);
  return promise;
}

// Per-tool wrapper that bumps inFlight while the work is in progress so
// the idle sweeper never closes a session mid-call.
async function withSession<T>(taskId: string, fn: (session: Session) => Promise<T>): Promise<T> {
  if (inFlightDisconnects > 0) {
    // The caller is the tool layer; throwing here surfaces as a `success:
    // false` envelope from each browser_* entry point via their existing
    // catch blocks.
    throw new Error("Browser disconnecting, retry shortly.");
  }
  // Capture the disconnect generation BEFORE bumping pendingAdmissions so
  // we can detect any disconnect that completes (and possibly re-completes)
  // while getOrCreate is materializing. A boolean wouldn't be enough: by
  // the time getOrCreate resumes the boolean may have flipped back to
  // false, but the browser we were going to use is gone.
  const enteredAt = disconnectGeneration;
  pendingAdmissions++;
  let session: Session;
  try {
    session = await getOrCreate(taskId);
    if (disconnectGeneration !== enteredAt) {
      // Disconnect started — and possibly finished — while we were
      // materializing. Bail out without using the session; the browser
      // is either being torn down or already gone.
      throw new Error("Browser disconnecting, retry shortly.");
    }
    session.inFlight++;
  } finally {
    pendingAdmissions--;
  }
  try {
    return await fn(session);
  } finally {
    session.inFlight--;
    session.lastActivity = Date.now();
  }
}

async function closeSession(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  consoleLogs.delete(taskId);
  try {
    // Shared context (persistent/cdp): close only the page. The user's
    // window, tabs, and the agent's persistent profile stay alive — the
    // next task lands in the same profile.
    await session.page.close().catch(() => undefined);
  } catch {
    // Already closed or browser disconnected; nothing useful to do.
  }
  // We deliberately do NOT tear down the shared handle when sessions hit
  // zero. The persistent context is cheap to keep alive idle (Chromium
  // sleeps when no pages are active) and re-launching it on the next
  // tool call would be more disruptive than the idle process is.
  // Explicit Connect/Disconnect and the wipe-profile action are the only
  // paths that tear down the shared handle.
}

// Drop the in-process Playwright handle without killing the underlying
// browser process. Used by the browser-connect capability when the user
// disconnects a CDP-attached Chrome: the next browser tool call should
// re-read state and either re-attach (if a fresh record is set up) or
// fall back to the headless launch path. Safe no-op when no shared
// browser is held.
export async function disconnectSharedBrowser(): Promise<void> {
  // Bump the generation FIRST so any in-flight admissions and any
  // pendingBrowser launch capture-and-compare can detect the disconnect
  // even if their resume runs after this function returns. Re-entrant
  // disconnects each get their own generation; the drain loop below
  // bails early if a NEWER generation appears, letting that newer call
  // handle the actual teardown.
  const myGeneration = ++disconnectGeneration;
  inFlightDisconnects++;
  try {
    // Wait for in-flight calls AND materializing admissions to drain. We
    // can't safely close pages / contexts while tools are mid-await on
    // them — the half-completed browser call would throw a confusing
    // "Target closed" up the stack. We also have to wait for any
    // withSession callers that have passed the admission check but
    // haven't yet bumped inFlight: closing under them would leave a
    // suspended call holding a soon-to-be-dead session reference. Bound
    // the wait so a hung page.goto can't wedge disconnect forever; after
    // the deadline, proceed with teardown anyway.
    const drainDeadline = Date.now() + DISCONNECT_DRAIN_DEADLINE_MS;
    while (Date.now() < drainDeadline) {
      // If a newer disconnect call has bumped the generation past ours,
      // bail early: the newer call will run its own drain and teardown,
      // and our continued work would just double-close pages.
      if (disconnectGeneration !== myGeneration) return;
      let pending = 0;
      for (const session of sessions.values()) pending += session.inFlight;
      if (pending === 0 && pendingAdmissions === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Same early-exit re-check after the drain loop: a newer disconnect
    // may have arrived while we slept the last 50ms tick. Let it own the
    // teardown.
    if (disconnectGeneration !== myGeneration) return;

    // Wait for any in-flight launch to settle BEFORE tearing down the
    // shared slot. The drain loop above only counts admissions that
    // reached withSession — a slow launchPersistentContext / connectOverCDP
    // started by an earlier admission that has since exited withSession
    // can still finish here and install itself into `shared`, holding the
    // profile lock against the Connect/Wipe that's running this teardown.
    // Swallow rejections: a failed launch leaves `shared` null, which is
    // what we want, and the original caller already saw the failure.
    if (pendingShared) {
      await pendingShared.catch(() => undefined);
    }

    const ids = Array.from(sessions.keys());
    for (const id of ids) {
      const session = sessions.get(id);
      sessions.delete(id);
      if (!session) continue;
      try {
        // Persistent and cdp both share a single context — close just the
        // page; teardownHandle below closes the context once.
        await session.page.close().catch(() => undefined);
      } catch {
        // ignore
      }
    }
    consoleLogs.clear();
    if (shared) {
      // Either the handle survived the entire drain, or pendingShared
      // resolved between the generation check and now and installed itself
      // into shared (the ensureShared post-await re-check usually catches
      // this and throws, but a future refactor or a same-generation race
      // could still land here). Tear it down regardless.
      await teardownHandle(shared).catch(() => undefined);
      shared = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  } finally {
    inFlightDisconnects--;
  }
}

// Run `fn` with the disconnect admission gate held closed for the entire
// duration. Used by browser-connect's launchManaged and wipeBrowserProfile
// to guarantee that no new agent tool call can land between the
// disconnect-then-launch (or disconnect-then-rm) steps in their critical
// section.
//
// Without this lock, the disconnectSharedBrowser-internal generation bump
// only blocks new admissions while disconnect itself is running. As soon
// as disconnect returns control to the caller, the gate reopens, and any
// admission that lands between `await disconnectSharedBrowser()` and the
// next step (launchPersistentContext, or fs.rm) sneaks back in — racing the
// caller for the profile dir lock.
//
// Mechanics: bump the generation at entry so any in-flight or
// freshly-arriving admission sees a generation mismatch and bails with
// the standard "Browser disconnecting" sentinel. Increment
// `inFlightDisconnects` so withSession's cheap short-circuit also rejects.
// Restore both in a `finally` so a thrown `fn` doesn't wedge the
// admission gate closed forever.
export async function withTeardownLock<T>(fn: () => Promise<T>): Promise<T> {
  disconnectGeneration++;
  inFlightDisconnects++;
  try {
    return await fn();
  } finally {
    inFlightDisconnects--;
  }
}

export async function closeAll(): Promise<void> {
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    const session = sessions.get(id);
    sessions.delete(id);
    if (!session) continue;
    try {
      await session.page.close().catch(() => undefined);
    } catch {
      // ignore
    }
  }
  consoleLogs.clear();
  if (shared) {
    await teardownHandle(shared).catch(() => undefined);
    shared = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

// Cloud metadata endpoints and link-local IPs we never want the agent to
// poke at, even though Gini is local-first. The 169.254.0.0/16 check
// covers AWS, Azure, and other cloud-provider quirks in one shot.
const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog"
]);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xoxb-[A-Za-z0-9-]{20,}/,
  /xoxp-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/
];

function isLinkLocal(host: string): boolean {
  // 169.254.0.0/16
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

// Lightweight IPv6 guard. WHATWG URL hands back hostnames in canonical
// lowercase form, but `[::1]` style brackets are preserved for IPv6
// literals. Strip the brackets, then close the explicit bypasses we know
// about (link-local fe80::/10, loopback ::1, IPv4-mapped ::ffff:a.b.c.d).
// Not a full SSRF sandbox — proportional to the design's "lightweight
// guard" intent.
function isBlockedIpv6(host: string): string | undefined {
  // fe80::/10 — first 10 bits are 1111 1110 10, so the first 16 bits fall
  // in fe80..febf. Require all four hex digits in the leading group so
  // shorter forms like `fe8::` (which expand to 0fe8::, outside the range)
  // don't false-positive. fe8a:: is inside the range and correctly matches.
  if (/^fe[89ab][0-9a-f]:/i.test(host)) {
    return `Blocked: ${host} is an IPv6 link-local address.`;
  }
  if (host === "::1") {
    return `Blocked: ${host} is the IPv6 loopback address.`;
  }
  // ::ffff:a.b.c.d — IPv4-mapped IPv6 in dotted-quad form. Re-run the
  // IPv4 link-local / metadata check against the trailing dotted quad.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (mapped) {
    const ipv4 = mapped[1]!;
    if (BLOCKED_HOSTNAMES.has(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a cloud metadata endpoint.`;
    }
    if (isLinkLocal(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a link-local address.`;
    }
  }
  // ::ffff:HHHH:HHHH — same IPv4-mapped address but in canonical hex form.
  // Bun normalizes `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so
  // the dotted-quad regex above never matches. Decode the two trailing
  // 16-bit groups back into a dotted quad and re-run the IPv4 checks.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    const ipv4 = `${a}.${b}.${c}.${d}`;
    if (BLOCKED_HOSTNAMES.has(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a cloud metadata endpoint.`;
    }
    if (isLinkLocal(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a link-local address.`;
    }
  }
  return undefined;
}

// Exported for direct unit testing in src/tools/browser.test.ts.
// Returns undefined when the URL is allowed; otherwise a human-readable
// reason starting with "Blocked:" or "Invalid URL:".
export function safetyCheck(rawUrl: string): string | undefined {
  // Run the secret-pattern scan against the raw input *before* attempting
  // to parse the URL. A malformed-but-secret-bearing input would otherwise
  // fall through to the `Invalid URL: ${rawUrl}` branch and leak the token
  // into the trace + audit row. Short-circuiting here keeps the error
  // surface free of the original string.
  //
  // decodeURIComponent is all-or-nothing — a single bad escape (e.g. `%zz`)
  // throws and we'd fall back to scanning only the raw form, missing tokens
  // that happen to be percent-encoded alongside other malformed escapes
  // (e.g. `http://example.com/%zz/%73%6b-ant-...`). Decode each `%HH`
  // independently so a single bad escape doesn't blind the rest of the scan.
  const decoded = rawUrl.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
    try {
      return decodeURIComponent(`%${hex}`);
    } catch {
      return match;
    }
  });
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(rawUrl) || pattern.test(decoded)) {
      return "Blocked: URL appears to contain an API key or token.";
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked: only http(s) URLs are allowed (got ${parsed.protocol}).`;
  }
  // Strip IPv6 brackets so the comparisons below see the bare host.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return `Blocked: ${host} is a cloud metadata endpoint.`;
  }
  if (isLinkLocal(host)) {
    return `Blocked: ${host} is a link-local address.`;
  }
  const ipv6Block = isBlockedIpv6(host);
  if (ipv6Block) return ipv6Block;
  return undefined;
}

interface SnapEntry {
  ref: string;
  role: string;
  name: string;
  value: string;
  url: string;
  depth: number;
  full: boolean; // true when emitted only because we're in `full` mode
}

interface SnapshotResult {
  text: string;
  refs: Map<string, Locator>;
  elementCount: number;
  truncated: boolean;
}

// Walk the page in the browser and return a flat list of "interesting"
// nodes plus a unique CSS-attribute ref we can use to resolve a Locator
// later. Built in a single page.evaluate so we minimize round-trips and
// reuse one DOM walk for both the snapshot text and the locator map.
async function snapshot(page: Page, full: boolean): Promise<SnapshotResult> {
  const REF_ATTR = "data-gini-ref";
  // First, clear stale refs from prior snapshots so id allocation stays
  // stable across calls.
  await page.evaluate((attr) => {
    for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
  }, REF_ATTR).catch(() => undefined);

  type Raw = {
    ref: string;
    role: string;
    name: string;
    value: string;
    url: string;
    depth: number;
    full: boolean;
  };

  const raw = await page.evaluate(
    ({ attr, fullMode }: { attr: string; fullMode: boolean }) => {
      const INTERACTIVE_TAGS = new Set([
        "A",
        "BUTTON",
        "INPUT",
        "SELECT",
        "TEXTAREA",
        "OPTION",
        "SUMMARY"
      ]);
      const ROLE_FROM_TAG: Record<string, string> = {
        A: "link",
        BUTTON: "button",
        SELECT: "combobox",
        TEXTAREA: "textbox",
        OPTION: "option",
        SUMMARY: "button"
      };
      const INPUT_ROLE: Record<string, string> = {
        button: "button",
        submit: "button",
        reset: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        email: "textbox",
        text: "textbox",
        password: "textbox",
        tel: "textbox",
        url: "textbox",
        number: "spinbutton"
      };

      const roleOf = (el: Element): string | undefined => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        if (el.tagName === "INPUT") {
          const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
          return INPUT_ROLE[type] ?? "textbox";
        }
        return ROLE_FROM_TAG[el.tagName];
      };

      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const refs = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "");
          const joined = refs.join(" ").trim();
          if (joined) return joined;
        }
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          const id = el.getAttribute("id");
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            const text = lbl?.textContent?.trim();
            if (text) return text;
          }
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) return placeholder.trim();
        }
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return true;
      };

      const out: Raw[] = [];
      let nextId = 1;
      const walk = (el: Element, depth: number): void => {
        const tag = el.tagName;
        const role = roleOf(el);
        const interactive = role !== undefined && (INTERACTIVE_TAGS.has(tag) || el.getAttribute("role"));
        const visible = isVisible(el);
        if (interactive && visible) {
          const ref = `@e${nextId++}`;
          el.setAttribute(attr, ref.slice(1));
          let value = "";
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            value = (el as HTMLInputElement).value ?? "";
          } else if (el.tagName === "SELECT") {
            value = (el as HTMLSelectElement).value ?? "";
          }
          const url = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
          out.push({
            ref,
            role: role!,
            name: nameOf(el),
            value,
            url,
            depth,
            full: false
          });
        } else if (fullMode && visible) {
          // In full mode, also record landmark/heading text so the snapshot
          // captures structural cues the model can use for orientation.
          const landmarkRoles = ["heading", "main", "navigation", "banner", "contentinfo", "region"];
          const tagToRole: Record<string, string> = {
            H1: "heading",
            H2: "heading",
            H3: "heading",
            H4: "heading",
            MAIN: "main",
            NAV: "navigation",
            HEADER: "banner",
            FOOTER: "contentinfo",
            ARTICLE: "article",
            SECTION: "region"
          };
          const fallbackRole = role ?? tagToRole[tag];
          if (fallbackRole && landmarkRoles.includes(fallbackRole)) {
            const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
            if (text) {
              out.push({ ref: "", role: fallbackRole, name: text, value: "", url: "", depth, full: true });
            }
          }
        }
        for (const child of Array.from(el.children)) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return out;
    },
    { attr: REF_ATTR, fullMode: full }
  );

  const refs = new Map<string, Locator>();
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;
  let elementCount = 0;
  for (const entry of raw as SnapEntry[]) {
    const indent = "  ".repeat(entry.depth);
    let line: string;
    if (entry.ref) {
      line = `${indent}[${entry.ref}] ${entry.role}`;
      if (entry.name) line += ` "${entry.name}"`;
      if (entry.value) line += ` value="${entry.value}"`;
      if (entry.role === "link" && entry.url) line += ` url="${entry.url}"`;
    } else {
      line = `${indent}${entry.role} "${entry.name}"`;
    }
    if (charCount + line.length + 1 > SNAPSHOT_CHAR_BUDGET) {
      truncated = true;
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
    if (entry.ref) {
      refs.set(entry.ref, page.locator(`[${REF_ATTR}="${entry.ref.slice(1)}"]`));
      elementCount++;
    }
  }
  let text = lines.join("\n");
  if (truncated) text += "\n[...truncated]";
  return { text, refs, elementCount, truncated };
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload });
}

function fail(error: string): string {
  return JSON.stringify({ success: false, error });
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function browserNavigate(taskId: string, args: Record<string, unknown>): Promise<string> {
  const url = str(args.url);
  if (!url) return fail("Missing required string argument: url");
  const blocked = safetyCheck(url);
  if (blocked) return fail(blocked);
  try {
    return await withSession(taskId, async (session) => {
      const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserSnapshot(taskId: string, args: Record<string, unknown>): Promise<string> {
  const full = bool(args.full, false);
  try {
    return await withSession(taskId, async (session) => {
      const snap = await snapshot(session.page, full);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClick(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  try {
    return await withSession(taskId, async (session) => {
      const locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await locator.click({ timeout: 10_000 });
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserType(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  const text = typeof args.text === "string" ? args.text : undefined;
  if (!ref) return fail("Missing required string argument: ref");
  if (text === undefined) return fail("Missing required string argument: text");
  try {
    return await withSession(taskId, async (session) => {
      const locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await locator.fill(text, { timeout: 10_000 });
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserPress(taskId: string, args: Record<string, unknown>): Promise<string> {
  const key = str(args.key);
  if (!key) return fail("Missing required string argument: key");
  try {
    return await withSession(taskId, async (session) => {
      await session.page.keyboard.press(key);
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserScroll(taskId: string, args: Record<string, unknown>): Promise<string> {
  const direction = str(args.direction);
  if (direction !== "up" && direction !== "down") {
    return fail("Argument direction must be 'up' or 'down'.");
  }
  try {
    return await withSession(taskId, async (session) => {
      const dy = direction === "down" ? 600 : -600;
      await session.page.evaluate((delta) => window.scrollBy(0, delta), dy);
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserBack(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    return await withSession(taskId, async (session) => {
      const response = await session.page.goBack({ waitUntil: "domcontentloaded" });
      const snap = await snapshot(session.page, false);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const consoleLogs = new Map<string, Array<{ type: string; text: string }>>();
const consoleHooked = new WeakSet<Page>();

function attachConsole(taskId: string, page: Page): void {
  if (consoleHooked.has(page)) return;
  consoleHooked.add(page);
  page.on("console", (msg) => {
    const buf = consoleLogs.get(taskId) ?? [];
    buf.push({ type: msg.type(), text: msg.text() });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    consoleLogs.set(taskId, buf);
  });
}

export async function browserConsole(taskId: string, args: Record<string, unknown>): Promise<string> {
  const expression = str(args.expression);
  const clear = bool(args.clear, false);
  try {
    return await withSession(taskId, async (session) => {
      // attachConsole is now called eagerly in getOrCreate; this is a
      // belt-and-braces re-attach in case the page was somehow swapped.
      attachConsole(taskId, session.page);
      if (clear) {
        consoleLogs.set(taskId, []);
      }
      let evalResult: unknown = undefined;
      let evalError: string | undefined;
      if (expression) {
        try {
          evalResult = await session.page.evaluate((expr) => {
            // eslint-disable-next-line no-new-func
            return new Function(`return (${expr});`)();
          }, expression);
        } catch (error) {
          evalError = error instanceof Error ? error.message : String(error);
        }
      }
      const messages = consoleLogs.get(taskId) ?? [];
      return ok({
        url: session.page.url(),
        messages,
        evalResult: evalResult === undefined ? null : evalResult,
        evalError: evalError ?? null
      });
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClose(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    consoleLogs.delete(taskId);
    await closeSession(taskId);
    return ok({ closed: true, taskId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Internal hooks exported for unit tests. The session manager keeps its
// state module-local so production callers don't accidentally poke at the
// shared browser; tests need controlled access to verify the
// disconnect generation, inFlight draining, and the CDP-safe close fallback.
export const __test = {
  // Bump the disconnect generation as if a disconnect ran. Tests that
  // need to simulate "disconnect mid-admission" call this between
  // capturing the current generation and resuming the admission.
  bumpDisconnectGenerationForTest(): number {
    return ++disconnectGeneration;
  },
  currentDisconnectGenerationForTest(): number {
    return disconnectGeneration;
  },
  setInFlightDisconnectsForTest(value: number): void {
    inFlightDisconnects = value;
  },
  inFlightDisconnectsForTest(): number {
    return inFlightDisconnects;
  },
  installPendingSharedForTest(promise: Promise<SharedHandle>): void {
    pendingShared = promise;
  },
  clearPendingSharedForTest(): void {
    pendingShared = null;
  },
  // Reset the cached chromium import so a test that installed a fresh
  // playwright-core mock via mock.module() forces ensureShared to re-import
  // the module and pick up the mocked chromium.launchPersistentContext.
  resetChromiumImportForTest(): void {
    chromiumImport = undefined;
  },
  // Install a fake shared handle so the close-path tests can assert
  // teardown behavior without launching Chromium. The `headed` flag
  // signals whether the test simulates the visible-window (managed) or
  // the headless-default state — both go through the same persistent
  // arm of teardownHandle, so the test impact is purely informational.
  installFakeManagedContextForTest(
    context: Pick<BrowserContext, "close"> & Partial<{ pages: () => Page[] }>
  ): void {
    shared = { kind: "persistent", context: context as BrowserContext, headed: true };
  },
  installFakeHeadlessPersistentContextForTest(
    context: Pick<BrowserContext, "close"> & Partial<{ pages: () => Page[] }>
  ): void {
    shared = { kind: "persistent", context: context as BrowserContext, headed: false };
  },
  installFakeCdpBrowserForTest(
    browser: Pick<Browser, "close"> & Partial<{ disconnect: () => Promise<void>; isConnected: () => boolean }>,
    context?: Pick<BrowserContext, "close">
  ): void {
    shared = {
      kind: "cdp",
      browser: browser as Browser,
      context: (context ?? ({ close: () => Promise.resolve() } as unknown as BrowserContext)) as BrowserContext
    };
  },
  uninstallFakeBrowserForTest(): { kind: SharedHandle["kind"] | null } {
    const captured = { kind: shared?.kind ?? null };
    shared = null;
    return captured;
  },
  // Synchronously poke inFlight on a synthetic session so the drain
  // test can verify disconnect waits without spinning up Playwright.
  installFakeSessionForTest(taskId: string, inFlight: number): void {
    sessions.set(taskId, {
      context: {} as BrowserContext,
      page: { close: () => Promise.resolve() } as unknown as Page,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight,
      ownsContext: false
    });
  },
  setFakeSessionInFlight(taskId: string, inFlight: number): void {
    const session = sessions.get(taskId);
    if (session) session.inFlight = inFlight;
  },
  clearFakeSessionsForTest(): void {
    sessions.clear();
  }
};
