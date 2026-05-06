# ADR 0001: v0 Local Runtime Architecture

## Decision

Gini v0 is a Bun TypeScript local runtime with a lane-aware JSON state store, authenticated localhost HTTP API, CLI, and local web control plane served by the runtime.

## Context

The master plan asks v0 to prove the installable local runtime, CLI, and local control surface before mobile, relay, broad connectors, or production packaging. Hermes is the main interaction inspiration: persistent tasks, memory proposals, and skills should feel continuous rather than like disconnected chat transcripts. OpenClaw is used as gateway/connector inspiration, but messaging channels are deferred behind the runtime/control-plane contract.

## Required Now

- `gini` CLI commands for install, start, stop, status, doctor, reset, task, approval, memory, skill, job, connector, trace, audit, and smoke.
- Runtime state is scoped by lane under `~/Library/Application Support/Gini/<lane>` by default.
- Runtime logs are scoped by lane under `~/Library/Logs/Gini/<lane>` by default.
- Local API requires a bearer token stored in the lane config.
- Tasks, traces, audit events, approvals, jobs, memories, skills, and demo connector records are persisted.
- Risky file and terminal actions create approval records before side effects.
- The provider layer supports deterministic `echo` for tests, `codex` via Codex CLI OAuth credentials, and `openai` via `OPENAI_API_KEY`.

## Deferred

- Production macOS LaunchAgent installation.
- Next.js app packaging. The current control plane is a static browser app served by the runtime; API contracts are kept compatible with a future Next.js client.
- Real connector secrets and Keychain integration.
- Remote relay, paired mobile auth, push notifications, and messaging bridges.

## Consequences For Coding Agents

- Use the API/CLI contracts instead of treating the web UI as a separate product brain.
- Add new behavior through lane-aware state, audit events, and trace records.
- Do not add dangerous tools that bypass approval and audit.
- Keep future mobile clients as consumers of the same runtime semantics.

## Acceptance Checks

- `bun run gini smoke` exercises task, memory, job, connector, trace, audit, and runtime health.
- `bun run gini provider set codex <model>` configures Codex OAuth without copying token values into Gini config.
- `bun run gini provider set openai <model>` configures a real model provider without persisting API keys.
- Reset affects only the selected lane.
- CLI and web observe the same state.
- Every side effect-oriented path has an audit record and, when tied to a task, trace evidence.
