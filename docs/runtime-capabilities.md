# Runtime Capabilities

This document maps the current runtime surfaces to the product capabilities Gini is expected to provide.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run gini smoke
```

The smoke output should include:

- an `evidencePath`

For an installed instance:

```sh
bun run gini evidence
```

## Capability Map

| Capability | Current surface |
| --- | --- |
| CLI task workflow | `gini task submit/list/show/retry/cancel` |
| Chat and session history | `gini chat new/send/sync/show/list`, `/api/chat` |
| Execution runs | `gini runs list/show`, `/api/runs`; chat turns create durable runs with plan steps and compatibility task links |
| Persistent memory | USER.md (instance), SOUL.md (per-agent), Hindsight (per-agent SQLite bank). `gini memory retain/recall/reflect/units/banks/migrate`, `/api/memory/{retain,recall,reflect,units,banks}` |
| Embeddings | Local Transformers.js by default; OpenAI and echo are opt-in. `gini embedding status`, `gini embedding reembed`, `/api/embedding/*` |
| Reranker | Local Transformers.js cross-encoder by default; echo and none are opt-in. `gini reranker status`, `/api/reranker/status` |
| Skills | Skills load enabled by default and can be enabled or disabled. `gini skills list/add/show/search/validate/test/enable/disable/rollback`, `/api/skills` |
| Search | `gini search <query>`, `/api/search` with task, trace, skill, and audit citations (pinned-memory citations were dropped with the state.memories consolidation; Hindsight recall is its own surface via `recall_memory`) |
| Jobs | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt jobs, and script jobs |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated under `approvalMode: "strict"`; under the default `"auto"` mode safe commands auto-run and dangerous shapes still gate (see ADR approval-mode.md) |
| Approval settings | `GET/PATCH /api/settings/auto-approve` for `approvalMode` (`strict`/`auto`/`yolo`), `autoApproveCommands` (shell-glob allowlist for `terminal_exec`), and `dangerousTerminalPatterns` (operator extension to the built-in blocklist) |
| Toolsets | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Providers | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter-compatible records, echo |
| Runtime updates | `gini update`, `/api/version`, `/api/update/check`, `/api/update`; installer-managed web runtimes show the current package/git version and can trigger an update |
| Delegation records | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin records | `gini mcp list/add/health/invoke/disable` |
| Messaging bridge records | `gini messaging list/add/health/receive/send/messages/disable/remove`; inbound messages create tasks. Telegram bridges support per-chat enrollment via `gini messaging allow/deny/reject-pending/chats` (no trust-on-first-use; on each DM from an unrecognized chat the poller mints a short verification code in `F971-8261` format, DMs it to the user, and records the same code on `recentDeniedChats` so the operator can confirm a match before clicking Approve; `reject-pending` clears a pending request row without granting allowlist access). Discord uses channel-as-auth — every non-bot poster in a configured `deliveryTargets` channel can submit, see [Discord bridge ADR](adr/discord-bridge.md) for the Message Content Intent setup step |
| Agents/config | `gini agents list/create/use/delete`, instance-aware config |
| Import inspection and migration | `gini import inspect openclaw <path>` (read-only summary), `gini import plan openclaw [path]` (dry-run with redacted secret summary), `gini import apply openclaw [path] [--force]` (mutates gini state — creates agents, encrypted bridge tokens, skills, workspace bootstrap files). See [openclaw migration ADR](adr/openclaw-migration.md) and [migration guide](migration-from-openclaw.md) |
| Self-improvement proposals | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Web control plane | Next.js app at `web/`, launched by `gini start` or `gini run` unless `--no-web` is set |

## Runtime Contracts

Stable local clients use the gateway API:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/chat`, `/api/runs`, `/api/approvals`
- `/api/memory/retain`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`, `/api/memory/migrate`
- `/api/embedding/status`, `/api/embedding/reembed`, `/api/reranker/status`
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/pairing`, `/api/devices`, `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/audit`, `/api/events`, `/api/events/stream`
- `/api/settings/auto-approve`
- `/api/parity/hermes`, `/api/readiness/v1`

All routes require `Authorization: Bearer <token>` except health checks, the limited SSE token compatibility path, and requests arriving through the optional Cloudflare quick tunnel with a valid secret-path prefix (see [Cloudflare Quick Tunnel With Secret-Path Auth And iCloud Notes Mirror](adr/tunnel-and-icloud-pairing.md)). The tunnel surface is opt-in (`tunnel.enabled` in the instance config) and rejects requests whose URL does not begin with the per-instance secret path.

## Boundaries

Current runtime work is local-first. Future mobile, relay, push notifications, and richer live external transports should consume these contracts rather than adding a second source of truth.
