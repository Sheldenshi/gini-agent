# Gini Runtime Implementation Notes

These notes describe the current source layout and boundaries. Product direction lives in [Master Plan](./master-plan.md). Runtime behavior is documented in [Gateway And Control Plane](./gateway.md), [Conversation And Runs](./conversation-runs.md), and [Memory](./memory.md).

## Source Layout

- `src/types.ts` defines serialized domain contracts and runtime record shapes.
- `src/paths.ts` owns path selection, instance directory layout, ports, and local filesystem conventions.
- `src/server.ts` is the Bun process entrypoint and scheduler loop.
- `src/http.ts` is the authenticated local API router.
- `src/agent.ts` owns task execution and approval-gated tool actions.
- `src/provider.ts` owns provider normalization, health checks, and model calls.
- `src/state/` contains persistence, JSON state store helpers, audit/trace records, IDs, security helpers, and SQLite memory storage.
- `src/domain/` contains behavior that mutates or evaluates runtime state.
- `src/domain/memory/` contains retain, recall, reflect, reinforce, entity, temporal, migration, and schema logic.
- `src/tools/` contains file, terminal, code, and web tool implementations.
- `src/cli.ts` is the CLI shim.
- `src/cli/` contains CLI routing, API helpers, process management, output helpers, and command modules.
- `web/` is the Next.js control plane and BFF proxy.

## Boundary Rules

- API handlers should delegate behavior to `src/domain/*` instead of embedding state mutation logic.
- Domain services may use `src/state/*`, `src/types.ts`, `src/paths.ts`, and other domain services when needed.
- Storage modules should remain persistence-oriented: load/save, record constructors, migrations, traces, logs, security helpers, and low-level state utilities.
- API responses must not expose bearer tokens, secret hashes, or credential material.
- CLI commands should prefer public runtime APIs when exercising product behavior.
- Direct domain calls from CLI are reserved for local harness/process operations such as install, smoke setup, snapshots, and evidence bundles.
- New connectors, tools, providers, and client surfaces should land in focused modules before adding router or CLI commands.
- Hermes-parity features should first add durable runtime records and safe inspection flows before adding live external transports.
- MCP, messaging, and import integrations must fail visibly and must not mutate external installs or credentials by default.

## Current Intentional Compromises

- Most non-memory runtime records still live in a JSON state file for easy local debugging.
- Memory uses SQLite because recall needs structured indexes and durable local query behavior.
- Provider clients still share `src/provider.ts`; split them when provider routing/fallback becomes more complex.
- Some integration surfaces are durable records and health flows before they are full live transports.
- The CLI command set is broad, but command modules now keep behavior out of the top-level shim.
