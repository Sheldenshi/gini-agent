# Gini Agent

Gini Agent is a local-first personal agent runtime for people who want an agent they can install, operate, inspect, approve, and debug.

Gini is not just a chat box, CLI, messaging bot, or pile of tools. Chat is an interaction surface. The runtime is the system of record for conversations, runs, tasks, approvals, memory, skills, jobs, tools, traces, audit events, and runtime health.

## Docs

- [Whitepaper](docs/whitepaper.md): the gaps this project is closing and the bar it's measured against
- [Architecture Overview](docs/architecture-overview.md): gateway/client map
- [Gateway And Control Plane](docs/gateway.md): runtime process, BFF, auth, instances, ports, disk layout
- [Conversation And Runs](docs/conversation-runs.md): chat, runs, tasks, plan steps, traces, and audit handoff
- [Memory](docs/memory.md): retain, recall, embeddings, reranking, review, and storage
- [Runtime Capabilities](docs/runtime-capabilities.md): current CLI/API capability map and verification commands
- [Operations](docs/operations.md): install, start, stop, smoke, diagnostics, and cleanup
- [Implementation Notes](docs/implementation-notes.md): source layout and module boundary rules
- [Roadmap](ROADMAP.md): shipped surfaces and what's planned, with design intent

## Architecture decisions

- [Architecture Decision Records](docs/adr/README.md): index of all ADRs and how to add new ones

## Architecture In One Sentence

Gini's **runtime is the gateway**: a single Bun process per instance owns state and performs work. The Next.js web app, CLI, future mobile app, MCP surfaces, and messaging bridges are clients of the same authenticated `/api/*` contract.

```text
                 GATEWAY (Bun runtime, one per instance)
                 state, agent loop, tools, memory, jobs
                              ^
          --------------------+--------------------
          |                    |                   |
      Next.js BFF          CLI / scripts       future clients
      browser UI           bearer token        mobile, MCP, messaging
      no browser token
```

## Current Runtime

This repo includes a Bun TypeScript local runtime with:

- instance-aware CLI and authenticated localhost gateway
- Next.js + Tailwind + shadcn/ui control plane with a server-side BFF proxy
- persistent chat sessions, runs, plan steps, tasks, approvals, audit events, traces, evidence bundles, jobs, memories, and skills
- approval-gated file, terminal, and code tools
- provider support with deterministic `echo`, Codex OAuth, OpenAI API key, and OpenRouter-compatible records
- four-network memory in SQLite with local embeddings and reranking by default
- trace-backed improvement proposals for memory, skill, and job changes
- paired-device auth and mobile bootstrap contracts for future mobile clients
- instance-local snapshots and promotion proposal records
- Local-first runtime primitives for memory, skills, jobs, search, providers, toolsets, subagents, MCP records, messaging records, and import inspection
- Skill-as-package + managed connector credential plane

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash
```

On macOS the installer enables autostart (per-user LaunchAgents for the runtime and webapp), waits for the webapp to come up, and opens the `/setup` page in your browser. Pick a provider in the browser form (OpenAI API key or existing `codex --login` auth) and you land on the running app. The runtime stays alive across reboots and crashes until you explicitly run `gini stop` or `gini autostart disable`.

If the browser doesn't open automatically (or you want to navigate manually), run `gini status` to print the actual web URL. The installed `default` instance always lives at `:7777`; other instances get hash-derived ports, so check `gini status` rather than guessing. The installer also prints the URL right before opening the browser.

Caveat on macOS 26 (Tahoe): after a SIGKILL, launchd sometimes refuses to auto-respawn (`pended nondemand spawn = inefficient`). Run `gini autostart kick` to force a respawn when that happens; RunAtLoad still fires at login.

If you opted out of autostart (`--no-autostart`) or you're on Linux (autostart is macOS-only in v1), run `gini setup` then `gini start` to launch the runtime by hand.

After install, the URLs are stable:

- web: `http://127.0.0.1:7777`
- runtime: `http://127.0.0.1:7778`

### Update

```bash
gini update
```

Pulls the latest source into `~/.gini/runtime`, reinstalls dependencies, and leaves your state under `~/.gini/instances/` and the model cache at `~/.gini/models/` untouched. If a runtime is currently running, Gini restarts it automatically so the new code is picked up without a manual `gini stop && gini start`.

When the web app is running from the installer-managed runtime, it surfaces the current package/git version in the sidebar and exposes the same update action through its Update button.

If you are working from a repo clone, use `git pull && bun install` instead — `gini update` only operates on the installer-managed runtime at `~/.gini/runtime`.

### From source (for developers)

```bash
bun install
bun run gini install
bun run gini start
```

When you run `bun run gini` from a repo clone, the instance is auto-derived from the repo directory basename, so each worktree gets isolated state without typing `--instance` every time. The installed `gini` command from `curl | bash` always uses the `default` instance, so developer worktrees and end-user state never collide. Per-instance runtime and web ports are deterministic hashes within a 100-port window starting at 7337 (runtime) / 3000 (web); `gini status` prints the actual URLs.

Run a foreground instance with an explicit name:

```bash
bun run gini run --instance feature-x
```

### Local development install (for testing in-progress changes)

If you're working on gini-agent itself and want to test the install/update/uninstall flow against your local checkout (without pushing to GitHub):

```bash
./scripts/install.sh --local
```

This is the same as the default install except it clones from your local repo into `~/.gini/runtime`. After you commit changes locally, `gini update` will pull them in. `gini uninstall` works exactly the same as a real install (same marker, same wrapper path).

## Common Commands

```bash
bun run gini status
bun run gini chat new
bun run gini chat send <session-id> "remember Gini should keep work inspectable"
bun run gini runs list
bun run gini task submit "read docs and summarize the gateway"
bun run gini approvals
bun run gini memory list
bun run gini job add heartbeat 60 "check runtime health"
bun run gini connectors health
bun run gini evidence
bun run gini search "runtime memory"
bun run gini toolsets
bun run gini subagent spawn reviewer "review recent traces"
bun run gini mcp add demo echo ok
bun run gini messaging add local demo local
bun run gini messaging add tg telegram <chat-id> --bot-token <bot-token>
bun run gini import inspect openclaw ~/.openclaw
bun run gini snapshot create "before trying candidate"
bun run gini provider show
```

## Providers

`gini setup` walks an interactive picker for both supported providers (OpenAI Codex and OpenAI API key). On `--yes`/`--non-interactive` runs it auto-picks: it prefers Codex when `CODEX_AUTH_JSON` is set or `~/.codex/auth.json` exists, falls back to OpenAI when `OPENAI_API_KEY` is set, and otherwise fails with a clear message naming all three sources.

Use Codex OAuth:

```bash
codex --login
bun run gini provider set codex gpt-5.5
bun run gini doctor
```

Gini reads existing Codex credentials from `CODEX_AUTH_JSON` or `~/.codex/auth.json` and does not write token values into Gini config.

Use OpenAI API keys as a fallback:

```bash
export OPENAI_API_KEY=...
bun run gini provider set openai gpt-5.4-mini
bun run gini doctor
```

API keys are read from the environment and are not written to Gini config.

### OpenAI-compatible local servers (oMLX, vLLM, LM Studio, llama.cpp)

The `local` provider speaks the OpenAI chat-completions wire shape so any compatible server works. Override the default base URL, the env var holding the API key, and any server-specific request fields with the corresponding flags:

```bash
bun run gini provider set local gemma-4-31b-it-8bit \
  --base-url http://127.0.0.1:8000/v1 \
  --api-key-env GINI_LOCAL_API_KEY \
  --extra-body '{"chat_template_kwargs":{"preserve_thinking":false,"enable_thinking":true}}'
```

`--base-url` and `--api-key-env` also work for `openai` and `openrouter` (point at a proxy, swap which env var holds the key). `--extra-body` is forwarded into every chat-completions request — see [provider-extra-body.md](docs/adr/provider-extra-body.md) for the full contract, the reserved-key denylist, and the security boundary.

## Parallel Development

Use instances for isolated work:

```bash
bun run gini --instance sandbox reset
bun run gini --instance sandbox run
```

Smoke tests are isolated by default:

```bash
bun run gini smoke
```

Each smoke run creates an ephemeral instance under `/tmp`, chooses available localhost ports, exercises the real runtime/API, writes evidence, and stops afterward. Multiple coding agents can run smoke tests at the same time without sharing the `dev` instance.

For a named persistent smoke instance:

```bash
bun run gini smoke --instance codex-a --state-root /tmp/gini-codex-a --log-root /tmp/gini-codex-a-logs --port 7601
```

## Local State

By default, Gini stores per-instance state and logs under `~/.gini/`:

```text
~/.gini/instances/<instance>/       # config, state.json, memory.db, traces, snapshots, workspace, logs
~/.gini/models/                     # Transformers.js embedding/reranker model cache shared across instances
```

Remove one instance:

```bash
bun run gini uninstall --instance <instance>
```

Full uninstall with two prompts (asks before deleting instance state):

```bash
bun run gini uninstall
```

Pass `--yes` to skip prompts, or `--purge` to wipe all instance state in one step.

For disposable development or tests:

```bash
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```

## Roadmap

- ✅ Local Bun runtime gateway
- ✅ Next.js webapp with BFF
- ✅ CLI with parallel instances
- ✅ Persistent chat, runs, approvals, audit, traces
- ✅ Approval-gated tools (file, terminal, code)
- ✅ Local memory with embeddings and reranking
- ✅ Trace-backed improvement proposals
- ✅ Provider support (Codex OAuth, OpenAI)
- ✅ Paired-device auth
- ✅ Auto-start after install (macOS LaunchAgents; runtime + webapp)
- ✅ Browser-based onboarding at install (/setup route)
- ⚪ iOS mobile app for remote control
- ⚪ Verification layer (reproducible builds, verify-app)
- ⚪ Gini as MCP server
- ⚪ Task self-learning and iteration loop
- ⚪ Native macOS app (Tauri shell, later)


This is the short preview. See the full roadmap in [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
