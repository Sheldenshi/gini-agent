# Gini Agent

Gini Agent is a local-first personal agent runtime for people who want an agent they can install, operate, inspect, approve, debug, and trust.

Gini is not just a chat box, CLI, messaging bot, or pile of tools. Chat is an interaction surface. The runtime is the system of record for conversations, runs, tasks, approvals, memory, skills, jobs, tools, traces, audit events, and runtime health.

## Docs

- [Master Plan](docs/master-plan.md): high-level goal, principles, and roadmap
- [Architecture Overview](docs/architecture-overview.md): gateway/client map
- [Gateway And Control Plane](docs/gateway.md): runtime process, BFF, auth, instances, ports, disk layout
- [Conversation And Runs](docs/conversation-runs.md): chat, runs, tasks, plan steps, traces, and audit handoff
- [Memory](docs/memory.md): retain, recall, embeddings, reranking, review, and storage
- [Runtime Capabilities](docs/runtime-capabilities.md): current CLI/API capability map and verification commands
- [Operations](docs/operations.md): install, start, stop, smoke, diagnostics, and cleanup
- [Implementation Notes](docs/implementation-notes.md): source layout and module boundary rules

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
- Hermes-inspired runtime primitives for memory, skills, jobs, search, providers, toolsets, subagents, MCP records, messaging records, and import inspection
- OpenClaw-inspired connector and gateway structure

## Quick Start

```bash
bun install
bun run gini install
bun run gini start
bun run gini smoke
```

`start` launches the runtime gateway and the local Next.js web control plane. It prints two URLs:

```text
url     -> runtime gateway API
webUrl  -> Next.js control plane
```

For the `dev` instance those default to:

- runtime: `http://127.0.0.1:7337`
- web: `http://127.0.0.1:3000`

Run a foreground instance for coding-agent worktrees:

```bash
bun run gini run --instance feature-x
```

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
bun run gini search "Hermes parity"
bun run gini toolsets
bun run gini subagent spawn reviewer "review recent traces"
bun run gini mcp add demo echo ok
bun run gini messaging add local demo local
bun run gini import inspect hermes ~/.hermes
bun run gini snapshot create "before trying candidate"
bun run gini provider show
bun run gini parity hermes
bun run gini readiness v1
```

## Providers

Use Codex OAuth:

```bash
codex --login
bun run gini provider set codex gpt-5.4
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

Remove every instance while keeping the model cache:

```bash
rm -rf ~/.gini/instances
```

For disposable development or tests:

```bash
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```
