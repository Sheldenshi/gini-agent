# ADR 0005: Subagent Delegation

> **Note (2026-05-13):** Subagent toolset filtering now intersects with
> the parent **agent's** toolsets (not the global enabled set) before
> the subagent's own `toolsetIds` narrows further. Provider and memory
> namespace inherit from the parent agent. See ADR 0006 and ADR 0007.

## Decision

Subagents are constrained child tasks running through the same chat-task
agent loop as their parents, with three knobs the parent can tune:

1. **System prompt override.** The subagent runs with its own system
   instructions instead of the default Gini preamble.
2. **Toolset whitelist.** The chat-task loop's tool catalog is filtered
   down to a parent-supplied subset of toolsets. `read_skill`,
   `web_fetch`, and `spawn_subagent` itself stay always-on.
3. **Skill whitelist.** The "Available skills:" block in the system
   prompt is filtered down to a parent-supplied subset of trusted
   skill names.

The model spawns subagents through a `spawn_subagent` tool. The
dispatch creates a `SubagentRecord`, submits a chat-mode child task,
and awaits the child's terminal state before returning the summary
back as the tool result. Depth caps at 3 (parent → child →
grandchild → great-grandchild is rejected).

## Context

Hermes-style "delegation" lets a parent agent fan out a focused
sub-task to a constrained child agent and collect its result. Slice 4
of the parity plan (after the agent loop and skill loader landed)
required a real subagent runtime. The pre-Slice-4 `spawnSubagent`
just submitted a generic task — no separate prompt, no toolset cap,
no skill cap, and no real "agent loop" running for the child.

The decision was to reuse the chat-task agent loop unchanged for the
subagent and inject the constraints at the boundaries — a single
SubagentRecord lookup at loop entry filters the catalog and
overrides the system prompt. That keeps the runtime surface small
(no separate "subagent loop" code path) and gives subagents tool
calling, approvals, audit, and trace records for free.

## Required Now

- `SubagentRecord` carries `systemPrompt` (always present),
  `toolsetIds?`, `skillNames?`, and result mirrors
  (`resultSummary?`, `resultError?`). A migration default in
  `normalizeState` backfills `systemPrompt = ""` for legacy rows.
- `spawnSubagent` (in `src/capabilities/subagents.ts`) creates the
  record, submits a chat-mode child task with `parentTaskId` and
  `subagentId` set, and links the task back to the record. Default
  system prompt is a generic "focused subagent" preamble.
- `runChatTask` looks up the SubagentRecord for the running task via
  `getSubagentForTask`. If present, the subagent's `systemPrompt`
  replaces `buildAgentSystemContext` output, the trusted-skills block
  is filtered by `skillNames`, and the tool catalog is filtered by
  `toolsetIds`.
- A `spawn_subagent` tool is added to the catalog (always-on) with
  args `{ name, prompt, system_prompt?, toolsets?, skills?,
  timeout_ms? }`. The dispatch:
  - pre-flights the depth cap and rejects with
    `max_subagent_depth_exceeded` when the parent chain is at depth ≥ 3,
  - writes a medium-risk audit (`subagent.spawn`) and a trace,
  - calls `spawnSubagent`,
  - polls `waitForSubagentTerminal` until the child reaches
    completed/failed/cancelled, the timeout elapses, or the parent
    task itself transitions to cancelled,
  - returns a JSON-shaped string `{ subagentId, status, summary, error }`
    as the tool result the model sees on the next iteration.
- Cancellation cascades. `cancelTask` walks descendants by
  `parentTaskId` and cancels each in-flight child. The chat-task loop
  checks task status at the top of each iteration and bails out on
  cancellation so a cascade-cancel doesn't keep running model calls
  against a dead task.
- `syncSubagentFromTask` mirrors a child task's terminal state onto
  the SubagentRecord (`resultSummary`, `resultError`) so the parent's
  polling loop can read the result without joining against the task
  table.
- HTTP routes:
  - `GET /api/subagents` (existing) returns the new fields
    additively — old consumers keep working.
  - `POST /api/subagents` accepts the new payload shape
    (`{ name, prompt, systemPrompt?, toolsets?, skills?,
    parentTaskId? }`) and the legacy shape (`{ name, prompt,
    toolsets? }`).
  - `POST /api/subagents/<id>/cancel` cancels the underlying child
    task.

## Deferred

- Governance for budget/depth caps (e.g. per-subagent token caps,
  per-conversation total caps). The PoC uses a single `MAX_SUBAGENT_DEPTH`
  constant.
- Approval gating on `spawn_subagent`. Today it's medium-risk but
  bypasses approval — the audit record is the only record. A future
  pass may require approval for high-fanout subagent strategies.
- Live event streaming from subagent → parent. Today the parent
  polls the SubagentRecord via `waitForSubagentTerminal`. A future
  pass could surface child trace events to the parent loop's
  `currentStep` for richer "what is the subagent doing right now"
  visibility.
- Web UI for subagents (a `/subagents` page with list + detail).

## Consequences For Coding Agents

- New constraints on a SubagentRecord must be applied at the loop
  boundary, not inside individual tools. Add the field to
  `SubagentRecord`, populate it in `spawnSubagent`, and consume it
  in `runChatTask` (system-prompt build) or `runLoop` (catalog
  filter).
- Long-running tools that the parent dispatch awaits (today only
  `spawn_subagent`) must check parent task status periodically.
  Otherwise a cancel-cascade will hang the parent.
- New code that ends the chat-task loop (cancellation, error,
  completion) must call `syncSubagentFromTask`. Without it the
  SubagentRecord will lag the task and the parent's
  `waitForSubagentTerminal` poll will spin until timeout.

## Acceptance Checks

- A chat task that calls `spawn_subagent` with `name`, `prompt`,
  `system_prompt`, `toolsets`, and `skills` produces a
  SubagentRecord with those fields, a chat-mode child task linked
  via `parentTaskId` and `subagentId`, and a medium-risk
  `subagent.spawn` audit row.
- Spawning past depth 3 returns a `max_subagent_depth_exceeded`
  error to the model and creates no new SubagentRecord.
- Cancelling a parent task cascades to in-flight subagent child
  tasks; both reach status `cancelled` after the cascade settles.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are
  green.
