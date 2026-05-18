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
| Persistent memory | `gini memory list/add/edit/approve/reject/archive`, `/api/memory` |
| Embeddings | Local Transformers.js by default; OpenAI and echo are opt-in. `gini embedding status`, `gini embedding reembed`, `/api/embedding/*` |
| Reranker | Local Transformers.js cross-encoder by default; echo and none are opt-in. `gini reranker status`, `/api/reranker/status` |
| Skills | Skills load enabled by default and can be enabled or disabled. `gini skills list/add/show/search/validate/test/enable/disable/rollback`, `/api/skills` |
| Search | `gini search <query>`, `/api/search` with task, trace, memory, skill, and audit citations |
| Jobs | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt jobs, and script jobs |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated (see `dangerouslyAutoApprove` in `docs/operations.md` and ADR dangerously-auto-approve.md for the opt-in global bypass) |
| Approval settings | `GET/PATCH /api/settings/auto-approve` for `autoApproveCommands` (shell-glob allowlist for `terminal_exec`) and `dangerouslyAutoApprove` (global bypass for every approval-gated tool) |
| Toolsets | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Providers | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter-compatible records, echo |
| Runtime updates | `gini update`, `/api/version`, `/api/update/check`, `/api/update`; installer-managed web runtimes show the current package/git version and can trigger an update |
| Delegation records | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin records | `gini mcp list/add/health/invoke/disable` |
| Messaging bridge records | `gini messaging list/add/health/receive/send/messages/disable`; inbound messages create tasks |
| Agents/config | `gini agents list/create/use/delete`, instance-aware config |
| Import inspection | `gini import inspect openclaw <path>`, read-only by default |
| Self-improvement proposals | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Web control plane | Next.js app at `web/`, launched by `gini start` or `gini run` unless `--no-web` is set |

## Runtime Contracts

Stable local clients use the gateway API:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/chat`, `/api/runs`, `/api/approvals`
- `/api/memory`, `/api/banks`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/migrate`
- `/api/embedding/status`, `/api/embedding/reembed`, `/api/reranker/status`
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/pairing`, `/api/devices`, `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/audit`, `/api/events`, `/api/events/stream`
- `/api/settings/auto-approve`
- `/api/parity/hermes`, `/api/readiness/v1`

All routes require `Authorization: Bearer <token>` except health checks and the limited SSE token compatibility path.

## Boundaries

Current runtime work is local-first. Future mobile, relay, push notifications, and richer live external transports should consume these contracts rather than adding a second source of truth.
