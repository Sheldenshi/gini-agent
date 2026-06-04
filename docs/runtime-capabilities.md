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
| Voice messages / speech-to-text | Mobile (iOS) press-and-hold records a 16 kHz mono WAV; `/api/uploads` accepts `audio/*`, `POST /api/chat/:id/messages` takes an `audio` ref, and the gateway transcribes it locally (Transformers.js whisper-small by default; echo is opt-in) so only the transcript reaches the model — the audio is kept render-only for playback. Readiness at `/api/stt/status`. See [voice-messages-and-local-stt.md](adr/voice-messages-and-local-stt.md) |
| Skills | Skills load enabled by default and can be enabled or disabled. `gini skills list/add/show/search/validate/test/enable/disable/rollback`, `/api/skills` |
| Search | `gini search <query>`, `/api/search` with task, trace, skill, and audit citations (pinned-memory citations were dropped with the state.memories consolidation; Hindsight recall is its own surface via `recall_memory`) |
| Jobs | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt jobs, and script jobs |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Web access | `web_fetch` (fetch a known URL); `web_search` tool backed by Brave Search / Exa connectors — auto-selects a healthy provider, gated by the `web_search` toolset (see ADR web-search-connectors.md) |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated under `approvalMode: "strict"`; under the default `"yolo"` mode every gate is bypassed, and the safe-middle `"auto"` mode (which operators can switch to) auto-runs safe commands while dangerous shapes still gate (see ADR approval-mode.md) |
| Approval settings | `GET/PATCH /api/settings/auto-approve` for `approvalMode` (`strict`/`auto`/`yolo`), `autoApproveCommands` (shell-glob allowlist for `terminal_exec`), and `dangerousTerminalPatterns` (operator extension to the built-in blocklist) |
| Toolsets | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Providers | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter-compatible records, echo |
| Runtime updates | `gini update`, `/api/version`, `/api/update/check`, `/api/update`; installer-managed web runtimes show the current package/git version and can trigger an update |
| Delegation records | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin records | `gini mcp list/add/health/invoke/disable` |
| Messaging bridge records | `gini messaging list/add/health/receive/send/messages/disable/remove`; inbound messages create tasks. Telegram bridges support per-chat enrollment via `gini messaging allow/deny/reject-pending/chats` (no trust-on-first-use; on each DM from an unrecognized chat the poller mints a short verification code in `F971-8261` format, DMs it to the user, and records the same code on `recentDeniedChats` so the operator can confirm a match before clicking Approve; `reject-pending` clears a pending request row without granting allowlist access). Discord uses channel-as-auth — every non-bot poster in a configured `deliveryTargets` channel can submit, see [Discord bridge ADR](adr/discord-bridge.md) for the Message Content Intent setup step |
| Agents/config | `gini agents list/create/use/delete`, instance-aware config |
| Self-config from chat | Gini inspects and reconfigures its own runtime — provider/model, active agent, toolsets, skills, MCP servers, connectors, approval mode + auto-approve allowlist / dangerous-pattern blocklist, and runtime update — through deferred direct tools (`get_self`, `set_provider`, `enable_toolset`, `set_approval_mode`, `update_self`, …) over a `SelfOperation` registry. The model `load_tools` them on demand; read ops run inline, config changes route through the approval seam as `self.config`. Secret tool args (api keys, tokens) are redacted from chat blocks + approval payloads. See [self-config registry ADR](adr/self-config-registry.md) |
| Import inspection and migration | `gini import inspect openclaw <path>` (read-only summary), `gini import plan openclaw [path]` (dry-run with redacted secret summary), `gini import apply openclaw [path] [--force]` (mutates gini state — creates agents, encrypted bridge tokens, skills, workspace bootstrap files). See [openclaw migration ADR](adr/openclaw-migration.md) and [migration guide](migration-from-openclaw.md) |
| Self-improvement proposals | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Web control plane | Next.js app at `web/`, launched by `gini start` or `gini run` unless `--no-web` is set |
| Off-LAN access (tunnel) | `gini tunnel [select <provider> \| connect [provider] \| cancel \| disconnect]`, `/api/tunnel{,/select,/connect,/cancel,/disconnect}`. The gini-relay provider runs an OAuth-loopback login on the host, assigns a per-device subdomain, and runs a supervised `frpc` child exposing the gateway port (the single origin fronting UI + API) at `https://<subdomain>.<relayDomain>`; `tailscale`/`ngrok`/`cloudflare` are disabled catalog placeholders. See [tunnel-connectivity.md](adr/tunnel-connectivity.md) |

## Runtime Contracts

Stable local clients use the gateway API:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/chat`, `/api/runs`, `/api/authorizations`, `/api/setup-requests`
- `/api/memory/retain`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`, `/api/memory/migrate`
- `/api/embedding/status`, `/api/embedding/reembed`, `/api/reranker/status`, `/api/stt/status`
- `/api/uploads` (POST `image/*` or `audio/*`), `GET /api/uploads/:id`
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/pairing`, `/api/pairing/claim`, `/api/pairing/request*`, `/api/devices`, `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/tunnel`, `/api/tunnel/select`, `/api/tunnel/connect`, `/api/tunnel/cancel`, `/api/tunnel/disconnect`
- `/api/audit`, `/api/events`, `/api/events/stream`
- `/api/settings/auto-approve`
- `/api/parity/hermes`, `/api/readiness/v1`

Native gateway `/api/*` routes require `Authorization: Bearer <token>` except health checks, the limited SSE token compatibility path, and the device-pairing routes under `/api/pairing/*`. Pairing has its own trust model (see [ADR: Device-pairing authentication](adr/device-pairing-auth.md)), and the two claim paths are distinct:

- **Legacy code-claim** — `POST /api/pairing/claim` takes a one-time operator-generated code in the request body and returns a `gini_device_<uuid>` bearer token (the mobile/CLI flow). It is public, not `gini_pair`-bound, and not rate-limited.
- **Relay device-request flow** — `POST /api/pairing/request` (the only rate-limited route), `GET /api/pairing/request/:id`, and `POST /api/pairing/request/:id/{claim,cancel}` are public and bound to the single-use `gini_pair` binding cookie rather than a bearer; `POST /api/pairing/request/:id/claim` sets the `gini_session` cookie instead of returning a bearer.
- **Operator routes** — `GET /api/pairing/requests` and `POST /api/pairing/requests/:id/{approve,reject}` are loopback-only.

Separately, web-bound `/api/runtime/*` calls arriving on a non-loopback (relay/allowlisted) front are authenticated by the `gini_session` cookie minted at request-claim, not a bearer.

## Boundaries

Current runtime work is local-first, with off-LAN reach available through the gini-relay tunnel (see the capability map above). Future mobile, push notifications, and richer live external transports should consume these contracts rather than adding a second source of truth.
