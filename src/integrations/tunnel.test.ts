// Unit tests for the tunnel connectivity behavior module (ADR
// tunnel-connectivity.md). Covers the full TunnelState contract returned by
// every function, the provider catalog, selection validation, the real
// gini-relay connect flow (connecting -> connected / error), cancel,
// disconnect, and the startup reconcile + resume (a previously connected tunnel
// comes back automatically by reusing the stored session) — at 100% line +
// function coverage.
//
// Every gini-relay seam (login primitive, tunnel builder, store, defaults,
// browser opener, local-port resolver) is injected via `setTunnelDeps`, so
// these tests never hit the network, OAuth, the host browser, or a spawned
// frpc child.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  awaitTunnelSettled,
  cancelTunnel,
  connectTunnel,
  defaultLogout,
  defaultOpenBrowser,
  defaultReadCloudflareConfig,
  defaultRunCommand,
  defaultTunnelProcSpawn,
  disconnectTunnel,
  getTunnel,
  makeDefaultDeps,
  makeDefaultDrivers,
  parseCloudflareConfig,
  reconcileTunnelOnStartup,
  refreshProviderDetection,
  selectProvider,
  setTunnelDeps,
  spawnUrlChild,
  stopAllTunnels,
  type ManualDriver,
  type SpawnedTunnelProc,
  type TunnelChild,
  type TunnelDeps
} from "./tunnel";
import { mutateState, readState } from "../state";
import { isRuntimeTunnelHost } from "../lib/origin-trust";
import type { RuntimeConfig, TunnelProviderId } from "../types";
import type { LoginHandle, RelayDefaults, Session, Store, TunnelOptions } from "gini-relay";

const ROOT = "/tmp/gini-tunnel-integration-tests";

function testConfig(instance: string): RuntimeConfig {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(ROOT, instance, "workspace"),
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// The relay defaults the fake login + tunnel builder echo back. relayDomain
// drives the public url the connected record records.
const RELAY: RelayDefaults = {
  relayUrl: "https://relay.test",
  frpsAddr: "relay.test",
  frpsPort: 7000,
  relayDomain: "relay.test",
  tlsServerName: "relay.test",
  frpToken: "tok",
  caFile: "/tmp/ca.crt",
  loopbackPorts: [8765, 8766, 8767],
  bandwidth: "1220KB"
};

const SESSION: Session = { token: "gsk_abc", subdomain: "subdom7", account: "user@test" };

// A controllable fake frpc child: `start()` resolves (or rejects), `stop()`
// records the call, `exited` never settles unless stopped.
function fakeChild(opts: { startRejects?: Error } = {}): TunnelChild & { stopped: boolean } {
  const exited = Promise.withResolvers<number>();
  return {
    stopped: false,
    start() {
      if (opts.startRejects) return Promise.reject(opts.startRejects);
      return Promise.resolve(this);
    },
    stop() {
      this.stopped = true;
      exited.resolve(0);
      return Promise.resolve(0);
    },
    exited: exited.promise
  };
}

// A child whose `exited` can be resolved on demand to simulate frpc dying on its
// own (crash / relay drop) WITHOUT a stop() call.
function crashableChild(): TunnelChild & { stopped: boolean; crash: (code: number) => void } {
  const exited = Promise.withResolvers<number>();
  return {
    stopped: false,
    start() {
      return Promise.resolve(this);
    },
    stop() {
      this.stopped = true;
      exited.resolve(0);
      return Promise.resolve(0);
    },
    exited: exited.promise,
    crash(code: number) {
      exited.resolve(code);
    }
  };
}

// A child whose stop() REJECTS (best-effort teardown must swallow it). start()
// is gateable; exited never settles on its own.
function rejectStopChild(
  gated = false
): TunnelChild & { releaseStart: () => void; stopCalls: number } {
  const startGate = Promise.withResolvers<void>();
  if (!gated) startGate.resolve();
  const child = {
    stopCalls: 0,
    start() {
      return startGate.promise.then(() => child);
    },
    stop() {
      child.stopCalls += 1;
      return Promise.reject(new Error("stop failed"));
    },
    exited: Promise.withResolvers<number>().promise,
    releaseStart() {
      startGate.resolve();
    }
  };
  return child;
}

// Poll the persisted tunnel status until it reaches `want` (the child-exit
// watcher writes asynchronously). Bounded at 600 * 5ms = 3000ms (under the
// 10000ms per-test cap) so a genuinely stuck state fails fast without flaking
// under CI load.
async function waitForStatus(c: RuntimeConfig, want: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (getTunnel(c).status === want) return;
    await Bun.sleep(5);
  }
  throw new Error(`tunnel status never reached "${want}" (stuck at "${getTunnel(c).status}")`);
}

// A fake store: deviceId is stable; session read/write are no-ops we don't
// assert on (the login primitive is faked, so it never actually persists).
function fakeStore(): Store {
  return {
    home: "/tmp/gini-relay-fake",
    deviceId: () => "device-1",
    readSession: () => SESSION,
    writeSession: () => {},
    clearSession: () => {}
  };
}

// A fake store with NO persisted session, forcing the OAuth login path.
function fakeStoreNoSession(): Store {
  return {
    home: "/tmp/gini-relay-fake",
    deviceId: () => "device-1",
    readSession: () => null,
    writeSession: () => {},
    clearSession: () => {}
  };
}

// Builds a fake LoginHandle whose waitForSession resolves with SESSION by
// default. Overrides let a test make the login hang or reject.
function fakeLoginHandle(over: Partial<LoginHandle> = {}): LoginHandle {
  return {
    url: "https://relay.test/consent?x=1",
    redirectUri: "http://127.0.0.1:8765/cb",
    waitForSession: () => Promise.resolve(SESSION),
    cancel: () => {},
    ...over
  };
}

// Assemble an injectable deps set. Each seam is overridable per test. The
// base set fixes resolveLocalPort to a sentinel; the port-resolution tests
// use `depsNoPort` to exercise the REAL default resolver.
function deps(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  return { ...depsNoPort(), resolveLocalPort: () => 4321, ...over };
}

// Inert manual drivers: detection reports the default-disabled availability
// and connect/disconnect must never run. Every deps set includes these so no
// test can fall through to the REAL drivers and shell out to a host-installed
// tailscale/ngrok/cloudflared (whose presence would also flip catalog rows).
function fakeDrivers(over: Partial<TunnelDeps["drivers"]> = {}): TunnelDeps["drivers"] {
  const inert = (requires: string): ManualDriver => ({
    detect: () => Promise.resolve({ enabled: false, requires }),
    connect: () => Promise.reject(new Error("manual driver connect must not run in this test"))
  });
  return {
    tailscale: inert("Tailscale network"),
    ngrok: inert("ngrok account"),
    cloudflare: inert("cloudflared CLI"),
    ...over
  };
}

// The same seams MINUS resolveLocalPort, so the module's default
// (env override -> gateway port config.port) runs.
function depsNoPort(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  const opened: string[] = [];
  return {
    loginUrl: () => Promise.resolve(fakeLoginHandle()),
    buildTunnel: (_opts: TunnelOptions) => fakeChild(),
    createStore: () => fakeStore(),
    resolveDefaults: () => RELAY,
    openBrowser: (url: string) => {
      opened.push(url);
    },
    probeLocalPort: () => Promise.resolve(true),
    logout: () => Promise.resolve(),
    drivers: fakeDrivers(),
    ...over
  };
}

// Deps whose store has NO session, so connect must run the browser login flow.
function depsLogin(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  return { ...deps(), createStore: () => fakeStoreNoSession(), ...over };
}

describe("tunnel integration", () => {
  let config: RuntimeConfig;
  let prevTunnelPort: string | undefined;

  beforeEach(() => {
    config = testConfig(`t-${Math.random().toString(36).slice(2)}`);
    prevTunnelPort = process.env.GINI_TUNNEL_PORT;
    setTunnelDeps(deps());
  });

  afterEach(() => {
    setTunnelDeps(); // restore the real gini-relay seams
    // Restore GINI_TUNNEL_PORT even if a port-override test failed mid-assertion,
    // so env state never leaks into a later test.
    if (prevTunnelPort === undefined) delete process.env.GINI_TUNNEL_PORT;
    else process.env.GINI_TUNNEL_PORT = prevTunnelPort;
    rmSync(`${ROOT}/instances/${config.instance}`, { recursive: true, force: true });
  });

  // GET on a fresh instance: the catalog is present, nothing selected, idle.
  test("getTunnel on a fresh instance returns catalog + idle/null", () => {
    const state = getTunnel(config);
    expect(state.selectedProvider).toBeNull();
    expect(state.status).toBe("idle");
    expect(state.url).toBeUndefined();
    expect(state.message).toBeUndefined();
    expect(state.providers.map((p) => p.id)).toEqual([
      "gini-relay",
      "tailscale",
      "ngrok",
      "cloudflare"
    ]);
  });

  // The catalog values must match the agreed contract exactly: only
  // gini-relay enabled (until detection finds a manual CLI); the rest disabled
  // with a `requires` reason and `setup` steps for the panel's info affordance.
  test("provider catalog matches the agreed shape", () => {
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId["gini-relay"]).toEqual({ id: "gini-relay", name: "Gini Relay", enabled: true });
    expect(byId.tailscale).toEqual({
      id: "tailscale",
      name: "Tailscale",
      enabled: false,
      requires: "Tailscale network",
      setup: byId.tailscale.setup
    });
    expect(byId.tailscale.setup?.length).toBeGreaterThan(0);
    expect(byId.ngrok).toEqual({
      id: "ngrok",
      name: "ngrok",
      enabled: false,
      requires: "ngrok account",
      setup: byId.ngrok.setup
    });
    expect(byId.cloudflare).toEqual({
      id: "cloudflare",
      name: "Cloudflare",
      enabled: false,
      requires: "cloudflared CLI",
      setup: byId.cloudflare.setup
    });
  });

  // select saves the choice without connecting; status stays idle.
  test("selectProvider saves selection, stays idle, audits", async () => {
    const state = await selectProvider(config, "gini-relay");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.status).toBe("idle");
    expect(state.url).toBeUndefined();
    const persisted = readState(config.instance);
    expect(persisted.tunnel?.selectedProvider).toBe("gini-relay");
    expect(persisted.audit.some((a) => a.action === "tunnel.select")).toBe(true);
  });

  // Unknown provider -> reject, no state mutation.
  test("selectProvider rejects an unknown provider", async () => {
    await expect(selectProvider(config, "bogus")).rejects.toThrow("Unknown tunnel provider: bogus");
    expect(readState(config.instance).tunnel).toBeNull();
  });

  // Disabled provider -> reject with the requires hint.
  test("selectProvider rejects a disabled provider with the requires hint", async () => {
    await expect(selectProvider(config, "ngrok")).rejects.toThrow("not available (requires ngrok account)");
    expect(readState(config.instance).tunnel).toBeNull();
  });

  // Re-selecting the provider you're already connected to is a no-op: the live
  // tunnel stays up (the edit panel must not disconnect on a redundant click).
  test("re-selecting the connected provider is a no-op and keeps the tunnel live", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    const reselected = await selectProvider(config, "gini-relay");
    expect(reselected.status).toBe("connected");
    expect(reselected.url).toBe("https://subdom7.relay.test");
    expect(child.stopped).toBe(false);
  });

  // connect using the saved selection: returns "connecting" immediately, then
  // the background flow settles to "connected" with the public url and opens
  // the consent URL in the host browser.
  test("connectTunnel reuses a stored session (no browser) and settles connected", async () => {
    const opened: string[] = [];
    let loginCalls = 0;
    setTunnelDeps(deps({
      openBrowser: (url) => opened.push(url),
      loginUrl: () => {
        loginCalls += 1;
        return Promise.resolve(fakeLoginHandle());
      }
    }));
    await selectProvider(config, "gini-relay");
    const connecting = await connectTunnel(config);
    expect(connecting.status).toBe("connecting");
    expect(connecting.url).toBeUndefined();
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    expect(settled.url).toBe("https://subdom7.relay.test");
    expect(settled.selectedProvider).toBe("gini-relay");
    // The stored session was reused: no browser opened, no re-login.
    expect(opened).toEqual([]);
    expect(loginCalls).toBe(0);
    const persisted = readState(config.instance);
    expect(persisted.tunnel?.subdomain).toBe("subdom7");
    expect(persisted.audit.some((a) => a.action === "tunnel.connect")).toBe(true);
    expect(persisted.audit.some((a) => a.action === "tunnel.connected")).toBe(true);
  });

  // No stored session -> connect runs the browser OAuth login flow.
  test("connectTunnel logs in via the browser when there is no stored session", async () => {
    const opened: string[] = [];
    setTunnelDeps(depsLogin({ openBrowser: (url) => opened.push(url) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    expect(settled.url).toBe("https://subdom7.relay.test");
    expect(opened).toEqual(["https://relay.test/consent?x=1"]);
  });

  // A stored session the relay rejects (revoked) -> connect self-heals by
  // falling back to a fresh login and retrying the tunnel build.
  test("connectTunnel falls back to login when the stored session is rejected", async () => {
    let build = 0;
    const opened: string[] = [];
    setTunnelDeps(deps({
      openBrowser: (url) => opened.push(url),
      buildTunnel: () => fakeChild(build++ === 0 ? { startRejects: new Error("relay: session rejected") } : {})
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(opened).toEqual(["https://relay.test/consent?x=1"]);
    expect(build).toBe(2);
  });

  // connect with an explicit provider arg overrides the saved selection.
  test("connectTunnel honors an explicit provider override", async () => {
    const state = await connectTunnel(config, "gini-relay");
    expect(state.status).toBe("connecting");
    expect(state.selectedProvider).toBe("gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
  });

  // connect with no selection and no arg -> reject.
  test("connectTunnel with no provider selected rejects", async () => {
    await expect(connectTunnel(config)).rejects.toThrow("No tunnel provider selected.");
  });

  // connect with an unknown explicit provider -> reject.
  test("connectTunnel rejects an unknown explicit provider", async () => {
    await expect(connectTunnel(config, "bogus")).rejects.toThrow("Unknown tunnel provider: bogus");
  });

  // connect with a disabled explicit provider -> reject.
  test("connectTunnel rejects a disabled explicit provider", async () => {
    await expect(connectTunnel(config, "tailscale")).rejects.toThrow("not available (requires Tailscale network)");
  });

  // A login failure flips the record to "error" with the message; no url.
  test("connectTunnel records error when login fails", async () => {
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.reject(new Error("relay returned no login url")) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("relay returned no login url");
    expect(state.url).toBeUndefined();
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.error")).toBe(true);
  });

  // A frpc start failure (after a good login) also flips to "error".
  test("connectTunnel records error when frpc start fails", async () => {
    setTunnelDeps(deps({ buildTunnel: () => fakeChild({ startRejects: new Error("frpc: boom") }) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("frpc: boom");
  });

  // A non-Error rejection is stringified into the message (String(error) path).
  test("connectTunnel stringifies a non-Error rejection", async () => {
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.reject("plain string failure") }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).message).toBe("plain string failure");
  });

  // Cancelling mid-login: the pending login is aborted, the record is idle,
  // and the background flow that loses the race must NOT clobber idle with
  // an error (the registry entry was cleared by the cancel).
  test("cancelTunnel during a pending login aborts and stays idle", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    let cancelled = false;
    const handle = fakeLoginHandle({
      waitForSession: () => hang, // never resolves on its own
      cancel: () => {
        cancelled = true;
      }
    });
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.resolve(handle) }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Let runConnect reach waitForSession (login handle stored).
    await Promise.resolve();
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(cancelled).toBe(true);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.cancel")).toBe(true);
    // The background flow won't settle (the login hangs); the record stays idle.
    expect(getTunnel(config).status).toBe("idle");
  });

  // cancel returns to idle, keeps the selection, clears url/message.
  test("cancelTunnel returns idle keeping the selection", async () => {
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.url).toBeUndefined();
  });

  // cancel with nothing selected still works (selection stays null) and the
  // teardown no-ops cleanly (no supervisor registered).
  test("cancelTunnel with no selection yields idle/null", async () => {
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
  });

  // disconnect tears down a live tunnel (stops the frpc child), keeps selection.
  test("disconnectTunnel stops the child and returns idle keeping the selection", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.url).toBeUndefined();
    expect(child.stopped).toBe(true);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.disconnect")).toBe(true);
  });

  // disconnect with nothing selected -> idle/null target audited as "none".
  test("disconnectTunnel with no selection yields idle/null", async () => {
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
    const audit = readState(config.instance).audit.find((a) => a.action === "tunnel.disconnect");
    expect(audit?.target).toBe("none");
  });

  // A second connect tears down the prior in-flight login before starting a
  // fresh one (covers the teardown-with-pending-login branch in connect).
  test("connectTunnel tears down a prior pending login before reconnecting", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    let firstCancelled = false;
    const first = fakeLoginHandle({ waitForSession: () => hang, cancel: () => { firstCancelled = true; } });
    let call = 0;
    setTunnelDeps(depsLogin({
      loginUrl: () => Promise.resolve(call++ === 0 ? first : fakeLoginHandle())
    }));
    await connectTunnel(config, "gini-relay");
    await Promise.resolve();
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(firstCancelled).toBe(true);
    expect(getTunnel(config).status).toBe("connected");
  });

  // A teardown whose child.stop() rejects is swallowed (best-effort path).
  test("disconnectTunnel swallows a child.stop() rejection", async () => {
    const child: TunnelChild = {
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error("already gone")),
      exited: Promise.withResolvers<number>().promise
    };
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
  });

  // A login.cancel() that throws during teardown is swallowed.
  test("cancelTunnel swallows a login.cancel() throw", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    const handle = fakeLoginHandle({
      waitForSession: () => hang,
      cancel: () => { throw new Error("cancel blew up"); }
    });
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.resolve(handle) }));
    await connectTunnel(config, "gini-relay");
    await Promise.resolve();
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
  });

  // The default resolveLocalPort path: env override wins.
  test("connectTunnel uses GINI_TUNNEL_PORT override for the local port", async () => {
    process.env.GINI_TUNNEL_PORT = "9911"; // restored in afterEach
    let seenPort = -1;
    setTunnelDeps(depsNoPort({
      buildTunnel: (opts) => {
        seenPort = opts.port;
        return fakeChild();
      }
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(seenPort).toBe(9911);
  });

  // The default resolveLocalPort path: with no env override, the tunnel exposes
  // the instance's GATEWAY port (config.port). The gateway fronts both the
  // native /api/* surface and the reverse-proxied web app, so one relay URL
  // serves the API and the UI.
  test("connectTunnel exposes the gateway port (config.port) for the local port", async () => {
    delete process.env.GINI_TUNNEL_PORT; // restored in afterEach
    let seenPort = -1;
    setTunnelDeps(depsNoPort({
      buildTunnel: (opts) => {
        seenPort = opts.port;
        return fakeChild();
      }
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(seenPort).toBe(config.port);
  });

  // disconnect fully logs out: it invokes the logout seam (revoke + clear) so a
  // later connect must log in again.
  test("disconnectTunnel logs out so a later connect must re-login", async () => {
    const child = fakeChild();
    let logoutCalls = 0;
    setTunnelDeps(deps({
      buildTunnel: () => child,
      logout: () => {
        logoutCalls += 1;
        return Promise.resolve();
      }
    }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(child.stopped).toBe(true);
    expect(logoutCalls).toBe(1);
  });

  // disconnect must settle to idle even when logout throws (best-effort).
  test("disconnectTunnel settles idle even when logout throws", async () => {
    setTunnelDeps(deps({ logout: () => Promise.reject(new Error("revoke failed")) }));
    await selectProvider(config, "gini-relay");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
  });

  // defaultLogout: no stored session -> nothing to clear.
  test("defaultLogout no-ops when there is no stored session", async () => {
    let unlinked = 0;
    await defaultLogout(
      config.instance,
      () => fakeStoreNoSession(),
      () => {
        unlinked += 1;
      }
    );
    expect(unlinked).toBe(0);
  });

  // defaultLogout: deletes the local session file so the next connect re-logs-in.
  test("defaultLogout deletes the local session file", async () => {
    let unlinkedPath = "";
    await defaultLogout(
      config.instance,
      () => fakeStore(),
      (p) => {
        unlinkedPath = p;
      }
    );
    expect(unlinkedPath).toContain("session.json");
  });

  // defaultLogout: an unlink failure (file already gone) is swallowed.
  test("defaultLogout swallows an unlink failure", async () => {
    await defaultLogout(
      config.instance,
      () => fakeStore(),
      () => {
        throw new Error("gone");
      }
    );
  });

  // The local-port readiness guard: if nothing serves the resolved local
  // port, connect must NOT advertise a connected tunnel — it records "error".
  test("connectTunnel errors when the local web port isn't serving", async () => {
    setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(false) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe(
      "Gini's web UI isn't responding on port 4321 — start it, then reconnect."
    );
    expect(state.url).toBeUndefined();
  });

  // The default host-browser opener shells out to `open <url>` via Bun.spawn.
  // Driven with a stubbed spawn so no real browser launches.
  test("defaultOpenBrowser spawns `open` with the url", () => {
    const calls: string[][] = [];
    const fakeSpawn = ((cmd: string[]) => {
      calls.push(cmd);
      return {} as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    defaultOpenBrowser("https://relay.test/consent", fakeSpawn);
    expect(calls).toEqual([["open", "https://relay.test/consent"]]);
  });

  // The connect-aborted branch: the login rejects AFTER a cancel has torn
  // down the supervisor, so runConnect must log "aborted" and NOT clobber the
  // idle record the cancel wrote with a spurious error.
  test("connectTunnel aborts cleanly when teardown wins the race against a login failure", async () => {
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    // Login that only rejects once the test releases the gate — by then the
    // cancel below has already deleted this instance's supervisor entry.
    const settled = (async () => {
      await gate;
      throw new Error("relay error getting login URL");
    })();
    setTunnelDeps(depsLogin({ loginUrl: () => settled.then(() => fakeLoginHandle()) }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Tear down before the login settles.
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    // Release the login failure; the background flow takes the aborted path.
    // The supervisor entry was deleted by the cancel, so awaitTunnelSettled
    // can't track it — flush the rejection + several microtasks instead.
    openGate();
    await settled.catch(() => {});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    // The cancel's idle record stands — no error clobber.
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect cancelled DURING the port probe must bail before the login —
  // never opening an OAuth browser tab for a connect the user abandoned.
  test("connect cancelled during the port probe never opens a browser", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({ probeLocalPort: () => probeGate.promise, openBrowser: (url) => opened.push(url) })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // runConnect is parked on the probe await; cancel before it resolves.
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    probeGate.resolve(true);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(opened).toEqual([]);
    expect(getTunnel(config).status).toBe("idle");
  });

  // The reuse path (stored session) is guarded too: a connect cancelled during
  // the probe must never spawn frpc.
  test("connect cancelled during the probe never spawns frpc (stored session)", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    let built = 0;
    setTunnelDeps(
      deps({
        probeLocalPort: () => probeGate.promise,
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    probeGate.resolve(true);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(built).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect cancelled DURING loginUrl (after the probe) must cancel the
  // freshly-minted login handle and bail before opening a browser.
  test("connect cancelled during loginUrl cancels the handle and never opens a browser", async () => {
    const loginGate = Promise.withResolvers<void>();
    let cancelled = false;
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({
        loginUrl: () => loginGate.promise.then(() => fakeLoginHandle({ cancel: () => { cancelled = true; } })),
        openBrowser: (url) => opened.push(url)
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Let runConnect pass the probe + first guard and park at loginUrl.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    loginGate.resolve();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(opened).toEqual([]);
    expect(getTunnel(config).status).toBe("idle");
  });

  // If a login fails AFTER loginUrl bound its loopback (e.g. waitForSession
  // rejects), the error path must cancel the handle so the loopback isn't leaked.
  test("a login failing after loginUrl cancels the handle (no loopback leak)", async () => {
    let cancelled = false;
    setTunnelDeps(
      depsLogin({
        loginUrl: () =>
          Promise.resolve(
            fakeLoginHandle({
              waitForSession: () => Promise.reject(new Error("relay session exchange failed")),
              cancel: () => {
                cancelled = true;
              }
            })
          )
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    expect(cancelled).toBe(true);
  });

  // The real gini-relay seam wrappers delegate to the library without any
  // network I/O: createStore (instance-scoped relayHome under the temp ROOT),
  // resolveDefaults (pure), and buildTunnel (pure construction — frpc isn't
  // spawned until start()). loginUrl is the live network primitive, so it's
  // only referenced, never invoked here.
  test("makeDefaultDeps wires the real gini-relay primitives", async () => {
    const real = makeDefaultDeps();
    const relay = real.resolveDefaults();
    expect(typeof relay.relayUrl).toBe("string");
    const store = real.createStore(config);
    expect(typeof store.deviceId()).toBe("string");
    const child = real.buildTunnel({
      session: SESSION,
      deviceId: store.deviceId(),
      port: 4321,
      defaults: relay
    });
    expect(typeof child.start).toBe("function");
    expect(typeof real.loginUrl).toBe("function");
    expect(real.resolveLocalPort(config)).toBeGreaterThan(0);
    expect(typeof real.probeLocalPort).toBe("function");
    expect(typeof (await real.probeLocalPort(config, 1))).toBe("boolean");
    expect(typeof real.logout).toBe("function");
    await real.logout(config);
  });

  // awaitTunnelSettled resolves immediately when no connect is in flight.
  test("awaitTunnelSettled resolves when nothing is connecting", async () => {
    await expect(awaitTunnelSettled(config.instance)).resolves.toBeUndefined();
  });

  // Seed a persisted "connected" tunnel record (as if the runtime was exposing a
  // tunnel before this restart). The link is long-lasting, so boot should resume.
  async function seedConnectedRecord(c: RuntimeConfig, provider: TunnelProviderId = "gini-relay"): Promise<void> {
    await mutateState(c.instance, (s) => {
      s.tunnel = {
        instance: c.instance,
        selectedProvider: provider,
        status: "connected",
        url: "https://subdom7.relay.test",
        subdomain: "subdom7",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
  }

  // Startup reconcile RESUMES a tunnel that was connected before the restart by
  // reusing the stored relay session (no browser login) — the link is meant to be
  // long-lasting / 24-7, so it comes back automatically. It first flips to
  // "connecting" so the first GET never reads a stale "connected".
  test("reconcileTunnelOnStartup resumes a previously connected tunnel by reusing the session", async () => {
    const child = fakeChild();
    let loginCalls = 0;
    const opened: string[] = [];
    setTunnelDeps(
      deps({
        buildTunnel: () => child,
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        },
        openBrowser: (url) => opened.push(url)
      })
    );
    await seedConnectedRecord(config);
    const immediate = await reconcileTunnelOnStartup(config);
    expect(immediate.status).toBe("connecting");
    expect(immediate.selectedProvider).toBe("gini-relay");
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    // Same deviceId-keyed subdomain — the link is stable across the restart.
    expect(settled.url).toBe("https://subdom7.relay.test");
    // Headless resume: the stored session was reused, no browser/login.
    expect(loginCalls).toBe(0);
    expect(opened).toEqual([]);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.reconcile")).toBe(true);
  });

  // Resume is non-interactive: with no stored session it must NOT open a browser
  // or mint a login on a headless restart — it settles idle for a manual reconnect.
  test("reconcileTunnelOnStartup resume settles idle (no login) when there is no stored session", async () => {
    let loginCalls = 0;
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        },
        openBrowser: (url) => opened.push(url)
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config);
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("idle");
    expect(settled.selectedProvider).toBe("gini-relay");
    expect(loginCalls).toBe(0);
    expect(opened).toEqual([]);
  });

  // Resume waits for the web child to come back (it may still be compiling right
  // after a restart): it polls the local port and connects once it answers.
  test("reconcileTunnelOnStartup resume waits for the web child then connects", async () => {
    const prevPoll = process.env.GINI_TUNNEL_RESUME_POLL_MS;
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "1";
    try {
      let probes = 0;
      setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(++probes >= 3) }));
      await seedConnectedRecord(config);
      await reconcileTunnelOnStartup(config);
      await awaitTunnelSettled(config.instance);
      expect(getTunnel(config).status).toBe("connected");
      expect(probes).toBeGreaterThanOrEqual(3);
    } finally {
      if (prevPoll === undefined) delete process.env.GINI_TUNNEL_RESUME_POLL_MS;
      else process.env.GINI_TUNNEL_RESUME_POLL_MS = prevPoll;
    }
  });

  // Resume gives up cleanly (settles idle, never spawns frpc) if the web child
  // never becomes reachable within the budget.
  test("reconcileTunnelOnStartup resume settles idle when the web never becomes ready", async () => {
    const prevWait = process.env.GINI_TUNNEL_RESUME_WAIT_MS;
    process.env.GINI_TUNNEL_RESUME_WAIT_MS = "0";
    try {
      let built = 0;
      setTunnelDeps(
        deps({
          probeLocalPort: () => Promise.resolve(false),
          buildTunnel: () => {
            built += 1;
            return fakeChild();
          }
        })
      );
      await seedConnectedRecord(config);
      await reconcileTunnelOnStartup(config);
      await awaitTunnelSettled(config.instance);
      expect(getTunnel(config).status).toBe("idle");
      expect(built).toBe(0);
    } finally {
      if (prevWait === undefined) delete process.env.GINI_TUNNEL_RESUME_WAIT_MS;
      else process.env.GINI_TUNNEL_RESUME_WAIT_MS = prevWait;
    }
  });

  // A resume cancelled while it waits for the web child bails without clobbering
  // the idle the cancel wrote (covers the supervisor-superseded guard in the wait).
  test("reconcileTunnelOnStartup resume bails when cancelled during the web wait", async () => {
    const prevPoll = process.env.GINI_TUNNEL_RESUME_POLL_MS;
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "5";
    try {
      setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(false) }));
      await seedConnectedRecord(config);
      await reconcileTunnelOnStartup(config);
      // Capture the resume's settled promise BEFORE cancel tears down the
      // supervisor, then await it — deterministic, no fixed sleep. The resume
      // wakes from its poll, sees it was superseded, and bails without clobbering
      // the idle the cancel wrote.
      const settled = awaitTunnelSettled(config.instance);
      const cancelled = await cancelTunnel(config);
      expect(cancelled.status).toBe("idle");
      await settled;
      expect(getTunnel(config).status).toBe("idle");
    } finally {
      if (prevPoll === undefined) delete process.env.GINI_TUNNEL_RESUME_POLL_MS;
      else process.env.GINI_TUNNEL_RESUME_POLL_MS = prevPoll;
    }
  });

  // A "connected" record for a provider that is no longer enabled does NOT resume
  // (covers the disabled-provider guard); it just resets to idle.
  test("reconcileTunnelOnStartup does not resume a connected record for a disabled provider", async () => {
    await seedConnectedRecord(config, "tailscale");
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("tailscale");
  });

  // Startup reconcile also resets a stale "connecting" record.
  test("reconcileTunnelOnStartup resets a stale connecting record to idle", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "connecting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
  });

  // Startup reconcile leaves an idle record untouched (no audit row, no write).
  test("reconcileTunnelOnStartup leaves an idle record untouched", async () => {
    await selectProvider(config, "gini-relay"); // writes an idle record
    const before = readState(config.instance).tunnel?.updatedAt;
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(readState(config.instance).tunnel?.updatedAt).toBe(before);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.reconcile")).toBe(false);
  });

  // Startup reconcile on a fresh instance (null record) is a clean no-op.
  test("reconcileTunnelOnStartup on a fresh instance returns idle/null", async () => {
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
  });

  // Startup reconcile leaves an error record untouched (it's not stale-live).
  test("reconcileTunnelOnStartup leaves an error record untouched", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "error",
        message: "boom",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("boom");
  });

  // A persisted error record surfaces its message and no url via GET.
  test("getTunnel surfaces a persisted error message and hides url", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "error",
        message: "login failed",
        url: "https://should-not-show",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("login failed");
    expect(state.url).toBeUndefined();
  });

  // Metadata wins over the spread: a rebuilt record takes the authoritative
  // instance and a fresh updatedAt, while preserving the original createdAt —
  // even when the prior record carried stale instance/timestamps.
  test("createTunnelRecord refreshes instance/updatedAt and preserves createdAt", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: "STALE-INSTANCE",
        selectedProvider: "gini-relay",
        status: "idle",
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z"
      };
    });
    await selectProvider(config, "gini-relay");
    const rec = readState(config.instance).tunnel;
    expect(rec?.instance).toBe(config.instance);
    expect(rec?.createdAt).toBe("2000-01-01T00:00:00.000Z");
    expect(rec?.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  // Shutdown teardown: stopAllTunnels stops the live frpc child so it isn't left
  // running past runtime exit.
  test("stopAllTunnels stops a live tunnel child", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    await stopAllTunnels();
    expect(child.stopped).toBe(true);
    // Idempotent: a second call with nothing live still resolves.
    await stopAllTunnels();
  });

  // A connect that is superseded mid-handshake by a newer connect must abort
  // (stop the child it spawned) and never overwrite the winner's "connected".
  test("a superseded connect aborts without clobbering the winning connect", async () => {
    // childA's stop() rejects so this also exercises the abort path's best-effort
    // stop().catch (the older run stopping the child it spawned).
    const childA = rejectStopChild(true);
    const childB = fakeChild();
    let built = 0;
    setTunnelDeps(deps({ buildTunnel: () => (built++ === 0 ? childA : childB) }));
    await selectProvider(config, "gini-relay");

    // Connect A parks at childA.start() (gated); flush so it builds + registers
    // childA before the superseding connect tears it down.
    await connectTunnel(config, "gini-relay");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(built).toBe(1);

    // Connect B supersedes A and connects.
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Release A: it sees it's no longer current and aborts (no clobber).
    childA.releaseStart();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(getTunnel(config).status).toBe("connected");
    expect(childA.stopCalls).toBeGreaterThanOrEqual(1);
  });

  // stopAllTunnels is best-effort: a child whose stop() rejects must be swallowed.
  test("stopAllTunnels swallows a child.stop() rejection", async () => {
    setTunnelDeps(deps({ buildTunnel: () => rejectStopChild() }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    await stopAllTunnels();
  });

  // A live tunnel whose frpc child exits on its own (crash/relay drop) flips
  // "connected" -> "error" so the UI stops advertising a dead tunnel.
  test("a tunnel child exiting on its own flips connected to error", async () => {
    const child = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    child.crash(7);
    await waitForStatus(config, "error");
    const state = getTunnel(config);
    expect(state.message).toContain("exited (code 7)");
    expect(state.url).toBeUndefined();
  });

  // The exit watcher must NOT fire after an intentional disconnect: disconnect
  // stops the child (resolving its exited), but the entry is gone, so the idle
  // record stands instead of being clobbered with a spurious "error".
  test("a child exiting via disconnect does not overwrite the idle record", async () => {
    const child = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    await disconnectTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect that starts while disconnect is awaiting logout must NOT be
  // clobbered back to idle: disconnect's idle write skips when a newer connect
  // has claimed the instance.
  test("disconnect does not clobber a connect that starts during the logout await", async () => {
    const logoutGate = Promise.withResolvers<void>();
    const childB = fakeChild();
    let built = 0;
    setTunnelDeps(
      deps({
        logout: () => logoutGate.promise,
        buildTunnel: () => (built++ === 0 ? fakeChild() : childB)
      })
    );
    // Get to connected (childA).
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Begin disconnect; it tears down then parks on the gated logout.
    const disconnecting = disconnectTunnel(config);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // A new connect claims the instance while disconnect is mid-logout.
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Release logout; disconnect must leave the new connect's record intact.
    logoutGate.resolve();
    await disconnecting;
    expect(getTunnel(config).status).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// Manual drivers: detection-driven catalog, the manual connect/disconnect/
// resume flows, and the runtime-tunnel origin trust they publish.
// ---------------------------------------------------------------------------

// A manual driver whose detect/connect are scriptable and counted.
function scriptedDriver(over: Partial<ManualDriver> & { requires?: string } = {}): ManualDriver & {
  detects: number;
  connects: number;
  disconnects: number;
} {
  const driver = {
    detects: 0,
    connects: 0,
    disconnects: 0,
    detect() {
      driver.detects += 1;
      return over.detect ? over.detect() : Promise.resolve({ enabled: true });
    },
    connect(port: number) {
      driver.connects += 1;
      return over.connect ? over.connect(port) : Promise.resolve({ url: "https://machine.tail-test.ts.net" });
    },
    disconnect() {
      driver.disconnects += 1;
      return over.disconnect ? over.disconnect() : Promise.resolve();
    }
  };
  return driver;
}

describe("manual tunnel drivers", () => {
  let config: RuntimeConfig;

  // Seed a persisted "connected" record as if the runtime had this provider up
  // before a restart (mirrors the relay reconcile tests' helper, which is
  // scoped to their describe).
  async function seedManualConnected(c: RuntimeConfig, provider: TunnelProviderId): Promise<void> {
    await mutateState(c.instance, (s) => {
      s.tunnel = {
        instance: c.instance,
        selectedProvider: provider,
        status: "connected",
        url: "https://stale.tail-test.ts.net",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
  }

  beforeEach(() => {
    config = testConfig(`m-${Math.random().toString(36).slice(2)}`);
    setTunnelDeps(deps());
  });

  afterEach(() => {
    setTunnelDeps();
    rmSync(`${ROOT}/instances/${config.instance}`, { recursive: true, force: true });
  });

  test("refreshProviderDetection flips detected rows enabled (keeping setup) and drops their requires", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    await refreshProviderDetection();
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId.tailscale.enabled).toBe(true);
    expect(byId.tailscale.requires).toBeUndefined();
    expect(byId.tailscale.setup?.length).toBeGreaterThan(0);
    expect(byId.ngrok.enabled).toBe(false);
    expect(byId.ngrok.requires).toBe("ngrok account");
  });

  test("a throwing detect keeps the default-disabled entry", async () => {
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        cloudflare: scriptedDriver({ detect: () => Promise.reject(new Error("spawn ENOENT")) })
      })
    }));
    await refreshProviderDetection();
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId.cloudflare.enabled).toBe(false);
    expect(byId.cloudflare.requires).toBe("cloudflared CLI");
    expect(byId.cloudflare.setup?.length).toBeGreaterThan(0);
  });

  test("detection results inside the TTL are reused; concurrent callers share one probe", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await Promise.all([refreshProviderDetection(), refreshProviderDetection()]);
    expect(tailscale.detects).toBe(1);
    await refreshProviderDetection(); // within TTL — no new probe
    expect(tailscale.detects).toBe(1);
  });

  test("selecting a manual provider re-probes a stale disabled cache and then succeeds", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    // No prior refresh: the cache still says disabled; select must re-detect.
    const state = await selectProvider(config, "tailscale");
    expect(state.selectedProvider).toBe("tailscale");
    expect(state.status).toBe("idle");
  });

  test("manual connect (childless driver) flips to connected and publishes origin trust", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    const connecting = await connectTunnel(config, "tailscale");
    expect(connecting.status).toBe("connecting");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("connected");
    expect(state.url).toBe("https://machine.tail-test.ts.net");
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(true);

    // Disconnect clears the record AND revokes the trusted front, and runs the
    // driver's provider-side teardown instead of the relay logout.
    let loggedOut = 0;
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({
      logout: () => {
        loggedOut += 1;
        return Promise.resolve();
      },
      drivers: fakeDrivers({ tailscale })
    }));
    const after = await disconnectTunnel(config);
    expect(after.status).toBe("idle");
    expect(after.selectedProvider).toBe("tailscale");
    expect(tailscale.disconnects).toBe(1);
    expect(loggedOut).toBe(0);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("manual connect with a child supervises it: a crash flips connected -> error", async () => {
    const child = crashableChild();
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => Promise.resolve({ url: "https://abc.ngrok-free.app", child }) })
      })
    }));
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).url).toBe("https://abc.ngrok-free.app");
    expect(isRuntimeTunnelHost("abc.ngrok-free.app")).toBe(true);

    child.crash(7);
    await waitForStatus(config, "error");
    expect(getTunnel(config).message).toBe("Tunnel process exited (code 7).");
    expect(isRuntimeTunnelHost("abc.ngrok-free.app")).toBe(false);
  });

  test("a failing manual driver folds its message into the error record", async () => {
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        cloudflare: scriptedDriver({ connect: () => Promise.reject(new Error("cloudflared exited (code 1) before reporting a public URL")) })
      })
    }));
    await connectTunnel(config, "cloudflare");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toContain("cloudflared exited");
  });

  test("manual connect refuses when the web UI is not reachable", async () => {
    setTunnelDeps(deps({
      probeLocalPort: () => Promise.resolve(false),
      drivers: fakeDrivers({ tailscale: scriptedDriver() })
    }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    expect(getTunnel(config).message).toContain("isn't responding on port");
  });

  test("a superseded childless manual connect tears down its provider config instead of publishing", async () => {
    const gate = Promise.withResolvers<void>();
    // The teardown call's failure must be swallowed (best-effort) — reject it
    // so the swallow path actually runs.
    const tailscale = scriptedDriver({
      connect: () => gate.promise.then(() => ({ url: "https://machine.tail-test.ts.net" })),
      disconnect: () => Promise.reject(new Error("serve off failed"))
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    // Capture the in-flight background connect BEFORE cancel tears the
    // supervisor entry down (afterwards awaitTunnelSettled has nothing to wait
    // on and would race the abort path).
    const settled = awaitTunnelSettled(config.instance);
    // Cancel while the driver is mid-connect; then release the driver.
    await cancelTunnel(config);
    gate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("a teardown during the web-ready probe aborts before the driver ever connects", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({
      probeLocalPort: () => probeGate.promise,
      drivers: fakeDrivers({ tailscale })
    }));
    await connectTunnel(config, "tailscale");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    probeGate.resolve(true);
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(tailscale.connects).toBe(0);
  });

  test("a driver failure after a teardown logs an abort instead of clobbering the idle record", async () => {
    const gate = Promise.withResolvers<never>();
    setTunnelDeps(deps({
      drivers: fakeDrivers({ ngrok: scriptedDriver({ connect: () => gate.promise }) })
    }));
    await connectTunnel(config, "ngrok");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    gate.reject(new Error("agent died"));
    await settled;
    // The superseded run must not write an error over cancel's idle record.
    expect(getTunnel(config).status).toBe("idle");
    expect(getTunnel(config).message).toBeUndefined();
  });

  test("a stale superseded run never tears down the front a NEWER connect just published", async () => {
    // R1 connects (slow driver); cancel supersedes it; R2 connects and
    // publishes. When R1's driver finally resolves, its abort path must SKIP
    // the provider-side teardown — otherwise the serve config R2 just brought
    // up would be yanked while the record reads connected.
    const r1Gate = Promise.withResolvers<void>();
    let connects = 0;
    const tailscale = scriptedDriver({
      connect: () => {
        connects += 1;
        return connects === 1
          ? r1Gate.promise.then(() => ({ url: "https://machine.tail-test.ts.net" }))
          : Promise.resolve({ url: "https://machine.tail-test.ts.net" });
      }
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));

    await connectTunnel(config, "tailscale"); // R1, parked on r1Gate
    const r1Settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);               // supersede R1 (idle; no teardown — R1 wasn't connected)
    await connectTunnel(config, "tailscale"); // R2
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    r1Gate.resolve();                          // R1's driver finally resolves
    await r1Settled;
    // R1's abort path must NOT have run the provider-side teardown.
    expect(tailscale.disconnects).toBe(0);
    expect(getTunnel(config).status).toBe("connected");
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(true);
  });

  test("a superseded child-backed manual connect stops the child it spawned (a stop failure is swallowed)", async () => {
    const gate = Promise.withResolvers<void>();
    const child = fakeChild();
    let stops = 0;
    // stop() rejecting must not surface — the abort path is best-effort.
    const rejectingChild: TunnelChild = {
      start: () => child.start(),
      stop: () => {
        stops += 1;
        void child.stop();
        return Promise.reject(new Error("kill failed"));
      },
      exited: child.exited
    };
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => gate.promise.then(() => ({ url: "https://abc.ngrok-free.app", child: rejectingChild })) })
      })
    }));
    await connectTunnel(config, "ngrok");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    gate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(stops).toBeGreaterThanOrEqual(1);
  });

  test("cancel after a childless manual connect already landed tears down the provider state", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    // The UI's Cancel can land after the background connect completed; the
    // serve config must not keep serving while the record reads idle.
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("disconnect while idle never runs provider-side teardown (protects a pre-existing serve config)", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await selectProvider(config, "tailscale");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    // Gini never started a tunnel — it must not turn off the operator's own
    // tailscale serve config.
    expect(tailscale.disconnects).toBe(0);
  });

  test("disconnect while idle with the relay selected does not log the relay out", async () => {
    let loggedOut = 0;
    setTunnelDeps(deps({
      logout: () => {
        loggedOut += 1;
        return Promise.resolve();
      }
    }));
    await selectProvider(config, "gini-relay");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(loggedOut).toBe(0);
  });

  test("disconnect after a partial manual connect failure (error record) still cleans up provider state", async () => {
    // tailscale serve came up but the DNS lookup failed -> record "error" with
    // provider-side state live; disconnect must be able to clean that up.
    const tailscale = scriptedDriver({ connect: () => Promise.reject(new Error("tailscale status failed: down")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    await disconnectTunnel(config);
    expect(tailscale.disconnects).toBe(1);
  });

  test("reconcile resumes a connected manual tunnel when its driver is still available", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await seedManualConnected(config, "tailscale");
    const flipped = await reconcileTunnelOnStartup(config);
    expect(flipped.status).toBe("connecting");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(getTunnel(config).url).toBe("https://machine.tail-test.ts.net");
    expect(tailscale.connects).toBe(1);
  });

  test("reconcile resets a connected manual tunnel to idle when its prerequisite is gone", async () => {
    setTunnelDeps(deps()); // all manual drivers detect disabled
    await seedManualConnected(config, "tailscale");
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("tailscale");
  });

  test("the catalog carries setup steps for every manual provider, enabled or not", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    await refreshProviderDetection();
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId["gini-relay"].setup).toBeUndefined();
    // Enabled and disabled rows both carry their host-side steps.
    expect(byId.tailscale.enabled).toBe(true);
    expect(byId.tailscale.setup?.[0]).toContain("Install Tailscale");
    expect(byId.ngrok.enabled).toBe(false);
    expect(byId.ngrok.setup?.some((s) => s.includes("authtoken"))).toBe(true);
    expect(byId.cloudflare.setup?.[0]).toContain("Install cloudflared");
  });

  test("switching providers away from a live childless manual tunnel tears down its provider state", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok: scriptedDriver() }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Selecting a DIFFERENT provider while tailscale serve is live must turn
    // the serve config off — otherwise the old front keeps serving while the
    // record reads idle.
    const switched = await selectProvider(config, "ngrok");
    expect(switched.selectedProvider).toBe("ngrok");
    expect(switched.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);

    // Re-selecting the already-idle provider does NOT re-run the teardown.
    await selectProvider(config, "tailscale");
    expect(tailscale.disconnects).toBe(1);
  });

  test("a failing provider-side teardown never blocks the provider switch", async () => {
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok: scriptedDriver() }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    const switched = await selectProvider(config, "ngrok");
    expect(switched.selectedProvider).toBe("ngrok");
    expect(switched.status).toBe("idle");
  });

  test("manual resume settles to idle when the web never comes back", async () => {
    process.env.GINI_TUNNEL_RESUME_WAIT_MS = "0";
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "1";
    try {
      setTunnelDeps(deps({
        probeLocalPort: () => Promise.resolve(false),
        drivers: fakeDrivers({ ngrok: scriptedDriver() })
      }));
      await seedManualConnected(config, "ngrok");
      await reconcileTunnelOnStartup(config);
      await awaitTunnelSettled(config.instance);
      expect(getTunnel(config).status).toBe("idle");
      expect(getTunnel(config).selectedProvider).toBe("ngrok");
    } finally {
      delete process.env.GINI_TUNNEL_RESUME_WAIT_MS;
      delete process.env.GINI_TUNNEL_RESUME_POLL_MS;
    }
  });
});

// ---------------------------------------------------------------------------
// spawnUrlChild: the URL-scanning process wrapper the ngrok/cloudflared
// drivers ride on.
// ---------------------------------------------------------------------------

// A scriptable SpawnedTunnelProc: push lines into stdout/stderr, resolve exit.
function fakeProc(): SpawnedTunnelProc & {
  emitOut: (line: string) => Promise<void>;
  emitErr: (line: string) => Promise<void>;
  exit: (code: number) => void;
  killed: boolean;
} {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const err = new TransformStream<Uint8Array, Uint8Array>();
  const outWriter = out.writable.getWriter();
  const errWriter = err.writable.getWriter();
  const exited = Promise.withResolvers<number>();
  const encoder = new TextEncoder();
  const proc = {
    stdout: out.readable,
    stderr: err.readable,
    exited: exited.promise,
    killed: false,
    kill() {
      proc.killed = true;
      exited.resolve(143);
    },
    // Return the write promise: awaiting it deterministically orders the
    // scanner's read (the parked reader resolves in the same microtask job)
    // ahead of the test's next step — no fixed sleeps needed.
    emitOut(line: string) {
      return outWriter.write(encoder.encode(`${line}\n`));
    },
    emitErr(line: string) {
      return errWriter.write(encoder.encode(`${line}\n`));
    },
    exit(code: number) {
      exited.resolve(code);
    }
  };
  return proc;
}

describe("spawnUrlChild", () => {
  test("resolves the first capture-group match and wraps the live process", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(https:\/\/[^\s"]+)/, 5_000);
    proc.emitOut("t=1 lvl=info msg=starting");
    proc.emitOut('t=2 lvl=info msg="started tunnel" url=https://ab-12.ngrok-free.app');
    const result = await pending;
    expect(result.url).toBe("https://ab-12.ngrok-free.app");
    expect(result.child).toBeDefined();
    await result.child!.start();
    const stopped = result.child!.stop();
    expect(proc.killed).toBe(true);
    expect(await stopped).toBe(143);
  });

  test("matches on stderr too (cloudflared logs there) using the whole match", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(
      () => proc,
      ["cloudflared"],
      /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/,
      5_000
    );
    proc.emitErr("INF +--------------------------------+");
    proc.emitErr("INF |  https://some-words.trycloudflare.com  |");
    const result = await pending;
    expect(result.url).toBe("https://some-words.trycloudflare.com");
  });

  test("an exit before the URL rejects with the output tail and the agent name", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(\S+)/, 5_000);
    // Awaiting the write delivers the line to the scanner (same microtask job
    // resolves the parked read) before the exit races it — deterministic.
    await proc.emitErr("ERROR: authentication failed: your authtoken is invalid");
    proc.exit(1);
    await expect(pending).rejects.toThrow(/ngrok exited \(code 1\).*authtoken is invalid/);
  });

  test("a silent agent times out, is killed, and rejects", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["cloudflared"], /never-matches/, 10);
    await expect(pending).rejects.toThrow(/did not report a public URL/);
    expect(proc.killed).toBe(true);
  });

  test("a stream that errors mid-read is swallowed; the exit watcher still settles the result", async () => {
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const writer = out.writable.getWriter();
    const exited = Promise.withResolvers<number>();
    const proc: SpawnedTunnelProc = {
      stdout: out.readable,
      stderr: null,
      exited: exited.promise,
      kill: () => exited.resolve(143)
    };
    const pending = spawnUrlChild(() => proc, ["agent"], /url=(\S+)/, 5_000);
    await writer.write(new TextEncoder().encode("warming up\n"));
    // The pipe tears down (e.g. the process was killed externally) — the read
    // loop's catch must swallow it rather than surface an unhandled rejection.
    await writer.abort(new Error("pipe torn down"));
    exited.resolve(9);
    await expect(pending).rejects.toThrow(/agent exited \(code 9\)/);
  });

  test("the default spawn wrapper drives a real process end to end", async () => {
    const pending = spawnUrlChild(
      defaultTunnelProcSpawn,
      ["sh", "-c", 'echo "url=https://real.example.test"; sleep 30'],
      /url=(\S+)/,
      5_000
    );
    const result = await pending;
    expect(result.url).toBe("https://real.example.test");
    // stop() kills the real child and resolves with its exit code.
    await result.child!.stop();
  });
});

// ---------------------------------------------------------------------------
// makeDefaultDrivers: the real CLI adapters, exercised through injected
// run/spawn seams (no tailscale/ngrok/cloudflared binaries involved).
// ---------------------------------------------------------------------------
describe("makeDefaultDrivers", () => {
  const TS_STATUS_RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail-test.ts.net." } });

  function runScript(script: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): {
    run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      run: (argv: string[]) => {
        const key = argv.join(" ");
        calls.push(key);
        const entry = script[key];
        if (!entry) return Promise.reject(new Error(`unscripted command: ${key}`));
        return Promise.resolve({ exitCode: entry.exitCode, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" });
      }
    };
  }

  test("tailscale: detect requires a Running backend with a MagicDNS name", async () => {
    const running = runScript({ "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING } });
    expect(await makeDefaultDrivers(running.run).tailscale.detect()).toEqual({ enabled: true });

    const stopped = runScript({
      "tailscale status --json": { exitCode: 0, stdout: JSON.stringify({ BackendState: "Stopped", Self: {} }) }
    });
    expect((await makeDefaultDrivers(stopped.run).tailscale.detect()).enabled).toBe(false);

    const badJson = runScript({ "tailscale status --json": { exitCode: 0, stdout: "not json" } });
    expect((await makeDefaultDrivers(badJson.run).tailscale.detect()).enabled).toBe(false);

    const missing = runScript({});
    expect((await makeDefaultDrivers(missing.run).tailscale.detect()).enabled).toBe(false);
  });

  test("tailscale: connect serves the gateway port and reports the ts.net URL; disconnect turns serve off", async () => {
    const script = runScript({
      "tailscale serve --bg http://127.0.0.1:7342": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING },
      "tailscale serve --https=443 off": { exitCode: 0 }
    });
    const driver = makeDefaultDrivers(script.run).tailscale;
    expect(await driver.connect(7342)).toEqual({ url: "https://mac.tail-test.ts.net" });
    await driver.disconnect!();
    expect(script.calls).toEqual([
      "tailscale serve --bg http://127.0.0.1:7342",
      "tailscale status --json",
      "tailscale serve --https=443 off"
    ]);
  });

  test("tailscale: connect surfaces serve failures, status failures, bad json, and a missing DNS name", async () => {
    const serveFails = runScript({ "tailscale serve --bg http://127.0.0.1:1": { exitCode: 1, stderr: "serve: not allowed" } });
    await expect(makeDefaultDrivers(serveFails.run).tailscale.connect(1)).rejects.toThrow("tailscale serve failed: serve: not allowed");

    const statusFails = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 1, stderr: "down" }
    });
    await expect(makeDefaultDrivers(statusFails.run).tailscale.connect(1)).rejects.toThrow("tailscale status failed: down");

    const badJson = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: "{" }
    });
    await expect(makeDefaultDrivers(badJson.run).tailscale.connect(1)).rejects.toThrow("unparseable JSON");

    const noName = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: JSON.stringify({ Self: {} }) }
    });
    await expect(makeDefaultDrivers(noName.run).tailscale.connect(1)).rejects.toThrow("MagicDNS");
  });

  test("ngrok and cloudflared: detect maps the CLI checks; a missing binary disables", async () => {
    const ok = runScript({
      "ngrok config check": { exitCode: 0, stdout: "Valid configuration" },
      "cloudflared --version": { exitCode: 0, stdout: "cloudflared version 2026.6.0" }
    });
    expect(await makeDefaultDrivers(ok.run).ngrok.detect()).toEqual({ enabled: true });
    expect(await makeDefaultDrivers(ok.run).cloudflare.detect()).toEqual({ enabled: true });

    const none = runScript({});
    expect((await makeDefaultDrivers(none.run).ngrok.detect()).enabled).toBe(false);
    expect((await makeDefaultDrivers(none.run).cloudflare.detect()).enabled).toBe(false);
  });

  test("ngrok and cloudflared: connect spawns the agent and scans for its URL", async () => {
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const spawned: string[][] = [];
      const procs: ReturnType<typeof fakeProc>[] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        procs.push(proc);
        return proc;
      };
      // No ~/.cloudflared/config.yml -> the quick-tunnel fallback.
      const drivers = makeDefaultDrivers(runScript({}).run, spawn, async () => null);

      const ngrokPending = drivers.ngrok.connect(7342);
      procs[0]!.emitOut('msg="started tunnel" url=https://xy-1.ngrok-free.app');
      expect((await ngrokPending).url).toBe("https://xy-1.ngrok-free.app");
      expect(spawned[0]).toEqual(["ngrok", "http", "7342", "--log", "stdout", "--log-format", "logfmt"]);

      const cfPending = drivers.cloudflare.connect(7342);
      // The cloudflare connect awaits the config read before spawning — poll
      // for the spawn instead of assuming it happened synchronously.
      while (procs.length < 2) await Bun.sleep(1);
      procs[1]!.emitErr("INF |  https://ab-cd.trycloudflare.com  |");
      expect((await cfPending).url).toBe("https://ab-cd.trycloudflare.com");
      expect(spawned[1]).toEqual(["cloudflared", "--config", "/dev/null", "tunnel", "--url", "http://127.0.0.1:7342"]);
    } finally {
      delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    }
  });

  test("cloudflared: a named-tunnel config.yml runs the OPERATOR'S tunnel against the gateway and publishes its stable hostname", async () => {
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const CONFIG = [
        "tunnel: d8eafe76-0586-454c-8846-2e86db3cecb3",
        "credentials-file: /Users/op/.cloudflared/d8eafe76-0586-454c-8846-2e86db3cecb3.json",
        "",
        "ingress:",
        "  - hostname: app.demoivyly.com",
        "    service: http://localhost:3000",
        "  - service: http_status:404"
      ].join("\n");
      const spawned: string[][] = [];
      const procs: ReturnType<typeof fakeProc>[] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        procs.push(proc);
        return proc;
      };
      const drivers = makeDefaultDrivers(runScript({}).run, spawn, async () => CONFIG);
      const pending = drivers.cloudflare.connect(7342);
      while (procs.length < 1) await Bun.sleep(1);
      procs[0]!.emitErr("2026-06-12T00:00:00Z INF Registered tunnel connection connIndex=0");
      const result = await pending;
      // The stable named-tunnel hostname (SSE-capable), NOT a trycloudflare URL.
      expect(result.url).toBe("https://app.demoivyly.com");
      expect(result.child).toBeDefined();
      // --config /dev/null is required even here: with ingress rules loaded
      // the --url origin override would be ignored.
      expect(spawned[0]).toEqual([
        "cloudflared", "--config", "/dev/null",
        "tunnel", "--cred-file", "/Users/op/.cloudflared/d8eafe76-0586-454c-8846-2e86db3cecb3.json",
        "run", "--url", "http://127.0.0.1:7342", "d8eafe76-0586-454c-8846-2e86db3cecb3"
      ]);
    } finally {
      delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    }
  });

  test("defaultReadCloudflareConfig returns text when readable and null otherwise", async () => {
    const prevHome = process.env.HOME;
    try {
      // A HOME with no ~/.cloudflared -> null.
      process.env.HOME = "/tmp/gini-no-cloudflared-home";
      expect(await defaultReadCloudflareConfig()).toBeNull();
      // A HOME with a config.yml -> its text.
      const home = "/tmp/gini-cloudflared-home";
      rmSync(home, { recursive: true, force: true });
      mkdirSync(`${home}/.cloudflared`, { recursive: true });
      await Bun.write(`${home}/.cloudflared/config.yml`, "tunnel: abc\n");
      process.env.HOME = home;
      expect(await defaultReadCloudflareConfig()).toBe("tunnel: abc\n");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("parseCloudflareConfig folds: null, no tunnel id, no hostname, defaulted credentials file", () => {
    expect(parseCloudflareConfig(null)).toBeNull();
    expect(parseCloudflareConfig("ingress:\n  - hostname: a.example\n    service: x")).toBeNull();
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - service: http_status:404")).toBeNull();
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - hostname: a.example\n    service: x")).toEqual({
      id: "abc-123",
      credentialsFile: undefined,
      hostname: "a.example"
    });
  });

  test("cloudflared: a config without credentials-file defaults to ~/.cloudflared/<id>.json", async () => {
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const spawned: string[][] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        void proc.emitErr("INF Registered tunnel connection connIndex=0");
        return proc;
      };
      const drivers = makeDefaultDrivers(
        runScript({}).run,
        spawn,
        async () => "tunnel: abc-123\ningress:\n  - hostname: gini.example.com\n    service: http://localhost:3000"
      );
      const result = await drivers.cloudflare.connect(7342);
      expect(result.url).toBe("https://gini.example.com");
      expect(spawned[0]).toEqual([
        "cloudflared", "--config", "/dev/null",
        "tunnel", "--cred-file", `${process.env.HOME}/.cloudflared/abc-123.json`,
        "run", "--url", "http://127.0.0.1:7342", "abc-123"
      ]);
    } finally {
      delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    }
  });

  test("the manual-connect timeout env knob falls back on garbage and applies when set", async () => {
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "10";
    try {
      const spawn = (): SpawnedTunnelProc => fakeProc();
      await expect(makeDefaultDrivers(runScript({}).run, spawn).ngrok.connect(1)).rejects.toThrow(
        /did not report a public URL/
      );
    } finally {
      delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    }
  });

  test("defaultRunCommand runs a real command and captures exit code + both streams", async () => {
    const result = await defaultRunCommand(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("defaultRunCommand kills a command that outlives its timeout", async () => {
    const result = await defaultRunCommand(["sleep", "30"], 25);
    expect(result.exitCode).not.toBe(0);
  });
});
