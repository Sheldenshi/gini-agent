# ADR: Agent Attribution Invariant At Event And Audit Emit Sites

- **Status:** Accepted
- **Date:** 2026-05-18
- **See also:** [Agents Replace Profiles](./agents-replace-profiles.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Every call into `appendEvent` and `addAudit` must declare its agent
attribution context explicitly. The shared `AgentContext` discriminated
union in `src/state/audit.ts` is required as the third argument:

```ts
export type AgentContext =
  | { agentId: string; system?: never }
  | { taskId: string; agentId?: string; system?: never }
  | { jobId: string; agentId?: string; system?: never }
  | { sessionId: string; agentId?: string; system?: never }
  | { memoryId: string; agentId?: string; system?: never }
  | { system: true; agentId?: never };
```

`resolveAgentId(state, ctx)` is deterministic:

- explicit `agentId` → use it
- `taskId` / `jobId` / `sessionId` / `memoryId` → look up the
  corresponding record and read its `agentId`
- `system: true` → return `undefined` and persist the row unattributed
- a source id provided but the record missing (deleted, race) → return
  `undefined` — **do not** fall back to `state.activeAgentId`

There is no fallback to `state.activeAgentId` anywhere in the inference
path. Forgetting to thread `agentId` is a TypeScript compile error.

## Context

Across Phase 2 review rounds (3, 4, 5) of the per-agent webapp work,
nearly every round found another emitter that lost `agentId`. The
pattern was always the same: a record (job, chat session, subagent,
approval) carries an `agentId`, but the event or audit emitter at some
later moment ignored it and let `inferAgentId` fall back to
`state.activeAgentId` — which had changed in between because the user
or a scheduler tick activated a different agent.

Each round added one more `agentId: foo.agentId` keyword argument at
one more call site. There was no structural reason the next reviewer
wouldn't find another. The bug class — silent attribution leak after
an active-agent switch — was systemic.

## Required Now

- `appendEvent` and `addAudit` take a required third parameter of type
  `AgentContext`. The persisted `agentId` field is filled in by
  `resolveAgentId`, not by the caller spreading a field through the
  event input.
- The inference helper does not read `state.activeAgentId` anywhere.
- The `system: true` escape hatch is reserved for events that genuinely
  have no agent owner: instance boot, instance config changes, agent
  CRUD (the agent IS the subject), instance-level integration
  configuration (MCP servers, messaging bridges, relays, browser
  connections, snapshots).
- `migrateRecordAgentIds` no longer backfills events or audits. A
  missing `agentId` on those rows is now a first-class signal that the
  row is system-attributed; stamping legacy rows with the migration-
  time active agent would erase that distinction.

## Migration

Approximately 120 call sites across the runtime were migrated to pass
an explicit `AgentContext`. Each site was reviewed for the best source
of attribution available in scope:

- record creation helpers (`src/state/records.ts`) attribute via the
  just-created record's own context (`taskId`, `jobId`, `sessionId`)
- job lifecycle, chat lifecycle, task lifecycle, subagent, approval
  audits use the source id their owning record carries
- agent lifecycle audits (`agent.created`, `agent.activated`,
  `agent.deleted`) attribute to the agent itself
- instance-level rows (devices, pairing, snapshots, promotions, MCP,
  messaging bridges, connectors, relays, imports, toolsets, skills)
  declare `system: true` so they remain unattributed and surface only
  under the activity feed's "All agents" view

## Consequences

Pro:

- The "I forgot to thread `agentId`" bug class is impossible. The
  compiler rejects every two-argument call.
- The agent-attribution contract lives in one place
  (`src/state/audit.ts`) and is enforceable by code review without
  expert runtime knowledge.
- `system: true` is now an explicit, auditable marker. Reviewers can
  ask "is this row really system-level?" at the diff instead of
  reasoning about whether `state.activeAgentId` would have been the
  right answer at runtime.

Con:

- Every emitter is verbose: a two-line audit payload is now four
  lines with the `AgentContext` argument on the next line. The
  verbosity is the point — it forces the call site to declare
  attribution rather than picking it up by accident.
- `system: true` is a small attack surface for "I don't want to think
  about this." Reviewers should treat it like an `as any` — it's not
  banned, but it should require justification. Every existing
  `system: true` call site in the migration carries a comment.

## Acceptance Checks

- `bun run typecheck` rejects `appendEvent(state, eventInput)` and
  `addAudit(state, auditInput)` (two arguments). The
  `// @ts-expect-error` guards in `src/http.test.ts` pin this at the
  type level.
- Resolution tests in `src/http.test.ts` cover every branch of the
  `AgentContext` union and the missing-source case.
- The Round-3 regression — a scheduled job fired after an agent switch
  must attribute to the originating job's agent — continues to pass.
