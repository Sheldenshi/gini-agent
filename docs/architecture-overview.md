# Gini Architecture Overview

A short visual + plain-language map of how Gini's runtime, control plane, and clients fit together. For the full product spec see [`master-plan.md`](./master-plan.md). For implementation-level notes see [`implementation-notes.md`](./implementation-notes.md).

## One sentence

Gini's **runtime is the gateway** — a single Bun process per lane that owns all state and does all real work. Every other surface (web app, mobile app, CLI, MCP integrations) is a client that consumes the same `/api/*` contract.

## Picture

```
                           ┌─────────────────────────────────┐
                           │         GATEWAY (server)        │
                           │                                 │
                           │  Bun runtime — one per lane     │
                           │                                 │
                           │  • agent loop                   │
                           │  • tool execution               │
                           │  • memory.db (SQLite)           │
                           │  • state.json                   │
                           │  • traces, audit, events        │
                           │  • bearer-token auth            │
                           │                                 │
                           │  /api/* (HTTP + SSE)            │
                           └────────────────┬────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
        │ token (server-side only)          │ paired-device token               │ bearer token
        │                                   │                                   │
┌───────┴───────┐                  ┌────────┴────────┐                  ┌───────┴────────┐
│   Next.js     │                  │  Phone app      │                  │   CLI          │
│   (BFF + UI)  │                  │  (Expo, v2)     │                  │   gini task /  │
│               │                  │                 │                  │   memory / etc │
│   one per     │                  │  pairs once,    │                  │                │
│   lane        │                  │  holds own      │                  │  spawns from   │
│   localhost   │                  │  token in       │                  │  any shell     │
│   port        │                  │  Keychain       │                  │                │
└───────┬───────┘                  └─────────────────┘                  └────────────────┘
        │
        │ HTML / JS / SSE (no token)
        │
   ┌────┴────┐
   │ browser │
   │         │
   │ never   │
   │ sees    │
   │ token   │
   └─────────┘

                          Other clients (post-v1):
                          MCP integrations, scheduled jobs that call out,
                          your own scripts — all use bearer tokens
                          and talk directly to the gateway.
```

## What each piece does

### Gateway (the runtime)

- **Single source of truth.** Every byte of agent state lives here: tasks, jobs, memory units, skills, audit events, traces.
- **One process per lane.** `--lane dev`, `--lane feature-x`, `--lane vienna` are independent gateways with isolated state, ports, and lifecycles. Each writes to `~/.gini/<lane>/`.
- **Token-authenticated.** Bearer tokens (per-lane and per-paired-device) gate every request. Tokens are minted at install time and stored in the lane's `config.json`.
- **HTTP + SSE.** Standard REST surface plus an event stream (`/api/events/stream`) for real-time updates.
- **Self-contained.** No Postgres, no Docker, no Python service. SQLite via `bun:sqlite` for the four-network memory, JSON for everything else.

Process: `src/server.ts`. Started by `gini start` (daemon) or `gini run` (foreground).

### Next.js (Backend-for-Frontend + browser UI)

- **A client of the gateway, plus a server for the browser.** Two-faced.
- **Holds the bearer token server-side.** Browser HTTP requests come into Next.js as `/api/runtime/*`, Next.js attaches `Authorization: Bearer <token>` and forwards to the gateway. The browser never sees the token — that's the entire reason Next.js exists in the picture.
- **One per lane.** Spawned by the same `gini start` / `gini run` that spawned the gateway. Picks its own deterministic port (3000 for `dev`, hash-derived for everything else).
- **Stateless.** Restarting Next.js doesn't lose anything; all state lives on the gateway.

Process: `web/`. Spawned by `src/cli/process.ts:startWeb`.

### Phone app (Expo, post-v1)

- **Direct client of the gateway.** No proxy in between. Talks the same `/api/*` the CLI talks.
- **Pairs once.** `POST /api/pairing` (already exists) issues a paired-device token. The phone stores it in iOS Keychain.
- **On LAN:** direct HTTP to the gateway (Bonjour discovery or manual code).
- **Off LAN (post-v1):** through a relay that routes encrypted traffic but cannot decrypt it.

Doesn't exist yet. The endpoints it would consume already do (`/api/mobile/bootstrap`, pairing/devices APIs, the rest of the runtime contract).

### CLI

- **Direct client of the gateway.** `gini task submit ...`, `gini memory list`, etc. Reads the lane's `config.json` to find the runtime URL and bearer token.
- **Subset of the same `/api/*` contract.** Anything the CLI does, a future client could do via HTTP.

## Why this shape

1. **Single source of truth.** Reload the web, open the phone, run a CLI command — they all see the same state because there's only one place state actually lives. No sync, no eventual consistency, no client-side caching that drifts.
2. **New clients = no gateway changes.** A future Slack bot, MCP integration, or whatever — they speak the existing API. Master plan §0.1 calls this out as the v1→v2 enabler.
3. **Trust boundary is clear.** Anything that can hold a token safely (CLI, mobile, MCP) talks direct. Anything that can't (browser) goes through Next.js. That's the only reason the BFF exists.
4. **Per-lane isolation.** Lanes are independent gateways. Run `--lane feature-x` and `--lane feature-y` side-by-side; they share nothing. Coding agents working on different worktrees can't step on each other.

## Lifecycle

| Command | Lane fate |
|---|---|
| `gini start --lane X` | Daemon. Lane survives terminal close, machine sleep, etc. Stops only on `gini stop --lane X` or reboot. |
| `gini run --lane X` | Foreground. Lane lives as long as this terminal. Ctrl-C, `kill`, or terminal close kills the gateway + Next.js + cleans pid/port files. |
| `gini stop --lane X` | Stops both gateway + Next.js, removes pid/port files. Works on lanes started either way. |

For coding agents in worktrees: use `gini run`. For the personal-agent-on-your-Mac case: use `gini start`.

## Where things live on disk

```
~/.gini/<lane>/
├── config.json         # lane config (port, token, provider, paths)
├── state.json          # tasks, jobs, skills, approvals, audit, events, ...
├── memory.db           # SQLite — four-network memory units, entities, links
├── runtime.pid         # gateway PID (recorded on start)
├── runtime.port        # gateway port (recorded after walk)
├── web.pid             # Next.js PID
├── web.port            # Next.js port
├── traces/             # per-task trace files (one dir per task)
├── snapshots/          # lane snapshots for promotion/rollback
├── skills/             # skill definitions
└── workspace/          # default workspace for file/terminal tools

~/.gini/logs/<lane>/    # rotated logs

~/.gini/models/         # Transformers.js model cache (shared across lanes)
```

## Ports

| Lane | Default runtime port | Default web port |
|---|---|---|
| `dev` (special-cased) | 7337 | 3000 |
| any other | `7337 + (FNV1a("runtime:<lane>") % 100)` | `3000 + (FNV1a("web:<lane>") % 100)` |

Both walk forward on collision (without rolling silently if the user pinned a specific port via `--port` / `--web-port`). The actual claimed port gets persisted in `runtime.port` / `web.port`.

## API surface (high-level)

The full list lives in [`v1-readiness.md`](./v1-readiness.md). At a glance:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/tasks`, `/api/chat/*`, `/api/approvals/*`
- `/api/memory/*`, `/api/banks/*`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/migrate`
- `/api/skills/*`, `/api/jobs/*`, `/api/connectors/*`
- `/api/embedding/*`, `/api/reranker/status`
- `/api/pairing/*`, `/api/devices/*`, `/api/mobile/bootstrap`
- `/api/audit`, `/api/events`, `/api/events/stream` (SSE)
- `/api/parity/hermes`, `/api/readiness/v1`

All routes accept `Authorization: Bearer <token>` (or `?token=` for SSE compatibility). Tokens are issued per lane and per paired device.

## What's not here yet

- iOS/Expo mobile app (post-v1).
- Remote relay for off-LAN access (post-v1).
- Push notifications (post-v1).
- LaunchAgent / system-service auto-start (master plan §0.1 envisions this; not wired).

The runtime contracts are stable enough that adding any of these is client-side work, not gateway work.
