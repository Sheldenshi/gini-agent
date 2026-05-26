# ADR: Per-Agent Memory Isolation

- **Status:** Accepted
- **Date:** 2026-05-13
- **See also:** [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md)

## Decision

Each agent owns its own memory pool. The agent id is the isolation
key. Hindsight memory banks and units carry the agent id, and recall
filters on it across all four channels (semantic, BM25, temporal,
graph). The legacy `MemoryRecord` rows also carry an `agentId`, and
`/api/memory*` filters by the active agent.

A new agent starts with empty memory. Configuration is copied from
defaults at creation; content is not.

## Context

Before isolation, all memory — legacy `MemoryRecord` rows and
Hindsight banks and units — lived in a single pool per instance.
Switching the active profile could see and write each other's
memories. With agents now driving runtime behavior (see ADR agents-replace-profiles.md),
shared memory leaks context across personas: a "coding" agent's pinned
memories would pollute the "research" agent's recall and vice versa.

The product expectation for per-agent personas is that switching the
agent changes which facts the agent knows.

## Required Now

- Two-level scoping in Hindsight:
  - Per-agent bank id: `bank_${agentId}`. `ensureAgentBank(instance,
    agentId)` creates the bank on demand.
  - Denormalized `agent_id` column on `memory_units` and
    `memory_banks` with matching indexes. The schema version bumps
    1 → 2; `ALTER TABLE ADD COLUMN` runs additively on first open.
- Legacy `MemoryRecord` gains an `agentId` field. `/api/memory`
  (legacy listing), `/api/memory/units`, and `/api/memory/banks`
  filter by the active agent.
- `RecallInput.agentId` is required. All four channels filter on
  `agent_id` before fusion and rerank. Bank id defaults to
  `bankIdForAgent(agentId)` so a fresh agent auto-creates its bank on
  first recall.
- Retain and reflect resolve the active agent via
  `resolveEffectiveContext` and stamp `agentId` at write time.
- `createAgent` calls `ensureAgentBank` so a newly created agent gets
  an empty bank immediately.
- `/api/status.activeAgent.memoryNamespace` exposes the isolation key
  for clients.

## Read And Write Semantics

- **Write:** every retain/reflect path resolves the active agent and
  stamps `agentId`. Auto-retain inside `runChatTask` and `runTask`
  reads `state.activeAgentId` and skips writing (with a trace) when
  no agent is active, rather than leaking into the default bank.
- **Read:** `RecallInput.agentId` is required. The four channels
  filter on `agent_id` before fusion. There is no cross-agent search;
  it is an explicit non-goal.

## Boundary

`agentId` is the isolation key.

**Amendment (2026-05-13):** `MemoryRecord.scope` and
`AgentRecord.memoryScopes` were removed in a follow-up after the audit
confirmed neither was consulted at runtime. The fields had been kept as
an "in-agent organizational tag" pending future use, but no read or
write path ever branched on them — they were dead weight after Phase
C. `normalizeState` gained an idempotent migration step that strips
both fields from existing state files on first read. The Hindsight
`metadata.legacyScope` breadcrumb on imported units is left intact as
a historical record of pre-Phase-C data and is separate from the
runtime field that was removed.

**Amendment (2026-05-21):** `state.memories` (the legacy JSON pinned-
memory store) was removed alongside the memory-surface consolidation.
The system-prompt pinned-memory block is gone; USER.md (instance-scoped,
cross-agent) holds the user-identity surface and Hindsight (per-agent
bank, unchanged) holds long-term recall. `migrateMemoryAgentId` and the
`MemoryRecord.scope` strip step were both removed because the source
collection no longer exists; the per-agent isolation key now applies
only to Hindsight units, jobs, sessions, and the SOUL.md file path. A
one-shot migration drains pre-consolidation `state.memories` into
USER.md and clears the array. See ADR
[runtime-identity-files.md](./runtime-identity-files.md).

## Subagent Inheritance

Subagents go through `runChatTask` which reads `state.activeAgentId`,
so they share the parent agent's memory pool. A subagent is a delegated
worker of the parent, not a peer with its own pool. If a subagent ever
activates a different agent mid-task, that path would need to be
revisited.

## Migration

`normalizeState` runs the Hindsight backfill after the agent rename and
lane migrations are settled. The legacy `state.memories` backfill was
retired alongside the memory-surface consolidation — see the 2026-05-21
amendment above.

- `migrateHindsightAgentIdColumns(instance, state)` opens the SQLite
  memory.db only if it already exists, runs
  `UPDATE … WHERE agent_id IS NULL` against `memory_units` and
  `memory_banks` (excluding `bank_default`), and emits a
  `hindsight.agentid.backfill` audit event with the count.

Both are idempotent. Subsequent calls match no rows. `bank_default`
deliberately keeps `agent_id = NULL` so the `DEFAULT_BANK_ID` constant
in legacy code paths keeps working.

## Consequences

- **Behavior change:** switching agents changes which memories are
  recalled and pinned. Cross-agent leaks are impossible after
  migration.
- **Schema bump:** Hindsight DB schema version 1 → 2. Additive
  migration on first read; no destructive operations.
- **Breaking internal API:** `RecallInput.agentId` is required. Every
  internal caller has been updated. Any external consumer would
  break — none exists today.
- **Audit log volume:** backfills emit one summary audit event each,
  not one per row, so first-read after upgrade does not flood the
  audit log on large state files.
- **`bank_default`** stays untagged for legacy compatibility; new
  per-agent banks always carry an agent id from creation.

## Alternatives Considered

- **Filter at query time only; no per-agent banks.** Rejected —
  slower queries, no bank-level cleanup story (e.g. deleting an
  agent's entire memory in one statement).
- **Drop `MemoryRecord.scope` entirely.** Initially rejected for this
  ADR as "too much ripple for one phase" and kept as an in-agent
  organizational tag. A follow-up audit on 2026-05-13 confirmed the
  field had no runtime consumers and dropped it, along with
  `AgentRecord.memoryScopes`. See the amendment in the Boundary
  section above.
- **Inherit memory from the parent agent on `createAgent`.**
  Rejected — the product choice is that new agents start clean. A
  newly-created "research" agent should not see "coding" agent
  history.
- **Cross-agent "search across all my agents" surface.** Explicit
  non-goal for this phase. Agents are isolated personas; if the user
  wants a unified view, that is a future feature with its own UI and
  ranking story.

## Acceptance Checks

- Recall with two agents and overlapping content returns disjoint
  results.
- `createAgent` yields an empty memory pool for the new agent.
- Switching agents returns different units from recall on the same
  query.
- Pre-migration data is bucketed under the active agent at migration
  time.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are
  green.

## Critical Files

- `src/state/memory-db.ts` — schema bump, `agent_id` columns and
  indexes, `bankIdForAgent`, `ensureAgentBank`,
  `listMemoryUnits` filter.
- `src/memory/recall.ts` — `RecallInput.agentId` required; all four
  channels filter on `agent_id`.
- `src/memory/retain.ts`, `src/memory/reflect.ts` — required
  `agentId`; stamp on write.
- `src/memory/legacy.ts`, `src/agent.ts` — legacy `MemoryRecord`
  flows resolve and stamp the active agent.
- `src/state/store.ts` — `migrateMemoryAgentId` and
  `migrateHindsightAgentIdColumns` in `normalizeState`.
- `src/capabilities/agents.ts` — `createAgent` calls
  `ensureAgentBank`.
- `src/execution/effective-context.ts` — `memoryNamespace` surfaced
  alongside `agentId`.
- `src/http.ts` — `/api/memory*` routes filter by active agent and
  reject when no agent is active for recall/retain/reflect.
