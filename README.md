# Gini Agent

Gini Agent is an open source personal agent framework for people who want an agent they can install, operate, and trust.

OpenClaw showed that people want agents that are always available: connected to channels, reachable from anywhere, extensible through integrations, and useful beyond a single terminal session.

Hermes showed that people want agents with depth: memory, skills, jobs, tool use, provider flexibility, delegation, and a path toward self-improvement.

But the next agent framework needs to solve what both still leave exposed.

Breadth without reliability becomes brittle. Memory without visibility becomes magic. Jobs without observability become silent failures. Skills without governance become folklore. Tools without permissions become dangerous. Chat without state becomes a messy transcript of work you cannot operate.

Gini Agent starts from those gaps.

It is not just a chat box, not just a CLI, not just a messaging bot, and not just a pile of tools. It is a full agent system designed around the way people actually need to work with autonomous software.

When an agent acts on your behalf, you should be able to see:

- what it is doing
- why it is doing it
- what it changed
- what failed
- what it remembers
- what skills it used
- what jobs are scheduled
- what it is allowed to do
- what needs your approval
- what evidence it left behind

Gini Agent reimagines human-agent interaction around persistent work instead of ephemeral chat.

Tasks, approvals, memory, skills, jobs, tools, traces, permissions, and runtime health are first-class. Chat and voice can still exist, but they are not the center. The center is the work: visible, inspectable, governable, and recoverable.

The goal is simple:

**An agent you can operate, inspect, approve, debug, and trust.**

Gini Agent is the open source software layer people can install and use themselves.

The master plan lives at:

`docs/master-plan.md`

A short architecture overview with diagram lives at:

`docs/architecture-overview.md`

The current module boundaries are documented at:

`docs/implementation-notes.md`

The V1 local runtime readiness map is documented at:

`docs/v1-readiness.md`

## Architecture in one sentence

Gini's **runtime is the gateway** — a single Bun process per instance that owns all state and does all real work. The Next.js web app, the CLI, and the future mobile app are all clients of the same `/api/*` contract.

```
                 GATEWAY (server, one per instance)
                 Bun runtime — state, agent loop, tools
                            ↑
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    Next.js BFF      Phone app (post-v1)    CLI / MCP /
    + browser UI     direct, paired         your scripts
```

See `docs/architecture-overview.md` for the full picture.

## v0 Developer Slice

This repo now includes a Bun TypeScript v0 implementation of the local runtime trunk:

- instance-aware CLI and runtime
- authenticated localhost API (the gateway)
- Next.js + Tailwind + shadcn/ui control plane (BFF for the browser; holds the bearer token server-side)
- persistent tasks, traces, audit events, approvals, jobs, memories, skills, and demo connectors
- approval-gated file writes and terminal commands
- provider support with deterministic `echo`, Codex OAuth, and OpenAI API key modes
- trace-backed improvement proposals for memory, skill, and job changes
- evidence bundles for smoke/reviewer agents
- paired-device auth and mobile bootstrap contracts for the future Expo app
- instance-local snapshots and promotion proposal records for v2 promotion/rollback workflows
- Hermes-parity structure for session search, toolsets, subagents, MCP records, messaging bridge records, provider catalog metadata, and read-only import inspection
- Hermes-inspired memory proposal flow and OpenClaw-inspired connector/skill scaffolding

Run it locally:

```bash
bun run gini install
bun run gini start         # daemon — instance keeps running after the terminal closes
bun run gini smoke
```

Or run a instance in the foreground (instance dies when this terminal exits — use this for coding-agent worktrees):

```bash
bun run gini run --instance feature-x
```

`start` and `run` both print two URLs:

```text
url     → runtime (gateway) — the API server
webUrl  → Next.js control plane — open this in a browser
```

For the `dev` instance those default to `http://127.0.0.1:7337` (runtime) and `http://127.0.0.1:3000` (web). Other instances get their own deterministic ports automatically; both walk forward if the default is busy.

Common commands:

```bash
bun run gini status
bun run gini task submit "remember Gini should keep work inspectable"
bun run gini approvals
bun run gini memory list
bun run gini job add heartbeat 60 "check runtime health"
bun run gini connectors health
bun run gini improvement propose skill review-traces "" "Inspect trace evidence before proposing changes"
bun run gini improvements
bun run gini evidence
bun run gini pairing
bun run gini devices
bun run gini mobile bootstrap
bun run gini search "Hermes parity"
bun run gini toolsets
bun run gini subagent spawn reviewer "review recent traces"
bun run gini mcp add demo echo ok
bun run gini messaging add local demo local
bun run gini import inspect hermes ~/.hermes
bun run gini snapshot create "before trying candidate"
bun run gini promotion propose HEAD /path/to/evidence.json "tested candidate in sandbox"
bun run gini provider show
bun run gini parity hermes
bun run gini readiness v1
```

Use Codex OAuth as the model provider:

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

Use instances for isolated development:

```bash
bun run gini --instance sandbox reset
bun run gini --instance sandbox start
```

Smoke tests are isolated by default:

```bash
bun run gini smoke
```

That creates an ephemeral `smoke-...` instance under `/tmp`, chooses a localhost port, runs through the real runtime/API, and stops that runtime afterward. Multiple coding agents can run smoke tests at the same time without sharing the `dev` instance.

For a named persistent test instance, pass explicit roots and a port:

```bash
bun run gini smoke --instance codex-a --state-root /tmp/gini-codex-a --log-root /tmp/gini-codex-a-logs --port 7601
```

By default, Gini stores per-instance state and logs under `~/.gini/`:

```text
~/.gini/instances/<instance>/       # config, state.json, memory.db, traces, snapshots, workspace
~/.gini/logs/<instance>/         # rotated runtime logs
~/.gini/models/              # Transformers.js embedding/reranker model cache (shared across instances)
```

To wipe a single instance: `rm -rf ~/.gini/instances/<instance>`. To wipe every instance while keeping the model cache and logs: `rm -rf ~/.gini/instances`.

For disposable development or tests, override those roots:

```bash
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```
