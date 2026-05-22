# ADR: Memory Surface Consolidation

- **Status:** Accepted
- **Date:** 2026-05-21
- **See also:** [Runtime Identity Files](./runtime-identity-files.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Gini exposes three memory surfaces, no fourth:

| Surface | Mechanism | Scope | Always inject? | Edit path |
|---|---|---|---|---|
| User identity | `USER.md` | instance (cross-agent) | yes | `edit_user_profile` (auto-approved when injection scan passes) |
| Agent persona | `SOUL.md` | per-agent | yes | `edit_soul` (propose → approve) |
| Everything else | Hindsight units | per-agent bank | only on recall hit | auto-retain at task end; `recall_memory` on demand |

`state.memories`, `add_memory`, `update_memory`, the `/api/memory` CRUD routes, the `gini memory list|add|approve|reject` CLI subcommands, and the "Pinned memories about this user" system-prompt block are removed.

A one-shot migration runs at instance startup: every active row in `state.memories` is appended into `USER.md` under a `<!-- migrated from pinned memories on <date> -->` header, the field is cleared, and a `state.migrations.statePinnedToUserMd` marker prevents re-runs.

## Context

The runtime previously carried four overlapping memory paths:

1. **`state.memories`** (JSON, per-agent, pinned-on-approval) — rendered as a "Pinned memories about this user" block every turn.
2. **Hindsight units** (SQLite, per-agent bank, retrieval-on-demand) — auto-retained at task end, recalled by embedding similarity.
3. **`USER.md`** (instance-scoped markdown, always-inject) — shipped on the parent branch as the cross-agent user-identity surface.
4. **`SOUL.md`** (per-agent markdown, always-inject) — shipped on the parent branch as the per-agent persona surface.

The trigger for consolidation was a real bug. The user told the model "my name is Shelden". The model replied "I proposed remembering your name for future chats" but `toolCalls: 0` in the trace — it claimed a side effect it had not performed. Diagnostic check of the Hindsight bank confirmed auto-retain HAD extracted "user's name is Shelden" into three five-W units; persistence already worked via Hindsight without any tool call.

The genuine niches collapsed to three:

- **Always inject + user identity** → `USER.md` already exists.
- **Always inject + agent voice** → `SOUL.md` already exists.
- **Everything else worth remembering** → Hindsight auto-retain already runs at task end and recall surfaces facts when the user asks.

`state.memories` no longer fills a niche the other three don't already cover. Keeping it forced the model to choose between `add_memory` and `edit_user_profile` for the same shape of fact, and the wrong choice (per-agent `state.memories` vs cross-agent `USER.md`) silently lost cross-agent identity.

## Required Now

- `RuntimeState.memories` and the `MemoryRecord` type are removed. `normalizeState` defensively drops the field on load so existing instances clear their persisted array on first read after the migration runs.
- `src/memory/legacy.ts` is removed. Its CRUD helpers (`createMemoryFromInput`, `updateMemory`, `editMemory`, `archiveMemory`) all targeted `state.memories` and have no remaining consumers.
- `src/memory/migrate-pinned-to-user-md.ts` (new) owns the one-shot migration. Exposes `migratePinnedMemoriesToUserProfile(instance)` which:
  1. Reads `state.memories`, filters to status `active`, deduplicates by content.
  2. Appends `<!-- migrated from pinned memories on <ISO date> -->\n- <content>\n- ...` under any existing `USER.md` body.
  3. Sets `state.migrations.statePinnedToUserMd = <ISO timestamp>` and clears `state.memories`.
  4. Emits one audit per migrated memory plus a summary audit. Best-effort: filesystem or read failures audit + continue; never crash startup.
  5. Idempotent via the marker — a second call is a no-op.
- `src/runtime/index.ts::install()` calls the migration AFTER `scaffoldInstanceIdentityFiles` (which materializes the zero-byte `USER.md` placeholder) and BEFORE the per-agent SOUL.md backfill loop. The order matters: the migration appends to `USER.md`, so the file must exist before the append runs.
- `add_memory` and `update_memory` are dropped from the tool catalog. `recall_memory` stays — it queries Hindsight, not `state.memories`.
- `buildAgentSystemContext` no longer takes a `memories` parameter and no longer renders the "Pinned memories about this user" block. Call sites in `src/provider.ts::generateTaskSummary` and `src/execution/chat-task.ts` drop the parameter. The legacy provider path also drops the `Active memory: ...` echo-mode debug suffix.
- `POST /api/memory`, `GET /api/memory`, `POST /api/memory/<id>/approve`, `POST /api/memory/<id>/reject`, `PATCH /api/memory/<id>`, and `DELETE /api/memory/<id>` are removed. The Hindsight surfaces (`/api/memory/retain`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`, `/api/embedding/*`, `/api/reranker/*`) stay; they were always Hindsight-only and never touched `state.memories`.
- `POST /api/identity-files/user/approve` is removed. `edit_user_profile` is now auto-approved — its body is written directly to `USER.md` after the injection scan passes, with no `.proposed` step. `POST /api/identity-files/soul/approve` stays — `edit_soul` keeps the propose-vs-approve gate because persona edits change agent behavior across the lifetime of the agent.
- `gini memory list|add|approve|reject|edit|archive|delete` subcommands are removed. The Hindsight subcommands (`retain`, `recall`, `reflect`, `units`, `bank`, `migrate`) stay. The CLI `--help` block drops the line.
- `src/runtime/defaults/INSTRUCTIONS.md` is rewritten with explicit guidance: identity facts → `edit_user_profile` (auto-approved, don't ask permission, don't narrate); persona signals → `edit_soul` (proposes for user approval); anything else worth remembering → just respond, auto-retain handles persistence; never claim a side effect not performed.

## Boundary

- **Auto-approve asymmetry between USER and SOUL.** `edit_user_profile` writes directly to the approved file because USER.md content is the user's own facts about themselves, the file is bounded and human-readable, and the injection scan still gates content that trips a threat pattern. `edit_soul` keeps the proposed-vs-approved split because persona edits ("act as a hard-edged critic") materially change agent behavior across every turn. The blast radius of a bad SOUL.md edit justifies a second pair of eyes; a bad USER.md edit costs the user one click to revert.
- **Migration content loss.** `state.memories` was per-agent. `USER.md` is instance-scoped. The migration collapses the union of all agents' active memories into a single instance-scoped file. The original per-agent scoping is lost — but pinned identity facts SHOULD have been cross-agent in the first place, which is the whole reason this consolidation exists. Proposed and rejected/archived rows are not migrated.
- **Migration is best-effort.** A filesystem error during the migration audits the failure via `appendLog` and lets the runtime continue. A failed migration leaves the marker UNSET so the next startup retries. Idempotent because the marker is only set on a successful write.
- **`state.memories` field stays in the on-disk shape until cleared.** Legacy state files written before this change still carry the array. The migration clears it and `normalizeState` drops any future occurrence — but a state file that never sees a write after the migration retains the field as an empty array. That's fine; the type is removed but the JSON shape is forward-compatible.
- **Hindsight is unchanged.** Auto-retain (`scheduleAutoRetain` in `src/agent.ts`), recall, reflect, and the per-agent bank topology are all untouched. The `recall_memory` tool still queries the active agent's bank.

## Read and Write Semantics

- **Migration trigger:** `install()` runs on every startup. The migration's first action is checking `state.migrations?.statePinnedToUserMd`. When set, it returns immediately with a `report.skipped = true` flag. When unset, it walks `state.memories`, appends to `USER.md`, clears the array, and sets the marker.
- **`edit_user_profile` write (set / append):** the tool writes the new body directly to `USER.md` via `writeUserProfile(instance, body, "approved")`. The injection scan runs on the new body — when it flags threats, the scan result still rides on the audit row + the tool-result string so the operator sees it (same fail-soft posture as before, just with no `.proposed` intermediate).
- **`edit_user_profile` audit row:** still `identity.user_profile.proposed` with `actor: "agent"` to match the SOUL flow's vocabulary. Evidence carries `scanFindings`. A subsequent system-attributed `identity.user_profile.approved` audit is emitted in the same `mutateState` block to record the auto-approval.
- **`edit_soul` is unchanged.** Writes to `SOUL.md.proposed`; the approval API renames over `SOUL.md` after a `POST /api/identity-files/soul/approve`.

## Consequences

- **One fewer surface area for the model to disambiguate.** The model previously chose between `add_memory` (per-agent pinned) and `edit_user_profile` (cross-agent always-inject) for the same shape of fact. Now only the latter exists.
- **Smaller system prompt.** The "Pinned memories about this user" block is gone from every turn. Identity facts live in `USER.md` (always-inject) and recalled-from-Hindsight (per query). Total token spend on memory drops.
- **`edit_user_profile` becomes a low-friction write.** "My name is X" produces a tool call that lands the fact in `USER.md` with no approval modal. The user reads the file any time they want; the injection scan still gates hostile content.
- **One fewer migration path to maintain.** The legacy `migrateLegacyMemories` helper (Hindsight phase 6) stays because old instances may still carry archived `state.memories` rows that survived the new migration. After the new migration clears `state.memories`, the legacy helper is a no-op.
- **API surface shrinks.** Six HTTP routes and ten CLI subcommands are removed. Clients that talked to `/api/memory` for pinned-memory CRUD must move to `edit_user_profile` (auto-approved write) or accept that auto-retain handles long-term memory.

## Alternatives Considered

- **Keep `state.memories` but never render the block.** Rejected. The CRUD surface, the API routes, and the CLI subcommands would all stay alive — a dead surface area the model could still discover and call.
- **Migrate `state.memories` into Hindsight instead of `USER.md`.** Rejected. Hindsight rows are per-agent and recall-on-demand; pinned-memory rows were always-inject by definition. Collapsing them into Hindsight would silently change the inject-cadence of every migrated fact.
- **Keep auto-approve symmetric (both SOUL and USER auto-approved).** Rejected. SOUL.md edits materially change agent behavior across the lifetime of the agent ("act as a hard-edged critic" reshapes every reply). USER.md edits add a fact about the user; the failure mode is "the model knows one extra true thing about you", which is bounded. The asymmetry maps to the blast radius.

## Acceptance Checks

- A fresh instance with no `state.memories` runs the migration as a no-op and sets the marker. Subsequent startups skip the migration entirely.
- An instance with two active `state.memories` rows produces a `USER.md` whose body ends with the migration header followed by both contents as bullets, has `state.memories` cleared to `[]`, and has the marker set. A second startup is a no-op.
- A failed migration (e.g. unwritable `USER.md`) leaves `state.memories` intact, the marker UNSET, and audits the failure via the runtime trace. The next startup retries.
- The system prompt built by `buildAgentSystemContext` no longer contains the string "Pinned memories about this user".
- The tool catalog returned by `buildToolCatalog` does not contain `add_memory` or `update_memory` at any toolset state.
- `POST /api/memory` returns 404. `POST /api/identity-files/user/approve` returns 404. `POST /api/identity-files/soul/approve` still returns 200.
- `gini memory add ...` exits with a usage error (subcommand unrecognized). `gini memory recall ...` still works.
- `edit_user_profile` with a clean body lands directly at the approved path; no `.proposed` sibling is created. The same call with a body that trips the injection scan still lands at the approved path (the scan is recorded but does not block — same posture as before).
- `edit_soul` still writes to `SOUL.md.proposed` and requires `POST /api/identity-files/soul/approve`.
