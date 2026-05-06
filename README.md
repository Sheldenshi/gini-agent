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

## v0 Developer Slice

This repo now includes a Bun TypeScript v0 implementation of the local runtime trunk:

- lane-aware CLI and runtime
- authenticated localhost API
- browser control plane served by the runtime
- persistent tasks, traces, audit events, approvals, jobs, memories, skills, and demo connectors
- approval-gated file writes and terminal commands
- provider support with deterministic `echo`, Codex OAuth, and OpenAI API key modes
- trace-backed improvement proposals for memory, skill, and job changes
- evidence bundles for smoke/reviewer agents
- Hermes-inspired memory proposal flow and OpenClaw-inspired connector/skill scaffolding

Run it locally:

```bash
bun run gini install
bun run gini start
bun run gini smoke
```

Open the control plane at the URL printed by `start`, usually:

```text
http://127.0.0.1:7337
```

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
bun run gini provider show
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

Use lanes for isolated development:

```bash
bun run gini --lane sandbox reset
bun run gini --lane sandbox start
```

Smoke tests are isolated by default:

```bash
bun run gini smoke
```

That creates an ephemeral `smoke-...` lane under `/tmp`, chooses a localhost port, runs through the real runtime/API, and stops that runtime afterward. Multiple coding agents can run smoke tests at the same time without sharing the `dev` lane.

For a named persistent test lane, pass explicit roots and a port:

```bash
bun run gini smoke --lane codex-a --state-root /tmp/gini-codex-a --log-root /tmp/gini-codex-a-logs --port 7601
```

By default, Gini follows macOS user-level install conventions:

```text
~/Library/Application Support/Gini/<lane>/
~/Library/Logs/Gini/<lane>/
```

For disposable development or tests, override those roots:

```bash
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --lane sandbox smoke
```
