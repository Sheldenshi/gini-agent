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
                           └────────────────┬────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
        │ token server-side only            │ paired-device token               │ bearer token
        │                                   │                                   │
┌───────┴───────┐                  ┌────────┴────────┐                  ┌───────┴────────┐
│   Next.js     │                  │  Future mobile  │                  │   CLI          │
│   BFF + UI    │                  │  app            │                  │   scripts      │
│               │                  │                 │                  │   MCP clients  │
│   one per     │                  │  pairs once,    │                  │                │
│   instance    │                  │  stores token   │                  │  direct API    │
│   localhost   │                  │  securely       │                  │  client        │
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

- Single source of truth for tasks, conversations, runs, jobs, memory, skills, approvals, audit, traces, and events.
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

### CLI

- Entry shim: `src/cli.ts`.
- Command implementation: `src/cli/`.
- Reads instance config and calls the gateway API.
- Also owns local process management for install/start/run/stop/smoke workflows.

### Future Clients

Mobile, MCP, messaging bridges, and scripts should connect through the gateway contract. Clients that can safely hold a token may call the gateway directly. Browser clients should go through a BFF.

## Why This Shape

1. **Single source of truth.** Reloading the web app, running a CLI command, and opening a future mobile app all observe the same runtime state.
2. **Clear trust boundary.** The browser never receives a bearer token. Trusted clients can hold their own tokens.
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
│       └── logs/
└── models/
```

## API Surface

The current capability map is in [Runtime Capabilities](./runtime-capabilities.md). Common surfaces include:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/chat`, `/api/runs`, `/api/approvals`
- `/api/memory`, `/api/banks`, `/api/embedding/*`, `/api/reranker/status`
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/pairing`, `/api/devices`, `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/audit`, `/api/events`, `/api/events/stream`
- `/api/parity/hermes`, `/api/readiness/v1`

## Not Yet Built

- Native/mobile app UI.
- Production relay for off-LAN access.
- Push notification delivery.
- Linux autostart parity.

Those should build on the existing gateway contract rather than changing the runtime/source-of-truth model.
