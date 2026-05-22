# ADR: Identity-File Long-Horizon Design

- **Status:** Accepted
- **Date:** 2026-05-22
- **See also:** [Runtime Identity Files](./runtime-identity-files.md)

## Decision

The three identity files (`INSTRUCTIONS.md`, `USER.md`, `SOUL.md`) are designed to stay clean across thousands of edits without operator babysitting. This ADR captures the design choices that make that possible: char budget visibility, section convention, history snapshots, and the deliberate departures from comparable systems.

Concrete artifacts on disk:

| Decision | Realization |
|---|---|
| Soft size cap visible to the model | Each USER.md / SOUL.md block in the system prompt rides under a one-line `USER profile (N / 1500 chars, X%):` header |
| H2 section convention | INSTRUCTIONS.md and the tool descriptions name `## Identity` / `## Preferences` / `## Background` / `## Goals` for USER.md and `## Voice` / `## Style` / `## Boundaries` for SOUL.md |
| Per-write history snapshots | Every approved write copies the previous body to `<file>.history/<ISO>.md`; retention capped at 50 snapshots per file |
| Set over append | The tool spec and INSTRUCTIONS.md tell the model to prefer `action: "set"` over `action: "append"` |

## Context

Before this work, the identity-file surface had four observable gaps over a long horizon:

1. **Drift.** A model that re-appends similar facts ("Name: Alex" landed three different ways) accumulated near-duplicates.
2. **Unbounded growth.** USER.md and SOUL.md had no size budget. A noisy auto-write loop could grow either file until the system prompt was dominated by stale context.
3. **No rollback.** The propose-vs-approve gate caught hostile writes but did nothing for the more common failure: a benign-but-over-eager edit that the user wanted to undo.
4. **Imperative phrasing.** Letting the model write "Always be terse" into USER.md poisoned the next session — that line is re-read as a directive and can override the user's current request.

Two comparable systems shaped the design space:

- **Hermes** uses `§` entry delimiters inside its MEMORY.md and a `replace`-style surgical substring edit operation. It silently truncates content over its budget.
- **OpenClaw** documents a similar three-file shape (`SOUL.md`, `USER.md`, `MEMORY.md`) but does not address the long-horizon hygiene of those files in product.

Gini deliberately departs from Hermes on three points:

- **Markdown H2 sections, NOT `§` entry delimiters.** Markdown is the file format; H2 headers (`## Identity`) are natively structured and human-readable. The user can open the file in any editor and see the structure. `§` requires special tooling to read.
- **`set` over `replace`.** The model sees the current file in the system prompt every turn, so a full rewrite is cheap. `replace` (surgical substring edit) was a fit for a model that couldn't see the file; with full visibility the model produces cleaner output by re-emitting the consolidated body.
- **Soft cap with budget visibility, NOT hard truncation.** Hard truncation is hostile UX — the user reads and writes these files by hand. We render the budget in the prompt block header (`N / 1500 chars, X%`) so the model can see how full the file is and consolidate proactively. Over-cap content keeps riding into the prompt; the header just shifts to "over cap — please consolidate" and a trace event fires.

## Required Now

### Char budget visibility

`src/system-prompt.ts` exports `USER_SOFT_CAP_CHARS = 1500`, `SOUL_SOFT_CAP_CHARS = 1500`, and `identityBudgetState(content, cap)` which returns `{ used, cap, pct, overCap, nearCap }`. `buildAgentSystemContext` wraps non-BLOCKED USER.md and SOUL.md content with a budget header:

```
USER profile (412 / 1500 chars, 27%):
<content>
```

Three regions:

- `used < 80% × cap` → bare header `(N / 1500 chars, X%)`.
- `80% ≤ used ≤ 100%` → header gains ` — near cap, consolidate`.
- `used > 100%` → header reads ` — over cap, please consolidate`. The full content still rides in (no truncation). The chat-task loop emits an `identity file budget exceeded` trace event so operators can see the model is sailing past the budget.

BLOCKED notices skip the header — they're a safety message, not file content, and a budget percentage on them would be nonsense.

### Section convention

INSTRUCTIONS.md, the `edit_user_profile` tool description, and the `edit_soul` tool description tell the model to maintain:

- USER.md under `## Identity` / `## Preferences` / `## Background` / `## Goals`.
- SOUL.md under `## Voice` / `## Style` / `## Boundaries`.

The convention is encouraged, not enforced. The runtime does not parse the file structure; if the model emits an unsectioned body the file still works. The headers exist to make consolidation natural — the model rewriting the file under `set` can place a new fact under the right section without inventing a structure ad hoc.

### History snapshots

`src/runtime/identity-files.ts` snapshots the previous body to `<file>.history/<ISO-timestamp>.md` before every approved write. Covered paths:

- `writeUserProfile` / `writeSoul` with `status: "approved"`.
- `approveUserProfile` / `approveSoul` (proposed → approved promotion).
- `removeUserProfileSection` / `removeSoulSection` with `status: "approved"`.

`HISTORY_MAX_SNAPSHOTS = 50` per file. After each write, the directory is sorted by mtime descending and anything beyond index 50 is unlinked. Filenames are ISO-8601 with colons replaced by dashes; a `-N` suffix is appended when two writes land in the same millisecond.

Best-effort: a filesystem failure during snapshot creation audits via `appendLog` and lets the write proceed. The snapshot exists for human recovery, not for system correctness — the active file is always the source of truth.

`listUserProfileHistory` / `listSoulHistory` enumerate the entries; `restoreUserProfileFromHistory` / `restoreSoulFromHistory` accept a snapshot name (basename, must end in `.md`, no path traversal) and atomically restore the body. The restore path snapshots the pre-restore body first so the rollback is itself reversible.

### Declarative phrasing rule

INSTRUCTIONS.md and the tool descriptions tell the model:

> Write USER.md entries as facts ABOUT the user, not as directives to yourself. "User prefers TypeScript" ✓ — "Always use TypeScript" ✗. Imperative phrasing in USER.md and SOUL.md gets re-read as a system directive next session and can override the user's current request.

The same shape applies to SOUL.md ("Voice is terse" ✓ — "Always be terse" ✗).

### SKIP list

INSTRUCTIONS.md and the `edit_user_profile` tool description tell the model:

> DO NOT save to USER.md: task progress, PR/issue/commit IDs, completed-work logs, file counts, anything that will be stale in a week. Those belong in long-term memory (auto-retain handles them silently).

This is the partition documented in [runtime-identity-files.md](./runtime-identity-files.md): USER.md is always-inject identity; everything else is Hindsight's job.

### USER vs SOUL partition

The earlier instructions and the two tool descriptions were quietly contradictory on the USER / SOUL split: INSTRUCTIONS.md listed "communication" under USER preferences AND the SOUL rules listed imperative communication preferences ("be more concise", "always end replies with Y") as SOUL triggers. The result was that the model would routinely misclassify "I prefer concise replies" or "no pleasantries" as SOUL persona signals and either route them to `edit_soul` (gated proposals) or write them as imperative directives that re-read as system rules next session. This section sharpens the partition stated in [runtime-identity-files.md](./runtime-identity-files.md):

- **USER.md is about the user.** Subject = I / the user. Two kinds of content:
  - **Facts:** name, role, location, employer, languages, family.
  - **Preferences:** how the user wants to be communicated with — "prefers concise replies", "no pleasantries", "use bullet points", "wants detailed technical explanations", "terse vs verbose", response length, formality.
- **SOUL.md is about the agent.** Subject = you / the agent. Persona / character / identity assignment by the user. Examples: "You are Athena, a research assistant"; "Act as a stoic critic with strong opinions"; "You're a sardonic, witty assistant who doesn't hedge"; "Speak like a pirate". The agent's *voice* is fundamentally shaped.
- **Imperative phrasing is not the discriminator.** Even when the user writes the imperative form ("be more concise"), if it's a preference about how the user wants replies it routes to USER.md. SOUL.md fires only when the user is explicitly sculpting WHO the agent IS, not WHAT TO DO for them.
- **Default to USER.md when unclear.** SOUL.md is a deliberate opt-in; the test in INSTRUCTIONS.md and the tool descriptions reads "When in doubt, default to `edit_user_profile`".

## Boundary

- **Soft cap is not enforced.** The model can let either file grow past 1500 chars. The runtime never truncates — that would lose human-edited content. The cap is a guideline rendered in the header; the worst case is the model sees `over cap — please consolidate` and either chooses to consolidate on the next write or not.
- **Section convention is not parsed.** The runtime does not lift sections out of USER.md or render them differently. The H2 convention exists purely so the model has a stable mental model for consolidation; the file is plain markdown that the user owns.
- **History snapshots are per-file, not per-instance.** USER.md history lives at `~/.gini/instances/<inst>/USER.md.history/`; SOUL.md history at `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md.history/`. Each kind has its own retention budget. Deleting the active file does not delete the history — the user can `rm USER.md` and roll back to a previous body via `gini identity rollback user <snapshot>`.
- **Rollback emits an audit row.** `identity.user_profile.rollback` / `identity.soul.rollback` events record the source snapshot name, the bytes restored, and the pre-rollback snapshot path. The user can chain audits to reconstruct edit history if they need to.
- **Distillation is deferred.** A future ADR may introduce LLM-mediated distillation — periodically rewriting USER.md / SOUL.md into a compact canonical form. We did not ship that now because (a) the soft cap + budget visibility already nudges the model toward consolidation on every write, and (b) a distillation pass adds a new model invocation with attendant cost and failure modes. We'd want to see real long-horizon data (months of usage, hundreds of writes) before paying that complexity.

## Read and Write Semantics

- **Read (system-prompt assembly):** unchanged from [runtime-identity-files.md](./runtime-identity-files.md). The new code path wraps the loaded body in the budget header before splicing.
- **Write (any approved path):** snapshot first, then `writeFileSafe` (write-and-rename). Snapshot failure does not block the write.
- **Promote (propose → approved):** snapshot the pre-approval body first, then `renameSync` the proposal over the approved target.
- **Restore (rollback):** read the snapshot, snapshot the pre-restore body (so the rollback is itself reversible), then `writeFileSafe` over the active file.

## Consequences

- **Identity files stay clean over thousands of edits.** The model sees its budget every turn and the prompt format steers it toward `set`-with-consolidation rather than `append`-with-accumulation.
- **Operators can recover from a regrettable edit.** `gini identity history user` shows what was there before; `gini identity rollback user <name>` restores it. The audit trail records both directions.
- **One more on-disk artifact per file.** `<file>.history/` directories grow up to 50 entries per file. With typical 1-2 KB bodies that's under 100 KB per file per instance — bounded.
- **Departure from Hermes is intentional.** A reader coming from Hermes will not find `§` delimiters, `replace`-style surgical edits, or silent truncation. The design choices above are why.

## Alternatives Considered

- **Hard truncation at the cap.** Rejected. The user reads these files by hand. Silently truncating their own edited body when the model overflows the cap is hostile UX. The model can be steered with prompt; the human cannot be steered when the file just disappears.
- **`§` entry delimiters instead of H2 sections.** Rejected. Markdown is the file format; H2 sits inside markdown natively. `§` would force readers to learn a custom syntax.
- **`replace`-style surgical edit instead of `set`.** Rejected. The model sees the current body in the prompt; rewriting the consolidated body is cheap and produces cleaner output than substring fiddling.
- **Distill the file periodically via a background model call.** Deferred (see Boundary above). We want long-horizon usage data first.
- **Cap-aware writes that block the write when over budget.** Rejected. Same reason as hard truncation — the user gets locked out of their own file when an automated path overshoots, and the user has no recourse if they actually want a long file.

## Acceptance Checks

- A USER.md with 412 chars rides into the system prompt under `USER profile (412 / 1500 chars, 27%):`. Same shape for SOUL.md with the `SOUL persona` label.
- A USER.md with 1300 chars renders `USER profile (1300 / 1500 chars, 87% — near cap, consolidate):`.
- A USER.md with 1600 chars renders `USER profile (1600 / 1500 chars, 107% — over cap, please consolidate):` and the full 1600 chars are present in the assembled prompt (no truncation). The chat-task loop emits an `identity file budget exceeded` trace event.
- A BLOCKED USER.md notice rides into the system prompt as-is, with no budget header above it.
- An approved write to USER.md drops the previous body into `~/.gini/instances/<inst>/USER.md.history/<ISO>.md`. The first write of an instance does NOT create a snapshot (nothing to roll back to).
- After 51 approved writes, the history dir holds exactly 50 entries and the oldest was unlinked.
- `gini identity show` returns INSTRUCTIONS.md, USER.md, and per-agent SOUL.md with budget metadata.
- `gini identity history user` lists snapshot names newest-first.
- `gini identity rollback user <name>` restores the named body, creates a fresh pre-rollback snapshot, and emits an `identity.user_profile.rollback` audit row.
- A rollback against a non-existent snapshot name returns `{ ok: false, reason: "no snapshot" }` and does not touch the active file.

## Critical Files

- `src/system-prompt.ts` — `USER_SOFT_CAP_CHARS`, `SOUL_SOFT_CAP_CHARS`, `identityBudgetState`, `renderUserProfileBlock`, `renderSoulBlock`, `buildAgentSystemContext`.
- `src/runtime/identity-files.ts` — `snapshotIdentityFile`, `pruneSnapshotHistory`, `listUserProfileHistory`, `listSoulHistory`, `restoreUserProfileFromHistory`, `restoreSoulFromHistory`, `HISTORY_MAX_SNAPSHOTS`.
- `src/runtime/defaults/INSTRUCTIONS.md` — declarative phrasing rule, SKIP list, section convention, set-over-append, budget awareness.
- `src/execution/tool-catalog.ts` — `edit_user_profile` and `edit_soul` tool descriptions advertise the section convention and the soft cap.
- `src/execution/chat-task.ts` — emits `identity file budget exceeded` trace when files go over cap.
- `src/http.ts` — `/api/identity-files` (show), `/api/identity-files/history` (list), `/api/identity-files/rollback` (restore).
- `src/cli/commands/identity.ts` — `gini identity show|history|rollback`.
- `~/.gini/instances/<inst>/USER.md.history/`, `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md.history/` — on-disk artifacts.
