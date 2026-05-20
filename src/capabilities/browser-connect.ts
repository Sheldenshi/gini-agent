// Headed-browser connect/disconnect capability. The runtime exposes three
// HTTP routes that delegate to the functions in this module:
//
//   GET  /api/browser                 -> getBrowserConnection
//   POST /api/browser/connect         -> connectBrowser
//   POST /api/browser/disconnect      -> disconnectBrowser
//
// Profile persistence shape:
//
// The agent ALWAYS drives the same per-instance profile directory at
// ~/.gini/instances/<inst>/chrome-profile/. Sign-ins land in that dir and
// survive across:
//   - Connect/Disconnect cycles (visibility toggle only)
//   - Runtime restarts
//   - Idle teardown
// The only way to lose them is to manually rm -rf the profile dir.
//
// Two connection modes (the third "headless" state is "no record"):
//
//   - "managed": no body. The runtime calls chromium.launchPersistentContext
//     against the per-instance profile dir with `headless: false` — Chrome
//     opens visibly so the user can sign in. The session manager pulls the
//     live BrowserContext from its own ensureShared() each time it needs
//     it. Disconnecting closes only the visible window; the next tool call
//     relaunches the same profile dir with `headless: true`.
//
//   - "cdp": body carries `{ cdpUrl }`. The runtime probes the supplied
//     CDP endpoint and stores the URL verbatim — minus any embedded
//     credentials in the redaction copy that lands in the audit row.
//     CDP attach is known-flaky under the current Playwright + Bun
//     stack; the UI warns users to prefer managed mode.
//
// The shape returned by all three GET/POST handlers is `{ connected:
// boolean, record?: BrowserConnectionRecord }` so the CLI / webapp can
// render a uniform status card.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { instanceRoot } from "../paths";
import { addAudit, mutateState, now, readState } from "../state";
import { findChromePath } from "../tools/chrome-discovery";
import {
  chromeProfileDirFor,
  disconnectSharedBrowser,
  materializeManagedForConnect,
  safetyCheck,
  withTeardownLock
} from "../tools/browser";
import type { BrowserConnectionRecord, RuntimeConfig } from "../types";

// We poll a user-supplied CDP /json/version endpoint every 500ms for up
// to 15s before giving up. Used only by `cdp` mode now (managed mode no
// longer probes — Playwright owns the lifecycle).
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;
// Sentinel cdpUrl value persisted for managed-mode records. The session
// manager doesn't read cdpUrl when mode === "managed" (it pulls the live
// BrowserContext from ensureShared instead), but the field is non-null in
// BrowserConnectionRecord to keep the GET /api/browser response shape
// stable across modes. The CLI / UI hides this value behind a friendly
// label.
const MANAGED_CDP_SENTINEL = "internal:managed";

type Status = {
  connected: boolean;
  record?: BrowserConnectionRecord;
};

// Pinpointed view of the /json/version JSON. We only care about the
// webSocketDebuggerUrl when a managed launch finishes booting — the rest
// of the payload is metadata we don't use.
interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

export function getBrowserConnection(config: RuntimeConfig): Status {
  const state = readState(config.instance);
  const record = state.browser ?? null;
  if (!record) return { connected: false };
  return { connected: true, record };
}

// Strip embedded `user:pass@` credentials before persisting a redacted
// form for audit / event logs. We never want a basic-auth-bearing ws:// URL
// to leak through the activity stream.
function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Not a valid URL — caller will already have failed validation, but
    // be defensive so we never echo raw input back into the audit row.
    return "<redacted>";
  }
}

// Same shape as redactUrlCredentials, but used at the storage boundary
// (state.json, GET /api/browser, the webapp): we actually drop the
// credentials rather than redacting to a sentinel. A user who supplies
// `ws://alice:pass@host/...` should not see their password rendered back
// in the status card.
function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Caller already validated — but if a fresh probe somehow returned a
    // malformed URL, drop it on the floor rather than persist garbage.
    return url;
  }
}

// Thin alias kept for back-compat with the test helpers. Same directory
// every browser tool call uses — sign-ins persist regardless of whether
// the user has clicked Connect.
function profileDirFor(config: RuntimeConfig): string {
  return chromeProfileDirFor(config.instance);
}

// HTTP probe of a CDP endpoint. The /json/version path returns Chrome's
// build info and the webSocketDebuggerUrl we'll later hand to Playwright.
// Returns the parsed body on success or null if the host did not respond
// with a JSON payload before the deadline.
async function probeCdp(httpUrl: string, deadlineMs: number): Promise<CdpVersionInfo | null> {
  const start = Date.now();
  while (Date.now() < start + deadlineMs) {
    try {
      const response = await fetch(`${httpUrl.replace(/\/$/, "")}/json/version`, {
        // AbortSignal.timeout keeps a single hung connection from eating
        // the entire poll budget.
        signal: AbortSignal.timeout(PROBE_INTERVAL_MS * 2)
      });
      if (response.ok) {
        const body = (await response.json()) as CdpVersionInfo;
        if (body && typeof body === "object") return body;
      }
    } catch {
      // Connection refused / network errors are expected during the
      // startup window — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return null;
}

// Maps a CDP ws://host:port/... URL onto its sibling http://host:port form
// for the /json/version probe. Falls back to the raw input if the URL
// parser rejects it (the caller will already have surfaced a validation
// error in that case).
function cdpHttpForm(cdpUrl: string): string {
  try {
    const parsed = new URL(cdpUrl);
    const proto = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${parsed.host}`;
  } catch {
    return cdpUrl;
  }
}

function validateCdpUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid cdpUrl: ${raw}` };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported cdpUrl protocol: ${parsed.protocol}` };
  }
  return { ok: true, url: parsed.toString() };
}

// PUBLIC input shape — accepted directly from authenticated callers (HTTP
// POST /api/browser/connect body, CLI). Keep this surface minimal and
// auditable. Fields that affect audit / trust semantics MUST NOT live here,
// because the HTTP route hands the parsed body straight to connectBrowser
// without filtering — declaring those fields on this type would let an
// authenticated client suppress its own audit trail by setting them in the
// POST body. Such fields belong in `InternalConnectOptions` (third arg),
// reachable only from in-process call sites.
export interface ConnectInput {
  cdpUrl?: unknown;
  // When set to "managed", an existing record that is NOT managed (i.e. a
  // `cdp`-mode record that may be headless or owned by a different Chrome)
  // is torn down and replaced with a fresh managed launch instead of being
  // returned as-is. The default behavior (no `mode`) preserves the existing
  // "vanilla reconnect" semantics used by the CLI and HTTP endpoint —
  // empty input means "reconnect to whatever exists." The `browser_connect`
  // tool dispatch sets `mode: "managed"` because its contract (and the
  // approval card the user just consented to) promises a visible Chrome
  // window; silently handing back a stale CDP session would violate that.
  mode?: "managed";
  // When true AND mode === "managed", the managed Chrome is launched with
  // headless: true so no window appears. The per-instance profile dir is
  // unchanged from the headed launch, so cookies from a prior visible
  // sign-in replay — the headless session is already signed in. Use this
  // AFTER sign-in to continue Cloud Console / OAuth work invisibly. Only
  // takes effect on managed mode; cdp mode is unaffected (the user owns
  // that Chrome's visibility).
  headless?: boolean;
}

// INTERNAL options — never plumbed from network input. Lives as a separate
// third argument to `connectBrowser` so it can't be smuggled in through
// `POST /api/browser/connect`'s JSON body. The HTTP route omits this arg,
// so `skipAudit` always defaults to false on that path and the capability
// always writes its `browser.connect` audit row. Only the in-process
// tool-dispatch caller (which writes its own richer audit row with the
// approval `reason` + `approvalId`) sets `skipAudit: true` to avoid a
// duplicate, reasonless row.
interface InternalConnectOptions {
  skipAudit?: boolean;
}

// Serializes concurrent /api/browser/connect calls. The browser-connect
// lifecycle is full of "is there already a state record?" checks; without
// this, two parallel callers each read empty state, each spawn Chrome,
// and the second writer wins — leaking the first child as a zombie. Pattern
// mirrors `pendingBrowser` in src/tools/browser.ts.
let pendingConnect: Promise<Status> | null = null;

// Same idea, but for /api/browser/disconnect. Without this, a second
// concurrent caller reads still-set state, calls disconnectSharedBrowser
// (which early-returns because the first caller already flipped its
// teardown flag), then proceeds to killManagedChrome before the first
// drain finishes. Folding both calls into the same promise keeps the
// teardown sequence atomic from the caller's perspective.
let pendingDisconnect: Promise<Status> | null = null;

// Idempotent connect. Mode is decided by whether the caller supplied a
// cdpUrl. We re-probe an existing record before returning it so a crashed
// Chrome doesn't appear as still-connected.
//
// The third `internal` argument is OFF-LIMITS to network callers (the HTTP
// route omits it). It carries flags that affect audit / trust semantics
// (`skipAudit`); putting them on `ConnectInput` would let any authenticated
// HTTP client set `{"skipAudit": true}` in the POST body and suppress the
// capability's own audit row, breaking the tamper-resistance contract.
export function connectBrowser(
  config: RuntimeConfig,
  input: ConnectInput,
  internal: InternalConnectOptions = {}
): Promise<Status> {
  if (pendingConnect) return pendingConnect;
  pendingConnect = (async () => {
    return await connectBrowserInner(config, input, internal);
  })().finally(() => {
    pendingConnect = null;
  });
  return pendingConnect;
}

async function connectBrowserInner(
  config: RuntimeConfig,
  input: ConnectInput,
  internal: InternalConnectOptions
): Promise<Status> {
  // Validate caller input BEFORE we touch any existing state. A bad cdpUrl
  // (malformed, blocked SSRF target, unsupported protocol) must surface as
  // a 400 to the caller without tearing down the user's already-managed
  // Chrome. Previously the mismatch check used the raw input string,
  // triggered tearDownExistingConnection (killing the user's Chrome), and
  // only THEN ran validation — see round-3 review.
  let validatedCallerCdp: string | undefined;
  if (typeof input.cdpUrl === "string" && input.cdpUrl.length > 0) {
    const validated = validateCdpUrl(input.cdpUrl);
    if (!validated.ok) throw new Error(validated.error);
    const httpForm = cdpHttpForm(validated.url);
    const blocked = safetyCheck(httpForm);
    if (blocked) throw new Error(`Invalid cdpUrl: ${blocked}`);
    validatedCallerCdp = validated.url;
  }

  const wantHeadless = input.headless === true;
  const existing = readState(config.instance).browser ?? null;
  if (existing) {
    // If the caller explicitly asked for a *different* endpoint than what's
    // stored, don't short-circuit on the old record — fall through to the
    // teardown + fresh attach path.
    const callerCdp = validatedCallerCdp;
    // Strict-managed mode: if the caller demands a managed Chrome and the
    // existing record isn't managed (e.g. it's a `cdp`-mode record left
    // over from a prior /api/browser/connect with a custom endpoint), the
    // existing record cannot satisfy the contract. Treat it as a mismatch
    // so we fall through to teardown + fresh managed launch rather than
    // silently returning a stale CDP session that may be headless.
    const strictManagedMismatch =
      input.mode === "managed" && existing.mode !== "managed";
    // Visibility mismatch: caller asked for headless when current is
    // headed (or vice versa). Even if the mode matches, the launch
    // option differs so we cannot short-circuit — Chromium must be
    // relaunched with the new headless flag against the same profile
    // dir. Only relevant when both sides are managed.
    const headlessMismatch =
      input.mode === "managed" &&
      existing.mode === "managed" &&
      (existing.headless === true) !== wantHeadless;
    const targetsSameEndpoint =
      !strictManagedMismatch && !headlessMismatch && targetsExistingRecord(existing, callerCdp);

    if (targetsSameEndpoint) {
      if (existing.mode === "managed") {
        // Managed mode: the session manager holds the live BrowserContext
        // in-process. If that handle is still alive we're already
        // connected — return the stored record without re-launching.
        // (disconnectSharedBrowser drops the handle, so a stale state
        // record without a matching handle is treated as dead and falls
        // through to teardown + relaunch.)
        return { connected: true, record: existing };
      }
      const httpForm = cdpHttpForm(existing.cdpUrl);
      const probe = await probeCdp(httpForm, PROBE_INTERVAL_MS * 2);
      if (probe) {
        // Chrome may have restarted on the same port with a fresh UUID
        // suffix on its webSocketDebuggerUrl — refresh the stored value so
        // tools don't try to use a dead URL.
        const refreshed: BrowserConnectionRecord = {
          ...existing,
          cdpUrl: stripUrlCredentials(probe.webSocketDebuggerUrl ?? existing.cdpUrl)
        };
        if (refreshed.cdpUrl !== existing.cdpUrl) {
          await mutateState(config.instance, (state) => {
            state.browser = refreshed;
          });
        }
        return { connected: true, record: refreshed };
      }
    }
    // The previous endpoint is dead (or the caller asked for a different
    // one) — tear it down fully before falling through to a fresh launch.
    // For a same-endpoint stale record we only need to clear state (the
    // probe just showed the remote is gone). For a mismatched endpoint
    // (caller asked for a *different* URL) we additionally drop the
    // in-process Playwright handle via disconnectSharedBrowser so the
    // managed BrowserContext (and the Chromium it owns) shuts down before
    // we try to launch a fresh one.
    if (!targetsSameEndpoint) {
      await tearDownExistingConnection(config, existing);
    } else {
      await mutateState(config.instance, (state) => {
        state.browser = null;
      });
    }
  }

  // If the fresh connect below throws, state was already cleared above
  // (either by tearDownExistingConnection on the mismatch path or the
  // mutateState block on the same-endpoint dead path), so the user is
  // left in a clean disconnected state rather than half-leaked. The
  // thrown error propagates up to the HTTP handler, which maps it to the
  // appropriate status code.
  // launchManaged installs the freshly-built BrowserContext directly into
  // the session manager (via materializeManagedForConnect) so there's no
  // headless-handle ambiguity — the next browser_* call reuses the live
  // managed context. For the cdp path we still drop any cached headless
  // handle so ensureShared rebuilds via the CDP branch on the next call.
  // `skipAudit` is read from the in-process `internal` arg ONLY. Reading it
  // from `input` (which we hand the HTTP body to verbatim) would let any
  // authenticated caller post `{"skipAudit": true}` and silence their own
  // audit row.
  const skipAudit = internal.skipAudit === true;
  if (validatedCallerCdp) {
    const result = await connectExisting(config, validatedCallerCdp, { skipAudit });
    await disconnectSharedBrowser();
    return result;
  }
  return await launchManaged(config, { skipAudit, headless: wantHeadless });
}

// Full teardown of an existing connection record. Sends SIGTERM to the
// recorded managed Chrome (if any), drops the in-process Playwright handle,
// and clears state — same sequence disconnectBrowser uses. Pulled out so
// the mismatch-reconnect path in connectBrowserInner can reuse it without
// re-entering disconnectBrowser (which would be coalesced through
// pendingDisconnect from a different call site).
async function tearDownExistingConnection(
  config: RuntimeConfig,
  existing: BrowserConnectionRecord
): Promise<void> {
  // Clear state FIRST so any concurrent ensureShared() callers that
  // re-enter during teardown see fresh state and don't reattach to the
  // soon-to-be-dead endpoint. Emit the same browser.disconnect audit row
  // disconnectBrowserInner writes so a mismatch-reconnect leaves the
  // activity log indistinguishable from a user-initiated disconnect.
  await mutateState(config.instance, (state) => {
    state.browser = null;
    addAudit(
      state,
      {
        actor: "user",
        action: "browser.disconnect",
        target: existing.mode === "managed" ? existing.dataDir ?? "managed" : redactUrlCredentials(existing.cdpUrl),
        risk: "medium",
        evidence: { mode: existing.mode, pid: existing.pid }
      },
      // Browser is an instance-shared resource — not bound to any one agent.
      { system: true }
    );
  });
  // disconnectSharedBrowser handles every mode correctly: closing the
  // managed BrowserContext terminates the Chromium child Playwright
  // launched, disconnect()ing the cdp Browser leaves the user's Chrome
  // alone, and closing the headless Browser exits Chromium. No separate
  // PID kill needed — Playwright owns the lifecycle.
  await disconnectSharedBrowser();
}

// Compare the caller's requested endpoint against the existing record.
// Returns true when the caller didn't specify anything (a vanilla
// "reconnect") or when their cdpUrl matches what we already have stored.
// False means the caller explicitly wants somewhere else — we should tear
// down and re-attach rather than handing back the stale record.
function targetsExistingRecord(
  existing: BrowserConnectionRecord,
  callerCdp: string | undefined
): boolean {
  // No explicit endpoint requested → managed reconnect → matches anything.
  if (callerCdp === undefined) return true;
  // Caller asked for cdp mode but existing is managed (or vice versa) →
  // always a mismatch.
  if (existing.mode === "managed") return false;
  try {
    const wanted = new URL(callerCdp);
    const have = new URL(existing.cdpUrl);
    return wanted.host === have.host;
  } catch {
    return false;
  }
}

// `validatedUrl` is the WHATWG-normalized form already vetted by
// connectBrowserInner (validateCdpUrl + safetyCheck against the http
// form). We re-derive the http form here for the probe rather than
// threading both representations through the call site.
async function connectExisting(
  config: RuntimeConfig,
  validatedUrl: string,
  opts: { skipAudit?: boolean } = {}
): Promise<Status> {
  const httpForm = cdpHttpForm(validatedUrl);
  const probe = await probeCdp(httpForm, PROBE_TIMEOUT_MS);
  if (!probe) {
    throw new Error(`Could not reach CDP endpoint at ${redactUrlCredentials(validatedUrl)}`);
  }
  const probeUrl = probe.webSocketDebuggerUrl ?? validatedUrl;
  const record: BrowserConnectionRecord = {
    mode: "cdp",
    // Strip embedded credentials before persisting. The audit row used
    // its own redactor; here we want the long-lived state record to be
    // free of secrets too, since it's surfaced by GET /api/browser.
    cdpUrl: stripUrlCredentials(probeUrl),
    pid: null,
    dataDir: null,
    chromePath: null,
    startedAt: now()
  };
  await mutateState(config.instance, (state) => {
    state.browser = record;
    // When the caller is the runtime's tool-dispatch path (skipAudit), it
    // already writes a richer browser.connect audit row carrying the
    // approval reason and approvalId — emitting a second row here would
    // double-count the action.
    if (!opts.skipAudit) {
      addAudit(
        state,
        {
          actor: "user",
          action: "browser.connect",
          target: redactUrlCredentials(record.cdpUrl),
          risk: "medium",
          evidence: { mode: "cdp", browser: probe.Browser ?? null }
        },
        { system: true }
      );
    }
  });
  return { connected: true, record };
}

async function launchManaged(
  config: RuntimeConfig,
  opts: { skipAudit?: boolean; headless?: boolean } = {}
): Promise<Status> {
  // Headless-after-signin support: when the caller asks for a headless
  // managed launch, Playwright is invoked with `headless: true` against
  // the SAME per-instance profile dir as the visible launch would use.
  // Cookies + storage persisted by the prior visible session replay, so
  // the headless context is already signed in. Falls back to visible
  // (`headless: false`) for any other value.
  const wantHeadless = opts.headless === true;
  // findChromePath honors GINI_CHROME_PATH first, then falls back to
  // Playwright's bundled Chromium, then system browsers. For the
  // launchPersistentContext path we pass the resolved path through to
  // Playwright as executablePath only when the discovery returned
  // something specific; otherwise we let Playwright default to its bundled
  // Chromium. Either way, the lifecycle is owned by Playwright — no
  // separate spawn() / CDP probe / PID tracking.
  const chromePath = await findChromePath();
  // chromePath stored for UI display. Null means "Playwright chose its
  // default", which is the normal happy path.
  const dataDir = profileDirFor(config);
  mkdirSync(dataDir, { recursive: true });

  // Route downloads from the managed Chrome into a directory Gini can
  // read. macOS sandboxes ~/Downloads so the agent (running as a Bun
  // process without Files-and-Folders entitlement) can't open files
  // saved there — the Workspace setup skill in particular was getting
  // stuck because the OAuth client_secret.json landed in ~/Downloads and
  // had to be moved by a manual terminal command. Saving under the
  // per-instance state dir (which Gini already owns) makes any download
  // immediately readable. CDP mode (existing user Chrome) is unaffected:
  // Playwright cannot override a remote Chrome's user-configured
  // downloads dir; the setup skill explains that fallback.
  const downloadsPath = join(instanceRoot(config.instance), "downloads");
  mkdirSync(downloadsPath, { recursive: true });

  // CRITICAL: tear down any existing shared handle BEFORE we attempt to
  // launch the visible Chrome. The headless persistent context the agent
  // may already be using is rooted at the same profile dir, and Chromium
  // locks the dir while a context is open — a second
  // launchPersistentContext against the same dir would fail with "user
  // data directory is already in use". This is the pivot's central
  // ordering rule: only one Chromium process can have the profile open at
  // a time, so visibility transitions go teardown-then-launch.
  //
  // Dynamically import playwright-core so tests can mock it via
  // mock.module without forcing every test that imports this module to
  // pull in the full browser SDK at module-init time. Catch the
  // module-not-found case explicitly so users see a friendly install
  // hint instead of the bare Node module-resolution error — this
  // happens when the runtime was started before `bun install` resolved
  // the dep, or in a slim install that intentionally omitted browser
  // tooling.
  let playwright: typeof import("playwright-core");
  try {
    playwright = (await import("playwright-core")) as typeof import("playwright-core");
  } catch (error) {
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
  const chromium = playwright.chromium;

  // withTeardownLock holds the admission gate CLOSED for the entire
  // disconnect-then-launch sequence. Without it, a new agent tool call
  // could land between disconnectSharedBrowser returning and the headed
  // launchPersistentContext starting — re-acquiring the profile lock with
  // a headless persistent context and forcing this launch to fail with
  // "user data directory is already in use".
  const context = await withTeardownLock(async () => {
    await disconnectSharedBrowser();

    try {
      return await chromium.launchPersistentContext(dataDir, {
        headless: wantHeadless,
        executablePath: chromePath ?? undefined,
        acceptDownloads: true,
        downloadsPath,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          // Suppress the "restore previous session?" dialog that appears
          // after a hard kill. We don't restore state because the user
          // signs in fresh per connect anyway.
          "--disable-features=ChromeWhatsNewUI,Translate"
        ]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to launch managed Chrome: ${message}. ` +
          "Confirm Chrome / Chromium is installed (or set GINI_CHROME_PATH), or run " +
          "`bunx playwright install chromium` to install Playwright's bundled Chromium."
      );
    }
  });

  // Hand the live BrowserContext to the session manager so the next
  // browser_* tool call can reuse it directly without re-launching.
  await materializeManagedForConnect(context);

  // Best-effort PID extraction for UI display. Playwright exposes the
  // child via context.browser()?.process(); the .process() method is on
  // playwright-core's Node-side Browser but isn't in the public typing,
  // so we duck-type it. Returns null on any failure — Playwright owns the
  // lifecycle so the PID is purely cosmetic.
  const browserAny = context.browser() as unknown as
    | { process?: () => { pid?: number } | undefined }
    | null;
  const pid = browserAny?.process?.()?.pid ?? null;
  // Resolve the executable Playwright actually used so the UI shows a
  // meaningful path even when chromePath was null.
  const resolvedChromePath = chromePath ?? (() => {
    try {
      return chromium.executablePath();
    } catch {
      return null;
    }
  })();

  const record: BrowserConnectionRecord = {
    mode: "managed",
    cdpUrl: MANAGED_CDP_SENTINEL,
    pid,
    dataDir,
    chromePath: resolvedChromePath ?? null,
    startedAt: now(),
    headless: wantHeadless
  };
  await mutateState(config.instance, (state) => {
    state.browser = record;
    // When the caller is the runtime's tool-dispatch path (skipAudit), it
    // already writes a richer browser.connect audit row carrying the
    // approval reason and approvalId — emitting a second row here would
    // double-count the action.
    if (!opts.skipAudit) {
      addAudit(
        state,
        {
          actor: "user",
          action: "browser.connect",
          target: dataDir,
          risk: "medium",
          evidence: { mode: "managed", pid, headless: wantHeadless }
        },
        { system: true }
      );
    }
  });
  return { connected: true, record };
}

export function disconnectBrowser(config: RuntimeConfig): Promise<Status> {
  if (pendingDisconnect) return pendingDisconnect;
  pendingDisconnect = (async () => {
    return await disconnectBrowserInner(config);
  })().finally(() => {
    pendingDisconnect = null;
  });
  return pendingDisconnect;
}

async function disconnectBrowserInner(config: RuntimeConfig): Promise<Status> {
  const existing = readState(config.instance).browser ?? null;
  if (!existing) return { connected: false };

  // Clear state FIRST so any concurrent ensureShared() callers that
  // re-enter during teardown see fresh state and take the headless
  // persistent branch (managed -> headless visibility toggle) rather than
  // reattaching to the soon-to-be-closed visible window.
  await mutateState(config.instance, (state) => {
    state.browser = null;
    addAudit(
      state,
      {
        actor: "user",
        action: "browser.disconnect",
        target: existing.mode === "managed" ? existing.dataDir ?? "managed" : redactUrlCredentials(existing.cdpUrl),
        risk: "medium",
        evidence: { mode: existing.mode, pid: existing.pid }
      },
      // Browser is an instance-shared resource — not bound to any one agent.
      { system: true }
    );
  });

  // For managed (visible) records: closing the BrowserContext terminates
  // the Chromium child. The next agent tool call relaunches the SAME
  // profile dir with headless: true, so the user's sign-ins remain
  // accessible. For cdp records: disconnect()ing leaves the user's
  // Chrome alone — they own that process.
  await disconnectSharedBrowser();

  return { connected: false };
}

// Internal helpers exported only for unit tests.
export const __test = {
  redactUrlCredentials,
  stripUrlCredentials,
  cdpHttpForm,
  validateCdpUrl,
  profileDirFor,
  MANAGED_CDP_SENTINEL,
  // Verifying the existsSync side effect of mkdirSync in tests would
  // require touching the real filesystem; the helper makes that observable.
  ensureProfileDir(config: RuntimeConfig): string {
    const dir = profileDirFor(config);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  exists: existsSync
};
