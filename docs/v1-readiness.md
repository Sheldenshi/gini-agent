# Gini V1 Readiness

This document maps the V1 plan to the current Gini runtime surfaces. V1 is scoped to the local runtime, CLI, local web control plane, stable contracts, and Hermes-equivalent runtime primitives. The iOS/Expo app, paired-device mobile UX, remote relay, and push delivery are V2 work.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run gini smoke
```

The smoke output must include:

- `parityOk: true`
- `readinessOk: true`
- an `evidencePath`

For an installed instance, use:

```sh
bun run gini parity hermes
bun run gini readiness v1
bun run gini evidence
```

## Hermes-Equivalent Workflows

| Capability | Gini V1 surface |
| --- | --- |
| CLI task workflow | `gini task submit/list/show/retry/cancel` |
| Local chat/session history | `gini chat new/send/sync/show/list`, `/api/chat` |
| Persistent memory | `gini memory list/add/edit/approve/reject/archive`, `/api/memory` |
| Embeddings | In-process Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384d) by default; OpenAI / echo are opt-in. `gini embedding status`, `gini embedding reembed [--bank ID] [--dry-run]`, `/api/embedding/{status,reembed}`. Cache lives at `~/.gini/models/`. Override via `GINI_EMBEDDING_PROVIDER=local\|openai\|echo` and `GINI_LOCAL_EMBEDDING_MODEL=<hf-id>`. |
| Reranker | In-process cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, ~22M params, ~100MB) by default; echo / none are opt-in. `gini reranker status`, `/api/reranker/status`. Same `~/.gini/models/` cache. Override via `GINI_RERANKER_PROVIDER=local\|echo\|none`, `GINI_LOCAL_RERANKER_MODEL=<hf-id>`, `GINI_RERANKER_TOP_N=<int>`. |
| Skills/procedures | `gini skills list/add/show/search/validate/test/trust/disable/rollback`, `/api/skills` |
| Session search | `gini search <query>`, `/api/search` with task/trace/memory/skill/audit citations |
| Jobs/cron | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt and script jobs |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated |
| Toolsets/gating | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Provider abstraction | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter, local-compatible paths |
| Delegation/subagents | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin surface | `gini mcp list/add/health/invoke/disable`, selected exposed tools |
| Messaging bridge | `gini messaging list/add/health/receive/send/messages/disable`, inbound messages create tasks |
| Profiles/config equivalent | `gini profiles list/create/use`, instance-aware config |
| Import/migration basics | `gini import inspect hermes|openclaw <path>`, read-only by default |
| Runtime self-improvement | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Local web control plane | Next.js 16 + Tailwind + shadcn/ui at `web/`, launched alongside the runtime by `gini start`. Sidebar surfaces the §5.1 nav (Home, Chat, Tasks, Memory, Skills, Jobs, Connections, Permissions, Activity, Settings). The browser talks to a server-side proxy at `/api/runtime/*` that injects the bearer token; the token never reaches client JS. Use `--no-web` (smoke does this automatically) to launch the runtime without the web app. |

## V1/V2 Boundary

V1 intentionally does not build the iOS/Expo app or production remote relay. It stabilizes the runtime contracts those clients consume:

- `/api/state`
- `/api/mobile/bootstrap`
- `/api/events`
- `/api/events/stream`
- `/api/tasks`
- `/api/chat`
- `/api/approvals`
- `/api/memory`
- `/api/embedding/status`, `/api/embedding/reembed`
- `/api/reranker/status`
- `/api/skills`
- `/api/jobs`
- `/api/messaging`
- `/api/parity/hermes`
- `/api/readiness/v1`

V2 starts from this runtime foundation and adds the native mobile app, paired-device auth as product UX, remote relay/push, stronger production/sandbox promotion, and deeper long-running operational hardening.

## Embeddings

Hindsight phase 2+ embeds memory units when retaining facts and embeds the query when recalling. As of `Default to in-process local embeddings`, the runtime ships with three providers:

- `local` (default) — `@huggingface/transformers` running ONNX in-process. Default model `Xenova/all-MiniLM-L6-v2` (~25MB, 384d). Lazy-loaded the first time a retain/recall actually needs an embedding so users on `openai` or `echo` never pay the native-binding cost. Override the model via `GINI_LOCAL_EMBEDDING_MODEL=<hf-id>` (e.g. `Xenova/bge-small-en-v1.5`). Cache at `~/.gini/models/`.
- `openai` — `text-embedding-3-small` over the same OpenAI bearer / Codex OAuth resolution as the chat provider. Opt-in via `GINI_EMBEDDING_PROVIDER=openai`.
- `echo` — deterministic 32-d hash, used by tests and by `gini smoke`. Opt-in via `GINI_EMBEDDING_PROVIDER=echo`.

Different models live in different vector spaces, so `recall`'s semantic channel filters memory units to those whose `embedding_model` equals the active provider's model. Switching providers leaves prior units in the bank; they remain BM25/graph/temporal-reachable but invisible to semantic recall until you run `gini embedding reembed [--bank ID]`. `gini doctor` and `gini embedding status` surface model mixing.

`gini smoke` pins `GINI_EMBEDDING_PROVIDER=echo` so CI never triggers a model download.

## Recall Pipeline

Recall fuses four channels (semantic, BM25, graph spreading-activation, temporal) with reciprocal rank fusion (RRF, `k=60`), then runs a cross-encoder reranker over the top-N before applying the token-budget pack. Reranker providers:

- `local` (default) — `@huggingface/transformers` running ONNX in-process. Default model `Xenova/ms-marco-MiniLM-L-6-v2` (~22M params, ~100MB). Lazy-loaded the first time recall fires, so users on `echo` or `none` never pay the model-load cost. Override the model via `GINI_LOCAL_RERANKER_MODEL=<hf-id>`. Cache at `~/.gini/models/` (shared with the embedding provider).
- `echo` — deterministic stub used by tests and by `gini smoke`. Score is `1 / (1 + index)` for predictable assertions.
- `none` — pass-through. Skips the cross-encoder entirely; RRF order stands.

Top-N defaults to 25 (override via `GINI_RERANKER_TOP_N`). The tail of the RRF list past the top-N keeps RRF order — cross-encoder cost grows with candidates, and tail entries rarely survive the token-budget pack. If the local provider fails to initialise, recall logs a single warning and falls through to `none` so results are always returned.

`gini reranker status` and `gini doctor` surface the active provider/model/top-N. `gini smoke` pins `GINI_RERANKER_PROVIDER=echo` so CI never triggers a cross-encoder download.

## Next.js Control Pinstance

The local web app at `web/` is a separate Next.js 16 process that the CLI launches with the runtime. It uses TanStack Query for data, `next-themes` for dark/light, shadcn/ui for primitives, and a server-side catch-all proxy (`web/src/app/api/runtime/[...path]/route.ts`) that forwards `GET/POST/PATCH/DELETE/PUT` to `${GINI_RUNTIME_URL}/api/<path>` with the bearer token attached. Real-time updates use the runtime's `/api/events/stream` SSE endpoint (also proxied). Pages render against live runtime state with empty states where no data exists; no fixture data is shipped.

`bun run gini start` launches the runtime and the Next.js app, prints both URLs, and uses dev mode unless `web/.next-<instance>/BUILD_ID` is present. `bun run gini stop` kills both. `bun run gini smoke` runs with `--no-web` automatically so smoke remains a runtime-only verification path.

## Process lifecycle: `start` vs `run`

There are two ways to launch a instance:

- **`gini start`** — daemon mode. The CLI spawns the runtime (and Next.js, unless `--no-web`) detached and `unref`s, so the children survive the launching shell. Use this for a persistent personal agent that should keep working after you close the terminal. Stop it explicitly with `gini stop`.
- **`gini run`** — foreground mode. The CLI stays attached: child stdio is inherited so logs stream live, no `detached`/`unref`, and `SIGINT`/`SIGTERM`/`SIGHUP` to the CLI tear the children down (5s SIGTERM grace, then SIGKILL). When the launching terminal closes (HUP) or Ctrl-C is pressed, the instance dies with it.

Use `gini run` for parallel coding-agent worktrees and CI: each worktree runs its instance in the foreground so the instance is bound to the agent's session — when the agent exits, no orphan runtime is left behind. Both modes share the same port-walking, healthz probing, instance state, and pid/port files; the only differences are stdio + detach + signal handling. `gini stop --instance <X>` still works against a `run`-launched instance if invoked from another terminal.

Ports are auto-allocated per instance so multiple instances coexist on one machine without manual `--port` wrangling. The default runtime port is `7337 + fnv1a(instance) % 100` and the default web port is `3000 + fnv1a(instance) % 100`; the `dev` instance stays pinned to `7337`/`3000` so existing muscle memory keeps working. If a default is busy (e.g. an unrelated process squats 3000) the CLI walks to the next free port and prints the actual URL it claimed. The chosen ports are persisted in `~/.gini/<instance>/runtime.port` / `web.port` so `gini status`, `gini stop`, and `gini doctor` read them directly without re-probing. Each instance also gets its own `web/.next-<instance>` build dir so two `next dev` instances do not contend on the same Next.js lockfile. Explicit `--port` / `--web-port` (and `GINI_PORT` / `GINI_WEB_PORT`) keep their strict-fail behaviour: a busy pinned port is reported, never silently rolled forward.
