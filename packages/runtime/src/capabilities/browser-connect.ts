// Headed-browser connect/disconnect capability. The runtime exposes three
// HTTP routes that delegate to the functions in this module:
//
//   GET  /api/browser                 -> getBrowserConnection
//   POST /api/browser/connect         -> connectBrowser
//   POST /api/browser/disconnect      -> disconnectBrowser
//
// Two transports (see issue #420):
//
//   - DEFAULT (no record): the runtime drives its OWN spawned per-instance
//     Chrome (src/tools/browser.ts), launched lazily on the first browser tool
//     call against ~/.gini/instances/<inst>/chrome-profile/. Sign-ins land in
//     that profile dir and survive runtime/Chrome restarts and idle teardown.
//     Sign-in happens in-place via the `browser.connect` SetupRequest's in-chat
//     screencast of that headless Chrome — no persisted record.
//
//   - "cdp" (POST /api/browser/connect with `{ cdpUrl }`): the user points the
//     runtime at their OWN already-running external Chrome over a CDP websocket
//     URL. We probe the endpoint, persist the URL (credentials stripped) as the
//     `state.browser` record, and attach over CDP — never spawning or signalling
//     that process. connectOverCDP works under Bun via the bundled-ws→built-in
//     patch (patches/playwright-core@1.61.1.patch); it's an opt-in transport for
//     users who run their own Chrome.
//
// (The old "managed" visible-window mode was removed — issue #420.)
//
// The shape returned by the GET/POST handlers is `{ connected: boolean,
// record?: BrowserConnectionRecord }` so the CLI / webapp can render a uniform
// status card.

import { mkdirSync } from "node:fs";
import { addAudit, mutateState, now, readState } from "../state";
import { chromeProfileDirFor, disconnectSharedBrowser, safetyCheck } from "../tools/browser";
import type { BrowserConnectionRecord, RuntimeConfig } from "../types";

// We poll a user-supplied CDP /json/version endpoint every 500ms for up to 15s
// before giving up — the only place this capability waits on the network.
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;

type Status = {
  connected: boolean;
  record?: BrowserConnectionRecord;
};

// Pinpointed view of the /json/version JSON. We only care about the
// webSocketDebuggerUrl; the rest of the payload is metadata we don't use.
interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

// The tool-result JSON the chat-task loop receives when a browser.connect
// SetupRequest completes via the non-screencast fallback. Shared with the HTTP
// /complete handler (which needs it for the atomic claim's toolResult, BEFORE
// this module's audit write runs) so the two paths can never drift.
export const BROWSER_CONNECT_SPAWNED_RESULT = JSON.stringify({ success: true, connected: true, mode: "spawned" });

// GET /api/browser status. Reports the persisted cdp record when one exists
// (the user attached their own Chrome); otherwise the default spawned Chrome is
// an internal on-demand handle the user doesn't toggle, so `connected: false`
// is the truthful state.
export function getBrowserConnection(config: RuntimeConfig): Status {
  const record = readState(config.instance).browser ?? null;
  if (!record) return { connected: false };
  return { connected: true, record };
}

// HTTP probe of a CDP endpoint. The /json/version path returns Chrome's build
// info and the webSocketDebuggerUrl. Returns the parsed body on success or null
// if the host did not respond with a JSON payload before the deadline.
async function probeCdp(
  httpUrl: string,
  deadlineMs: number,
  intervalMs: number = PROBE_INTERVAL_MS
): Promise<CdpVersionInfo | null> {
  const start = Date.now();
  while (Date.now() < start + deadlineMs) {
    try {
      const response = await fetch(`${httpUrl.replace(/\/$/, "")}/json/version`, {
        // AbortSignal.timeout keeps a single hung connection from eating the
        // entire poll budget.
        signal: AbortSignal.timeout(intervalMs * 2)
      });
      if (response.ok) {
        const body = (await response.json()) as CdpVersionInfo;
        if (body && typeof body === "object") return body;
      }
    } catch {
      // Connection refused / network errors are expected during the startup
      // window — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// Maps a CDP ws://host:port/... URL onto its sibling http://host:port form for
// the /json/version probe. Falls back to the raw input if the URL parser
// rejects it (the caller will already have surfaced a validation error then).
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

// Strip embedded `user:pass@` credentials before persisting a redacted form for
// audit / event logs. We never want a basic-auth-bearing ws:// URL to leak
// through the activity stream.
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
    return "<redacted>";
  }
}

// Same shape, but at the storage boundary (state.json, GET /api/browser, the
// webapp) we actually drop the credentials rather than redacting to a sentinel.
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
    return url;
  }
}

// PUBLIC input shape — accepted directly from authenticated callers (HTTP POST
// /api/browser/connect body, CLI). Keep this surface minimal: the HTTP route
// hands the parsed body straight to connectBrowser, so any field that affects
// audit/trust semantics belongs in InternalConnectOptions instead, reachable
// only from in-process call sites.
export interface ConnectInput {
  cdpUrl?: unknown;
}

// INTERNAL options — never plumbed from network input. The HTTP route omits
// this arg, so `skipAudit` always defaults to false on that path and the
// capability always writes its `browser.connect` audit row. Test-only probe
// overrides keep the unreachable-endpoint failure path fast without burning the
// full 15s real deadline.
interface InternalConnectOptions {
  skipAudit?: boolean;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
}

// Serializes concurrent /api/browser/connect calls so two parallel attaches
// can't both write a record and leak a handle.
let pendingConnect: Promise<Status> | null = null;
// Same idea for /api/browser/disconnect.
let pendingDisconnect: Promise<Status> | null = null;

// Connect. With no `cdpUrl` this is a no-op acknowledgement — the default
// transport is the spawned Chrome, launched lazily by the next browser tool
// call, which carries no record. With a `cdpUrl` it probes the user's external
// Chrome and attaches over CDP, persisting the `state.browser` record.
//
// The third `internal` argument is OFF-LIMITS to network callers (the HTTP
// route omits it); it carries flags that affect audit/trust semantics.
export function connectBrowser(
  config: RuntimeConfig,
  input: ConnectInput = {},
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
  // ABSENT cdpUrl (undefined / null) → the default spawned transport. A bare
  // connect means "use the default": if a cdp record is still persisted,
  // leaving it would let the next tool call keep attaching to the user's
  // external Chrome, contradicting the {connected:false} we return here. Drop
  // it (and the in-process handle, and write the disconnect audit row) so the
  // next call relaunches spawned. Otherwise it's a pure no-op acknowledgement —
  // the spawned Chrome launches lazily on the first browser_* tool call.
  if (input.cdpUrl === undefined || input.cdpUrl === null) {
    // Route through the public disconnectBrowser so the teardown shares the
    // pendingDisconnect single-flight (a concurrent /api/browser/disconnect
    // folds into the same promise rather than double-tearing-down + writing a
    // duplicate audit row).
    if (readState(config.instance).browser) return await disconnectBrowser(config);
    return { connected: false };
  }
  // PRESENT but not a non-empty string → malformed input. Reject it as a 400
  // (the route maps "Invalid cdpUrl" → 400) WITHOUT touching existing state — a
  // {cdpUrl: 123} or {cdpUrl: ""} must not silently disconnect an active cdp
  // attach the way an absent cdpUrl does.
  if (typeof input.cdpUrl !== "string" || input.cdpUrl.length === 0) {
    throw new Error(`Invalid cdpUrl: ${JSON.stringify(input.cdpUrl)}`);
  }

  // Validate caller input BEFORE touching any existing state.
  const validated = validateCdpUrl(input.cdpUrl);
  if (!validated.ok) throw new Error(validated.error);
  const httpForm = cdpHttpForm(validated.url);
  // CDP endpoints are always loopback (127.0.0.1:9222 / localhost typically) —
  // that's the whole point of CDP. Pass allowLoopback so the navigation-SSRF
  // block on loopback doesn't refuse a legitimate CDP attach. The agent's own
  // navigation surface still hits the default safetyCheck() (no allowLoopback).
  const blocked = safetyCheck(httpForm, { allowLoopback: true });
  if (blocked) throw new Error(`Invalid cdpUrl: ${blocked}`);

  // Probe tuning resolves from the in-process `internal` arg, then a server-side
  // env override, then the module constants. None is reachable from `input`.
  const envInterval = Number(process.env.GINI_CDP_PROBE_INTERVAL_MS);
  const envTimeout = Number(process.env.GINI_CDP_PROBE_TIMEOUT_MS);
  const probeIntervalMs =
    internal.probeIntervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : PROBE_INTERVAL_MS);
  const probeTimeoutMs =
    internal.probeTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : PROBE_TIMEOUT_MS);

  const existing = readState(config.instance).browser ?? null;
  if (existing && targetsExistingRecord(existing, validated.url)) {
    // Same host:port already recorded — re-probe its liveness in one short poll
    // window rather than waiting out a cold start.
    const probe = await probeCdp(cdpHttpForm(existing.cdpUrl), probeIntervalMs * 2, probeIntervalMs);
    if (probe) {
      // Chrome regenerates its browser-level ws path (/devtools/browser/<guid>)
      // on every restart, and playwright's connectOverCDP uses a ws URL
      // VERBATIM (no /json/version re-resolution). So the host:port probe can
      // succeed against a restarted Chrome while the stored ws path is stale —
      // refresh the record from the probe's fresh webSocketDebuggerUrl before
      // returning, or the next tool call would attach to a dead guid.
      const freshWs = probe.webSocketDebuggerUrl ? stripUrlCredentials(probe.webSocketDebuggerUrl) : existing.cdpUrl;
      const record: BrowserConnectionRecord = freshWs === existing.cdpUrl ? existing : { ...existing, cdpUrl: freshWs };
      if (record !== existing) {
        await mutateState(config.instance, (state) => {
          state.browser = record;
        });
      }
      // Drop any cached in-process handle (e.g. a previously-spawned Chrome)
      // so the NEXT browser tool call re-reads this cdp record and attaches via
      // the cdp branch rather than reusing the stale spawned handle.
      await disconnectSharedBrowser();
      return { connected: true, record };
    }
    // Stale record (the user's Chrome went away) — clear it BEFORE the fresh
    // attach so that if the fresh attach also fails (endpoint truly gone),
    // state is left cleanly disconnected rather than holding a dead record that
    // GET /api/browser still reports as connected and that the next tool call
    // wastes a 60s connectOverCDP timeout on. The liveness probe above already
    // ran a short window and returned null, so we've decided this endpoint is
    // dead — clearing here matches the pre-rewrite contract.
    await mutateState(config.instance, (state) => {
      state.browser = null;
    });
  }

  const result = await connectExisting(config, validated.url, {
    skipAudit: internal.skipAudit,
    probeTimeoutMs,
    probeIntervalMs
  });
  // The cdp record is now persisted; drop the cached in-process handle so
  // ensureShared rebuilds via the cdp branch (connectOverCDP) on the next tool
  // call instead of reusing a previously-spawned headless Chrome.
  await disconnectSharedBrowser();
  return result;
}

// Compare the caller's requested endpoint against the existing record. True
// when the hosts match (a reconnect to the same Chrome); false means the caller
// wants a different endpoint and we should re-attach.
function targetsExistingRecord(existing: BrowserConnectionRecord, callerCdp: string): boolean {
  try {
    const wanted = new URL(callerCdp);
    const have = new URL(existing.cdpUrl);
    return wanted.host === have.host;
  } catch {
    return false;
  }
}

// `validatedUrl` is the WHATWG-normalized form already vetted by
// connectBrowserInner (validateCdpUrl + safetyCheck on the http form). We
// re-derive the http form here for the probe.
async function connectExisting(
  config: RuntimeConfig,
  validatedUrl: string,
  opts: { skipAudit?: boolean; probeTimeoutMs?: number; probeIntervalMs?: number } = {}
): Promise<Status> {
  const httpForm = cdpHttpForm(validatedUrl);
  const probe = await probeCdp(
    httpForm,
    opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    opts.probeIntervalMs ?? PROBE_INTERVAL_MS
  );
  if (!probe) {
    throw new Error(`Could not reach CDP endpoint at ${redactUrlCredentials(validatedUrl)}`);
  }
  const probeUrl = probe.webSocketDebuggerUrl ?? validatedUrl;
  const record: BrowserConnectionRecord = {
    mode: "cdp",
    // Strip embedded credentials before persisting — this record is surfaced
    // by GET /api/browser.
    cdpUrl: stripUrlCredentials(probeUrl),
    startedAt: now()
  };
  await mutateState(config.instance, (state) => {
    state.browser = record;
    // The in-process tool-dispatch path (skipAudit) writes its own richer
    // browser.connect row carrying the approval reason + approvalId; emitting a
    // second row here would double-count.
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
  // Drop the in-process handle regardless: for a cdp record this detaches from
  // the user's Chrome (never killing it); for the default spawned Chrome it
  // tears the spawned handle down and the next tool call relaunches the same
  // profile dir. The on-disk profile is untouched either way.
  //
  // We write a `browser.disconnect` audit row ONLY when a cdp record exists:
  // that is a user-meaningful transport change (the user detaches the runtime
  // from their own external Chrome and reverts to the spawned default). A
  // spawned-handle drop with no record is an internal lifecycle reset — the
  // same per-instance Chrome relaunches on the next tool call — so auditing it
  // would be noise, not a security-relevant event. (The asymmetry is by design,
  // not a missing audit row.)
  if (existing) {
    await mutateState(config.instance, (state) => {
      state.browser = null;
      addAudit(
        state,
        {
          actor: "user",
          action: "browser.disconnect",
          target: redactUrlCredentials(existing.cdpUrl),
          risk: "medium",
          evidence: { mode: existing.mode }
        },
        // Browser is an instance-shared resource — not bound to any one agent.
        { system: true }
      );
    });
  }
  await disconnectSharedBrowser();
  return { connected: false };
}

// Drives the user-side completion of a `browser.connect` SetupRequest's
// non-screencast path. Sign-in normally happens in-place via the screencast
// bridge (handled directly in the /complete HTTP route), so this is the
// degenerate fallback: the user has finished acting in the agent's spawned
// Chrome and cookies are already in the shared profile — there is nothing to
// relaunch. We write the rich `browser.connect` audit row carrying the
// originating setup id and user-facing reason and return the JSON tool-result
// string the chat-task loop expects.
export async function completeBrowserConnectSetup(
  config: RuntimeConfig,
  setup: {
    id: string;
    target: string;
    taskId?: string;
    agentId?: string;
    payload: Record<string, unknown>;
  }
): Promise<{ ok: boolean; result: string }> {
  const reasonTarget = typeof setup.payload.reason === "string" && setup.payload.reason.length > 0
    ? setup.payload.reason
    : setup.target;
  await mutateState(config.instance, (state) => {
    addAudit(
      state,
      {
        actor: "user",
        action: "browser.connect",
        target: reasonTarget,
        risk: "medium",
        taskId: setup.taskId,
        runId: setup.taskId ? state.tasks.find((task) => task.id === setup.taskId)?.runId : undefined,
        approvalId: setup.id,
        evidence: { success: true, mode: "spawned" }
      },
      setupAuditContext(setup)
    );
  });
  return { ok: true, result: BROWSER_CONNECT_SPAWNED_RESULT };
}

// Inlined here (rather than importing approvalAgentContext from src/agent.ts)
// because capabilities/* must not depend on agent.ts — that would create a
// cycle. Matches approvalAgentContext: prefer task scope, then agent scope,
// then system.
function setupAuditContext(setup: {
  taskId?: string;
  agentId?: string;
}): { taskId: string } | { agentId: string } | { system: true } {
  if (setup.taskId) return { taskId: setup.taskId };
  if (setup.agentId) return { agentId: setup.agentId };
  return { system: true };
}

// Thin alias kept for back-compat with the test helpers. The spawned launch
// uses this per-instance profile dir; ensuring it exists keeps the first
// tool-call launch from racing directory creation.
function profileDirFor(config: RuntimeConfig): string {
  return chromeProfileDirFor(config.instance);
}

// Internal helpers exported only for unit tests.
export const __test = {
  profileDirFor,
  validateCdpUrl,
  cdpHttpForm,
  redactUrlCredentials,
  stripUrlCredentials,
  // Verifying the existsSync side effect of mkdirSync in tests would require
  // touching the real filesystem; the helper makes that observable.
  ensureProfileDir(config: RuntimeConfig): string {
    const dir = profileDirFor(config);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
};
