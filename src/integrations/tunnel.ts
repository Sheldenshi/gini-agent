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
import { clearRuntimeTunnelTrust, setRuntimeTunnelTrust } from "../lib/origin-trust";

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

// ---------------------------------------------------------------------------
// Manual tunnel drivers (tailscale serve / ngrok / cloudflared quick tunnel).
//
// Each driver knows how to (a) DETECT whether its prerequisite is met on this
// machine — which is what flips the catalog row from disabled to enabled —
// (b) CONNECT: bring the tunnel up for the gateway port and report the public
// URL (plus a supervised child for process-backed tunnels), and (c) optionally
// DISCONNECT provider-side state (tailscale's serve config persists outside
// any child process). Defaults shell out to the real CLIs; tests inject fakes
// through `setTunnelDeps({ drivers })`.
// ---------------------------------------------------------------------------

export const MANUAL_PROVIDER_IDS = ["tailscale", "ngrok", "cloudflare"] as const;
export type ManualProviderId = (typeof MANUAL_PROVIDER_IDS)[number];

export interface ProviderAvailability {
  enabled: boolean;
  requires?: string;
}

export interface ManualDriverResult {
  url: string;
  // Present for process-backed tunnels (ngrok, cloudflared); absent for
  // tailscale serve, whose lifetime lives in tailscaled, not a child of ours.
  child?: TunnelChild;
}

export interface ManualDriver {
  detect(): Promise<ProviderAvailability>;
  connect(port: number): Promise<ManualDriverResult>;
  disconnect?(): Promise<void>;
}

const DEFAULT_REQUIRES: Record<ManualProviderId, string> = {
  tailscale: "Tailscale network",
  ngrok: "ngrok account",
  cloudflare: "cloudflared CLI"
};

// Host-side setup steps per manual provider, surfaced by the panel's info
// affordance so an unavailable row tells the user exactly how to make it
// available (and an available row how it was satisfied). Code, not state —
// like the catalog itself.
const PROVIDER_SETUP: Record<ManualProviderId, string[]> = {
  tailscale: [
    "Install Tailscale: brew install tailscale (or the Mac App Store app)",
    "Sign in and join your tailnet: tailscale up",
    "That's it — Gini runs `tailscale serve` for you and publishes https://<machine>.<tailnet>.ts.net (private to your tailnet)"
  ],
  ngrok: [
    "Install ngrok: brew install ngrok",
    "Create a free account at https://dashboard.ngrok.com and copy your authtoken",
    "Authenticate the agent: ngrok config add-authtoken <token>",
    "Gini then runs `ngrok http <gateway-port>` for you — free-tier URLs are random per connect and show a one-time browser interstitial"
  ],
  cloudflare: [
    "Install cloudflared: brew install cloudflared",
    "Best: set up a named tunnel on your own domain (cloudflared tunnel login / create / route dns — see the Remote Access guide). With a ~/.cloudflared/config.yml present, Gini runs YOUR tunnel pointed at the gateway and publishes your stable hostname — SSE (live updates) works",
    "No named tunnel? No account needed — Gini falls back to a quick tunnel with a random https://<words>.trycloudflare.com URL. Testing-grade: no SSE (live updates need a reload) and the URL changes per connect"
  ]
};

// A named Cloudflare tunnel parsed from ~/.cloudflared/config.yml: the tunnel
// id, its credentials file, and the first ingress hostname (the operator's
// stable public name for this tunnel). Minimal line-based parse — the file is
// cloudflared's own simple key/value + ingress-list shape, not arbitrary YAML.
export interface NamedCloudflareTunnel {
  id: string;
  credentialsFile?: string;
  hostname: string;
}

export function parseCloudflareConfig(body: string | null): NamedCloudflareTunnel | null {
  if (!body) return null;
  const id = /^tunnel:\s*([A-Za-z0-9-]+)\s*$/m.exec(body)?.[1];
  const credentialsFile = /^credentials-file:\s*(\S+)\s*$/m.exec(body)?.[1];
  const hostname = /^\s*-\s*hostname:\s*(\S+)\s*$/m.exec(body)?.[1];
  if (!id || !hostname) return null;
  return { id, credentialsFile, hostname };
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type RunCommand = (argv: string[], timeoutMs?: number) => Promise<RunResult>;

// Run a short-lived CLI command, capturing output. A missing binary rejects
// (Bun.spawn throws ENOENT) — callers treat that as "prerequisite not met".
export async function defaultRunCommand(argv: string[], timeoutMs = 15_000): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

// The slim process surface a long-running tunnel agent needs. Mirrors
// Bun.spawn's shape so the default is a thin wrapper and tests can fake the
// streams deterministically.
export interface SpawnedTunnelProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}
export type TunnelProcSpawn = (argv: string[]) => SpawnedTunnelProc;

export const defaultTunnelProcSpawn: TunnelProcSpawn = (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
};

// How long a spawned tunnel agent gets to print its public URL before the
// connect is declared failed. Read at call time so tests can tighten it.
function manualConnectTimeoutMs(): number {
  const v = Number(process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

// Spawn a tunnel agent and scan its output for the public URL. Resolves with
// the url + a TunnelChild wrapping the live process; rejects (and kills the
// process) if the agent exits or stays silent past the deadline. The last few
// output lines ride along in the error so the panel shows the real cause
// (auth failure, port clash, …) instead of a bare timeout.
export async function spawnUrlChild(
  spawn: TunnelProcSpawn,
  argv: string[],
  urlPattern: RegExp,
  timeoutMs: number
): Promise<ManualDriverResult> {
  const proc = spawn(argv);
  const settled = Promise.withResolvers<string>();
  const tail: string[] = [];
  let buffered = "";

  const scan = (chunk: string): void => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        tail.push(line.trim());
        if (tail.length > 20) tail.shift();
      }
      const match = urlPattern.exec(line);
      if (match) settled.resolve(match[1] ?? match[0]);
    }
  };

  const readAll = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scan(decoder.decode(value, { stream: true }));
      }
    } catch {
      // The stream tears down when the process is killed; the race below
      // already settled (or will settle via `exited`).
    }
  };
  void readAll(proc.stdout);
  void readAll(proc.stderr);

  const timer = setTimeout(() => {
    settled.reject(new Error(`${argv[0]} did not report a public URL within ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);
  void proc.exited.then((code) => {
    settled.reject(
      new Error(`${argv[0]} exited (code ${code}) before reporting a public URL${tail.length ? `: ${tail.slice(-3).join(" | ")}` : "."}`)
    );
  });

  try {
    const url = await settled.promise;
    return {
      url,
      child: {
        start: () => Promise.resolve(0),
        stop: () => {
          proc.kill();
          return proc.exited;
        },
        exited: proc.exited
      }
    };
  } catch (error) {
    proc.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Read the operator's ~/.cloudflared/config.yml (null when absent/unreadable).
// Exported so tests can exercise the real default read seam.
export async function defaultReadCloudflareConfig(): Promise<string | null> {
  try {
    return await Bun.file(`${process.env.HOME}/.cloudflared/config.yml`).text();
  } catch {
    return null;
  }
}

// Build the real CLI-backed drivers. Exported with injectable run/spawn/read
// seams so tests cover every fold without the tailscale/ngrok/cloudflared
// binaries or a real ~/.cloudflared.
export function makeDefaultDrivers(
  run: RunCommand = defaultRunCommand,
  spawn: TunnelProcSpawn = defaultTunnelProcSpawn,
  readCloudflareConfig: () => Promise<string | null> = defaultReadCloudflareConfig
): Record<ManualProviderId, ManualDriver> {
  const tailscaleDnsName = async (): Promise<string> => {
    const status = await run(["tailscale", "status", "--json"]);
    if (status.exitCode !== 0) {
      throw new Error(`tailscale status failed: ${(status.stderr || status.stdout).trim()}`);
    }
    let name = "";
    try {
      const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: string } };
      name = (parsed.Self?.DNSName ?? "").replace(/\.$/, "");
    } catch {
      throw new Error("tailscale status returned unparseable JSON.");
    }
    if (!name) throw new Error("tailscale did not report a MagicDNS name for this machine.");
    return name;
  };

  // Detection probes get a tight timeout: boot awaits a detection pass before
  // Bun.serve binds, and the CLI's start health window is 5,000 ms total
  // (src/cli/process.ts) — a wedged provider CLI must not eat that budget.
  const DETECT_TIMEOUT_MS = 2_000;

  return {
    tailscale: {
      detect: async () => {
        const status = await run(["tailscale", "status", "--json"], DETECT_TIMEOUT_MS).catch(() => null);
        if (status && status.exitCode === 0) {
          try {
            const parsed = JSON.parse(status.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
            if (parsed.BackendState === "Running" && (parsed.Self?.DNSName ?? "").replace(/\.$/, "")) {
              return { enabled: true };
            }
          } catch {
            // fall through to disabled
          }
        }
        return { enabled: false, requires: DEFAULT_REQUIRES.tailscale };
      },
      // `tailscale serve --bg` persists in tailscaled (no child to supervise)
      // and is idempotent, which is also what makes the boot resume safe.
      connect: async (port) => {
        const serve = await run(["tailscale", "serve", "--bg", `http://127.0.0.1:${port}`]);
        if (serve.exitCode !== 0) {
          throw new Error(`tailscale serve failed: ${(serve.stderr || serve.stdout).trim()}`);
        }
        return { url: `https://${await tailscaleDnsName()}` };
      },
      disconnect: async () => {
        await run(["tailscale", "serve", "--https=443", "off"]);
      }
    },
    ngrok: {
      detect: async () => {
        const check = await run(["ngrok", "config", "check"], DETECT_TIMEOUT_MS).catch(() => null);
        return check && check.exitCode === 0
          ? { enabled: true }
          : { enabled: false, requires: DEFAULT_REQUIRES.ngrok };
      },
      connect: (port) =>
        spawnUrlChild(
          spawn,
          ["ngrok", "http", String(port), "--log", "stdout", "--log-format", "logfmt"],
          /url=(https:\/\/[^\s"]+)/,
          manualConnectTimeoutMs()
        )
    },
    cloudflare: {
      detect: async () => {
        const version = await run(["cloudflared", "--version"], DETECT_TIMEOUT_MS).catch(() => null);
        return version && version.exitCode === 0
          ? { enabled: true }
          : { enabled: false, requires: DEFAULT_REQUIRES.cloudflare };
      },
      // Prefer the operator's NAMED tunnel when ~/.cloudflared/config.yml
      // declares one: run it with the GATEWAY as the catch-all origin so the
      // tunnel's stable DNS-routed hostname serves Gini — and named tunnels
      // proxy SSE, unlike quick tunnels. `--config /dev/null` is REQUIRED
      // here too: --url is ignored whenever ingress rules load, so running
      // with the config would route the hostname to the config's own service
      // instead of the gateway. Credentials are passed explicitly (the
      // config's credentials-file, defaulting to ~/.cloudflared/<id>.json).
      // Without a named tunnel, fall back to an ephemeral quick tunnel.
      connect: async (port) => {
        const named = parseCloudflareConfig(await readCloudflareConfig());
        if (named) {
          const credFile = named.credentialsFile ?? `${process.env.HOME}/.cloudflared/${named.id}.json`;
          // Registration is logged, not the public hostname (that's DNS-routed)
          // — wait for a registered connection, then publish the config's
          // stable hostname.
          const result = await spawnUrlChild(
            spawn,
            [
              "cloudflared", "--config", "/dev/null",
              "tunnel", "--cred-file", credFile,
              "run", "--url", `http://127.0.0.1:${port}`, named.id
            ],
            /(Registered tunnel connection|Connection [a-f0-9-]+ registered)/,
            manualConnectTimeoutMs()
          );
          return { url: `https://${named.hostname}`, child: result.child };
        }
        return spawnUrlChild(
          spawn,
          ["cloudflared", "--config", "/dev/null", "tunnel", "--url", `http://127.0.0.1:${port}`],
          /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/,
          manualConnectTimeoutMs()
        );
      }
    }
  };
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
  // The manual tunnel drivers (tailscale / ngrok / cloudflared).
  drivers: Record<ManualProviderId, ManualDriver>;
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
    logout: (config: RuntimeConfig) => defaultLogout(config.instance),
    drivers: makeDefaultDrivers()
  };
}

let deps: TunnelDeps = makeDefaultDeps();

// Swap the gini-relay/driver seams. Tests inject fakes; calling with no
// argument restores the real implementations (so a test can clean up after
// itself). Either way the detection cache and runtime-tunnel trust registry
// reset, so availability/trust never leaks between tests.
export function setTunnelDeps(next?: Partial<TunnelDeps>): void {
  deps = next ? { ...makeDefaultDeps(), ...next } : makeDefaultDeps();
  detection = defaultDetection();
  detectionAt = 0;
  detectionInFlight = null;
  clearRuntimeTunnelTrust();
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

// Monotonic per-instance epoch for CHILDLESS provider-side state (tailscale
// serve lives in tailscaled, not in a child we can stop). Every action that
// may publish or tear down that state bumps the epoch; a DEFERRED teardown
// (the superseded-connect abort path, which fires after its own awaits) only
// runs if the epoch hasn't moved since its run began — otherwise a stale
// `tailscale serve off` could turn off the front a NEWER connect just
// published, leaving a "connected" record with a dead URL and no child
// watcher to flip it to error.
const providerSideEpochs = new Map<Instance, number>();

function bumpProviderSideEpoch(instance: Instance): number {
  const next = (providerSideEpochs.get(instance) ?? 0) + 1;
  providerSideEpochs.set(instance, next);
  return next;
}

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
//
// NOTE: a connected CHILDLESS tunnel (tailscale serve) is deliberately NOT
// torn down here — serve persisting in tailscaled across a runtime restart is
// what makes the boot resume seamless (the same ts.net URL keeps answering
// while the gateway restarts), mirroring how frpc relay state outlives a
// non-graceful exit. The reconcile resumes or settles the record on the next
// boot; an operator who wants the front gone disconnects before stopping.
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
// Provider catalog + availability detection.
// ---------------------------------------------------------------------------

// Last-known driver availability. The catalog is rebuilt from this cache on
// every read (never persisted); the cache itself refreshes via
// `refreshProviderDetection` — at boot, on an explicit `GET /api/tunnel?detect=1`
// (the panel-open / CLI-status path), and lazily when a select/connect targets
// a provider the cache still marks disabled. Plain polling GETs never spawn
// detection subprocesses.
function defaultDetection(): Record<ManualProviderId, ProviderAvailability> {
  return {
    tailscale: { enabled: false, requires: DEFAULT_REQUIRES.tailscale },
    ngrok: { enabled: false, requires: DEFAULT_REQUIRES.ngrok },
    cloudflare: { enabled: false, requires: DEFAULT_REQUIRES.cloudflare }
  };
}
let detection: Record<ManualProviderId, ProviderAvailability> = defaultDetection();
let detectionAt = 0;
let detectionInFlight: Promise<void> | null = null;
const DETECTION_TTL_MS = 5_000;

export function isManualProviderId(id: string): id is ManualProviderId {
  return (MANUAL_PROVIDER_IDS as readonly string[]).includes(id);
}

// Probe every manual driver and update the availability cache. Concurrent
// callers share one in-flight probe; results within the TTL are reused so a
// polling burst doesn't stack subprocess spawns. `force` (the explicit
// `?detect=1` panel-open / CLI-status path) bypasses the TTL — the panel
// promises "availability is re-checked each time it opens" — but still
// shares an in-flight probe. A driver that throws stays default-disabled.
export function refreshProviderDetection(force = false): Promise<void> {
  if (!force && Date.now() - detectionAt < DETECTION_TTL_MS) return Promise.resolve();
  if (detectionInFlight) return detectionInFlight;
  detectionInFlight = (async () => {
    const next = defaultDetection();
    await Promise.all(
      MANUAL_PROVIDER_IDS.map(async (id) => {
        try {
          next[id] = await deps.drivers[id].detect();
        } catch {
          // keep the default-disabled entry
        }
      })
    );
    detection = next;
    detectionAt = Date.now();
  })().finally(() => {
    detectionInFlight = null;
  });
  return detectionInFlight;
}

// The provider catalog: gini-relay is always available; the manual providers
// reflect the last detection pass (disabled with a `requires` explanation
// until their CLI prerequisite is found). The order here is the order the
// panel renders them. Rebuilt fresh on every read — never persisted.
function providerCatalog(): TunnelProvider[] {
  const availability = (id: ManualProviderId): { enabled: boolean; requires?: string; setup: string[] } => {
    const entry = detection[id];
    return entry.enabled
      ? { enabled: true, setup: PROVIDER_SETUP[id] }
      : { enabled: false, requires: entry.requires ?? DEFAULT_REQUIRES[id], setup: PROVIDER_SETUP[id] };
  };
  return [
    { id: "gini-relay", name: "Gini Relay", enabled: true },
    { id: "tailscale", name: "Tailscale", ...availability("tailscale") },
    { id: "ngrok", name: "ngrok", ...availability("ngrok") },
    { id: "cloudflare", name: "Cloudflare", ...availability("cloudflare") }
  ];
}

// Resolve a catalog entry by id, or undefined if the id isn't a known
// provider. Selection/connect validate against this so a disabled or
// unknown provider is rejected before any state mutation.
function findProvider(id: string): TunnelProvider | undefined {
  return providerCatalog().find((provider) => provider.id === id);
}

// Write the tunnel record AND sync the runtime-tunnel origin trust to it: a
// `connected` record's url front is admitted by the gateway's web-bound guard
// (src/lib/origin-trust.ts) exactly while the record says connected — every
// transition away from connected revokes the front atomically with the state
// write, so a torn-down tunnel host can't keep riding the trust lane.
function applyTunnel(
  state: RuntimeState,
  fields: Parameters<typeof createTunnelRecord>[1]
): NonNullable<RuntimeState["tunnel"]> {
  const record = createTunnelRecord(state, fields);
  state.tunnel = record;
  setRuntimeTunnelTrust(record.instance, record.status === "connected" && record.url ? record.url : null);
  return record;
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
  let entry = findProvider(provider);
  if (!entry) throw new Error(`Unknown tunnel provider: ${provider}`);
  if (!entry.enabled && isManualProviderId(entry.id)) {
    // The availability cache may predate a freshly-installed CLI (or a fresh
    // boot) — re-probe before rejecting so a valid selection never bounces.
    await refreshProviderDetection();
    entry = findProvider(provider) ?? entry;
  }
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
  // idle (an orphaned child). No-op when nothing is live. Capture the entry
  // being torn down so the idle write below can detect a connect that claims
  // the instance during the teardown awaits.
  const torndown = supervisors.get(config.instance);
  teardown(config.instance);
  // A live MANUAL tunnel may have provider-side state that outlives any child
  // of ours (tailscale serve persists in tailscaled) — tear that down too, or
  // the old front would keep serving while the record reads idle. `error`
  // counts as live: a partial connect can leave provider-side state up.
  // Best-effort and idempotent; the epoch bump invalidates any stale deferred
  // teardown still in flight from a superseded run.
  if (
    current &&
    current.selectedProvider &&
    current.selectedProvider !== entry.id &&
    current.status !== "idle" &&
    isManualProviderId(current.selectedProvider)
  ) {
    bumpProviderSideEpoch(config.instance);
    try {
      await deps.drivers[current.selectedProvider].disconnect?.();
    } catch {
      // never block a provider switch on the old provider's teardown.
    }
  }
  return mutateState(config.instance, (state) => {
    // A connect claimed the instance during the teardown awaits — leave its
    // live record intact; the user's later action (the connect) wins over
    // this earlier-started selection write.
    const live = supervisors.get(config.instance);
    if (live && live !== torndown) return toState(state.tunnel ?? null);
    applyTunnel(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: entry.id,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
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
  let entry = findProvider(requested);
  if (!entry) throw new Error(`Unknown tunnel provider: ${requested}`);
  if (!entry.enabled && isManualProviderId(entry.id)) {
    await refreshProviderDetection();
    entry = findProvider(requested) ?? entry;
  }
  if (!entry.enabled) {
    throw new Error(`Tunnel provider ${entry.name} is not available${entry.requires ? ` (requires ${entry.requires})` : ""}.`);
  }

  // Connecting DIRECTLY to a different provider (the explicit-provider path —
  // no selectProvider step ran, so its switch teardown didn't either): a live
  // OLD childless manual front must be torn down, or tailscale serve would
  // keep serving while the record describes the new provider. `error` counts
  // as live — a partial connect can leave provider-side state up. Best-effort,
  // and awaited BEFORE the supervisor claim below so this connect stays the
  // newest claim (last connect wins) when others interleave with the await.
  const previous = readState(config.instance).tunnel;
  if (
    previous &&
    previous.selectedProvider &&
    previous.selectedProvider !== entry.id &&
    previous.status !== "idle" &&
    isManualProviderId(previous.selectedProvider)
  ) {
    bumpProviderSideEpoch(config.instance);
    try {
      await deps.drivers[previous.selectedProvider].disconnect?.();
    } catch {
      // never block the new connect on the old provider's teardown.
    }
  }

  // Tear down any previous in-flight login / live child, then claim a fresh
  // supervisor entry SYNCHRONOUSLY (no await between teardown and the claim) so
  // two concurrent connects get DISTINCT entries: the older run sees it is no
  // longer current and aborts instead of double-spawning a tunnel.
  teardown(config.instance);
  const sup = supervisor(config.instance);

  const id: TunnelProviderId = entry.id;
  const connecting = await mutateState(config.instance, (state) => {
    applyTunnel(state, {
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
  sup.settled = isManualProviderId(id) ? runManualConnect(config, id, sup) : runConnect(config, id, sup);
  return connecting;
}

// Boot-resume web-readiness knobs. Right after a restart the gateway is
// listening but the web child it reverse-proxies may still be (re)compiling, so
// the resume polls the local port until it answers instead of failing on a
// single probe. Read at call time (not module load) so tests can tighten them.
function resumeWaitMs(): number {
  const v = Number(process.env.GINI_TUNNEL_RESUME_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}
function resumePollMs(): number {
  const v = Number(process.env.GINI_TUNNEL_RESUME_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 1_000;
}

// Poll the local web port until the probe succeeds or the deadline elapses. Used
// only by the boot resume (awaitWebReady). Bails false the moment the run is
// superseded (a user connect/cancel during the wait) so it never fights a winner.
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
// it can't reconnect non-interactively (web never came up, or no stored session):
// a routine restart shouldn't surface an "error" badge, and idle lets the user
// reconnect manually. No audit row — the appendLog at the call site is the trace.
async function settleResumeIdle(config: RuntimeConfig, provider: TunnelProviderId): Promise<void> {
  await mutateState(config.instance, (state) => {
    applyTunnel(state, {
      ...(state.tunnel ?? {}),
      selectedProvider: provider,
      status: "idle",
      url: undefined,
      subdomain: undefined,
      message: undefined
    });
  });
}

// The background connect flow for a MANUAL driver (tailscale / ngrok /
// cloudflared). Mirrors runConnect's supervision contract — same web-readiness
// probe, same isCurrent ownership rules, same error-into-state fold — without
// the OAuth/session machinery (these drivers have no login).
async function runManualConnect(
  config: RuntimeConfig,
  provider: ManualProviderId,
  sup: Supervisor,
  opts: { awaitWebReady?: boolean } = {}
): Promise<void> {
  const isCurrent = (): boolean => supervisors.get(config.instance) === sup;
  // Claim a provider-side epoch for this run. The deferred abort teardown
  // below only fires while this is still the latest epoch — a NEWER connect
  // bumps it when it publishes, so a stale `tailscale serve off` can never
  // turn off the front the newer run just brought up.
  const epoch = bumpProviderSideEpoch(config.instance);
  const epochCurrent = (): boolean => providerSideEpochs.get(config.instance) === epoch;
  try {
    const port = deps.resolveLocalPort(config);
    const ready = opts.awaitWebReady
      ? await waitForLocalPort(config, port, isCurrent)
      : await deps.probeLocalPort(config, port);
    if (!ready) {
      if (opts.awaitWebReady) {
        // Boot resume: a restart where the web never came back up shouldn't
        // error — settle idle so the user can reconnect (mirrors the relay
        // resume; waitForLocalPort already returns false when superseded).
        if (isCurrent()) await settleResumeIdle(config, provider);
        appendLog(config.instance, "tunnel.resume.web_unavailable", { provider, port });
        return;
      }
      throw new Error(`Gini's web UI isn't responding on port ${port} — start it, then reconnect.`);
    }
    if (!isCurrent()) {
      appendLog(config.instance, "tunnel.connect.aborted", { provider });
      return;
    }

    const result = await deps.drivers[provider].connect(port);
    if (result.child) sup.child = result.child;

    // A cancel/disconnect or a newer connect may have superseded us while the
    // driver was bringing the tunnel up — tear down what we just started
    // instead of publishing it. Childless drivers (tailscale serve) get their
    // provider-side teardown ONLY while our epoch is still the latest: a newer
    // connect that already re-published the same provider-side front (serve is
    // a singleton in tailscaled) must not have it yanked by this stale loser.
    if (!isCurrent()) {
      if (result.child) {
        void result.child.stop().catch(() => {});
        sup.child = undefined;
      } else if (epochCurrent()) {
        void deps.drivers[provider].disconnect?.().catch(() => {});
      }
      appendLog(config.instance, "tunnel.connect.aborted", { provider });
      return;
    }

    // Publishing: bump the epoch so any STALE superseded run still in flight
    // sees it is no longer current and skips its deferred teardown.
    bumpProviderSideEpoch(config.instance);
    await mutateState(config.instance, (state) => {
      applyTunnel(state, {
        ...(state.tunnel ?? {}),
        selectedProvider: provider,
        status: "connected",
        url: result.url,
        subdomain: undefined,
        message: undefined
      });
      addAudit(
        state,
        {
          actor: "runtime",
          action: "tunnel.connected",
          target: provider,
          risk: "medium",
          evidence: { provider, url: result.url, port }
        },
        { system: true }
      );
    });
    appendLog(config.instance, "tunnel.connected", { provider, url: result.url, port });
    if (result.child) watchChildExit(config, provider, sup, result.child);
  } catch (error) {
    sup.child = undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (!isCurrent()) {
      appendLog(config.instance, "tunnel.connect.aborted", { provider, message });
      return;
    }
    await mutateState(config.instance, (state) => {
      applyTunnel(state, {
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

// The background login + tunnel handshake. Runs the full gini-relay flow:
// mint the consent URL → open it in the host browser → await the session →
// build + start frpc on the local web port → record the public url. On any
// failure (or if the connect was cancelled mid-flight) it writes an "error"
// (or leaves the cancel-written "idle") record. Never throws — errors are
// captured into state so the polling UI surfaces them.
//
// opts (boot resume only):
//   reuseOnly    — never open a browser / mint a fresh login. If the stored
//                  session is missing or rejected, settle to idle instead. Keeps
//                  a headless restart from popping an OAuth tab on the server.
//   awaitWebReady — poll the local port until it answers (the web child may still
//                  be compiling after a restart) instead of a single probe.
async function runConnect(
  config: RuntimeConfig,
  provider: TunnelProviderId,
  sup: Supervisor,
  opts: { reuseOnly?: boolean; awaitWebReady?: boolean } = {}
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
    const ready = opts.awaitWebReady
      ? await waitForLocalPort(config, port, isCurrent)
      : await deps.probeLocalPort(config, port);
    if (!ready) {
      // Boot resume: a restart where the web never came back up shouldn't error —
      // settle idle so the user can reconnect. (waitForLocalPort already returns
      // false when superseded; the isCurrent guard avoids clobbering a winner.)
      if (opts.reuseOnly) {
        if (isCurrent()) await settleResumeIdle(config, provider);
        appendLog(config.instance, "tunnel.resume.web_unavailable", { provider, port });
        return;
      }
      throw new Error(
        `Gini's web UI isn't responding on port ${port} — start it, then reconnect.`
      );
    }
    // A cancel/disconnect/supersede may have landed during the probe await —
    // bail before spawning frpc (reuse path) or minting a login (login path).
    if (!isCurrent()) {
      appendLog(config.instance, "tunnel.connect.aborted", { provider });
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
      applyTunnel(state, {
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
      applyTunnel(state, {
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
        applyTunnel(state, {
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

// Abort a pending connect: status -> "idle", keeping the selection so the
// panel still shows the chosen provider with Connect available. Clears any
// stale url/message and tears down the in-flight login/child.
export async function cancelTunnel(config: RuntimeConfig): Promise<TunnelState> {
  // Capture the record + entry BEFORE the teardown awaits (mirrors disconnect).
  const torndown = supervisors.get(config.instance);
  const before = readState(config.instance).tunnel ?? null;
  teardown(config.instance);
  // Cancel can land AFTER the background connect already flipped the record to
  // "connected" (the UI's Cancel races the connect's completion). For a
  // CHILDLESS manual provider (tailscale serve lives in tailscaled) teardown
  // stops nothing, so run the provider-side teardown here or the old front
  // would keep serving while the record reads idle. Best-effort + idempotent.
  if (
    before?.status === "connected" &&
    before.selectedProvider &&
    isManualProviderId(before.selectedProvider)
  ) {
    bumpProviderSideEpoch(config.instance);
    try {
      await deps.drivers[before.selectedProvider].disconnect?.();
    } catch {
      // never block cancel on a provider-teardown failure.
    }
  }
  return mutateState(config.instance, (state) => {
    // A connect claimed the instance during the teardown awaits — leave its
    // live record intact instead of clobbering it back to idle.
    const current = supervisors.get(config.instance);
    if (current && current !== torndown) return toState(state.tunnel ?? null);
    const selected = state.tunnel?.selectedProvider ?? null;
    applyTunnel(state, {
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
  // Capture the entry we're tearing down BEFORE the provider-teardown awaits:
  // if a new connect claims the instance during those awaits, the idle write
  // below must not clobber its live record.
  const torndown = supervisors.get(config.instance);
  const before = readState(config.instance).tunnel ?? null;
  const selectedBefore = before?.selectedProvider ?? null;
  teardown(config.instance);
  // Provider-side side effects run ONLY when something runtime-managed was
  // actually live (connected/connecting — and error, where a partial connect
  // can leave provider-side state like a tailscale serve that came up before
  // the DNS lookup failed). A bare select-then-disconnect while idle must not
  // log the relay out or turn off an operator's PRE-EXISTING serve config
  // that Gini never started.
  const wasLive = before?.status === "connected" || before?.status === "connecting" || before?.status === "error";
  if (wasLive && selectedBefore === "gini-relay") {
    // Local logout: disconnect severs the connector, so clear this instance's
    // stored relay session (local-only — no server-side revoke; keeps a stable
    // subdomain on reconnect). A later connect then requires a fresh login
    // (best-effort — a logout failure must never block disconnect from settling).
    try {
      await deps.logout(config);
    } catch {
      // never block disconnect on a logout failure.
    }
  } else if (wasLive && selectedBefore && isManualProviderId(selectedBefore)) {
    // Provider-side teardown for drivers whose tunnel outlives any child of
    // ours (tailscale serve). Child-backed drivers were stopped by teardown.
    bumpProviderSideEpoch(config.instance);
    try {
      await deps.drivers[selectedBefore].disconnect?.();
    } catch {
      // never block disconnect on a provider-teardown failure.
    }
  }
  return mutateState(config.instance, (state) => {
    // A connect claimed the instance during the teardown awaits — leave its
    // live record intact instead of clobbering it back to idle.
    const current = supervisors.get(config.instance);
    if (current && current !== torndown) return toState(state.tunnel ?? null);
    const selected = state.tunnel?.selectedProvider ?? null;
    applyTunnel(state, {
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
// REUSES the stored relay session — no browser login — and waits for the web
// child to come back up. It is best-effort: on no session / web-never-ready it
// settles to idle. A prior "connecting" was an incomplete attempt with no
// guaranteed session, so it just resets to idle; idle/error records are left
// untouched. The caller (src/server.ts boot) wraps this in a best-effort
// .catch() so a state-write failure can never crash boot.
export async function reconcileTunnelOnStartup(config: RuntimeConfig): Promise<TunnelState> {
  const record = readState(config.instance).tunnel ?? null;
  if (!record || (record.status !== "connected" && record.status !== "connecting")) {
    return toState(record);
  }
  const selected = record.selectedProvider ?? null;
  // A manual provider's availability cache is empty on a fresh boot — probe
  // before deciding whether the record's provider can resume. (Never rejects:
  // each driver probe catches into its default-disabled entry.)
  if (selected && isManualProviderId(selected)) {
    await refreshProviderDetection();
  }
  const provider = selected ? findProvider(selected) : undefined;
  // Only a tunnel that was actually "connected" (with an enabled provider still
  // in the catalog) resumes; a stale "connecting" just resets to idle.
  const willResume = record.status === "connected" && Boolean(provider?.enabled);

  const next = await mutateState(config.instance, (state) => {
    const prior = state.tunnel?.status;
    applyTunnel(state, {
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
    // Background reconnect, waiting for the web child to become reachable (the
    // gateway binds, and the web child finishes compiling, just after this
    // returns — so the resume probes with retry). gini-relay reuses the stored
    // session (no browser); manual drivers just reconnect — tailscale republishes
    // the same stable ts.net URL, while ngrok/cloudflared mint a fresh one.
    // Retained on the supervisor so tests can await the terminal transition.
    teardown(config.instance);
    const sup = supervisor(config.instance);
    sup.settled = isManualProviderId(provider.id)
      ? runManualConnect(config, provider.id, sup, { awaitWebReady: true })
      : runConnect(config, provider.id, sup, { reuseOnly: true, awaitWebReady: true });
  }
  return next;
}

// Test helper: await the in-flight background connect for an instance so a
// test can observe the terminal connected/error transition deterministically
// without polling. Resolves immediately if no connect is in flight.
export function awaitTunnelSettled(instance: Instance): Promise<void> {
  return supervisors.get(instance)?.settled ?? Promise.resolve();
}
