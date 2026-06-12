// Tunnel connectivity behavior module (see ADR tunnel-connectivity.md).
// Mirrors src/integrations/relay.ts: thin functions over the persisted
// singleton (`state.tunnel`) that the HTTP routes and CLI delegate to.
//
// The tunnel gateway exposes a remote URL for this instance through one of
// several providers. EVERY function here returns the full TunnelState so a
// single fetch drives the whole selection/connect/connected UI:
//
//   GET  /api/tunnel             -> getTunnel
//   POST /api/tunnel/select      -> selectProvider
//   POST /api/tunnel/connect     -> connectTunnel
//   POST /api/tunnel/cancel      -> cancelTunnel
//   POST /api/tunnel/disconnect  -> disconnectTunnel
//
// The provider catalog is rebuilt from code on every read (NOT persisted),
// so adding a provider never needs a state migration. Only the user's
// selection + connection status live in `state.tunnel`.
//
// gini-relay (the enabled provider) is wired through its client library:
// `loginUrl(deps)` mints the OAuth-loopback consent URL, which we open in
// the HOST browser; `waitForSession()` resolves with the session token +
// assigned subdomain; `buildTunnel(opts)` builds a supervised native frpc
// child that exposes the instance's gateway port. The public URL is
// `https://<subdomain>.<relayDomain>`. Every gini-relay seam (login
// primitive, tunnel builder, credential store, browser opener, port
// resolver) is injectable so unit tests never hit the network, OAuth, or
// the host browser. See `setTunnelDeps`.

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildTunnel as realBuildTunnel,
  createStore as realCreateStore,
  loginUrl as realLoginUrl,
  resolveDefaults as realResolveDefaults,
  type Frpc,
  type LoginHandle,
  type RelayDefaults,
  type Session,
  type Store,
  type TunnelOptions
} from "gini-relay";
import type {
  Instance,
  RuntimeConfig,
  RuntimeState,
  TunnelProvider,
  TunnelProviderId,
  TunnelState
} from "../types";
import { addAudit, createTunnelRecord, mutateState, readState } from "../state";
import { appendLog } from "../state/trace";
import { relayHome } from "../paths";
import { isSupervisedWebChild } from "../runtime/health-probe";

// ---------------------------------------------------------------------------
// Injectable gini-relay seams.
//
// The real implementations come straight from the gini-relay client package.
// Tests call `setTunnelDeps` to swap in fakes so the connect flow exercises
// the connecting/connected/error/cancel transitions without a relay backend,
// a real OAuth round-trip, a host browser, or a spawned frpc child.
// ---------------------------------------------------------------------------

// A started, supervised frpc tunnel. We only need the lifecycle surface the
// connect flow drives (`start`, `stop`, `exited`) so the seam stays narrow
// and easy to fake; the real `Frpc` satisfies this structurally.
export interface TunnelChild {
  start(): Promise<unknown>;
  stop(): Promise<number>;
  exited: Promise<number>;
}

export interface TunnelDeps {
  // Library login primitive: returns the consent URL plus `waitForSession`
  // and `cancel`. No browser, no printing.
  loginUrl: typeof realLoginUrl;
  // Build (do not start) a supervised native frpc tunnel for a session+port.
  buildTunnel: (opts: TunnelOptions) => TunnelChild;
  // The relay credential store (deviceId + session persistence). Scoped to the
  // instance (relayHome) so each instance owns its own device/session and can't
  // share a subdomain with — or disconnect — another instance.
  createStore: (config: RuntimeConfig) => Store;
  // The public relay defaults (relayUrl, relayDomain, loopbackPorts, …).
  resolveDefaults: () => RelayDefaults;
  // Open the consent URL in the HOST browser. Defaults to `open <url>`.
  openBrowser: (url: string) => void;
  // Resolve the local port the tunnel should expose for an instance (the gateway port).
  resolveLocalPort: (config: RuntimeConfig) => number;
  // Probe whether THIS instance's web app is reachable on the resolved port (the
  // gateway port; the /api/runtime/__healthz probe transits the gateway's
  // reverse-proxy to the web child) before we advertise a public URL. Verifies
  // the gini-web identity marker (not just any HTTP response), so a stale port
  // file or a port-squatting process can't get published to the public relay
  // URL. Prevents a "connected" record pointing at a dead/foreign local port
  // (which surfaces to visitors as a confusing relay 404).
  probeLocalPort: (config: RuntimeConfig, port: number) => Promise<boolean>;
  // Log out of the relay LOCALLY: delete this instance's stored credential so a
  // subsequent connect requires a fresh login. Local-only by design — no
  // server-side revoke — which keeps the same stable subdomain/URL on reconnect
  // while still rotating the token. Called by disconnect (= sever the connector).
  logout: (config: RuntimeConfig) => Promise<void>;
}

// The default host-browser opener. The auth code comes back to THIS machine's
// loopback, so the consent URL must be approved in a browser on this same
// host. `open` is the macOS opener gini already shells out to elsewhere;
// Bun.spawn detaches it so a slow browser launch never blocks the connect
// flow. Exported so a test can drive it with a stubbed spawn.
export function defaultOpenBrowser(url: string, spawn: typeof Bun.spawn = Bun.spawn): void {
  spawn(["open", url]);
}

// The local port the tunnel exposes: the instance's GATEWAY port (config.port).
// The gateway serves its native /api/* directly AND reverse-proxies the web app
// — UI, assets, /api/runtime/*, HMR — to the Next.js web child (see ADR
// gateway-web-reverse-proxy.md). Exposing the gateway therefore makes one relay
// URL serve both the API (e.g. a mobile client's /api/* calls) and the web UI.
// Resolution order, most-authoritative first:
//   1. GINI_TUNNEL_PORT env override (operator escape hatch / tests).
//   2. The gateway port (`config.port`), which the CLI pins to the actually-
//      bound port before launch (src/cli/process.ts).
function defaultResolveLocalPort(config: RuntimeConfig): number {
  const override = Number(process.env.GINI_TUNNEL_PORT);
  if (Number.isFinite(override) && override > 0) return override;
  return config.port;
}

// Builds the real gini-relay-backed seam set. Exported so a test can assert
// the wrappers delegate to the library without a network round-trip (each
// wrapper is pure construction — `loginUrl`/`start` are what actually touch
// the network, and those are never called here).
// Log out of the relay: delete the LOCAL credential so the next connect must
// log in again. disconnect calls this — disconnecting logs you out of the
// connector. We clear the local session only (no server-side revoke), so a
// re-login keeps the same stable subdomain/URL while still requiring fresh
// auth (and re-login rotates the token anyway). The store is instance-scoped
// (relayHome) so logging out one instance never clears another's session.
// Seams injected for tests.
export async function defaultLogout(
  instance: Instance,
  makeStore: (instance: Instance) => Store = (inst) => realCreateStore({ home: relayHome(inst) }),
  unlink: (path: string) => void = unlinkSync
): Promise<void> {
  const store = makeStore(instance);
  if (!store.readSession()) return;
  try {
    unlink(join(store.home, "session.json"));
  } catch {
    // already gone — nothing to clear.
  }
}

export function makeDefaultDeps(): TunnelDeps {
  return {
    loginUrl: realLoginUrl,
    buildTunnel: (opts: TunnelOptions): TunnelChild => realBuildTunnel(opts) as Frpc,
    createStore: (config: RuntimeConfig) => realCreateStore({ home: relayHome(config.instance) }),
    resolveDefaults: () => realResolveDefaults(),
    openBrowser: defaultOpenBrowser,
    resolveLocalPort: defaultResolveLocalPort,
    probeLocalPort: (config: RuntimeConfig, port: number) => isSupervisedWebChild(config.instance, port),
    logout: (config: RuntimeConfig) => defaultLogout(config.instance)
  };
}

let deps: TunnelDeps = makeDefaultDeps();

// Swap the gini-relay seams. Tests inject fakes; calling with no argument
// restores the real implementations (so a test can clean up after itself).
export function setTunnelDeps(next?: Partial<TunnelDeps>): void {
  deps = next ? { ...makeDefaultDeps(), ...next } : makeDefaultDeps();
}

// ---------------------------------------------------------------------------
// Live-child supervision.
//
// Each instance owns at most one in-flight login + one running frpc child.
// We keep the handles in a module-level registry so `disconnectTunnel` can
// stop the child, `cancelTunnel` can abort a pending login, and the
// startup reconcile can detect that no child is alive and reset a stale
// "connected" record back to idle.
// ---------------------------------------------------------------------------
interface Supervisor {
  // Pending login handle (present from connect-start until the session
  // resolves or the login is cancelled).
  login?: LoginHandle;
  // The running frpc child (present once the tunnel is up).
  child?: TunnelChild;
  // The in-flight background connect promise — awaited by tests to observe
  // the terminal (connected/error) transition deterministically.
  settled?: Promise<void>;
}

const supervisors = new Map<Instance, Supervisor>();

function supervisor(instance: Instance): Supervisor {
  let entry = supervisors.get(instance);
  if (!entry) {
    entry = {};
    supervisors.set(instance, entry);
  }
  return entry;
}

// Tear down a live child + pending login for an instance. Best-effort: a
// stop/cancel failure is swallowed so disconnect/cancel always settle to
// idle. The registry entry is cleared so a subsequent connect starts clean.
function teardown(instance: Instance): void {
  const entry = supervisors.get(instance);
  if (!entry) return;
  try {
    entry.login?.cancel();
  } catch {
    // A cancel after the login already settled is a no-op upstream; swallow.
  }
  if (entry.child) {
    void entry.child.stop().catch(() => {
      // The child may already be gone; the OS reaps it on exit regardless.
    });
  }
  supervisors.delete(instance);
}

// Stop every live tunnel child + pending login across all instances. Called on
// runtime shutdown so frpc children are torn down gracefully (their relay-side
// registration severed) instead of left running through the drain window. The
// registry is cleared first, so each child's exit watcher sees its entry is gone
// and writes no spurious "error" record during shutdown. Best-effort and awaited
// so the drain can wait on a clean teardown.
export async function stopAllTunnels(): Promise<void> {
  const entries = [...supervisors.values()];
  supervisors.clear();
  await Promise.all(
    entries.map((entry) => {
      try {
        entry.login?.cancel();
      } catch {
        // login already settled — nothing to cancel.
      }
      return entry.child?.stop().then(() => undefined).catch(() => undefined) ?? Promise.resolve();
    })
  );
}

// ---------------------------------------------------------------------------
// Provider catalog.
// ---------------------------------------------------------------------------

// The static provider catalog. gini-relay is the only enabled provider for
// now; the rest are placeholders surfaced with a `requires` explanation of
// the prerequisite that's missing. The order here is the order the panel
// renders them. Rebuilt fresh on every read — never persisted.
function providerCatalog(): TunnelProvider[] {
  return [
    { id: "gini-relay", name: "Gini Relay", enabled: true },
    { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
    { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
    { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "Cloudflare account" }
  ];
}

// Resolve a catalog entry by id, or undefined if the id isn't a known
// provider. Selection/connect validate against this so a disabled or
// unknown provider is rejected before any state mutation.
function findProvider(id: string): TunnelProvider | undefined {
  return providerCatalog().find((provider) => provider.id === id);
}

// Build the full TunnelState from the persisted singleton (which may be
// null) plus the freshly-rebuilt catalog. `url` is included only when
// connected; `message` only on error — matching the discriminated contract
// the UI relies on.
function toState(record: RuntimeState["tunnel"]): TunnelState {
  const providers = providerCatalog();
  if (!record) {
    return { providers, selectedProvider: null, status: "idle" };
  }
  const state: TunnelState = {
    providers,
    selectedProvider: record.selectedProvider,
    status: record.status
  };
  if (record.status === "connected" && record.url) state.url = record.url;
  if (record.status === "error" && record.message) state.message = record.message;
  return state;
}

export function getTunnel(config: RuntimeConfig): TunnelState {
  return toState(readState(config.instance).tunnel ?? null);
}

// Save a provider selection WITHOUT connecting. Validates the provider is a
// known, enabled catalog entry; rejects disabled/unknown ones. Status stays
// "idle" — the user still has to click Connect. Clears any prior url/message
// because the selection changed.
export async function selectProvider(config: RuntimeConfig, provider: string): Promise<TunnelState> {
  const entry = findProvider(provider);
  if (!entry) throw new Error(`Unknown tunnel provider: ${provider}`);
  if (!entry.enabled) {
    throw new Error(`Tunnel provider ${entry.name} is not available${entry.requires ? ` (requires ${entry.requires})` : ""}.`);
  }
  // Re-selecting the provider you're already connected to (or connecting with)
  // is a no-op: don't tear a live tunnel down just because the user re-clicked
  // its row in the edit panel. Only an actual provider change drops to idle.
  const current = readState(config.instance).tunnel;
  if (
    current?.selectedProvider === entry.id &&
    (current.status === "connected" || current.status === "connecting")
  ) {
    return toState(current);
  }
  // Switching providers drops to "idle", so stop any live child / pending login
  // first — otherwise the old tunnel would keep running while the record reads
  // idle (an orphaned child). No-op when nothing is live.
  teardown(config.instance);
  return mutateState(config.instance, (state) => {
    const record = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: entry.id,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
    state.tunnel = record;
    // Selection is an instance-level transport choice, like a relay.
    addAudit(
      state,
      {
        actor: "user",
        action: "tunnel.select",
        target: entry.id,
        risk: "low",
        evidence: { provider: entry.id }
      },
      { system: true }
    );
    return toState(state.tunnel);
  });
}

// Begin a connect. Validates the target provider (the optional `provider`
// arg overrides the saved selection; otherwise the saved selection is used)
// is enabled, flips status to "connecting", and kicks off the gini-relay
// login + frpc handshake in the BACKGROUND. Returns immediately with the
// "connecting" state; the UI/CLI polls GET /api/tunnel until the background
// flow flips status to "connected" (with the public url) or "error" (with a
// message). The OAuth consent URL is opened in the host browser.
export async function connectTunnel(config: RuntimeConfig, provider?: string): Promise<TunnelState> {
  const requested = provider ?? readState(config.instance).tunnel?.selectedProvider ?? null;
  if (!requested) throw new Error("No tunnel provider selected.");
  const entry = findProvider(requested);
  if (!entry) throw new Error(`Unknown tunnel provider: ${requested}`);
  if (!entry.enabled) {
    throw new Error(`Tunnel provider ${entry.name} is not available${entry.requires ? ` (requires ${entry.requires})` : ""}.`);
  }

  // Tear down any previous in-flight login / live child, then claim a fresh
  // supervisor entry SYNCHRONOUSLY (no await between teardown and the claim) so
  // two concurrent connects get DISTINCT entries: the older run sees it is no
  // longer current and aborts instead of double-spawning a tunnel.
  teardown(config.instance);
  const sup = supervisor(config.instance);

  const id: TunnelProviderId = entry.id;
  const connecting = await mutateState(config.instance, (state) => {
    state.tunnel = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: id,
      status: "connecting",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
    addAudit(
      state,
      {
        actor: "user",
        action: "tunnel.connect",
        target: id,
        risk: "medium",
        evidence: { provider: id }
      },
      { system: true }
    );
    return toState(state.tunnel);
  });

  // Fire the background handshake. We retain its promise on the (already
  // claimed) supervisor so tests can await the terminal transition; production
  // never awaits it (the UI polls). The flow catches its own errors into "error".
  sup.settled = runConnect(config, id, sup);
  return connecting;
}

// Override-port resume readiness knobs. The default resume fronts the gateway
// port and is gated on the bind (gatewayReady) with no poll; these apply ONLY to
// the GINI_TUNNEL_PORT override fallback, where the tunnel exposes a port this
// process doesn't bind and must poll it for readiness with retry (the override
// target may still be coming up after a restart). Read at call time so tests can
// tighten them.
function resumeWaitMs(): number {
  const v = Number(process.env.GINI_TUNNEL_RESUME_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}
function resumePollMs(): number {
  const v = Number(process.env.GINI_TUNNEL_RESUME_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 1_000;
}

// Poll the resolved local port until the identity probe succeeds or the deadline
// elapses. Used only by the resume's GINI_TUNNEL_PORT-override fallback. Bails
// false the moment the run is superseded (a user connect/cancel during the wait)
// so it never fights a winner.
async function waitForLocalPort(
  config: RuntimeConfig,
  port: number,
  isCurrent: () => boolean
): Promise<boolean> {
  const deadline = Date.now() + resumeWaitMs();
  while (isCurrent()) {
    if (await deps.probeLocalPort(config, port)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(resumePollMs());
  }
  return false;
}

// Settle the tunnel to "idle" keeping the selection. Used by the boot resume when
// it can't reconnect non-interactively — there's no stored session, or (on a
// GINI_TUNNEL_PORT override) the resolved port never verified as serving gini: a
// routine restart shouldn't surface an "error" badge, and idle lets the user
// reconnect manually. No audit row — the appendLog at the call site is the trace.
async function settleResumeIdle(config: RuntimeConfig, provider: TunnelProviderId): Promise<void> {
  await mutateState(config.instance, (state) => {
    state.tunnel = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: provider,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
  });
}

// The background login + tunnel handshake. Runs the full gini-relay flow:
// mint the consent URL → open it in the host browser → await the session →
// build + start frpc on the local gateway port → record the public url. On any
// failure (or if the connect was cancelled mid-flight) it writes an "error"
// (or leaves the cancel-written "idle") record. Never throws — errors are
// captured into state so the polling UI surfaces them.
//
// opts (boot resume only):
//   reuseOnly    — never open a browser / mint a fresh login. If the stored
//                  session is missing or rejected, settle to idle instead. Keeps
//                  a headless restart from popping an OAuth tab on the server.
//                  Also skips the pre-connect web-readiness probe: a resume
//                  restores the remote client's only channel as soon as the
//                  gateway port is ours, not after the web child's recompile.
//   gatewayReady — resolves once THIS process has bound the gateway port. The
//                  resume awaits it before building frpc, so the stable public
//                  URL is never forwarded to a stale/foreign listener still
//                  holding the port (a paired browser would otherwise hand it
//                  the session cookie). Resolves the instant Bun.serve binds and
//                  never if the bind fails. Omitting it is NOT a bypass: the
//                  resume then degrades to the local-port probe below (the same
//                  guard a fresh connect uses), so it still verifies the port —
//                  it just loses the no-web-wait fast path. Tests omit it (or
//                  point the port off config.port) to drive that probe path.
async function runConnect(
  config: RuntimeConfig,
  provider: TunnelProviderId,
  sup: Supervisor,
  opts: { reuseOnly?: boolean; gatewayReady?: Promise<void> } = {}
): Promise<void> {
  // This run "owns" the instance only while its supervisor entry is the current
  // one. A cancel/disconnect (teardown deletes the entry) or a newer concurrent
  // connect (replaces it) means we were superseded — we must not publish
  // "connected" or leak the child we spawned.
  const isCurrent = (): boolean => supervisors.get(config.instance) === sup;
  try {
    const store = deps.createStore(config);
    const relay = deps.resolveDefaults();
    const port = deps.resolveLocalPort(config);
    // Don't expose `port` through the relay until we know it's legitimately
    // ours. Three cases:
    //   - Fresh, user-initiated connect: probe the local web port and refuse to
    //     advertise a brand-new public URL unless it serves gini — so a
    //     not-yet-ready app or a stale/foreign port is never published.
    //   - Resume of the gateway port (the default): the tunnel fronts THIS
    //     process's own gateway port (config.port), but reconcileTunnelOnStartup
    //     runs before Bun.serve binds it — so wait only for the bind. gatewayReady
    //     resolves the instant Bun.serve binds config.port (and never if the bind
    //     fails), proving we own the port; no web-child probe, so reachability
    //     returns the moment the port is ours instead of after the web recompile.
    //     The relay URL is a remote client's only channel to watch the restart
    //     finish, so the client's own polls — and the watchdog — handle web-child
    //     readiness, not the tunnel.
    //   - Resume of a NON-gateway port: a GINI_TUNNEL_PORT override points the
    //     tunnel at a port this process never binds, so gatewayReady (which proves
    //     only config.port) can't vouch for it. Fall back to a bounded, cancellable
    //     poll of that port's identity before exposing it, mirroring the
    //     fresh-connect guard (the override target may still be coming up after a
    //     restart), so a stale override can't publish a foreign listener.
    let overrideProbeFailed = false;
    if (!opts.reuseOnly) {
      if (!(await deps.probeLocalPort(config, port))) {
        throw new Error(
          `Gini's web UI isn't responding on port ${port} — start it, then reconnect.`
        );
      }
    } else if (opts.gatewayReady && port === config.port) {
      await opts.gatewayReady;
    } else {
      overrideProbeFailed = !(await waitForLocalPort(config, port, isCurrent));
    }
    // A cancel/disconnect/supersede may have landed during the await above — bail
    // before settling idle, minting a login, or building frpc.
    if (!isCurrent()) {
      appendLog(config.instance, "tunnel.connect.aborted", { provider });
      return;
    }
    if (overrideProbeFailed) {
      // Resume couldn't verify the override port — don't expose it. Settle idle so
      // the operator can reconnect rather than surfacing a spurious error.
      await settleResumeIdle(config, provider);
      appendLog(config.instance, "tunnel.resume.web_unavailable", { provider, port });
      return;
    }

    const startWith = async (s: Session): Promise<TunnelChild> => {
      const child = deps.buildTunnel({ session: s, deviceId: store.deviceId(), port, defaults: relay });
      sup.child = child;
      await child.start();
      return child;
    };

    // Reuse the stored session if the device already has one — gini-relay
    // sessions don't expire, so a prior login serves indefinitely. This skips
    // the browser round-trip (and the token churn of a re-login) on every
    // connect. If starting the tunnel with the stored session fails for ANY
    // reason we fall back to a fresh OAuth login: this self-heals a genuinely
    // revoked/invalid session, at the cost of also re-prompting on a transient
    // start failure (gini-relay doesn't surface a clean auth-vs-transport
    // signal to distinguish the two).
    let session = store.readSession();
    let child: TunnelChild | undefined;
    if (session) {
      try {
        child = await startWith(session);
      } catch {
        sup.child = undefined;
        session = null;
      }
    }
    if (!session) {
      // Boot resume with no usable stored session: do NOT open a browser / mint a
      // login on a headless restart. Settle idle so the user reconnects manually.
      // (A record that was "connected" at shutdown normally still has its session,
      // so this is the defensive edge — e.g. the session file was cleared.)
      if (opts.reuseOnly) {
        if (isCurrent()) await settleResumeIdle(config, provider);
        appendLog(config.instance, "tunnel.resume.no_session", { provider });
        return;
      }
      const handle = await deps.loginUrl({
        store,
        relayUrl: relay.relayUrl,
        loopbackPorts: relay.loopbackPorts
      });
      // teardown may have landed during loginUrl's await — cancel the freshly
      // minted login (tears down its loopback) instead of opening the browser.
      if (!isCurrent()) {
        try {
          handle.cancel();
        } catch {
          // login already settled — nothing to cancel.
        }
        appendLog(config.instance, "tunnel.connect.aborted", { provider });
        return;
      }
      sup.login = handle;
      deps.openBrowser(handle.url);
      session = await handle.waitForSession();
      // The login resolved; from here a cancel acts through the child/teardown.
      sup.login = undefined;
      child = await startWith(session);
    }

    // A cancel/disconnect or a newer connect may have torn us down while we were
    // awaiting the login/handshake. If so, stop the child we just started (so it
    // isn't orphaned) and bail without clobbering the record they wrote.
    if (!isCurrent()) {
      void child?.stop().catch(() => {});
      sup.child = undefined;
      appendLog(config.instance, "tunnel.connect.aborted", { provider });
      return;
    }

    const url = `https://${session.subdomain}.${relay.relayDomain}`;
    await mutateState(config.instance, (state) => {
      state.tunnel = createTunnelRecord(state, {
        ...(state.tunnel ?? {}),
        selectedProvider: provider,
        status: "connected",
        url,
        subdomain: session.subdomain,
        message: undefined
      });
      addAudit(
        state,
        {
          actor: "runtime",
          action: "tunnel.connected",
          target: provider,
          risk: "medium",
          evidence: { provider, url, port }
        },
        { system: true }
      );
    });
    appendLog(config.instance, "tunnel.connected", { provider, url, port });
    // Watch the live child for an unexpected exit (crash, relay drop) so a dead
    // tunnel flips to "error" instead of reading "connected" forever.
    if (child) watchChildExit(config, provider, sup, child);
  } catch (error) {
    // A teardown (cancel/disconnect) or a newer connect replaced our registry
    // entry; if we're no longer current the connect was aborted/superseded on
    // purpose — don't clobber the record they wrote with a spurious error.
    // Cancel a pending login first: if loginUrl bound its loopback but a later
    // step threw (e.g. openBrowser failed), nulling the ref alone would leak
    // that server — cancel() tears it down and is idempotent if already settled.
    const pendingLogin = sup.login;
    sup.login = undefined;
    sup.child = undefined;
    if (pendingLogin) {
      try {
        pendingLogin.cancel();
      } catch {
        // login already settled — nothing to cancel.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!isCurrent()) {
      appendLog(config.instance, "tunnel.connect.aborted", { provider, message });
      return;
    }
    await mutateState(config.instance, (state) => {
      state.tunnel = createTunnelRecord(state, {
        ...(state.tunnel ?? {}),
        selectedProvider: provider,
        status: "error",
        url: undefined,
        subdomain: undefined,
        message
      });
      addAudit(
        state,
        {
          actor: "runtime",
          action: "tunnel.error",
          target: provider,
          risk: "medium",
          evidence: { provider, message }
        },
        { system: true }
      );
    });
    appendLog(config.instance, "tunnel.connect.error", { provider, message });
  }
}

// After a successful connect, react to the frpc child exiting on its own (crash,
// relay drop, network change). The guard inside mutateState runs atomically with
// every other state write: it only flips "connected" -> "error" if this is still
// the live child AND we're still connected, so an intentional cancel/disconnect
// (which clears/replaces the entry and writes "idle" first) or a newer connect is
// never clobbered. Without this a dead tunnel would advertise a live URL forever.
function watchChildExit(
  config: RuntimeConfig,
  provider: TunnelProviderId,
  sup: Supervisor,
  child: TunnelChild
): void {
  void child.exited.then(async (code) => {
    try {
      await mutateState(config.instance, (state) => {
        if (
          supervisors.get(config.instance) !== sup ||
          sup.child !== child ||
          state.tunnel?.status !== "connected"
        ) {
          return;
        }
        sup.child = undefined;
        state.tunnel = createTunnelRecord(state, {
          ...(state.tunnel ?? {}),
          selectedProvider: provider,
          status: "error",
          url: undefined,
          subdomain: undefined,
          message: `Tunnel process exited (code ${code}).`
        });
        addAudit(
          state,
          {
            actor: "runtime",
            action: "tunnel.error",
            target: provider,
            risk: "medium",
            evidence: { provider, code }
          },
          { system: true }
        );
      });
      appendLog(config.instance, "tunnel.exited", { provider, code });
    } catch {
      // Best-effort watcher: a state-write failure must never become an
      // unhandled rejection (which the crash handlers would treat as fatal).
      // Worst case the record stays "connected" — exactly the pre-watcher state.
    }
  });
}

// Abort a pending login: status -> "idle", keeping the selection so the
// panel still shows the chosen provider with Connect available. Clears any
// stale url/message and tears down the in-flight login/child.
export async function cancelTunnel(config: RuntimeConfig): Promise<TunnelState> {
  teardown(config.instance);
  return mutateState(config.instance, (state) => {
    const selected = state.tunnel?.selectedProvider ?? null;
    state.tunnel = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: selected,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
    addAudit(
      state,
      {
        actor: "user",
        action: "tunnel.cancel",
        target: selected ?? "none",
        risk: "low",
        evidence: { provider: selected }
      },
      { system: true }
    );
    return toState(state.tunnel);
  });
}

// Tear down a live tunnel: status -> "idle", KEEPING selectedProvider so the
// user can reconnect to the same provider without re-selecting. Stops the
// frpc child and clears the url/message.
export async function disconnectTunnel(config: RuntimeConfig): Promise<TunnelState> {
  // Capture the entry we're tearing down BEFORE the logout await: if a new
  // connect claims the instance during that await, the idle write below must
  // not clobber its live record.
  const torndown = supervisors.get(config.instance);
  teardown(config.instance);
  // Local logout: disconnect severs the connector, so clear this instance's
  // stored relay session (local-only — no server-side revoke; keeps a stable
  // subdomain on reconnect). A later connect then requires a fresh login
  // (best-effort — a logout failure must never block disconnect from settling).
  try {
    await deps.logout(config);
  } catch {
    // never block disconnect on a logout failure.
  }
  return mutateState(config.instance, (state) => {
    // A connect claimed the instance during the logout await — leave its live
    // record intact instead of clobbering it back to idle.
    const current = supervisors.get(config.instance);
    if (current && current !== torndown) return toState(state.tunnel ?? null);
    const selected = state.tunnel?.selectedProvider ?? null;
    state.tunnel = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: selected,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
    addAudit(
      state,
      {
        actor: "user",
        action: "tunnel.disconnect",
        target: selected ?? "none",
        risk: "medium",
        evidence: { provider: selected }
      },
      { system: true }
    );
    return toState(state.tunnel);
  });
}

// Startup reconcile (called from src/server.ts on boot). A persisted
// "connected"/"connecting" record describes a frpc child the runtime spawned
// before it restarted — that child is gone now, so the live status is stale.
//
// The tunnel link is meant to be long-lasting (the relay keys the public
// subdomain to a stable deviceId, so reconnecting reuses the SAME URL), so a
// tunnel that was "connected" at shutdown is brought back AUTOMATICALLY:
// persist-and-resume. We flip the record to "connecting" (never leave a stale
// "connected" the first GET could read) and kick off a background reconnect that
// REUSES the stored relay session — no browser login — and restores the tunnel
// as soon as this process owns the gateway port (`gatewayReady`), without
// waiting on the web child's recompile: the relay URL is a remote client's only
// channel to watch the restart finish, so reachability can't be gated on the web
// app being ready (the client's own polls handle that). It is best-effort: on no
// session it settles to idle. A prior "connecting" was an incomplete attempt
// with no guaranteed session, so it just resets to idle; idle/error records are
// left untouched. The caller (src/server.ts boot) wraps this in a best-effort
// .catch() so a state-write failure can never crash boot.
//
// `gatewayReady` resolves once Bun.serve has bound config.port. The status flip
// runs synchronously (so the call can stay before the bind, keeping the first
// GET off a stale "connected"), but the background frpc rebuild awaits this
// before exposing the port — see runConnect. Omitting it (as tests do) is not a
// bypass: the rebuild then degrades to the local-port probe, which still verifies
// the port before exposing it.
export async function reconcileTunnelOnStartup(
  config: RuntimeConfig,
  opts: { gatewayReady?: Promise<void> } = {}
): Promise<TunnelState> {
  const record = readState(config.instance).tunnel ?? null;
  if (!record || (record.status !== "connected" && record.status !== "connecting")) {
    return toState(record);
  }
  const selected = record.selectedProvider ?? null;
  const provider = selected ? findProvider(selected) : undefined;
  // Only a tunnel that was actually "connected" (with an enabled provider still
  // in the catalog) resumes; a stale "connecting" just resets to idle.
  const willResume = record.status === "connected" && Boolean(provider?.enabled);

  const next = await mutateState(config.instance, (state) => {
    const prior = state.tunnel?.status;
    state.tunnel = createTunnelRecord(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: selected,
      status: willResume ? "connecting" : "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
    addAudit(
      state,
      {
        actor: "runtime",
        action: "tunnel.reconcile",
        target: selected ?? "none",
        risk: "low",
        evidence: { provider: selected, from: prior, resume: willResume }
      },
      { system: true }
    );
    return toState(state.tunnel);
  });

  if (willResume && provider) {
    // Background reconnect: reuse the stored session and rebuild the tunnel as
    // soon as this process owns the gateway port (gatewayReady), so a remote
    // client regains its channel right after the bind instead of waiting out the
    // web child's recompile. Retained on the supervisor so tests can await the
    // terminal transition.
    teardown(config.instance);
    const sup = supervisor(config.instance);
    sup.settled = runConnect(config, provider.id, sup, { reuseOnly: true, gatewayReady: opts.gatewayReady });
  }
  return next;
}

// Test helper: await the in-flight background connect for an instance so a
// test can observe the terminal connected/error transition deterministically
// without polling. Resolves immediately if no connect is in flight.
export function awaitTunnelSettled(instance: Instance): Promise<void> {
  return supervisors.get(instance)?.settled ?? Promise.resolve();
}
