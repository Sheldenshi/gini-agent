# Gateway And Control Plane

Gini's runtime is the gateway: one Bun process per instance owns state, execution, tools, memory, jobs, approvals, audit, traces, and events. Every other surface is a client.

## Process Shape

```text
                 GATEWAY (Bun runtime, one per instance)
                 /api/* HTTP + /api/events/stream SSE
                              ^
          --------------------+--------------------
          |                    |                   |
      Next.js BFF          CLI / scripts       future clients
      browser UI           bearer token        mobile, MCP, messaging
      no browser token
```

The gateway starts from `src/server.ts`. `gini start` launches it as a daemon. `gini run` launches it in the foreground and ties its lifecycle to the terminal.

## Next.js BFF

The web app in `web/` is both a browser UI and a backend-for-frontend:

- browser requests go to `/api/runtime/*`
- `web/src/app/api/runtime/[...path]/route.ts` forwards to the gateway
- the gateway bearer token stays server-side in the Next.js process
- the browser never receives the token

The web app is stateless. Restarting it does not lose runtime data because all state lives in the gateway.

## CLI

The CLI entrypoint is `src/cli.ts`, which delegates to the modular command tree under `src/cli/`. CLI commands read the selected instance config, attach the bearer token, and call the same gateway API used by other clients.

Some local harness operations, such as smoke setup and evidence bundle generation, can use domain helpers directly when they need to manage a runtime process or local files. The `gini import apply openclaw` command is the load-bearing exception: it requires the gateway stopped for the target instance and mutates `state.json`, `secrets.env`, workspace files, skills, and `memory.db` in-process. See [Openclaw Migration](./adr/openclaw-migration.md) for the lock model.

## Instances

Instances isolate state, logs, ports, tokens, workspaces, and web build directories. The installed end-user CLI uses the `default` instance; `bun run gini` from a repo checkout auto-derives the instance from the repo directory basename so each worktree is isolated.

```sh
bun run gini run --instance feature-x
bun run gini start --instance personal
```

The `default` instance is pinned to memorable ports — web `7777`, runtime `7778` — so end-users always know what URL to hit. Other instances derive deterministic hash-based ports in a 100-port window (runtime base 7337, web base 3000) and walk forward if a port is busy. Explicit `--port`, `--web-port`, `GINI_PORT`, and `GINI_WEB_PORT` stay strict: if the pinned port is busy, startup fails instead of silently moving.

## Disk Layout

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

`~/.gini/models/` is shared across instances for local embedding and reranker model caches.

## Auth

The gateway uses per-instance bearer tokens. Paired devices can receive their own tokens through pairing endpoints. Tokens are stored in the instance `config.json`; the Next.js BFF reads the token server-side and does not expose it to client JavaScript.

Privileged BFF routes (mutating POSTs like `messaging/add`, `messaging/<id>/remove`, `runtime/update`) carry a CSRF guard that uses one of two policies:

1. **`GINI_TRUSTED_ORIGINS` set** — comma-separated list of full origins (scheme + host + port), e.g.

   ```
   GINI_TRUSTED_ORIGINS=https://gini-server.tail-xyz.ts.net,http://localhost:3000
   ```

   The guard accepts an `Origin` only if it exactly matches one of the listed entries. This is the required posture for any BFF exposed beyond loopback (tailnet, tunnel, public DNS). If you set the env var but every entry is malformed, the guard fails closed and refuses every privileged POST until you fix the value — a typo bricks privileged routes loudly rather than silently downgrading.

2. **`GINI_TRUSTED_ORIGINS` unset** — local-dev fallback. The guard accepts requests only when both the request `Host` is loopback (`localhost`, `127.0.0.1`, or `[::1]`) and the `Origin` matches `Host`. Any non-loopback Host is refused without an explicit allowlist, so a BFF run on a tailnet hostname without `GINI_TRUSTED_ORIGINS` will see every privileged POST 403'd — set the env var or bind the BFF to loopback only.

Closing the non-loopback fallback path blocks the DNS-rebinding shape where an attacker page sets `Origin` to a hostname they control but rebinds DNS to the BFF's loopback / tailnet IP — the rebound host equals itself, so a Host-comparison alone would pass. The allowlist (or the loopback restriction) takes that codepath off the table.

See [BFF trust boundary ADR](adr/bff-trust-boundary.md) for the decision context, threat model, and alternatives considered.

## Lifecycle Commands

| Command | Behavior |
| --- | --- |
| `gini start --instance X` | daemon; runtime and web keep running after the shell exits |
| `gini run --instance X` | foreground; runtime and web stop when the process receives Ctrl-C/HUP/TERM |
| `gini stop --instance X` | stops runtime and web for an instance |
| `gini update` | updates the installer-managed runtime and restarts a running instance when code changed |
| `gini uninstall --instance X` | removes one instance's local state |
| `gini uninstall` | full uninstall: stops every instance, removes installer-managed wrapper/runtime/PATH block, prompts before deleting instance state |

Use `gini run` for coding-agent worktrees and CI. Use `gini start` for a persistent personal runtime.
