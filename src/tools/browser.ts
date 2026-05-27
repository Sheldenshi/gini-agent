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
// actions (click/type/drag/select_option/tabs:new/tabs:switch/tabs:close)
// skip the approval gate; the snapshot itself is the trace evidence.
// browser_upload_file is the lone exception — it's approval-gated (high
// risk) because it can exfiltrate workspace files to a remote site.
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { instanceRoot } from "../paths";
import { generateVisionAnalysis } from "../provider";
import { assertInsideWorkspace, readState } from "../state";
import { sanitizeUrlForAuditTarget } from "../execution/browser-fill-secrets-types";
import type { BrowserConnectionRecord, Instance, RuntimeConfig } from "../types";

// Per-instance Chrome profile directory. The agent persists ALL sign-ins
// and cookies here; the directory survives Connect/Disconnect cycles and
// runtime restarts. Removing it requires deleting the directory manually.
export function chromeProfileDirFor(instance: Instance): string {
  return join(instanceRoot(instance), "chrome-profile");
}

// Synchronously read the current URL of the task's browser session, if any.
// Used by approval flows (e.g. browser.upload_file) so the approval card
// can surface the upload destination to the user without forcing a
// withSession round-trip. Returns undefined when no session exists yet —
// the agent may request upload before navigating, in which case there's
// simply no destination URL to display.
export function peekCurrentBrowserUrl(taskId: string): string | undefined {
  const session = sessions.get(taskId);
  if (!session) return undefined;
  try {
    return session.page.url();
  } catch {
    return undefined;
  }
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
  // Tabs the agent itself opened during this task. Used by closeSession to
  // drain agent-opened tabs at task end without touching tabs the user
  // opened or another task owns. Populated by getOrCreate ONLY when it
  // actually created a fresh page (a reused pre-existing page is a user
  // page and stays out of the set) and by browser_tabs action:"new".
  // Pages closed via browser_tabs action:"close" are removed.
  ownedPageIds: Set<Page>;
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
// Per-task registry of literal secret values that browserFillByLocator
// has typed into the page. Populated BEFORE the .fill() call so a
// page that synchronously clears or copies the input on the `input`
// event still has its typed bytes recorded — without this, a page
// that clears its own input post-fill would leave the
// data-gini-secret-stamped element empty and the live-DOM-only
// collector at collectSecretValuesFromPageWithSession would return
// nothing for that task, defeating redaction in subsequent
// browser_console / browser_snapshot / browser_vision calls. Read
// alongside the live-DOM collector to catch BOTH (a) values typed
// via fill_secret that the page has since cleared/moved, and
// (b) values the page itself populated into data-gini-secret-stamped
// elements (e.g. server-side prefilled credentials revealed via
// hover). The registry is per-task so closing a session
// (closeSession or sweep) deletes the entry, bounding memory.
const filledSecretValues = new Map<string, Set<string>>();
// Minimum length below which a typed value is NOT registered as a
// redaction target. A single-character secret would otherwise
// turn every literal occurrence of that character into
// "[redacted]" — including digits inside snapshot ref tokens
// like `[@e1]`, which would shred the snapshot and break the
// agent's locator references. Multi-character secrets are
// vanishingly unlikely to collide with structural snapshot
// tokens. Real credentials are always ≥ this length in
// practice (PINs are typically 4+, OTPs 6+, passwords 8+).
export const FILLED_SECRET_MIN_REDACTION_LENGTH = 4;
// Record a secret value typed for a task. Called by
// browserFillByLocator immediately before .fill() runs. Empty
// strings and short strings are not recorded so the redactor's
// substring match stays safe against structural tokens.
function recordFilledSecret(taskId: string, value: string): void {
  if (typeof value !== "string" || value.length < FILLED_SECRET_MIN_REDACTION_LENGTH) return;
  let set = filledSecretValues.get(taskId);
  if (!set) {
    set = new Set<string>();
    filledSecretValues.set(taskId, set);
  }
  set.add(value);
}
// Drop the per-task registry when the task's session closes (idle
// sweep, explicit close, or browser disconnect). Memory-bound
// cleanup — the union-across-tasks redaction (see
// allRegisteredSecrets below) keeps secrets visible to other
// active tasks until each task's own session terminates.
function clearFilledSecrets(taskId: string): void {
  filledSecretValues.delete(taskId);
}
// Union of every known secret across every active task's registry.
// The shared-BrowserContext architecture (persistent / CDP profile
// is shared across tasks per src/tools/browser.ts:495-502) means
// Task A can type a credential, the page can JS-copy it into
// document.title, and Task B can read that title via its own
// snapshot/navigate response. Task B's per-task registry is empty,
// but Task A's is non-empty until Task A's session closes — so
// reading the union catches cross-task leaks via shared DOM state.
// Returns [] when no task has any registered secrets so the
// redactor's empty-set fast path stays cheap in the common case.
function allRegisteredSecrets(): string[] {
  if (filledSecretValues.size === 0) return [];
  const out = new Set<string>();
  for (const set of filledSecretValues.values()) {
    for (const v of set) out.add(v);
  }
  return Array.from(out);
}
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
    // Surface a friendlier error than the bare Node module-resolution
    // string when playwright-core isn't installed. Matches the
    // defensive wrapper in src/capabilities/browser-connect.ts so
    // both code paths emit the same install hint.
    chromiumImport = import("playwright-core").then(
      (mod) => mod.chromium,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const isMissing =
          (error as { code?: string } | undefined)?.code === "MODULE_NOT_FOUND" ||
          (error as { code?: string } | undefined)?.code === "ERR_MODULE_NOT_FOUND" ||
          message.includes("Cannot find package 'playwright-core'") ||
          message.includes("Cannot find module 'playwright-core'");
        if (isMissing) {
          throw new Error(
            "Browser runtime is missing. Run `bun install` in the gini-agent checkout, then restart the runtime."
          );
        }
        throw error;
      }
    );
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

// Exposed so callers like browserVision can capture the current disconnect
// generation before doing slow work (provider fetch) and re-check after,
// bailing if the browser was torn down underneath them. Same value the
// internal admission gate compares against.
export function currentDisconnectGeneration(): number {
  return disconnectGeneration;
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
    // Only mark the page as agent-owned when we just created it. A reused
    // pre-existing page (CDP-attached user tab, managed-mode profile's
    // initial tab) belongs to the user — closing it on session teardown
    // would kill the user's window/tab.
    const ownedPageIds = new Set<Page>();
    if (!reusable) ownedPageIds.add(page);
    const session: Session = {
      context,
      page,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds
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
  // Drop the per-task secret-redaction registry when the session
  // closes. The DOM is gone (the page closes below), so the
  // registry would never be consulted again for this task —
  // keeping it would just leak memory across many tasks.
  clearFilledSecrets(taskId);
  try {
    // Shared context (persistent/cdp): close every page the agent opened
    // during this task. The user's window, tabs the user opened
    // themselves, and the agent's persistent profile stay alive — the
    // ownedPageIds set tracks ONLY agent-opened tabs (initial page from
    // getOrCreate plus any browser_tabs action:"new"), so user tabs are
    // never in this set. The next task lands in the same profile.
    for (const page of session.ownedPageIds) {
      await page.close().catch(() => undefined);
    }
    session.ownedPageIds.clear();
  } catch {
    // Already closed or browser disconnected; nothing useful to do.
  }
  // We deliberately do NOT tear down the shared handle when sessions hit
  // zero. The persistent context is cheap to keep alive idle (Chromium
  // sleeps when no pages are active) and re-launching it on the next
  // tool call would be more disruptive than the idle process is.
  // Explicit Connect/Disconnect is the only path that tears down the
  // shared handle.
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
      // Clear the per-task secret-redaction registry along with
      // the session — the DOM is going away. Without this, the
      // registry would leak across many disconnects, bounded only
      // by process exit.
      clearFilledSecrets(id);
      if (!session) continue;
      try {
        // Persistent and cdp both share a single context — close just the
        // pages we own. teardownHandle below closes the whole context for
        // persistent mode (so agent-opened pages would go away anyway), but
        // in CDP mode the user's browser process stays alive, so any
        // agent-opened tabs we don't close here would survive disconnect
        // as orphan tabs in the user's window.
        for (const page of session.ownedPageIds) {
          await page.close().catch(() => undefined);
        }
        session.ownedPageIds.clear();
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
// duration. Used by browser-connect's launchManaged to guarantee that no
// new agent tool call can land between the disconnect-then-launch steps
// in its critical section.
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
    // Match closeSession / disconnectSharedBrowser: drop the
    // per-task secret-redaction registry alongside the session.
    clearFilledSecrets(id);
    if (!session) continue;
    try {
      // Close every agent-owned page. In CDP mode this is the only thing
      // that reaps agent-opened tabs (the user's browser stays alive).
      // In persistent mode teardownHandle closes the whole context next,
      // so this is harmless redundancy.
      for (const page of session.ownedPageIds) {
        await page.close().catch(() => undefined);
      }
      session.ownedPageIds.clear();
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
  hidden: boolean; // true when the element exists but isn't visible
}

// Cap on the number of invisible-but-locatable interactive elements we
// emit per snapshot. A page with thousands of hidden nodes (e.g. a
// virtualized list with prerendered rows) would otherwise blow up the
// snapshot. Visible entries are budgeted separately via SNAPSHOT_CHAR_BUDGET.
const SNAPSHOT_HIDDEN_BUDGET = 50;

interface SnapshotResult {
  text: string;
  refs: Map<string, Locator>;
  elementCount: number;
  truncated: boolean;
}

// Marker attribute stamped on snapshot-rendered elements so the
// "@<id>" ref tokens the LLM sees in a snapshot can be translated
// back into playwright locators by callers outside snapshot() —
// principally browserFillByLocator below.
const REF_ATTR_GLOBAL = "data-gini-ref";

// Walk the page in the browser and return a flat list of "interesting"
// nodes plus a unique CSS-attribute ref we can use to resolve a Locator
// later. Built in a single page.evaluate so we minimize round-trips and
// reuse one DOM walk for both the snapshot text and the locator map.
async function snapshot(page: Page, full: boolean, taskId?: string): Promise<SnapshotResult> {
  const REF_ATTR = REF_ATTR_GLOBAL;
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
    hidden: boolean;
  };

  const raw = await page.evaluate(
    ({ attr, fullMode, hiddenBudget }: { attr: string; fullMode: boolean; hiddenBudget: number }) => {
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
        number: "spinbutton",
        // `file` is a first-class role so the model can distinguish a
        // file-picker input from a normal textbox — most upload widgets
        // hide the underlying <input type="file"> behind a styled button,
        // and the agent needs to be able to target the input by ref.
        file: "file"
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
        // For elements stamped with data-gini-secret (contenteditable
        // fields filled via fill_secret), the textContent holds the
        // typed value — same risk as <input>.value would carry. Mask
        // the name with "[redacted]" so the snapshot doesn't leak the
        // typed bytes via the entry's name field.
        if (el.getAttribute("data-gini-secret") !== null) {
          const raw = (el.textContent ?? "").trim();
          return raw.length > 0 ? "[redacted]" : "";
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
      let hiddenEmitted = 0;
      let hiddenTotal = 0;
      const isFileInput = (el: Element): boolean =>
        el.tagName === "INPUT" && ((el as HTMLInputElement).type?.toLowerCase() ?? "text") === "file";
      const walk = (el: Element, depth: number): void => {
        const tag = el.tagName;
        const role = roleOf(el);
        const interactive = role !== undefined && (INTERACTIVE_TAGS.has(tag) || el.getAttribute("role"));
        const visible = isVisible(el);
        // <input type="file"> always gets a ref — most real upload widgets
        // hide the actual input behind a styled button, and without a ref
        // browser_upload_file can't target it. Counted in the visible
        // budget regardless of visibility; the `[hidden]` annotation tells
        // the model the input isn't directly clickable.
        const forceEmit = interactive && isFileInput(el);
        if (interactive && (visible || forceEmit)) {
          const ref = `@e${nextId++}`;
          el.setAttribute(attr, ref.slice(1));
          let value = "";
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            // Suppress sensitive input values so a user-typed
            // credential filled via browser.fill_secret does not
            // round-trip back into the LLM through the next
            // browser_snapshot. Trigger conditions:
            //   - type="password" (matches what the rendered
            //     browser visually masks)
            //   - autocomplete hints that the field is a credential
            //     or one-time code (covers cases where the page uses
            //     a custom text input + JS reveal)
            //   - data-gini-secret attribute stamped by
            //     browserFillByLocator after a successful fill, so a
            //     filled field stays masked even if the page swaps
            //     out the type (some SPAs flip type=text after fill
            //     to show the value visually)
            const input = el as HTMLInputElement;
            const inputType = (input.type || "").toLowerCase();
            const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
            // `getAttribute(...) !== null` works on both real DOM Element
            // and any minimal stub that implements only getAttribute (the
            // unit test fakes in browser.test.ts don't have hasAttribute).
            const isSecretField = inputType === "password"
              || autocomplete === "current-password"
              || autocomplete === "new-password"
              || autocomplete === "one-time-code"
              || input.getAttribute("data-gini-secret") !== null;
            const rawValue = input.value ?? "";
            value = isSecretField
              ? (rawValue.length > 0 ? "[redacted]" : "")
              : rawValue;
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
            full: false,
            hidden: !visible
          });
          // For <select>, surface its <option> children as sibling rows at
          // depth+1 so the agent can address each option by its own @eN
          // ref (browser_click / browser_select_option). The bare walker
          // skips <option> elements because they have a zero-size bounding
          // rect in the native renderer; we explicitly enumerate via
          // querySelectorAll so options nested inside <optgroup> are
          // captured too.
          if (tag === "SELECT" && visible) {
            const options = (el as HTMLSelectElement).querySelectorAll("option");
            for (const opt of Array.from(options)) {
              if (opt.disabled || opt.hidden) continue;
              const optRef = `@e${nextId++}`;
              opt.setAttribute(attr, optRef.slice(1));
              const labelOrText = (opt.label || opt.text || "").trim().slice(0, 120);
              out.push({
                ref: optRef,
                role: "option",
                name: labelOrText,
                value: opt.value,
                url: "",
                depth: depth + 1,
                full: false,
                hidden: false
              });
            }
          }
        } else if (interactive && !visible) {
          // Invisible interactive element — give it a ref so wait_for can
          // target it (state:"hidden"/"attached"/"detached"), but suppress
          // name/value/url annotations (they're usually empty or stale
          // and just add noise). Capped separately so a virtualized list
          // with thousands of prerendered rows doesn't blow up the snapshot.
          hiddenTotal++;
          if (hiddenEmitted < hiddenBudget) {
            const ref = `@e${nextId++}`;
            el.setAttribute(attr, ref.slice(1));
            out.push({
              ref,
              role: role!,
              name: "",
              value: "",
              url: "",
              depth,
              full: false,
              hidden: true
            });
            hiddenEmitted++;
          }
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
              out.push({ ref: "", role: fallbackRole, name: text, value: "", url: "", depth, full: true, hidden: false });
            }
          }
        }
        for (const child of Array.from(el.children)) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return { entries: out, hiddenEmitted, hiddenTotal, hiddenBudget };
    },
    { attr: REF_ATTR, fullMode: full, hiddenBudget: SNAPSHOT_HIDDEN_BUDGET }
  );

  const refs = new Map<string, Locator>();
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;
  let elementCount = 0;
  const entries = (raw as { entries: SnapEntry[] }).entries;
  const hiddenEmitted = (raw as { hiddenEmitted: number }).hiddenEmitted;
  const hiddenTotal = (raw as { hiddenTotal: number }).hiddenTotal;
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    let line: string;
    if (entry.ref) {
      line = `${indent}[${entry.ref}] ${entry.role}`;
      if (entry.hidden) {
        // Hidden entries get role + [hidden] only — no name/value/url
        // annotations, since they're typically empty or stale on
        // not-yet-shown / off-screen widgets and just add noise.
        line += " [hidden]";
      } else {
        if (entry.name) line += ` "${entry.name}"`;
        if (entry.value) line += ` value="${entry.value}"`;
        if (entry.role === "link" && entry.url) line += ` url="${entry.url}"`;
      }
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
  // Separate marker for hidden-budget truncation so the model can tell
  // "more interactive elements exist on the page, just hidden" apart
  // from "snapshot text was clipped at the char budget".
  if (hiddenTotal > hiddenEmitted) text += "\n[...hidden truncated]";
  // Defense in depth: redact any literal occurrence of a known
  // data-gini-secret value from the assembled snapshot text. The
  // walker's element-local redaction only catches the stamped
  // element itself — a page that JS-copies the typed value into
  // another DOM node (a "you typed: ..." preview, password-strength
  // widget echo, password-match indicator, hidden mirror input)
  // would otherwise emit the copy verbatim through the unmarked
  // element's name / textContent. Post-processing the assembled
  // snapshot text against the live secret list closes this gap
  // with the same primitive browserConsole and browserVision use.
  const secretValues = await collectSecretValuesFromPageWithSession(page, taskId);
  if (secretValues.length > 0) {
    text = redactSecretValuesFromString(text, secretValues);
  }
  return { text, refs, elementCount, truncated };
}

// Build a browser tool response, applying a redaction pass over
// EVERY string leaf when the per-task secret registry has any
// recorded values. The snapshot text is already redacted inside
// snapshot(), and browserConsole/browserVision redact their
// eval/answer fields explicitly — but every browser tool response
// also includes raw `url: page.url()`, `title: await page.title()`,
// and (for browser_tabs) tab arrays with both. A page can write
// the typed credential into document.title (via an input handler)
// or push it into the URL state (via history.pushState / hash),
// and those metadata fields would otherwise leak through. Walking
// the entire payload through redactSecretValuesDeep catches every
// string leaf — url, title, tab.url, tab.title, plus anything
// future tool responses surface.
//
// taskId is accepted for API symmetry but the redaction consults
// allRegisteredSecrets() across every active task's registry, not
// just this task's. The shared BrowserContext (CDP / persistent
// profile) bleeds DOM state across tasks — Task A's page can copy
// a typed credential into document.title, then Task B reads that
// title via its own snapshot/navigate response. A purely
// per-task lookup would miss this because Task B's registry is
// empty. The union catches cross-task leaks at the cost of
// over-redacting in edge cases where two tasks coincidentally
// typed the same long string (vanishingly unlikely given the
// 4-char minimum).
function ok(payload: Record<string, unknown>, _taskId?: string): string {
  void _taskId;
  const secrets = allRegisteredSecrets();
  if (secrets.length === 0) {
    return JSON.stringify({ success: true, ...payload });
  }
  const redacted = redactSecretValuesDeep({ success: true, ...payload }, secrets);
  return JSON.stringify(redacted);
}

function fail(error: string): string {
  // Mirror ok()'s redaction so an error message that contains a
  // registered secret value (playwright's "Call log: fill(...)"
  // verbiage, or any error whose text was built from page state
  // like a contenteditable's textContent) doesn't leak the secret
  // into the tool result that flows back to the LLM. All browser
  // tools' top-level catch-handlers return `fail(error.message)`,
  // so this one place covers every browser tool's failure path
  // — the bounded fill module's pre-redaction is now defense in
  // depth, not the sole guard.
  const secrets = allRegisteredSecrets();
  const sanitized = secrets.length > 0
    ? redactSecretValuesFromString(error, secrets)
    : error;
  return JSON.stringify({ success: false, error: sanitized });
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
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserSnapshot(taskId: string, args: Record<string, unknown>): Promise<string> {
  const full = bool(args.full, false);
  try {
    return await withSession(taskId, async (session) => {
      const snap = await snapshot(session.page, full, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
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
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
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
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Collects the values of every element on the live page that
// carries the data-gini-secret attribute (stamped by
// browserFillByLocator after a successful fill_secret submission)
// AND merges in the per-task secret registry populated BEFORE the
// fill. The registry catches values the page has since cleared,
// detached, or copied to an unstamped element on the input handler
// — without it, those bytes would not appear in the live DOM under
// any stamped element and the redactor would let them through.
//
// Used by browser_console, browser_vision, and the snapshot walker
// to redact literal occurrences of typed credentials from any
// tool result that flows back to the LLM. Callers pass their
// already-acquired playwright Page so the collection inherits the
// surrounding withSession lock and the secret-list snapshot lives
// in closure scope BEFORE the agent-controlled side effect runs
// (eval, screenshot, walk) — so an agent-supplied expression that
// navigates the page can't empty the secret list mid-call.
//
// taskId is optional so the existing browser-tool call sites can
// be incrementally migrated; when omitted, only the live-DOM
// collection runs (legacy behavior).
async function collectSecretValuesFromPageWithSession(page: import("playwright-core").Page, taskId?: string): Promise<string[]> {
  let liveValues: string[] = [];
  try {
    liveValues = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("[data-gini-secret]"));
      const values: string[] = [];
      for (const el of nodes) {
        // <input>/<textarea>/<select> elements expose the typed
        // bytes via the .value property. Non-input fill targets
        // (e.g. [contenteditable] <div> elements — playwright's
        // .fill() supports these) hold the typed bytes in
        // textContent instead. Collect BOTH so the redactor knows
        // every literal secret occurrence regardless of which
        // surface the fill landed on.
        const value = (el as HTMLInputElement).value;
        if (typeof value === "string" && value.length > 0) values.push(value);
        const text = el.textContent;
        if (typeof text === "string" && text.length > 0) values.push(text);
      }
      return values;
    });
  } catch {
    liveValues = [];
  }
  // Merge in EVERY active task's registry (not just this task's).
  // Shared BrowserContext means another task's typed credential
  // could be visible on this page's title / DOM / URL even though
  // this task never typed it. taskId is accepted for API
  // symmetry; the union read makes it advisory.
  void taskId;
  const registered = allRegisteredSecrets();
  if (registered.length > 0) {
    const out: string[] = [...liveValues];
    for (const v of registered) {
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }
  return liveValues;
}

// Replace every occurrence of any secret value in `text` with
// "[redacted]". Sorts secrets by length descending so longer
// secrets are replaced before shorter prefixes (avoids leaking a
// suffix when one secret contains another). Empty / zero-length
// secrets are skipped to prevent global replacement runaway.
export function redactSecretValuesFromString(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length === 0) continue;
    // String.replaceAll is preferred over global-regex because the
    // secret may contain regex metacharacters that would otherwise
    // need escaping.
    out = out.split(s).join("[redacted]");
  }
  return out;
}

// Deep-walk any JSON-serializable value and redact secret bytes
// from every string leaf, including string-typed values inside
// arrays and objects. Used by browser_console where the agent's
// eval expression can wrap a secret in a container
// (`[input.value]`, `{v: input.value}`) to escape a string-only
// redactor. Primitives that aren't strings are passed through;
// circular structures are guarded so a `{ self: self }` reference
// cycle doesn't infinite-loop.
export function redactSecretValuesDeep(value: unknown, secrets: readonly string[], seen: WeakSet<object> = new WeakSet()): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactSecretValuesFromString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretValuesDeep(item, secrets, seen));
  }
  // Redact both KEYS and values. An agent can use a computed key
  // to smuggle the secret bytes out via JSON serialization
  // (`{[input.value]: 1}` → `{"hunter2": 1}`). When two keys
  // collapse to the same redacted form, append a numeric suffix
  // so the second hit doesn't silently overwrite the first.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const redactedKey = redactSecretValuesFromString(k, secrets);
    let finalKey = redactedKey;
    if (finalKey !== k && Object.prototype.hasOwnProperty.call(out, finalKey)) {
      let i = 2;
      while (Object.prototype.hasOwnProperty.call(out, `${redactedKey}_${i}`)) i++;
      finalKey = `${redactedKey}_${i}`;
    }
    out[finalKey] = redactSecretValuesDeep(v, secrets, seen);
  }
  return out;
}

// browser.fill_secret slot writer. Takes a raw playwright selector
// (CSS, text=, role=, or an ARIA snapshot ref token like "@e2"
// which resolveLocator translates to [data-gini-ref="e2"]) plus the
// value to type. Used exclusively by the POST /api/approvals/<id>/connect
// browser.fill_secret branch; never called via the tool catalog.
// Skips the post-fill snapshot that browser_type takes because the
// agent will re-snapshot on its own when it resumes — and because
// the fill might be one of several in the same submit batch, so
// taking a snapshot per slot is wasted work.
// Result discriminator for browserFillByLocator. Callers branch
// on `code` rather than parsing a magic-string prefix from
// `error` — see src/execution/browser-fill-secrets.ts which uses
// code === "origin-mismatch" to halt the per-slot loop without
// typing remaining secrets into a drifted origin. Future error
// classes (e.g. timeout, detached, frame-detached) can be added
// here without touching the consumer's branching logic.
export type BrowserFillByLocatorResult =
  | { ok: true }
  | { ok: false; code: "origin-mismatch"; error: string }
  | { ok: false; code: "validation-error"; error: string }
  | { ok: false; code: "fill-error"; error: string };

export async function browserFillByLocator(
  taskId: string,
  args: { locator: string; value: string; expectedUrl?: string }
): Promise<BrowserFillByLocatorResult> {
  if (typeof args.locator !== "string" || args.locator.length === 0) {
    return { ok: false, code: "validation-error", error: "Missing required string argument: locator" };
  }
  if (typeof args.value !== "string") {
    return { ok: false, code: "validation-error", error: "Missing required string argument: value" };
  }
  // Capture the live secret list into closure scope BEFORE the
  // session work runs. disconnectSharedBrowser has a bounded
  // DISCONNECT_DRAIN_DEADLINE_MS (5s) but locator.fill has a
  // 10s timeout — so a disconnect that fires mid-fill can run
  // clearFilledSecrets and empty the global registry BEFORE the
  // fill catch runs. A purely-global-read in the catch would
  // then redact against an empty set and leak the typed value
  // via the Playwright "Call log: fill(...)" verbiage. The
  // local snapshot survives teardown; we include the about-to-
  // be-recorded value in case recordFilledSecret hasn't run
  // yet (or skipped the value for being below the redaction
  // floor — registering it locally for THIS error path is safe
  // because the local list never escapes this function).
  const secretsForCatch: string[] = [...allRegisteredSecrets()];
  if (typeof args.value === "string" && args.value.length > 0 && !secretsForCatch.includes(args.value)) {
    secretsForCatch.push(args.value);
  }
  try {
    return await withSession(taskId, async (session) => {
      // Per-slot URL re-check immediately before the playwright
      // .fill() call. The /connect handler's pre-loop URL check is
      // TOCTOU on its own: a navigation between the pre-loop check
      // and any subsequent slot's .fill() would land the secret on
      // a new origin. Re-reading session.page.url() inside the
      // same withSession callback closes the window to the depth
      // of one playwright API call. Callers that don't supply
      // expectedUrl skip the check (existing browser tool callers
      // that don't need the binding).
      //
      // expectedUrl is the page origin (protocol+host+port), the
      // same shape the producer-side approvedUrl on the approval
      // payload carries (both flow through sanitizeUrlForAuditTarget,
      // which strips pathname/query/fragment because reset and
      // magic-link URLs can carry tokens in the path).
      if (args.expectedUrl) {
        const liveUrl = sanitizeUrlForAuditTarget(session.page.url());
        if (liveUrl !== args.expectedUrl) {
          return {
            ok: false,
            code: "origin-mismatch",
            error: `origin-mismatch: live=${liveUrl ?? "invalid"} expected=${args.expectedUrl}`
          } as const;
        }
      }
      const selector = args.locator.startsWith("@")
        ? `[${REF_ATTR_GLOBAL}="${args.locator.slice(1)}"]`
        : args.locator;
      const locator = session.page.locator(selector);
      // Record the value in the per-task secret registry BEFORE the
      // fill so a page that synchronously clears the input on its
      // `input` handler still has the typed bytes available to the
      // redactor. Recording is best-effort; even if the .fill
      // below throws (origin mismatch, timeout), the registry
      // entry is fine to keep — the value was about to land in
      // the DOM and any later snapshot that captured it pre-throw
      // still needs redaction.
      recordFilledSecret(taskId, args.value);
      await locator.fill(args.value, { timeout: 10_000 });
      // Stamp the element with data-gini-secret so subsequent
      // browser_snapshot calls redact its value (see snapshot
      // walker's secret-field branch). type="password" already
      // triggers redaction on its own; this covers fields the page
      // may flip from password→text post-fill (some SPAs do this
      // to show the value in their own custom UI) and generic
      // credential fields that aren't explicitly password type but
      // were filled via fill_secret.
      //
      // CRITICAL: the stamping MUST NOT fail the fill outcome. The
      // .fill() at the line above already wrote the secret to the
      // DOM; if we let a stamp-evaluate throw (element detached,
      // page navigated, frame-detached, serialization error) bubble
      // out to the outer catch, the caller would record this slot
      // as errored AND the value would be in the DOM unstamped —
      // subsequent snapshots wouldn't redact it. Wrap the entire
      // Node-side evaluate await in its own try/catch so the fill
      // outcome reflects the actual DOM write, not the stamp's
      // success. A stamp failure is a recoverable defense-in-depth
      // miss; if it happens, the snapshot walker's other heuristics
      // (type=password, autocomplete=current-password) still cover
      // the common cases.
      try {
        await locator.evaluate((el) => {
          try {
            (el as Element).setAttribute("data-gini-secret", "true");
          } catch {
            /* attribute set best-effort */
          }
        });
      } catch {
        /* stamp evaluate threw on the Node side (detached element,
           navigation, serialization) — keep the fill outcome and
           rely on the snapshot walker's other redaction signals.
           A defensive trace is emitted by the bounded fill module
           via the per-slot result if subsequent calls observe
           unstamped values. */
      }
      return { ok: true } as const;
    });
  } catch (error) {
    // CRITICAL: Playwright's locator.fill embeds the typed value
    // into its timeout-error message via "Call log: fill(\"<value>\")"
    // (see coreBundle.js fill instrumentation). If the fill times
    // out (disabled input, slow SPA hydration, contenteditable
    // mismatch), the raw error.message contains the secret in
    // plaintext. Returning it verbatim would route the value
    // through:
    //   - browser-fill-secrets.ts: errors[].error → appendTrace
    //     data (NOT redacted:true → persisted to per-task JSONL)
    //   - browser-fill-secrets.ts: resumeChatTask resumeResult
    //     → tool_result block → LLM context
    // Redact every literal occurrence of any registered secret
    // for this task before returning. The registry was populated
    // pre-fill, so even a clear-on-input page hostile script
    // can't unregister the value.
    const raw = error instanceof Error ? error.message : String(error);
    // Redact against the locally-captured secret list (snapshotted
    // BEFORE the fill, so it survives disconnect's bounded drain
    // deadline). Falling back to the live global registry would
    // miss the typed value if disconnectSharedBrowser fired and
    // cleared the registry mid-fill — see the secretsForCatch
    // capture above. The local list also defends against
    // recordFilledSecret skipping short values (the floor would
    // bar the registry entry but the local capture still gets
    // redacted for this error path only).
    void taskId;
    const sanitized = redactSecretValuesFromString(raw, secretsForCatch);
    return { ok: false, code: "fill-error", error: sanitized };
  }
}

export async function browserPress(taskId: string, args: Record<string, unknown>): Promise<string> {
  const key = str(args.key);
  if (!key) return fail("Missing required string argument: key");
  try {
    return await withSession(taskId, async (session) => {
      await session.page.keyboard.press(key);
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
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
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserBack(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    return await withSession(taskId, async (session) => {
      const response = await session.page.goBack({ waitUntil: "domcontentloaded" });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
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
      // Collect data-gini-secret values BEFORE the eval. If we
      // collected after, an agent-supplied expression that itself
      // navigates (`location.href='...'; document.querySelector('input').value`)
      // or clears the form would empty the secret list — leaving
      // the captured evalResult (which read the value pre-navigation)
      // unredacted on the way back to the LLM. Pre-collection
      // snapshots the secret list into closure scope so the
      // redactor's input is stable regardless of subsequent page
      // state.
      const secretValues = await collectSecretValuesFromPageWithSession(session.page, taskId);
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
      // Redact data-gini-secret values from anywhere they could
      // surface to the LLM. The snapshot walker's redaction handles
      // the structured snapshot path; this catches the eval /
      // console-log paths. Deep-redact non-string evalResult values
      // — the agent can wrap a secret in a container like
      // `[input.value]` or `{v: input.value}` to escape a string-only
      // redactor, but redactSecretValuesDeep walks every string leaf
      // inside arrays and objects.
      const redactedMessages = messages.map((m) => ({
        ...m,
        text: redactSecretValuesFromString(m.text, secretValues)
      }));
      const redactedEvalResult = evalResult === undefined
        ? null
        : redactSecretValuesDeep(evalResult, secretValues);
      return ok({
        url: session.page.url(),
        messages: redactedMessages,
        evalResult: redactedEvalResult,
        evalError: evalError ? redactSecretValuesFromString(evalError, secretValues) : null
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Hover over an element identified by its @eN ref from the last snapshot.
// Hovering can reveal tooltips or trigger CSS :hover-only menus the agent
// needs to interact with next; we re-snapshot afterwards so any newly
// visible interactive elements get fresh @eN refs.
export async function browserHover(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  try {
    return await withSession(taskId, async (session) => {
      const locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await locator.hover({ timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Drag one element onto another by their @eN refs. Useful for kanban-style
// reorderings and drag-to-upload zones; we wait for any post-drop navigation
// or DOM settle via waitForLoadState before re-snapshotting.
export async function browserDrag(taskId: string, args: Record<string, unknown>): Promise<string> {
  const fromRef = str(args.fromRef);
  const toRef = str(args.toRef);
  if (!fromRef) return fail("Missing required string argument: fromRef");
  if (!toRef) return fail("Missing required string argument: toRef");
  try {
    return await withSession(taskId, async (session) => {
      const fromLoc = session.refs.get(fromRef);
      if (!fromLoc) return fail(`Unknown ref ${fromRef}. Take a fresh snapshot first.`);
      const toLoc = session.refs.get(toRef);
      if (!toLoc) return fail(`Unknown ref ${toRef}. Take a fresh snapshot first.`);
      await fromLoc.dragTo(toLoc, { timeout: 10_000 });
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Select option(s) on a <select> by ref. Callers can address either:
//
//   1. The <select> directly + value/values — Playwright's normal contract.
//   2. A specific <option> ref alone — we walk up to the containing
//      <select> and use the option's `value` attribute. The snapshot
//      walker surfaces both the select and its options as @eN refs, so
//      the model often picks an option ref naturally; rather than fight
//      the model into picking the select, we accept either shape.
//
// If both an option ref AND a value/values are supplied, the explicit
// value wins (callers may override the option's default value attribute).
export async function browserSelectOption(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  const value = typeof args.value === "string" ? args.value : undefined;
  const valuesRaw = args.values;
  const hasValues = valuesRaw !== undefined;
  let values: string[] | undefined;
  if (hasValues) {
    if (!Array.isArray(valuesRaw) || !valuesRaw.every((v): v is string => typeof v === "string")) {
      return fail("Argument 'values' must be an array of strings.");
    }
    values = valuesRaw;
  }
  if (value !== undefined && hasValues) {
    return fail("Provide either 'value' or 'values', not both.");
  }
  try {
    return await withSession(taskId, async (session) => {
      let locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);

      // Detect whether the resolved element is an <option>. If so, walk
      // up to the containing <select> and (when no explicit value/values
      // was supplied) infer the value from the option's `value` attribute.
      // Errors evaluating tagName fall back to "treat as select" — that
      // keeps existing select-ref callers working under any future
      // walker change that surfaces non-OPTION refs.
      let inferredValue: string | undefined;
      try {
        const meta = await locator.evaluate((el: Element) => ({
          tagName: el.tagName,
          value: el.getAttribute("value") ?? (el as HTMLOptionElement).value ?? ""
        }));
        if (meta.tagName === "OPTION") {
          inferredValue = typeof meta.value === "string" ? meta.value : undefined;
          // Walk up to the parent <select>; .selectOption only works on
          // <select>, not on individual <option> nodes.
          locator = locator.locator("xpath=ancestor::select[1]");
        }
      } catch {
        // If evaluate fails (no such element, page navigated away mid-
        // call, etc.) we fall through to the original selectOption call,
        // which will surface its own structured error to the caller.
      }

      // Selection priority: explicit value > explicit values[] > inferred
      // value from option ref. If none of those are available, fail with
      // the standard message.
      let selection: string | string[];
      if (value !== undefined) {
        selection = value;
      } else if (values !== undefined) {
        selection = values;
      } else if (inferredValue !== undefined) {
        selection = inferredValue;
      } else {
        return fail("Missing required argument: provide either 'value' (string) or 'values' (string[]).");
      }
      await locator.selectOption(selection, { timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated,
        selected: selection
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Wait for either a known element to reach a particular state, or for a
// substring of text to appear anywhere in document.body.innerText. Either
// `ref` or `text` must be supplied (exclusively). After the wait completes
// we re-snapshot so any newly visible interactive elements pick up fresh
// `@eN` refs. Timeouts surface as a structured `Wait timed out...` error
// rather than the raw Playwright stack.
export async function browserWaitFor(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  const text = str(args.text);
  if (ref && text) return fail("Provide either 'ref' or 'text', not both.");
  if (!ref && !text) return fail("Missing required argument: provide either 'ref' or 'text'.");
  const stateArg = args.state;
  const allowedStates = new Set(["visible", "hidden", "attached", "detached"]);
  let waitState: "visible" | "hidden" | "attached" | "detached" = "visible";
  if (stateArg !== undefined) {
    if (typeof stateArg !== "string" || !allowedStates.has(stateArg)) {
      return fail("Argument 'state' must be one of: visible, hidden, attached, detached.");
    }
    waitState = stateArg as typeof waitState;
  }
  let timeoutMs = 10_000;
  if (args.timeoutMs !== undefined) {
    if (typeof args.timeoutMs !== "number" || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      return fail("Argument 'timeoutMs' must be a positive number.");
    }
    // Hard upper bound: 60s. Any larger value gets silently clamped so an
    // agent can't wedge a tool call for minutes on a stuck condition. The
    // catalog entry documents the cap.
    timeoutMs = Math.min(args.timeoutMs, 60_000);
  }
  try {
    return await withSession(taskId, async (session) => {
      try {
        if (ref) {
          const locator = session.refs.get(ref);
          if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
          await locator.waitFor({ state: waitState, timeout: timeoutMs });
        } else {
          // text-mode: poll the page for the substring. Playwright's
          // waitForFunction handles the timing for us; we pass the needle in
          // as an argument so it crosses the page boundary as a string.
          await session.page.waitForFunction(
            (needle: string) => document.body?.innerText?.includes(needle) ?? false,
            text!,
            { timeout: timeoutMs }
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout|exceeded/i.test(message)) {
          return fail(`Wait timed out after ${timeoutMs}ms: ${message}`);
        }
        return fail(message);
      }
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Multi-tab management. Drives BrowserContext.pages() and context.newPage()
// for list / new / switch / close. Critically, every action that swaps the
// active page clears `session.refs` BEFORE assigning `session.page` so any
// concurrent stale ref lookup fails fast against the old refs map rather
// than silently resolving against the new page.
export async function browserTabs(taskId: string, args: Record<string, unknown>): Promise<string> {
  const action = str(args.action);
  if (!action) return fail("Missing required string argument: action");
  if (action !== "list" && action !== "new" && action !== "switch" && action !== "close") {
    return fail("Argument 'action' must be one of: list, new, switch, close.");
  }
  try {
    return await withSession(taskId, async (session) => {
      if (action === "list") {
        const pages = session.context.pages();
        const tabs = await Promise.all(
          pages.map(async (p, i) => ({
            index: i,
            url: p.url(),
            title: await p.title().catch(() => ""),
            active: p === session.page
          }))
        );
        return ok({ url: session.page.url(), tabs }, taskId);
      }
      if (action === "new") {
        if (args.url !== undefined && (typeof args.url !== "string" || args.url.length === 0)) {
          return fail("Argument 'url' must be a non-empty string.");
        }
        const url = str(args.url);
        if (url) {
          const blocked = safetyCheck(url);
          if (blocked) return fail(blocked);
        }
        const page = await session.context.newPage();
        // Mark the freshly-opened tab as agent-owned IMMEDIATELY so any
        // failure between here and the final session.page swap (goto error,
        // console attach error, snapshot throw, even a sync throw between
        // awaits) still leaves the tab tracked for closeSession to reap.
        // Without this, an orphan tab survives task teardown.
        session.ownedPageIds.add(page);
        attachConsole(taskId, page);
        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
        }
        // Clear refs BEFORE swapping the page so any concurrent stale ref
        // lookup hitting session.refs while session.page is the new tab
        // fails fast against an empty map rather than silently resolving
        // against a locator that points at the old page.
        session.refs = new Map();
        session.page = page;
        await page.bringToFront().catch(() => undefined);
        const snap = await snapshot(session.page, false, taskId);
        session.refs = snap.refs;
        return ok({
          url: session.page.url(),
          title: await session.page.title(),
          snapshot: snap.text,
          elementCount: snap.elementCount,
          truncated: snap.truncated
        }, taskId);
      }
      if (action === "switch") {
        if (typeof args.index !== "number" || !Number.isInteger(args.index) || args.index < 0) {
          return fail("Argument 'index' must be a non-negative integer.");
        }
        const target = session.context.pages()[args.index];
        if (!target) return fail(`No tab at index ${args.index}.`);
        session.refs = new Map();
        session.page = target;
        await target.bringToFront().catch(() => undefined);
        const snap = await snapshot(session.page, false, taskId);
        session.refs = snap.refs;
        return ok({
          url: session.page.url(),
          title: await session.page.title(),
          snapshot: snap.text,
          elementCount: snap.elementCount,
          truncated: snap.truncated
        }, taskId);
      }
      // close
      if (typeof args.index !== "number" || !Number.isInteger(args.index) || args.index < 0) {
        return fail("Argument 'index' must be a non-negative integer.");
      }
      const target = session.context.pages()[args.index];
      if (!target) return fail(`No tab at index ${args.index}.`);
      const wasActive = target === session.page;
      await target.close();
      // Drop the closed page from agent ownership if we had it. If the
      // page wasn't agent-owned (rare in practice — the agent normally
      // only addresses tabs it can see, and it opens new ones via
      // browser_tabs:new), the delete is a harmless no-op.
      session.ownedPageIds.delete(target);
      if (wasActive) {
        // Match the invariant the new/switch branches follow: clear refs
        // BEFORE assigning session.page so a stale-ref lookup that races
        // the page swap fails fast against an empty map. Then pick
        // whatever's left, or create a fresh page so the session isn't
        // left pointing at a closed handle. A freshly-opened fallback page
        // counts as agent-owned (we just created it).
        session.refs = new Map();
        const remaining = session.context.pages();
        if (remaining[0]) {
          session.page = remaining[0];
        } else {
          const fallback = await session.context.newPage();
          session.ownedPageIds.add(fallback);
          session.page = fallback;
        }
      } else {
        // Active page didn't change, but refs map points at the old
        // snapshot we're about to refresh — drop it now for consistency
        // with the wasActive branch.
        session.refs = new Map();
      }
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClose(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    consoleLogs.delete(taskId);
    await closeSession(taskId);
    return ok({ closed: true, taskId }, taskId);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Cap on screenshot byte size we'll forward to the vision provider. A
// 5MB PNG is already absurdly large for vision input — anything bigger
// is almost certainly a huge full-page scroll capture that will either
// blow the provider's request limit or produce a useless answer. Failing
// fast here is cheaper (no provider round-trip) and gives the model a
// clear retry instruction.
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

// Screenshot the current page and ask the configured vision model a question
// about it. Returns the model's text answer. The agent never sees the
// screenshot bytes — vision is a side call mediated by the provider layer so
// pixels stay out of the agent loop's transcript. One image per invocation;
// `full` toggles fullPage vs viewport. Cost is bounded by the provider's
// default 512-token response budget, the 5MB screenshot cap above, and a
// disconnect-generation re-check that bails before returning if the browser
// was torn down mid-call.
export async function browserVision(
  taskId: string,
  args: Record<string, unknown>,
  config: RuntimeConfig
): Promise<string> {
  const question = str(args.question);
  if (!question) return fail("Missing required string argument: question");
  const full = bool(args.full, false);
  try {
    return await withSession(taskId, async (session) => {
      // Capture the disconnect generation BEFORE the screenshot. A slow
      // screenshot (large full-page captures can take seconds) followed by
      // a disconnect mid-await would otherwise slip past the post-fetch
      // check and let us forward stale bytes from a torn-down browser.
      const capturedGeneration = currentDisconnectGeneration();
      // Pre-collect data-gini-secret values BEFORE the screenshot.
      // If we collected after, a screenshot that itself navigates
      // (extremely rare) or page cleanup between screenshot and
      // collection would empty the secret list and skip the
      // belt-and-braces post-OCR redaction.
      const secretValues = await collectSecretValuesFromPageWithSession(session.page, taskId);
      // Blur every data-gini-secret element before the screenshot so
      // the vision model can't OCR a credential the user typed via
      // fill_secret. Native browser rendering already masks
      // type="password" inputs, but non-password inputs filled via
      // fill_secret (OTP/recovery-code text inputs) would otherwise
      // render in cleartext. The blur is applied via inline style
      // immediately before the screenshot and restored immediately
      // after — the user's actual page never sees the blur because
      // the headless render happens in the same DOM frame.
      // Both evaluate calls are tolerant of synthetic / mocked
      // pages that may not implement page.evaluate at all (the
      // browserVision unit tests use a stripped-down page mock).
      try {
        if (typeof session.page.evaluate === "function") {
          await session.page.evaluate(() => {
            const els = document.querySelectorAll("[data-gini-secret]");
            for (const el of Array.from(els)) {
              const h = el as HTMLElement;
              h.dataset.giniBlurRestore = h.style.filter || "";
              h.style.filter = "blur(12px)";
            }
          });
        }
      } catch { /* best-effort blur */ }
      let buf: Buffer;
      try {
        buf = await session.page.screenshot({ type: "png", fullPage: full });
      } finally {
        // Always restore even if screenshot threw — otherwise the
        // page would be left visibly blurred for the user.
        try {
          if (typeof session.page.evaluate === "function") {
            await session.page.evaluate(() => {
              const els = document.querySelectorAll("[data-gini-secret]");
              for (const el of Array.from(els)) {
                const h = el as HTMLElement;
                h.style.filter = h.dataset.giniBlurRestore ?? "";
                delete h.dataset.giniBlurRestore;
              }
            });
          }
        } catch { /* best-effort restore */ }
      }
      if (buf.length > MAX_SCREENSHOT_BYTES) {
        return fail(
          `Screenshot too large (${buf.length} bytes > 5MB cap). Try full:false or scroll to a specific section.`
        );
      }
      const imageBase64 = Buffer.from(buf).toString("base64");
      const result = await generateVisionAnalysis(config, {
        prompt: question,
        imageBase64,
        mimeType: "image/png",
        maxTokens: 512
      });
      // Re-check after the provider response too — a disconnect that
      // started while we were awaiting the model is just as bad as one
      // that started during the screenshot.
      if (currentDisconnectGeneration() !== capturedGeneration) {
        return fail("Browser disconnecting, retry shortly.");
      }
      // Defense in depth: even with the blur, post-process the
      // vision answer to redact any literal occurrence of a known
      // secret value — covers a model that pre-cached the value
      // from an earlier turn or somehow recovered it from a
      // partial blur (very small screenshot, tiny font, etc.).
      // secretValues was snapshotted pre-screenshot above.
      const redactedAnswer = redactSecretValuesFromString(result.text, secretValues);
      return ok({
        url: session.page.url(),
        answer: redactedAnswer,
        bytes: buf.length,
        full,
        cost: result.cost ?? null,
        usage: result.usage ?? null
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Validate that a workspace-relative `userPath` points at an in-workspace
// regular file and return both the absolute path and a workspace-relative
// display path (for trace/approval rendering). Throws with a structured
// message when the path is missing, outside the workspace, doesn't exist,
// isn't a file, or resolves outside the workspace via a symlink.
//
// Shared by browser_upload_file's pre-approval gate (so the user sees a
// real, validated path on the approval card) AND by the post-approval
// executor (browserUploadFileApproved), which re-runs THIS function
// against the user-supplied path — not the pre-resolved one — so a
// TOCTOU symlink swap between request and approval is rejected.
export function resolveUploadPath(
  workspaceRoot: string,
  userPath: string
): { absolute: string; displayPath: string } {
  if (!userPath) throw new Error("Missing required string argument: path");
  const absolute = assertInsideWorkspace(workspaceRoot, userPath);
  if (!existsSync(absolute)) {
    throw new Error(`Upload path does not exist: ${userPath}`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absolute);
  } catch (error) {
    throw new Error(`Cannot stat upload path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!st.isFile()) {
    throw new Error(`Upload path is not a file: ${userPath}`);
  }
  // Resolve symlinks and re-run the workspace check. A symlink under the
  // workspace pointing at /etc/passwd would otherwise let an agent
  // exfiltrate arbitrary files via an upload widget; closing this here
  // keeps the assertInsideWorkspace contract intact across symlink chases.
  // We realpath both sides so a workspace itself reached via a symlink
  // (common on macOS where /tmp -> /private/tmp) doesn't false-positive
  // a perfectly in-workspace file.
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new Error(`Cannot resolve upload path: ${error instanceof Error ? error.message : String(error)}`);
  }
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspaceRoot);
  } catch {
    // If the workspace itself can't be realpath'd, fall back to the
    // original; the second assertInsideWorkspace below catches anything
    // that lands outside the un-resolved tree as well.
    realWorkspace = workspaceRoot;
  }
  try {
    assertInsideWorkspace(realWorkspace, real);
  } catch {
    throw new Error(`Path resolves outside workspace via symlink: ${userPath}`);
  }
  return { absolute: real, displayPath: userPath };
}

// Upload a workspace file to a file-input element by ref. The user-supplied
// path is treated as workspace-relative, validated to be inside the
// workspace, and then re-validated after symlink resolution so a planted
// symlink pointing at /etc/passwd can't escape the sandbox. The realpath is
// what gets handed to Playwright's setInputFiles.
//
// NOTE: The chat-task dispatcher now routes browser_upload_file through an
// approval gate (see src/execution/tool-dispatch.ts::requestBrowserUpload
// and src/agent.ts::executeApprovedAction). This function remains as the
// direct, unapproved path used by tests and any non-chat-task caller that
// has already validated user intent.
export async function browserUploadFile(
  taskId: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  const userPath = str(args.path);
  if (!userPath) return fail("Missing required string argument: path");
  let resolved: { absolute: string; displayPath: string };
  try {
    resolved = resolveUploadPath(workspaceRoot, userPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    return await withSession(taskId, async (session) => {
      const locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await locator.setInputFiles(resolved.absolute, { timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        path: resolved.displayPath,
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Approved-upload executor. Called by agent.executeApprovedAction after the
// user explicitly authorizes a browser.upload_file approval. RE-runs
// resolveUploadPath against the user-supplied path at execute time (NOT
// the pre-resolved path captured at approval time) so a TOCTOU swap —
// an attacker (or buggy tool) replacing the workspace file with a symlink
// to /etc/passwd between approval and execution — fails closed. Returns
// the same envelope shape browserUploadFile uses so the chat-task loop
// feeds the success message back as the tool result.
export async function browserUploadFileApproved(
  taskId: string,
  ref: string,
  workspaceRoot: string,
  userPath: string
): Promise<string> {
  let resolved: { absolute: string; displayPath: string };
  try {
    resolved = resolveUploadPath(workspaceRoot, userPath);
  } catch (error) {
    // The approval payload stored a resolved path that passed the symlink
    // check at request time. If the same validation fails NOW the path
    // changed underneath us — refuse rather than upload whatever the
    // symlink now points at.
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Upload path changed between approval and execution: ${message}`);
  }
  try {
    return await withSession(taskId, async (session) => {
      const locator = session.refs.get(ref);
      if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await locator.setInputFiles(resolved.absolute, { timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        path: resolved.displayPath,
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
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
    const fakePage = { close: () => Promise.resolve() } as unknown as Page;
    sessions.set(taskId, {
      context: {} as BrowserContext,
      page: fakePage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight,
      ownedPageIds: new Set<Page>([fakePage])
    });
  },
  // Install a synthetic session with a caller-provided `page` so tool
  // entry points (browserVision, etc.) can be exercised against a
  // hand-built page without spawning Chromium.
  installFakeSessionWithPageForTest(taskId: string, page: Partial<Page>): void {
    const realPage = page as unknown as Page;
    sessions.set(taskId, {
      context: {} as BrowserContext,
      page: realPage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds: new Set<Page>([realPage])
    });
  },
  // Install a synthetic session with both a `page` and `context` so tab-
  // management tests (which read context.pages() and call context.newPage())
  // can exercise the entire flow without spawning Chromium.
  installFakeSessionWithPageAndContextForTest(
    taskId: string,
    page: Partial<Page>,
    context: Partial<BrowserContext>
  ): void {
    const realPage = page as unknown as Page;
    sessions.set(taskId, {
      context: context as unknown as BrowserContext,
      page: realPage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds: new Set<Page>([realPage])
    });
  },
  // Read the currently-installed page on a fake session so tests can
  // assert that a tab-management operation actually swapped session.page.
  getFakeSessionPageForTest(taskId: string): Page | undefined {
    return sessions.get(taskId)?.page;
  },
  // Read the entire fake session so tests can mutate ownedPageIds directly
  // (used by the closeSession drain test to simulate agent-opened tabs).
  getFakeSessionForTest(taskId: string): Session | undefined {
    return sessions.get(taskId);
  },
  // Run closeSession against a synthetic session — the production
  // closeSession is module-private, but tests need to exercise its
  // ownedPageIds drain behavior end-to-end.
  closeSessionForTest(taskId: string): Promise<void> {
    return closeSession(taskId);
  },
  // Read the currently-installed refs map so tests can assert it was
  // cleared (e.g. tab switch / new / close should clear the refs).
  getFakeSessionRefsForTest(taskId: string): Map<string, Locator> | undefined {
    return sessions.get(taskId)?.refs;
  },
  // Set the refs map on a fake session so tests can plant a fake locator
  // keyed by `@eN` before invoking a tool that needs to resolve it.
  setFakeSessionRefsForTest(taskId: string, refs: Map<string, unknown>): void {
    const session = sessions.get(taskId);
    if (session) session.refs = refs as Map<string, Locator>;
  },
  setFakeSessionInFlight(taskId: string, inFlight: number): void {
    const session = sessions.get(taskId);
    if (session) session.inFlight = inFlight;
  },
  clearFakeSessionsForTest(): void {
    sessions.clear();
    // Match the real session-teardown contract: also drop the
    // per-task secret-redaction registry so tests that install
    // fake sessions then call this helper don't leak state into
    // subsequent tests.
    filledSecretValues.clear();
  },
  // Expose the in-page walker for direct unit testing. Callers supply a
  // fake Page whose `evaluate(fn, arg)` runs `fn(arg)` locally against
  // a pre-populated `globalThis.document` (and friends) — that lets
  // browser walk semantics be asserted without spawning Chromium.
  snapshotForTest(page: Page, full: boolean): Promise<SnapshotResult> {
    return snapshot(page, full);
  }
};
