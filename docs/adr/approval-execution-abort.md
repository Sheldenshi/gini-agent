# ADR: Approval execution abort protocol

## Decision

`cancelTask` propagates an abort signal into every in-flight approved
action so a task that is cancelled mid-execution can stop the side
effect rather than waiting for it to complete. A module-scoped registry
in `src/execution/approval-execution.ts` (`claimApproval` /
`releaseApproval` / `abortApprovalsForTask` / `raceWithAbort`) lets
`agent.executeApprovedAction` register a per-approval `AbortController`
and lets `agent.cancelTask` fire `controller.abort("task.cancelled")`
on every entry that targets the cancelled task.

The claim and the abort both happen INSIDE their callers' `mutateState`
callbacks so they serialize through the per-instance lock. Two
interleavings, both safe:

- (a) `cancelTask`'s mutateState wins → the executor's claim
  mutateState observes `task.status === "cancelled"`, takes the
  existing task-terminal branch (marks the approval cancelled, emits
  the `approval.cancelled_task_terminal` audit row), and returns
  without spawning the side effect or registering with the in-flight
  registry.
- (b) Executor's claim mutateState wins → the executor registers
  itself; `cancelTask`'s subsequent mutateState finds the entry, fires
  `controller.abort`, and emits an `approval.in_flight_aborted` audit
  row listing the aborted approval IDs. The executor reads
  `signal.aborted` at each integration point in the action branch and
  reacts.

Per-action behaviour:

- **`file.write` / `file.patch`** — the abort check, the path
  validation, the actual `writeFileSync`, and the audit-row write
  all live inside the SAME `mutateState` callback so the lock
  serializes the entire sequence with any concurrent `cancelTask` /
  `decideApproval-deny` / `failTask` mutation. Without the
  in-callback ordering, `cancelTask`'s callback could fire abort
  AFTER our `signal.aborted` check but BEFORE the synchronous
  `writeFileSync` and the file would still land on disk. When the
  signal IS aborted at the lock-held check, the executor emits
  `file.write_aborted` / `file.patch_aborted` (same `extraEvidence`
  markers as the normal row plus `aborted: true, abortReason:
  "task.cancelled"`) and skips the write entirely. Path-validation
  throws are also inside the lock so an aborted task with an
  invalid path emits the aborted row instead of bubbling a path
  error up to `failTask`.
- **`terminal.exec`** — the executor races `proc.exited` against the
  abort signal using `Promise.race`. The winner determines the
  audit row name: "aborted" routes through `terminal.exec_aborted`
  with `signal.reason` carrying the abort reason
  (`task.cancelled` / `task.failed` / `sibling.denied`); "exited"
  routes through the regular `terminal.exec`. Promise.race relies
  on microtask ordering directly, so a same-tick "abort fires AND
  `proc.exited` resolves" interleaving is decided deterministically
  by whichever promise settled first (no side-flag indirection).
  When the abort wins, the executor calls `proc.kill()` to SIGTERM
  the immediate child. Process-group teardown is documented as a
  known limitation: Bun's spawn does not expose a `detached` /
  `setsid` option that turns the child into a session leader, so
  `process.kill(-pid, signal)` would target a non-existent or our-
  own process group and is unsafe. For commands that fork detached
  children (`zsh -lc "sleep 30 & wait"`), the grandchildren survive
  the cancel; auditors should treat `terminal.exec_aborted` as
  "the runtime acknowledged the cancel" rather than "the entire
  process tree was reaped." A pre-spawn `signal.aborted` check
  covers the narrow window where the signal fires between the
  claim mutateState and the `spawn()` call, emitting
  `terminal.exec_aborted` with `evidence.spawnSkipped: true`.
- **`browser.upload_file`** — Playwright's `setInputFiles` does not
  accept an `AbortSignal`. The executor calls `raceWithAbort(() =>
  browserUploadFileApproved(...), signal)`. The helper takes a
  LAZY factory so the upload promise is never constructed when the
  signal is already aborted at entry; this closes the security
  window where the upload would otherwise start in the background
  while the audit row already said `_aborted`. When the signal
  fires mid-flight the helper detaches the upload promise
  (`.catch(() => {})` to swallow late rejections) and the executor
  writes a `browser.upload_file_aborted` audit row. The browser
  may still commit the upload as a background side effect when
  the abort fires while the call is in flight; the audit reflects
  what the runtime acknowledged at cancel time, not what the page
  state eventually became.
- **`browser.fill_secret`** — the side effect (per-slot playwright
  fill) runs INSIDE `POST /api/approvals/<id>/connect`, not inside
  `executeApprovedAction`, so the in-flight registry's
  `claimApproval` / `releaseApproval` lifecycle does NOT cover the
  fill loop. See [browser-fill-secret.md](browser-fill-secret.md)
  for the rationale (the secret values are request-scope only and
  can't be threaded through `runApprovedAction`'s signature without
  persisting them). The bounded module
  `src/execution/browser-fill-secrets.ts` substitutes a per-slot
  `readState` task-status check before each `browserFillByLocator`
  call: a `cancelTask` landing after the atomic resolve will be
  observed at the next iteration, the loop bails, and the audit
  row records `aborted: "task-cancelled-mid-fill"`. Playwright's
  `.fill()` itself does not accept an `AbortSignal`, so the
  granularity is "between slot N and slot N+1" rather than the
  per-await granularity that `raceWithAbort` provides for
  `browser.upload_file`.

`cancelTask`, `failTask`, and `decideApproval-deny` each call
`abortApprovalsForTask` from inside their own `mutateState` callback
and emit an `approval.in_flight_aborted` audit row when at least
one abort fires, listing the approval IDs targeted and the reason
(`task.cancelled`, `task.failed`, or `sibling.denied`). Routing the
abort through all three terminal-transition paths closes the
follow-up race codex flagged: a side effect that started under a
won claim race no longer survives a sibling denial or a runtime
failure.

## Errors

Two distinct error classes drive the dispatcher's race-loss handling
in `src/execution/tool-dispatch.ts::pendingOrAuto`. Keeping them
separate makes "I lost the race" and "the task is already terminal"
distinguishable in audit traces and unit tests.

- `ApprovalRaceLostError` — thrown by `resolveApproval` when the
  approval row's status is no longer `pending` at lock time. This is
  the original race-loss class. The dispatcher converts it to a
  `kind: "sync"` skipped tool result with message `Action skipped:
  approval was already <status> by another caller.`
- `TaskAlreadyTerminalError` — thrown by every chat-task request
  helper (`requestFileWrite`, `requestFilePatch`,
  `requestTerminalExec`, `requestCodeExec`, `requestBrowserUpload`)
  when their `mutateState` callback observes
  `isTerminalTaskStatus(item.status)` and refuses to create an
  approval row against an already-terminal task. The matching
  imperative helpers in `src/tools/*` (`requestShell`,
  `requestCodeExecution`, `requestFileWrite`, `requestFilePatch`)
  use the same `isTerminalTaskStatus` guard but simply return the
  unchanged task — the imperative dispatcher handles the no-op
  inline rather than via a thrown error. The
  dispatcher converts it to a sync skipped tool result with message
  `Action skipped: task was already <status> when the request reached
  the runtime.` Used in place of `ApprovalRaceLostError` because the
  semantics are different — there is no approval row to lose a race
  against; the task itself is terminal before any approval lifecycle
  began.

Future approval-gated tool helpers should follow the same pattern:
check `isTerminalTaskStatus(item.status)` inside the request
mutateState; throw `TaskAlreadyTerminalError(taskId, item.status)`
on terminal; let `pendingOrAuto` handle the rest.

## Terminal-status discipline

Every `mutateState` callback that flips `task.status` MUST first
check `isTerminalTaskStatus(item.status)` (from `src/state/store.ts`)
and short-circuit when the task is already terminal. Without this
discipline a cancel that landed during a long await — the imperative
dispatcher's pre-dispatch `Bun.sleep(10)`, the chat loop's
`generateToolCallingResponse`, an approval-gated request helper's
state probe — would be silently overwritten by the caller flipping
status back to `running` / `waiting_approval` / `completed`. The
helper is the single source of truth for "what counts as terminal"
so adding a new terminal status (e.g. a hypothetical `expired`)
becomes a single-file change. Patched sites at protocol shipping
time: `runTask` and `runChatTask` entry guards; `runTerminalCommand`
via the registry claim; every chat-task and imperative request*
helper; every chat-task `runLoop` status mutation; the
`completeApprovedTask` and `completeLowRiskToolTask` helpers; the
imperative LLM-summary completion path.

`runChatTask` additionally respects an already-`cancelled` /
`failed` / `completed` task status set BEFORE the chat-task loop
acquires its first `mutateState` lock. Previously the loop
unconditionally overwrote the status to `running`, allowing a
cancellation issued between `submitTask` returning and the loop
scheduling to be silently overwritten and the loop to continue.

## Context

Issue #23 documents a pre-existing race that `dangerouslyAutoApprove`
made more reachable in practice. The approval lifecycle (request →
approve → side effect → audit row → resume) crosses several awaits.
The audit-row write happens AFTER the side effect, which means a
`cancelTask` issued while the side effect is running has no way to
intercept it: the original `executeApprovedAction` only checked task
status once, at the top of the function, and the long-running
`setInputFiles` (10s default timeout) and uncapped `terminal.exec`
durations meant the cancel window was wide enough to hit in practice.

The validator on PR #24 confirmed the bug but flagged it as
pre-existing and recommended a separate ADR + fix. This ADR is that
follow-up.

## Required Now

- `src/execution/approval-execution.ts` — the registry module and the
  `raceWithAbort` helper. The registry is a nested
  `Map<instance, Map<approvalId, entry>>` so the instance dimension
  is a true partition (instance names can contain any characters
  without breaking abort/reset semantics). `id()` truncates UUIDs to
  eight characters so two instances CAN otherwise produce the same
  approvalId; the instance partition keeps them independent.
- `executeApprovedAction` claim/release lifecycle around the existing
  per-action branches, with signal threading into terminal.exec
  (`proc.kill`) and browser.upload_file (`raceWithAbort`) and a
  pre-write check for file.write/file.patch.
- `cancelTask` extends its mutateState callback with a call to
  `abortApprovalsForTask` and an `approval.in_flight_aborted` audit
  row when entries were aborted.
- `runChatTask` respects pre-existing terminal status so a cancel
  issued before the loop's first iteration is not overwritten.
- Regression test suite at `src/execution/approval-execution.test.ts`
  covering: registry behavior, `raceWithAbort` happy path / abort path
  / pre-aborted / late-rejection swallowing, end-to-end
  `cancelTask`-during-`terminal.exec` killing the proc and emitting
  `terminal.exec_aborted`, and the cancel-before-claim race producing
  a cancelled task with no successful `terminal.exec` row.

## Deferred

- Threading the signal through `withSession` in
  `src/tools/browser.ts` so the underlying Playwright call can also
  be aborted via a generation bump or page close. The current shim
  detaches the upload promise but the browser-side work continues;
  the `browser.upload_file_late_completion` audit row records the
  actual outcome.
- True process-tree teardown for `terminal.exec` grandchildren. The
  immediate proc gets SIGTERM via `proc.kill()`. Backgrounded /
  detached children inside `zsh -lc cmd` survive the cancel. Fixing
  this requires either a `setsid` wrap in `spawnArgs` (Linux-only)
  or Bun adding a `detached` option to `spawn`. Tracked as a
  follow-up.
- `code_exec` already routes through the `terminal.exec` approval
  (see `src/execution/tool-dispatch.ts::requestCodeExec`), so it
  inherits the SIGTERM behavior described above. The same
  grandchildren limitation applies.

## Audit action naming

The protocol introduces six new audit action names. They follow two
conventions on purpose so auditors can grep by intent:

- `<tool>_aborted` (`file.write_aborted`, `file.patch_aborted`,
  `terminal.exec_aborted`, `browser.upload_file_aborted`) — the
  per-action row that supplants the regular `<tool>` row when the
  signal won the race. Carries the same evidence shape as the
  regular row plus `aborted: true, abortReason: <signal.reason>`.
- `approval.in_flight_aborted` — the orchestration row emitted by
  `cancelTask` / `failTask` / `decideApproval-deny` when at least
  one executor was aborted. Carries `reason`, `approvalIds`, and
  (for sibling denial) the `originatingApprovalId`.
- `browser.upload_file_late_completion` — the followup row emitted
  by the detached Playwright upload's settled handler, recording
  whether the browser ultimately committed the file despite the
  abort. Carries `afterAbort: true, detachedSettled, success,
  error`.

`abortReason` is read from `signal.reason` (passed by
`controller.abort(reason)` in the three terminal-transition paths)
so the audit row records WHICH transition cancelled the action,
not a hardcoded value.

## Consequences

- Audit trail gains the four `<tool>_aborted` rows plus
  `approval.in_flight_aborted` and
  `browser.upload_file_late_completion`. Auditors can grep for
  `_aborted` to find every cancel-intercepted side effect and
  `_late_completion` for browser commits that happened after the
  abort.
- A cancelled task no longer holds the runtime hostage for the full
  `terminal.exec` timeout; SIGTERM lands within milliseconds of the
  abort firing.
- The `dangerouslyAutoApprove` lifecycle is unchanged at the request
  level; the abort protocol simply gives `cancelTask` a working
  cleanup path inside the auto-approve loop.
- Registry leaks are guarded by the `finally`-block release. Tests
  call `__resetInFlight()` between cases to keep the module-local
  Map clean across runs.

## Acceptance checks

- `bun run typecheck` clean.
- `bun test src/execution/approval-execution.test.ts` clean.
- `bun test` end-to-end clean.
- `cancelTask` during a long-running `sleep` invocation kills the proc
  promptly (well below the configured timeout) and writes
  `terminal.exec_aborted`. The shipping regression test polls for the
  audit row to land rather than asserting a wall-clock budget — both
  the pre-spawn (`spawnSkipped: true`) and post-spawn variants of the
  aborted row are accepted to absorb claim-vs-spawn microtask ordering
  on slow CI.
- ADR approval-and-audit-substrate.md and ADR dangerously-auto-approve.md cross-link to this ADR.
