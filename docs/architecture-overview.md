# Gini Architecture Overview

Gini is organized around one stateful runtime gateway and many replaceable clients.

For deeper topic docs, see [Gateway And Control Plane](./gateway.md), [Conversation And Runs](./conversation-runs.md), [Memory](./memory.md), and [Runtime Capabilities](./runtime-capabilities.md).

## One Sentence

Gini's **runtime is the gateway**: a single Bun process per instance owns all durable state and performs all real work. Every other surface consumes the same authenticated `/api/*` contract.

## Picture

```text
                           ┌─────────────────────────────────┐
                           │         GATEWAY (server)        │
                           │                                 │
                           │  Bun runtime, one per instance  │
                           │                                 │
                           │  • agent loop                   │
                           │  • tool execution               │
                           │  • memory.db (SQLite)           │
                           │  • state.json                   │
                           │  • traces, audit, events        │
                           │  • bearer-token auth            │
                           │                                 │
                           │  /api/* (HTTP + SSE)            │
                           │  + reverse proxy → Next.js      │
                           │    (UI, /api/runtime/*, HMR WS) │
                           └────────────────┬────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
        │ token server-side only            │ paired-device token               │ bearer token
        │                                   │                                   │
┌───────┴───────┐                  ┌────────┴────────┐                  ┌───────┴────────┐
│   Next.js     │                  │  Expo mobile    │                  │   CLI          │
│   BFF + UI    │                  │  app            │                  │   scripts      │
│               │                  │                 │                  │   MCP clients  │
│   one per     │                  │  pair via relay │                  │                │
│   instance    │                  │  link or paste  │                  │  direct API    │
│   localhost   │                  │  URL + token    │                  │  client        │
└───────┬───────┘                  └─────────────────┘                  └────────────────┘
        │
        │ HTML / JS / SSE
        │
   ┌────┴────┐
   │ browser │
   │ never   │
   │ sees    │
   │ token   │
   └─────────┘
```

## Components

### Gateway

- Single source of truth for tasks, conversations, runs, jobs, memory, skills, authorizations, setup requests, audit, traces, and events.
- One process per instance.
- Authenticated HTTP API plus SSE event stream.
- JSON state for broad runtime records and SQLite for memory.
- Starts from `src/server.ts`.

### Next.js Control Plane

- Lives in `web/`.
- Browser talks to `/api/runtime/*`.
- Server-side BFF attaches the gateway bearer token.
- Uses the same API that CLI and future clients use.
- Can be disabled with `--no-web` for smoke and runtime-only testing.
- Reachable two ways: directly on its own port, or **through the gateway as a single origin** — the gateway reverse-proxies non-`/api` traffic and the `/api/runtime/*` BFF namespace to Next.js and bridges the HMR WebSocket, so UI + API share one origin. The upstream is healthz-validated per instance (`src/web-target.ts`). This single origin is what the gini-relay tunnel exposes for off-LAN access (see [Off-LAN Access](#off-lan-access)). See [Gateway And Control Plane](./gateway.md) and ADR [gateway-web-reverse-proxy.md](./adr/gateway-web-reverse-proxy.md).

### CLI

- Entry shim: `src/cli.ts`.
- Command implementation: `src/cli/`.
- Reads instance config and calls the gateway API.
- Also owns local process management for install/start/run/stop/smoke workflows.
- The `gini import apply openclaw` migrator is the one documented exception to "all writes go through the gateway." It refuses to run while the instance's gateway is alive (see [Openclaw Migration](./adr/openclaw-migration.md)) and writes directly to `state.json`, `secrets.env`, workspace files, skills, and `memory.db` through the in-process `mutateState` path. Single-process serialization is what makes the offline-only constraint necessary.

### Other Clients

The Expo mobile app is a gateway client (it holds its own bearer token and can obtain one via relay-link pairing — see [Device-Pairing Authentication](adr/device-pairing-auth.md)). MCP, messaging bridges, and scripts connect through the same gateway contract. Clients that can safely hold a token may call the gateway directly; browser clients go through a BFF.

## Why This Shape

1. **Single source of truth.** Reloading the web app, running a CLI command, and opening the mobile app all observe the same runtime state.
2. **Clear token boundary.** The browser never receives a bearer token. Local clients that can safely store credentials can hold their own tokens.
3. **Replaceable clients.** New surfaces do not require a second backend or a duplicated state model.
4. **Parallel agent support.** Instances isolate ports, state, logs, workspaces, and runtime processes.

## Storage

```text
~/.gini/
├── instances/
│   └── <instance>/
│       ├── config.json
│       ├── state.json
│       ├── memory.db
│       ├── runtime.pid
│       ├── runtime.port
│       ├── web.pid
│       ├── web.port
│       ├── traces/
│       ├── snapshots/
│       ├── skills/
│       ├── workspace/
│       ├── imports/
│       └── logs/
└── models/
```

`<instance>/imports/` holds verbatim archives of source state taken before any importer (currently only `gini import apply openclaw`) mutates the destination instance. The archives can contain plaintext provider keys, bot tokens, session transcripts, and memory units — they are retained as a manual restore path and never auto-purged. Treat them with the same care as the active state. See [Openclaw Migration](./adr/openclaw-migration.md) for the format.

## API Surface

The current capability map is in [Runtime Capabilities](./runtime-capabilities.md). Common surfaces include:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/usage`, `/api/chat`, `/api/runs`, `/api/authorizations`, `/api/setup-requests`
- `/api/memory/retain`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`, `/api/embedding/*`, `/api/reranker/status`
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/pairing`, `/api/pairing/request*` (relay device pairing), `/api/devices`, `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/tunnel`, `/api/tunnel/select`, `/api/tunnel/connect`, `/api/tunnel/cancel`, `/api/tunnel/disconnect`
- `/api/audit`, `/api/events`, `/api/events/stream`, `/api/logs`
- `/api/parity/hermes`, `/api/readiness/v1`

## On-Machine Lifecycle

On macOS a launchd-managed instance is supervised to stay up across crashes, clean exits, and auto-update self-restarts. Three per-instance LaunchAgents — gateway, web, and a long-lived watchdog probe loop — keep it running: `KeepAlive` is always-respawn, so `gini stop` unloads the services via `launchctl bootout` (the only way to keep a supervised instance down), and the watchdog covers the gaps KeepAlive can't (a wedged-but-alive process and a launchd-deferred respawn). When the runtime (or the watchdog, for web) detects a crash, it captures a redacted report to a local queue and, on the next restart of the `default` instance, asks the user whether to file it as a GitHub issue — nothing is published without consent. Foreground / `gini run` / conductor / tmux instances keep PID-kill stop and are unaffected. See [Always-Up Supervision](./adr/always-up-supervision.md) and [Crash Reporting And Issue Filing](./adr/crash-reporting-and-issue-filing.md).

## Off-LAN Access

Off-LAN access is available through **four runtime-driven tunnel providers** — gini-relay (the managed, zero-prerequisite default), Tailscale, ngrok, and Cloudflare. The user picks a provider and connects (`gini tunnel`, or the web tunnel panel over `/api/tunnel*`). For **gini-relay**, the gateway runs an OAuth-loopback login in a browser on the host, the relay assigns the device a session and a subdomain, and a supervised native `frpc` child exposes the instance's gateway port (the single origin fronting UI + API) at `https://<subdomain>.<relayDomain>` (`relayDomain` default `gini-relay.lilaclabs.ai`, overridable via `GINI_RELAY_DOMAIN`). `tailscale`, `ngrok`, and `cloudflare` are equally drivable when their host prerequisite is detected — the runtime runs `tailscale serve`, `ngrok http`, or a cloudflared tunnel itself; a connect attempt on a provider whose prerequisite is missing is rejected with the machine-readable `provider_unavailable` code, which the web UI uses to open that provider's self-contained guide inline (per-provider pages under [Remote Access](./remote-access.md)). The gateway owns the relay / runtime-tunnel / loopback / `GINI_TRUSTED_ORIGINS` trust decision for web-bound requests — a runtime-managed tunnel's connected URL is trusted automatically, exactly while connected — and rewrites `Host`/`Origin` to loopback before proxying, so the inner web child (BFF) stays relay-agnostic. On top of that host trust, a web request on a non-loopback front must also be **paired**: it needs a `gini_session` cookie minted through an operator-approved device-pairing handshake, or its page navigations are redirected to `/pair` and its `/api/runtime/*` calls 401. Loopback is trusted with no pairing. See [Tunnel Connectivity](./adr/tunnel-connectivity.md), [BFF Trust Boundary](./adr/bff-trust-boundary.md), and [Device-Pairing Authentication](./adr/device-pairing-auth.md).

## Not Yet Built

- Push notification delivery.

A basic Expo mobile client lives under `mobile/` — agent picker, per-agent chat list, and chat detail with task polling. It speaks the same `/api/*` contract directly with its own bearer token (no BFF), so it does not change the runtime/source-of-truth model.

Those should build on the existing gateway contract rather than changing the runtime/source-of-truth model.
