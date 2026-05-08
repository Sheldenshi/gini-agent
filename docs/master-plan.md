# Gini Master Plan

Gini is a local-first personal agent runtime that a user can install, operate, inspect, approve, debug, and trust.

The product goal is not to make another chat UI. Chat is one input surface. The system of record is the work: conversations, runs, tasks, approvals, memory, skills, jobs, traces, audit events, tools, connectors, and runtime health.

## High-Level Goal

Build an agent system with Hermes-class runtime depth and OpenClaw-style reach, but with stronger operational guarantees:

- persistent work instead of disposable transcripts
- inspectable execution instead of opaque agent behavior
- governed memory and skills instead of hidden adaptation
- approval-gated tools instead of unrestricted side effects
- observable jobs and traces instead of silent background work
- local ownership of state, credentials, and runtime lifecycle
- stable HTTP contracts so CLI, web, mobile, MCP, and messaging clients all operate the same runtime

The Mac/local runtime is the source of truth. Web, CLI, future mobile, and connector surfaces are clients.

## Product Principles

- **Runtime first.** The gateway owns state, execution, memory, jobs, approvals, audit, and traces.
- **Clients stay replaceable.** Next.js, CLI, future mobile, and messaging bridges consume the same `/api/*` contract.
- **Chat creates durable work.** A user can ask for something conversationally, but Gini records runs, plan steps, events, approvals, traces, and linked tasks where useful.
- **Memory is visible.** Retain, recall, reflect, reinforce, edit, approve, reject, and archive are inspectable operations.
- **Tools are permissioned.** File writes, terminal commands, and code execution pass through approval and audit boundaries.
- **Instances isolate work.** Multiple users, agents, worktrees, and smoke runs can operate without sharing state or ports.
- **Local by default.** State lives under `~/.gini/instances/<instance>/`; shared model cache lives under `~/.gini/models/`.
- **Provider choice is explicit.** Codex OAuth is the preferred interactive path, with OpenAI API keys and deterministic echo mode available.
- **External integrations fail visibly.** Connectors, MCP, messaging, importers, and providers should report health and avoid mutating external installs by default.

## Current System Shape

Gini currently ships as a Bun TypeScript runtime with:

- instance-aware CLI and authenticated localhost gateway
- Next.js control plane using a server-side BFF proxy
- tasks, chat sessions, execution runs, plan steps, approvals, audit, events, traces, evidence bundles, and support diagnostics
- jobs with prompt/script runs, replay, pause, resume, and run history
- four-network memory in SQLite with semantic, lexical, graph, and temporal recall
- local Transformers.js embeddings and reranker by default, with OpenAI/echo alternatives
- skills, toolsets, provider catalog, Codex OAuth, OpenAI, OpenRouter-compatible records, subagent records, MCP records, messaging records, connector records, profiles, snapshots, promotion proposals, and read-only import inspection
- smoke/parity/readiness checks designed for parallel coding-agent workflows

See the focused docs linked from the README for operational detail.

## Roadmap

The roadmap is organized by system area instead of arbitrary release labels. Work should advance these areas without breaking the runtime contracts.

### Runtime And Gateway

- Keep the Bun gateway as the only stateful execution authority.
- Harden install/start/run/stop/uninstall flows.
- Add LaunchAgent-style persistence when the product needs automatic startup.
- Preserve per-instance state, logs, ports, tokens, workspace, and web build isolation.
- Keep browser tokens server-side through the Next.js BFF.

### Conversation And Execution

- Treat chat as the user interaction layer, not the execution engine.
- Represent meaningful work as durable runs with plan steps, events, traces, approvals, and optional compatibility task records.
- Improve run lifecycle semantics: queued, running, waiting for approval, blocked, failed, canceled, and completed.
- Make decomposition visible without forcing every conversational exchange into a rigid task model.
- Support retry, replay, cancellation, and evidence bundles from run history.

### Memory

- Continue the four-network memory direction: semantic, BM25/lexical, graph, and temporal recall.
- Keep retention and reflection governable through approvals and review surfaces.
- Improve bank management, compaction, contradiction handling, and provenance.
- Support model changes through re-embedding and explicit model-space metadata.
- Keep local embeddings/reranking useful by default while allowing remote providers.

### Tools, Approvals, And Audit

- Keep side-effecting tools behind approval gates.
- Expand toolsets without bypassing auditability.
- Make approval requests actionable from CLI, web, and future mobile.
- Preserve trace and audit records for every meaningful action.
- Make policy failures and denied actions easy to diagnose.

### Jobs

- Treat jobs as first-class runtime records, not hidden cron entries.
- Keep prompt and script jobs observable through run history, traces, retries, and replay.
- Add richer schedules, dependencies, and failure policies as the runtime matures.
- Make long-running work resumable and inspectable.

### Skills And Self-Improvement

- Keep skills as inspectable, testable, versioned runtime assets.
- Require trace-backed proposals for skill, memory, and job improvements.
- Add stronger evaluation gates before promotion.
- Preserve rollback paths for generated changes.

### Connectors, MCP, And Messaging

- Keep external channels as input/output surfaces, not sources of truth.
- Make inbound messages create durable records in the runtime.
- Expose connector and MCP health.
- Avoid writing to external installs or credentials during import/inspection unless explicitly approved.
- Expand live transports once the local contracts and observability are strong.

### Control Planes

- Keep Next.js as the local browser control plane and automated product-test surface.
- Build future mobile against the same gateway contracts instead of a separate backend.
- Use pairing/device tokens for clients that can safely hold credentials.
- Add relay/push only after local runtime operations are reliable.

### Reliability And Operations

- Maintain fast smoke coverage for parallel agents and CI.
- Keep evidence bundles useful for reviewer agents and humans.
- Expand diagnostics for provider health, memory model state, connector health, and port/process conflicts.
- Make support bundles redact secrets by default.

## Reference Systems

Hermes is the runtime-capability reference: memory, skills, jobs, provider flexibility, delegation, session search, and a seamless conversational feel.

OpenClaw is the reach/connectivity reference: always-available agent surfaces, connector scaffolding, and gateway-style architecture.

Gini should match the important runtime primitives while making them more visible, governed, and operable.

## Current Non-Goals

- No separate hosted backend is required for the local runtime.
- The browser must not receive the gateway bearer token.
- Messaging apps are not the source of truth.
- The future mobile app should consume existing runtime contracts; it should not redefine the architecture.
- Importers should inspect external systems before they mutate anything.
