// Browser automation tools. Drives a headless Chromium via playwright-core.
// One Chromium instance is shared across tasks; each task gets its own
// BrowserContext for cookie/storage isolation. Sessions are keyed by
// taskId and idle-swept after 5 minutes. All tools are sync — they return
// a JSON string immediately. Side-effecting actions (click/type) skip the
// approval gate; the snapshot itself is the trace evidence.
//
// CDP-attached mode: when the user has connected a real headed Chrome via
// /api/browser/connect, the session manager swaps the headless launch for
// chromium.connectOverCDP() and reuses the user's default context instead
// of creating fresh ones. That's what makes the user's signed-in cookies
// visible to the agent.
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { readState } from "../state";
import type { BrowserConnectionRecord, Instance } from "../types";

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
  // True when we created the BrowserContext ourselves (headless launch
  // path, or CDP attach where the remote browser had no default context).
  // False when we reused the user's default context — closeSession() then
  // closes only the page so we don't kill the user's tabs.
  ownsContext: boolean;
}

let sharedBrowser: Browser | undefined;
// True when sharedBrowser was acquired via chromium.connectOverCDP rather
// than chromium.launch. Drives all of the "don't kill the user's Chrome"
// branches in close paths and the "reuse default context" branch in
// session creation.
let sharedBrowserIsCdp = false;
let chromiumImport: Promise<typeof import("playwright-core").chromium> | undefined;
// In-flight launch promise so concurrent ensureBrowser callers share one
// chromium.launch() instead of orphaning the loser's Browser.
let pendingBrowser: Promise<Browser> | null = null;
// Set to true while disconnectSharedBrowser is tearing down the shared
// browser handle. withSession rejects new admissions during that window
// so a concurrent tool call doesn't re-enter ensureBrowser() and either
// reattach to the about-to-die remote or race the close-and-launch path.
// Cleared in the finally of disconnectSharedBrowser.
let disconnecting = false;
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

async function ensureBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (pendingBrowser) return pendingBrowser;
  // Resolve the active connection record *before* the await chain starts so
  // two concurrent cold-start callers see the same decision (CDP vs launch).
  // If the record disappears between this read and the actual attach the
  // attach will fail and the caller will retry through the normal error
  // path — we don't try to atomically lock state across the dynamic import.
  const record = activeBrowserRecord();
  const useCdp = Boolean(record?.cdpUrl);
  pendingBrowser = (async () => {
    const chromium = await loadChromium();
    if (useCdp && record?.cdpUrl) {
      // connectOverCDP returns a Browser handle scoped to the remote
      // process. The remote Chrome's default BrowserContext (the one the
      // user has been clicking around in) shows up under browser.contexts()
      // — we'll reuse it in getOrCreate() so signed-in cookies are visible.
      return chromium.connectOverCDP(record.cdpUrl);
    }
    return chromium.launch({ headless: true });
  })()
    .then((browser) => {
      sharedBrowser = browser;
      sharedBrowserIsCdp = useCdp;
      registerExitHook();
      startSweeper();
      return browser;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (useCdp) {
        throw new Error(
          `Failed to attach over CDP: ${message}. ` +
            "Disconnect and reconnect via /api/browser/connect, or start a fresh Chrome session."
        );
      }
      throw new Error(
        `Failed to launch Chromium: ${message}. ` +
          "Run `bunx playwright install chromium` to install the browser."
      );
    })
    .finally(() => {
      pendingBrowser = null;
    });
  return pendingBrowser;
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
    const browser = await ensureBrowser();
    // CDP-attached: reuse the user's already-open default BrowserContext
    // so any pages we create live in their authenticated profile. Newer
    // Chrome builds reject newContext() over CDP outright; even when they
    // accept it, the new context inherits no cookies, defeating the whole
    // point of /api/browser/connect. Track whether we owned the creation
    // so closeSession() knows to leave the user's context alone.
    let context: BrowserContext;
    let weCreatedContext = true;
    if (sharedBrowserIsCdp) {
      const existing = browser.contexts()[0];
      if (existing) {
        context = existing;
        weCreatedContext = false;
      } else {
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }
    let page: Page;
    try {
      page = await context.newPage();
    } catch (error) {
      // Avoid orphaning the context if newPage throws between newContext()
      // and the sessions.set() below. Don't close a context we didn't
      // create (that would close the user's tabs).
      if (weCreatedContext) {
        await context.close().catch(() => undefined);
      }
      throw error;
    }
    const session: Session = {
      context,
      page,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownsContext: weCreatedContext
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
  if (disconnecting) {
    // The caller is the tool layer; throwing here surfaces as a `success:
    // false` envelope from each browser_* entry point via their existing
    // catch blocks.
    throw new Error("Browser disconnecting, retry shortly.");
  }
  const session = await getOrCreate(taskId);
  session.inFlight++;
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
    if (session.ownsContext) {
      await session.context.close();
    } else {
      // CDP-attached + reused context: close only the page. The user's
      // existing tabs stay open in their Chrome.
      await session.page.close().catch(() => undefined);
    }
  } catch {
    // Already closed or browser disconnected; nothing useful to do.
  }
  // Don't tear down the shared browser when CDP-attached — that handle
  // belongs to the user's Chrome. The headless launch path keeps the
  // original "tear it down once everyone's gone" behavior so we don't
  // hold a Chromium process open between idle bursts.
  if (sessions.size === 0 && sharedBrowser && !sharedBrowserIsCdp) {
    try {
      await sharedBrowser.close();
    } catch {
      // ignore
    }
    sharedBrowser = undefined;
    sharedBrowserIsCdp = false;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }
}

// Drop the in-process Playwright handle without killing the underlying
// browser process. Used by the browser-connect capability when the user
// disconnects a CDP-attached Chrome: the next browser tool call should
// re-read state and either re-attach (if a fresh record is set up) or
// fall back to the headless launch path. Safe no-op when no shared
// browser is held.
export async function disconnectSharedBrowser(): Promise<void> {
  if (disconnecting) {
    // Another caller already kicked off teardown; piggyback rather than
    // racing it (re-entry would double-close pages / contexts).
    return;
  }
  disconnecting = true;
  try {
    // Wait for in-flight calls to drain. We can't safely close pages /
    // contexts while tools are mid-await on them — the half-completed
    // browser call would throw a confusing "Target closed" up the stack.
    // Bound the wait so a hung page.goto can't wedge disconnect forever;
    // after the deadline, proceed with teardown anyway.
    const drainDeadline = Date.now() + DISCONNECT_DRAIN_DEADLINE_MS;
    while (Date.now() < drainDeadline) {
      let pending = 0;
      for (const session of sessions.values()) pending += session.inFlight;
      if (pending === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const ids = Array.from(sessions.keys());
    for (const id of ids) {
      const session = sessions.get(id);
      sessions.delete(id);
      if (!session) continue;
      try {
        // For sessions reusing the user's default context, close just the
        // page so we don't close the user's tabs. For sessions that own
        // their context, close the context as usual.
        if (session.ownsContext) {
          await session.context.close().catch(() => undefined);
        } else {
          await session.page.close().catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }
    consoleLogs.clear();
    if (sharedBrowser) {
      try {
        // Use disconnect() rather than close() over CDP — close() over CDP
        // also terminates the remote browser, which the user owns. The
        // Browser type from playwright-core only exposes disconnect on
        // CDP-attached instances, so we probe at runtime.
        const candidate = sharedBrowser as unknown as { disconnect?: () => Promise<void> };
        if (sharedBrowserIsCdp) {
          if (typeof candidate.disconnect === "function") {
            await candidate.disconnect();
          }
          // No disconnect() available on this CDP-attached Browser handle.
          // We deliberately do NOT fall back to close() — close() over CDP
          // also terminates the user's Chrome. Leaking the in-process
          // Playwright handle is strictly better than killing the user's
          // browser; the handle will be garbage-collected once nothing
          // references it.
        } else {
          await sharedBrowser.close();
        }
      } catch {
        // ignore
      }
      sharedBrowser = undefined;
      sharedBrowserIsCdp = false;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  } finally {
    disconnecting = false;
  }
}

export async function closeAll(): Promise<void> {
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    const session = sessions.get(id);
    sessions.delete(id);
    if (!session) continue;
    try {
      if (session.ownsContext) {
        await session.context.close();
      } else {
        await session.page.close().catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }
  consoleLogs.clear();
  if (sharedBrowser) {
    try {
      // Mirror disconnectSharedBrowser's CDP-aware teardown: over CDP we
      // disconnect the Playwright handle without killing the user's
      // Chrome; for the headless-launch path we close() as before. We
      // deliberately do NOT fall back to close() when disconnect() is
      // unavailable on a CDP-attached handle — close() would terminate
      // the user's Chrome.
      const candidate = sharedBrowser as unknown as { disconnect?: () => Promise<void> };
      if (sharedBrowserIsCdp) {
        if (typeof candidate.disconnect === "function") {
          await candidate.disconnect();
        }
        // Otherwise: leak the in-process handle on purpose (see comment
        // above in disconnectSharedBrowser).
      } else {
        await sharedBrowser.close();
      }
    } catch {
      // ignore
    }
    sharedBrowser = undefined;
    sharedBrowserIsCdp = false;
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
// disconnecting flag, inFlight draining, and the CDP-safe close fallback.
export const __test = {
  setDisconnectingForTest(value: boolean): void {
    disconnecting = value;
  },
  isDisconnectingForTest(): boolean {
    return disconnecting;
  },
  // Install a fake shared browser so the close-path tests can assert
  // disconnect()-vs-close() behavior without launching Chromium.
  installFakeBrowserForTest(
    browser: Pick<Browser, "close"> & Partial<{ disconnect: () => Promise<void> }>,
    isCdp: boolean
  ): void {
    sharedBrowser = browser as Browser;
    sharedBrowserIsCdp = isCdp;
  },
  uninstallFakeBrowserForTest(): { sharedBrowser: Browser | undefined; sharedBrowserIsCdp: boolean } {
    const captured = { sharedBrowser, sharedBrowserIsCdp };
    sharedBrowser = undefined;
    sharedBrowserIsCdp = false;
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
