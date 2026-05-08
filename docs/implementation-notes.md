# Gini Runtime Implementation Notes

**Status:** Implementation notes. The canonical product spec is [master-plan.md](./master-plan.md).

This repo is organized around runtime boundaries rather than feature chronology.

## Source Layout

- `src/types.ts` defines stable domain contracts and serialized state shapes.
- `src/paths.ts` owns macOS/user-level path selection and instance directory layout.
- `src/state.ts` is the file-backed repository layer for state, trace, audit, and record constructors.
- `src/domain/` contains behavior that mutates or evaluates runtime state.
- `src/api/` contains API-facing view models and redaction rules.
- `src/http.ts` is the authenticated local API router and web app adapter.
- `src/agent.ts` owns task execution and approval-gated tool actions.
- `src/provider.ts` owns model provider normalization, health, and calls.
- `src/cli.ts` is the command-line adapter over runtime APIs and domain utilities.
- `src/server.ts` is the process entrypoint and scheduler loop.

## Boundary Rules

- API handlers should delegate behavior to `src/domain/*` instead of embedding state mutation logic.
- Domain services may use `state.ts`, `types.ts`, `paths.ts`, and other domain services when needed.
- `state.ts` should remain storage-oriented: constructors, persistence, trace/log writes, and low-level state helpers.
- `api/` modules must not expose secret hashes or bearer tokens.
- CLI commands should prefer public runtime APIs when exercising product behavior; direct domain calls are reserved for local harness operations such as snapshots and evidence bundles.
- New connectors, tools, providers, and mobile surfaces should land in their own modules before adding router or CLI commands.
- Hermes-parity features should first add durable runtime records and safe inspection flows before adding live external transports.
- MCP, messaging, and import integrations must fail visibly and must not mutate external installs or credentials by default.

## Current Intentional Compromises

- The state store is still a JSON file to keep v0 install/debug simple.
- The web control plane is a single HTML file served by the runtime until a real Next.js/Expo shell is added.
- Provider clients still share one module; split them when provider routing/fallback grows beyond the current Codex/OpenAI/echo set.
- `cli.ts` remains a larger adapter because it mirrors the full command map, but durable business logic has been moved out of it.
