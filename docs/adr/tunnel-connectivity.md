# ADR: Tunnel Connectivity

## Decision

Gini exposes a remote URL for an instance through a **tunnel provider**, selected and managed by the user through a uniform RPC contract. The gateway owns a small persisted singleton (the user's provider selection + connection status) and rebuilds the provider catalog from code on every read. Every tunnel route returns the **full `TunnelState`** so a single fetch drives the whole selection / connect / connected UI without follow-up requests.

The provider catalog is fixed for now: `gini-relay` is the only enabled provider; `tailscale`, `ngrok`, and `cloudflare` are catalog placeholders surfaced to the UI with a `requires` string explaining the missing prerequisite. The gini-relay connect flow is wired through the [`gini-relay`](https://github.com/Lilac-Labs/gini-relay) client package: `connectTunnel` flips status to `connecting` and returns immediately, then a background handshake mints an OAuth-loopback consent URL (`loginUrl`), opens it in the host browser, awaits the session, builds + starts a native `frpc` tunnel (`buildTunnel`) that exposes the instance's gateway port (the single origin fronting UI + API; see *Exposed port*), and records the public `https://<subdomain>.<relayDomain>` url. The UI/CLI polls `GET /api/tunnel` until status flips to `connected` (with `url`) or `error` (with `message`).

## Context

An instance runs on the user's machine bound to loopback. To reach it from a phone or a remote device, the gateway needs a publicly reachable URL fronted by a tunnel. Users will eventually pick among several tunnel providers (a hosted Gini Relay, their own Tailscale network, ngrok, Cloudflare), but only the hosted relay is being built first. The UI needs the full provider catalog up front — including the disabled ones and why they're disabled — so it can render the selection panel in one pass, and it needs the live connection status to decide which view to show.

The browser-connect capability (`src/capabilities/browser-connect.ts`, ADR-less but mirrored here) established the pattern this follows: an opt-in singleton on `RuntimeState` (`state.browser`), a behavior module exposing thin functions, HTTP routes that delegate to it, and a CLI shim that goes through the gateway. Tunnel connectivity reuses that shape (`state.tunnel`).

## Trust boundary

- The tunnel selection + status are **instance-level** transport state, not per-agent — every agent in the instance shares the one tunnel. Audit rows for select/connect/cancel/disconnect are attributed `{ system: true }`, matching relays and the browser connection.
- The catalog is code, not state: it is never persisted and never accepted from a client. A client can only ask to **select** or **connect** a provider id; the gateway validates that id against the code-defined catalog and rejects unknown or disabled providers before any state mutation. This keeps a client from enabling a provider the runtime isn't ready to drive.
- The HTTP layer maps the user-input rejections (`Unknown tunnel provider…`, `No tunnel provider selected…`, `Tunnel provider … is not available…`) to `400` so the panel surfaces the real reason rather than a generic 500.
- Browser clients never receive the gateway bearer; the Next.js BFF injects it server-side (repo-wide rule). This ADR's backend is independent of any UI — the UI track wires to it in a later step.

## The `TunnelState` contract

Every route returns:

```ts
type TunnelProvider = {
  id: "gini-relay" | "tailscale" | "ngrok" | "cloudflare";
  name: string;
  enabled: boolean;
  requires?: string;
};

type TunnelState = {
  providers: TunnelProvider[];                                   // catalog, drives the panel
  selectedProvider: "gini-relay" | "tailscale" | "ngrok" | "cloudflare" | null;
  status: "idle" | "connecting" | "connected" | "error";
  url?: string;        // present only when status === "connected"
  message?: string;    // present only when status === "error"
};
```

View derivation from state:

- `selectedProvider === null` & status `idle` → Selection panel.
- status `idle` with a selection → Selection panel (Connect available on the selected provider).
- status `connecting` → Selection panel with the selected provider's button showing "Pending Login…" + Cancel (the OAuth consent tab is open in the host browser; the gateway is awaiting the session + frpc readiness).
- status `connected` → Connected popover (QR + url + disconnect + edit).
- status `error` → error shown in the panel (`message`).

## Provider catalog

| id | name | enabled | requires |
|----|------|---------|----------|
| `gini-relay` | Gini Relay | `true` | — |
| `tailscale` | Tailscale | `false` | `Tailscale network` |
| `ngrok` | ngrok | `false` | `ngrok account` |
| `cloudflare` | Cloudflare | `false` | `Cloudflare account` |

## Endpoints

RPC action style, matching `/api/browser/*` and `/api/relays/*`. Every route returns the full `TunnelState`.

- `GET  /api/tunnel` — state + providers catalog (one fetch drives the whole UI).
- `POST /api/tunnel/select  {provider}` — save selection without connecting (status stays `idle`).
- `POST /api/tunnel/connect {provider?}` — begin connect; the optional `provider` overrides the saved selection.
- `POST /api/tunnel/cancel` — abort a pending login → status `idle` (keeps the selection).
- `POST /api/tunnel/disconnect` — tear down the tunnel, keep `selectedProvider` → status `idle`.

## Persistence

The singleton `TunnelSelectionRecord` lives at `state.tunnel` in the atomic JSON `state.json` (not `jsc:serialize`), mirroring `state.browser`:

```ts
interface TunnelSelectionRecord {
  instance: Instance;
  selectedProvider: TunnelProviderId | null;
  status: TunnelStatus;
  url?: string;
  subdomain?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}
```

It is defaulted to `null` in `createEmptyState` and backfilled with `state.tunnel ??= null` in `normalizeState`, so legacy and hand-edited state files present a consistent shape. The catalog is rebuilt from code on every read, so adding a provider needs no state migration.

## The gini-relay connect flow (OAuth loopback + frpc)

`connectTunnel` validates the target provider is enabled, flips the record to `connecting`, and returns immediately. A **background** handshake (`runConnect`) then drives the gini-relay client library.

**Session reuse first.** `runConnect` reuses an existing session from the credential store (`store.readSession()`) and goes straight to `buildTunnel` — gini-relay sessions don't expire, so one login serves indefinitely and a reconnect needs **no browser and no re-login** (a reconnect with a stored session settled to `connected` in 1 second in a live test). The OAuth steps below run **only** when there is no stored session, or when a reused session is rejected by the relay (e.g. it was revoked) and `child.start()` throws — in that case `runConnect` discards the stored session and falls back to a fresh login so connect self-heals. When a login is needed:

1. `loginUrl({ store, relayUrl, loopbackPorts })` binds a `127.0.0.1` callback server, asks the relay for a Google consent URL, and hands back `{ url, waitForSession, cancel }`. The URL is **machine-bound** — the auth code returns to this host's loopback, so it must be approved in a browser on this same machine (RFC 8252 loopback redirect + PKCE).
2. The consent URL is opened in the **host browser** via `Bun.spawn(["open", url])` (the `openBrowser` seam).
3. `waitForSession()` resolves once the user approves: the relay exchanges the code and returns `{ token, subdomain, account }`, persisted by the store to the **instance-scoped** relay home (`~/.gini/instances/<inst>/relay`, via `relayHome(instance)`) so concurrent instances never share a device/session or stomp each other's tunnel.
4. `buildTunnel({ session, deviceId, port, defaults })` builds a supervised native `frpc` child for the **gateway port** (see *Exposed port*), and `child.start()` resolves when the proxy is actually up.
5. The record flips to `connected` with `url: https://<subdomain>.<relayDomain>` and the `subdomain` persisted.

On any failure — relay error, login rejection, frpc start failure — the record flips to `error` with the thrown message; `url` is cleared. If the connect was cancelled mid-flight (the supervisor was torn down by `cancel`/`disconnect` before the background flow settled), the flow logs `tunnel.connect.aborted` and leaves the cancel-written `idle` record intact rather than clobbering it with a spurious error.

### Exposed port

The tunnel exposes the instance's **gateway port** (`config.port`). The gateway is the single origin that serves its native `/api/*` directly AND reverse-proxies the web app — UI, assets, the `/api/runtime/*` BFF namespace, and HMR — to the Next.js web child (see ADR [gateway-web-reverse-proxy.md](gateway-web-reverse-proxy.md)). Exposing the gateway therefore makes one relay URL serve both the API (e.g. a mobile client's direct `/api/*` calls) and the web UI. Resolution order (`resolveLocalPort`), most-authoritative first:

1. `GINI_TUNNEL_PORT` env override (operator escape hatch / tests).
2. The gateway port (`config.port`), which the CLI pins to the actually-bound port before launch.

Before advertising a public URL, connect verifies the web app is actually serving via the shared identity probe (`isSupervisedWebChild` → `{ service: "gini-web", instance }` on `/api/runtime/__healthz`). Because that path is web-bound, the probe transits the gateway's reverse-proxy to the web child, so a green probe means the gateway is up AND the web child is reachable through it — a stale port or a down web child can't be published to the public relay URL.

The gateway owns the host/origin trust decision for every web-bound request (loopback / relay-subdomain / `GINI_TRUSTED_ORIGINS`, fail-closed, plus a `Sec-Fetch-Site` check) and rewrites `Host`/`Origin` to loopback before proxying, so the inner web child is purely internal and needs no relay awareness. See ADR [bff-trust-boundary.md](bff-trust-boundary.md).

### Supervision

Each instance owns at most one in-flight login + one running `frpc` child, tracked in a module-level supervisor registry in `src/integrations/tunnel.ts`:

- `disconnectTunnel` stops the `frpc` child (best-effort — a stop failure is swallowed) and resets to `idle`, keeping the selection. Its idle write skips if a newer connect claimed the instance during the (awaited) local logout, so it never clobbers a live reconnect.
- `cancelTunnel` aborts a pending login via the handle's `cancel()` (best-effort) and resets to `idle`. `selectProvider` likewise tears down any live child before flipping to `idle`, so changing the selection never orphans a running tunnel.
- A fresh `connectTunnel` tears down any prior in-flight login / live child and claims a fresh supervisor entry synchronously, so two concurrent connects get distinct entries: the superseded run aborts (before opening the OAuth browser, and stopping any child it spawned) instead of double-spawning or clobbering the winner.
- A live child that exits on its own (crash, relay drop) flips the record `connected → error` via an exit watcher, so a dead tunnel never keeps advertising a URL; an intentional cancel/disconnect/supersede is guarded out of that path.
- Runtime shutdown stops every live child (`stopAllTunnels`, awaited in the SIGTERM drain) so `frpc` is torn down gracefully with the runtime rather than left forwarding past exit.

### Reconcile on startup

A persisted `connected` / `connecting` record describes an `frpc` child the runtime spawned **before it restarted** — that child is gone after a restart, so the record is stale and would make `GET /api/tunnel` falsely read connected. `reconcileTunnelOnStartup` (called from `src/server.ts` boot, mirroring the `state.browser` stale-record clear) resets any non-idle record to `idle` (keeping the selection so the user can reconnect); `idle`/`error` records are left untouched. It's best-effort — the boot site wraps it in a `.catch()` so a state-write failure can never crash startup.

**Clean shutdown vs. non-graceful exit.** On `SIGTERM` the drain awaits `stopAllTunnels()`, which terminates the `frpc` child cleanly, so a graceful shutdown leaves no orphan. A **non-graceful** exit (uncaught crash, `SIGKILL`, OOM, power loss) runs no drain: because `frpc` is spawned non-detached it is reparented rather than killed, so it can keep forwarding the public URL after the runtime dies, and the next boot's reconcile then marks state `idle` while that orphan is still live. Closing this residual window requires a persisted tunnel pidfile plus a signature-guarded reaper in reconcile (kill a matching live `frpc` from a prior run) — deferred as a separate, higher-risk change since it kills processes by signature.

### Injectable seams

Every gini-relay dependency is injectable through `setTunnelDeps` (the login primitive, tunnel builder, credential store, defaults resolver, host-browser opener, and local-port resolver), so unit tests exercise the full `connecting → connected / error / cancel / disconnect / reconcile` matrix without touching the network, OAuth, the host browser, or a spawned `frpc` child. `awaitTunnelSettled(instance)` lets a test await the background handshake deterministically.

## Components

- `src/types.ts` — `TunnelProvider`, `TunnelProviderId`, `TunnelStatus`, `TunnelState`, `TunnelSelectionRecord`; optional `tunnel?: TunnelSelectionRecord | null` on `RuntimeState`.
- `src/state/store.ts` — default in `createEmptyState`; backfill in `normalizeState`.
- `src/state/records.ts` — `createTunnelRecord` (exported from the `src/state` barrel).
- `src/integrations/tunnel.ts` — behavior module (`getTunnel`, `selectProvider`, `connectTunnel`, `cancelTunnel`, `disconnectTunnel`, `reconcileTunnelOnStartup`), the supervisor registry, and the `setTunnelDeps` / `awaitTunnelSettled` test seams.
- `src/server.ts` — calls `reconcileTunnelOnStartup` on boot (best-effort).
- `src/http.ts` — the five thin routes + the `statusFromErrorMessage` 400 mappings.
- `src/cli/commands/tunnel.ts` — `gini tunnel [select <provider> | connect [provider] | cancel | disconnect]`, registered in `src/cli/index.ts`.
- `gini-relay` (npm/git dependency) — the client library: `loginUrl`, `buildTunnel`, `createStore`, `resolveDefaults`.

## Acceptance checks

- `GET /api/tunnel` on a fresh instance returns the four-provider catalog (gini-relay enabled, the rest disabled with their `requires` strings), `selectedProvider: null`, `status: "idle"`.
- `POST /api/tunnel/select {provider:"gini-relay"}` saves the selection and stays `idle`; selecting a disabled (`ngrok`) or unknown provider returns `400`.
- `POST /api/tunnel/connect` returns `status: "connecting"` immediately; the background handshake then flips `GET /api/tunnel` to `connected` (with `url: https://<subdomain>.<relayDomain>`) or `error` (with `message`). An explicit `provider` in the body overrides the saved selection.
- `POST /api/tunnel/cancel` aborts a pending login and `POST /api/tunnel/disconnect` stops the live `frpc` child; both return to `status: "idle"` keeping `selectedProvider`.
- A restart with a persisted `connected`/`connecting` record reconciles to `idle` on boot (the spawned child is gone), keeping the selection; `idle`/`error` records are left untouched.
- Every route returns the full `TunnelState`.
- The CLI commands go through the gateway routes (verified by the CLI unit tests pinning URL + method + body).
- 100% line and function coverage on `src/integrations/tunnel.ts` (every gini-relay seam injected via `setTunnelDeps`, so tests never hit the network/OAuth/browser/frpc) and `src/cli/commands/tunnel.ts`; the additions to `records.ts`/`store.ts`/`http.ts` are covered by the integration, http, and CLI tests.
