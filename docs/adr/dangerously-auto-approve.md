# ADR: dangerouslyAutoApprove — sanctioned approval-bypass mode

## Decision

Add an opt-in per-instance flag, `RuntimeConfig.dangerouslyAutoApprove`,
that bypasses the human approval gate for every approval-gated tool
served by the chat-task dispatcher (`file_write`, `file_patch`,
`terminal_exec`, `code_exec`, `browser_upload_file`) and the legacy
imperative dispatch (`gini task submit "write …"`, `POST /api/tasks`).
The default is `false`. When the flag is `true`:

1. The dispatcher still creates the approval row and writes the
   `approval.requested` audit row (so the trail is identical for
   reviewers).
2. The runtime then immediately calls `agent.resolveApproval` with
   `actor: "runtime"`, marking the approval `approved` and writing an
   `approval.approved` audit row with
   `evidence.autoApproved=true, evidence.autoApprovedReason="dangerouslyAutoApprove"`.
3. The same `executeApprovedAction` path that human approvals take runs
   the side effect and emits the per-action audit row, also stamped
   with the auto-approve markers.
4. If the side effect itself throws, the runtime raises an
   `ApprovedActionFailedError`; the chat-task loop's generic dispatch
   try/catch lets that error escape so the owning task is failed
   instead of letting the model receive `Error: …` as a recoverable
   tool result.

The flag is wired through:

- `GET /api/settings/auto-approve` (returns `{ patterns, dangerouslyAutoApprove }`).
- `PATCH /api/settings/auto-approve` (accepts either or both fields).
- Persists to `~/.gini/instances/<instance>/config.json`.

## Context

`RuntimeConfig.autoApproveCommands` already lets users skip the human
gate for specific `terminal_exec` patterns. That mechanism is too
narrow for a trusted local dev loop where the operator wants every
file write and shell command the agent issues to fire without prompts.

ADR trust-substrate.md and ADR agent-loop-tool-calling.md both describe
approvals as *the* path to side effects. We did not want to weaken
those invariants by allowing the model to bypass them — the bypass has
to be (a) an explicit operator configuration choice, (b) auditable
exactly like a normal approval, and (c) localized so future tools that
land approval gates inherit the bypass uniformly.

A first attempt duplicated the side-effect, audit, and approval-row
logic into per-tool helpers inside the dispatcher. Codex review caught
that the duplication had drifted (the code_exec auto-helper was
silently skipping approval-row creation). The shipped version
refactors `agent.executeApprovedAction` to return its result string,
adds a wrapper `agent.resolveApproval` that handles approval status +
audit + side effect, and reduces the dispatcher to a single
`pendingOrAuto(config, request)` helper that either pauses for the
human gate or routes through the same shared path.

## Required Now

- `RuntimeConfig.dangerouslyAutoApprove?: boolean` field on the per-
  instance config object, persisted with `updateAutoApproveSettings`.
- `agent.resolveApproval(config, approvalId, { actor, resumeChatTask,
  evidenceExtra })` is exported. It marks the approval approved,
  audits the approval.approved event with the supplied
  `AutoApproveMarkers` (`autoApproved`, `autoApprovedReason`), and
  calls `executeApprovedAction` which returns the per-action result
  string the dispatcher feeds back to the model.
- `decideApproval` becomes a thin wrapper around `resolveApproval` for
  the approve case. The deny case is unchanged in shape but its
  internal `mutateState` now folds the `task.failed` transition in
  atomically (closing a sibling-deny race the refactor surfaced).
- `tool-dispatch.pendingOrAuto(config, request)` wraps every
  approval-gated dispatch. When the flag is on it catches
  side-effect errors and re-throws them as
  `ApprovedActionFailedError`; the chat-task loop's tool dispatch
  re-throws that class instead of swallowing it as a recoverable tool
  result.
- `resolveApproval` distinguishes race-loss from side-effect failure
  by throwing `ApprovalRaceLostError` when the approval is no longer
  pending (a concurrent caller decided it first). `pendingOrAuto`
  and the imperative auto-resolve path catch that class, do NOT
  write `approval.approved` or a per-action audit row (the other
  caller owns those writes), and return a benign sync tool result.
  The chat-task loop's terminal-status bail-out then observes the
  task state the other caller transitioned to and exits the loop
  without overwriting it.
- The imperative dispatch path in `runTask` checks the flag after each
  `request*` tool returns and resolves the freshly-created approval
  inline so the same bypass applies to `POST /api/tasks` /
  `gini task submit`.
- `file_write` and `file_patch` use the
  `assertInsideWorkspaceNoSymlinkEscape` variant (realpath check of
  the deepest existing ancestor) so a workspace-internal symlink
  pointing outside cannot redirect bytes outside the workspace under
  the bypass.

## Deferred

- UI surface for toggling the flag from `/settings`. Today the flag
  is set via `PATCH /api/settings/auto-approve` or by editing
  `config.json` directly.
- ~~A more general approval-execution claim/cancellation protocol that
  lets `cancelTask` abort an already-approved async side effect~~ —
  shipped in ADR approval-execution-abort.md. The in-flight registry threads an
  `AbortSignal` through `executeApprovedAction` and `cancelTask`
  fans the abort out to every active executor for the cancelled
  task. The audit trail gains `*_aborted` action names plus an
  `approval.in_flight_aborted` orchestration row.

## Consequences For Coding Agents

- New approval-gated tools added in the future must route through
  `pendingOrAuto` (chat-task) and, if exposed via the imperative
  dispatcher, observe `config.dangerouslyAutoApprove` after creating
  their pending approval. Adding a side effect that creates an
  approval and runs the action itself (instead of going through
  `resolveApproval` → `executeApprovedAction`) would silently bypass
  the audit-marker contract documented above.
- Audit consumers should treat `evidence.autoApproved === true` plus a
  non-empty `evidence.autoApprovedReason` as authoritative "the human
  gate was skipped" markers. The reason string identifies WHY it was
  skipped (`"dangerouslyAutoApprove"`, a `terminal_exec` allowlist
  pattern like `"memo *"`, etc.).
- `evidenceExtra` on `resolveApproval` is typed `AutoApproveMarkers`
  on purpose — runtime-owned canonical evidence fields
  (`beforeBytes`, `exitCode`, `diff`, etc.) must not be overridable
  from the auto-approve call site.

## Acceptance Checks

- A chat-task `file_write` with the flag off produces
  `status: "waiting_approval"` on the task and a single pending
  approval; with the flag on, the task completes with the file on
  disk and the `approval.approved` and `file.write` audit rows carry
  `autoApprovedReason: "dangerouslyAutoApprove"`. The
  `approval.requested` row is stamped by `createApproval` before the
  marker is known and therefore does NOT carry the marker — its
  presence still confirms the approval was created.
- The same applies to `terminal_exec` when no `autoApproveCommands`
  pattern matches; an allowlist match preserves the existing fast
  path with no approval row created.
- An imperative `write foo :: bar` task auto-resolves under the flag
  and pauses without the flag.
- An approved side-effect failure (e.g. `file_write` against a
  directory path) flips the task to `failed` and leaves a visible
  `approval.approved` row without a matching `file.write` audit row,
  rather than allowing the model to mark the task complete.
- An in-workspace symlink that points outside the workspace cannot be
  used to land bytes outside `workspaceRoot` from `file_write` /
  `file_patch`; the throw says `Path escapes workspace via symlink`.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are
  green; `src/execution/dangerously-auto-approve.test.ts` covers the
  flag-on/flag-off matrix for `file_write`, `terminal_exec`
  (allowlist and non-allowlist), the imperative dispatch path, the
  symlink-escape rejection, the side-effect-failure propagation, and
  the direct `resolveApproval` unit shape.

## Per-Job Scope

`RuntimeConfig.dangerouslyAutoApprove` and
`RuntimeConfig.autoApproveCommands` are operator-only global config.
That shape is right for a trusted local dev loop, but it falls down for
scheduled jobs: a `create_job` invocation that the user expects to run
*unattended* (recurring, no human at fire-time) cannot be configured to
auto-approve through chat without first asking the operator to flip a
global switch that affects every other task on the instance. The
job-spawned chat-task hits the first approval gate and stalls in
`waiting_approval` forever.

The refinement: thread the same envelope **per-job** without changing
its shape or semantics.

- `JobRecord` gains two optional fields,
  `autoApproveCommands?: string[]` and
  `dangerouslyAutoApprove?: boolean`. Both default to absent, in which
  case the job-spawned task inherits the current per-instance
  RuntimeConfig behavior (no change for legacy jobs).
- `createScheduledJob` validates both fields with the same shape as
  the operator-side validators (non-empty strings inside the array,
  strict boolean for the flag) and persists them onto the JobRecord.
- `dispatchPromptRun` builds a *cloned* RuntimeConfig via
  `buildTaskConfig`, overlays the job's envelope onto the clone, and
  hands the clone to `submitTask`. The clone — never the original —
  is what the spawned chat-task sees. `dangerouslyAutoApprove=true`
  on the job sets the same flag on the clone; a non-empty
  `autoApproveCommands` is merged onto the cloned array (the
  operator's global allowlist still applies; the per-job opt-in
  widens it for that job's task only).
- The scheduled-run path (`runDueJobs` → `dispatchPromptRun`) and the
  manual / replay paths (`runJobNow` → `dispatchPromptRun`) both go
  through the same `buildTaskConfig` seam, so an operator who clicks
  Run / replays a job tests the same envelope the scheduler will use
  at fire-time.
- `create_job` tool spec exposes `autoApproveCommands`,
  `dangerouslyAutoApprove`, and `timeoutSeconds` to the chat agent.
  The tool description states: "When a scheduled job needs to run
  *unattended*, set `autoApproveCommands` for the commands it will
  need to run, or `dangerouslyAutoApprove: true` for tasks that need
  broad action — otherwise the job will stall at the first approval
  gate forever." The dispatcher validates the envelope before reaching
  `createScheduledJob` so a bad payload returns a typed
  `Invalid input: …` tool-result.
- Audit/trace evidence on the `job.created` row captures the envelope
  the agent chose so a reviewer can answer "what bypass did this job
  schedule for itself?" without replaying the conversation.

### Trust model

The per-job opt-in does NOT widen the system's trust surface — it
shifts the opt-in point from operator config to a chat exchange:

1. The user describes unattended work in natural language ("read the
   docs every morning and open a PR with the cleanup").
2. The chat agent translates intent into the envelope — choosing
   `autoApproveCommands` for narrow opt-in (`"git *"`, `"gh *"`,
   `"rg *"`) and only escalating to `dangerouslyAutoApprove: true`
   when the user explicitly authorizes broad action.
3. The runtime applies the envelope **only** to that job's spawned
   tasks via the cloned config. The operator's global RuntimeConfig is
   never mutated.
4. The same audit contract applies: every auto-approved side effect
   produces an approval row (status="approved") and an action audit
   row, both stamped with `evidence.autoApproved=true` and
   `evidence.autoApprovedReason=<matched pattern>` (for the allowlist
   fast path) or `"dangerouslyAutoApprove"` (for the full bypass).
   The `job.created` audit row also captures which envelope the agent
   scheduled, so the trail shows both the original opt-in and every
   action that fired under it.

### Consequences for coding agents

- New approval-gated tools added in the future continue to inherit the
  bypass via the existing `pendingOrAuto` / allowlist paths in
  `tool-dispatch.ts`. No additional per-job wiring is needed because
  the envelope flows through `RuntimeConfig`, which is what those
  paths already read.
- `buildTaskConfig` MUST NOT mutate its `config` argument. Cloning the
  config (including a fresh array for `autoApproveCommands`) is what
  keeps the operator's global RuntimeConfig isolated from the
  per-job envelope. Failing to clone would silently leak the job's
  bypass into every other task on the instance.
- `src/jobs/auto-approve.test.ts` covers the end-to-end matrix
  (allowlist fast-path, full bypass via `resolveApproval`, default
  behavior preserved without the envelope) plus the validators on the
  persistence layer; `src/jobs.test.ts` adds the equivalent matrix at
  the `create_job` tool-dispatch entry point.
