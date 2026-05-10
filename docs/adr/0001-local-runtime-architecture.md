# ADR 0001: Local Runtime Architecture

## Decision

Gini is a Bun TypeScript local runtime with instance-aware state, an authenticated localhost HTTP gateway, a CLI, and a local Next.js control plane.

The gateway is the source of truth. Clients consume the gateway contract; they do not own durable runtime state.

## Context

Gini needs Hermes-class runtime depth while keeping OpenClaw-style reach possible through connectors and future clients. The local runtime must support persistent work, memory, jobs, approvals, traces, audit, providers, and tool execution before broader remote/mobile surfaces are product-critical.

## Required Now

- `gini` CLI commands for install, start, run, stop, status, doctor, task, chat, runs, approval, memory, skill, job, connector, trace, audit, evidence, parity, readiness, and smoke.
- Runtime state is scoped by instance under `~/.gini/instances/<instance>/` by default.
- Runtime logs are scoped inside the same instance directory.
- Local API requires a bearer token stored in the instance config.
- The Next.js control plane uses a server-side BFF proxy so browser JavaScript never receives the gateway token.
- Conversations, runs, plan steps, tasks, traces, audit events, approvals, jobs, memories, skills, and connector records are persisted.
- Risky file, terminal, and code actions create approval records before side effects.
- The provider layer supports deterministic `echo`, Codex OAuth, OpenAI API keys, and OpenRouter-compatible records.

## Deferred

- Production macOS LaunchAgent installation.
- Native/mobile app UI.
- Production relay, push notifications, and broad live messaging transports.
- Real connector secret storage and Keychain integration.

## Consequences For Coding Agents

- Use API/CLI contracts instead of treating the web UI as a separate product brain.
- Add new behavior through instance-aware state, audit events, traces, and domain modules.
- Do not add dangerous tools that bypass approval and audit.
- Keep future clients as consumers of the same runtime semantics.

## Acceptance Checks

- `bun run gini smoke` exercises task, memory, job, connector, trace, audit, parity, readiness, and runtime health.
- `bun run gini provider set codex <model>` configures Codex OAuth without copying token values into Gini config.
- `bun run gini provider set openai <model>` configures a real model provider without persisting API keys.
- Reset affects only the selected instance.
- CLI and web observe the same gateway state.
- Every side-effect-oriented path has an audit record and, when tied to execution, trace evidence.
