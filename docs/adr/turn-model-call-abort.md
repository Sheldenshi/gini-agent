# ADR: Turn model-call abort protocol

## Decision

`cancelTask` aborts the in-flight provider model call of a chat turn at
the source, so a turn cancelled mid-stream stops its fetch + SSE stream
reader the instant the cancel lands instead of reading deltas until the
upstream connection closes on its own.

A module-scoped per-turn registry in `src/execution/turn-abort.ts`
(`registerTurn` / `releaseTurn` / `abortTurnForTask`) holds at most one
`AbortController` per `(instance, taskId)`. The chat-task entry points
register a controller, thread its signal into every model/aux call for
that turn, and the terminal-transition paths fire `controller.abort()`
on the entry that targets the cancelled task. This is the model-call
analogue of the approved-action abort registry in
`src/execution/approval-execution.ts` (see
[approval-execution-abort.md](approval-execution-abort.md)); the two
registries are independent — one aborts the side effect of an approved
tool, the other aborts the model call that drives the turn.

## Why a separate registry from approvals

A task can have several pending approvals at once, so the approval
registry is keyed `Map<instance, Map<approvalId, entry>>`. A task runs at
most ONE turn at a time, so the turn registry is keyed
`Map<instance, Map<taskId, entry>>`. Conflating them would force a
synthetic approval-style id onto turns and blur which registry a given
abort targets. Keeping them separate keeps each lifecycle legible: a
cancel fires BOTH (`recordInFlightAborted` calls `abortTurnForTask` for
the model call and `abortApprovalsForTask` for any in-flight side
effect), but each registry owns its own entries and reset semantics.

The instance dimension is a true nested-Map partition rather than a
string-prefix key, for the same reason the approval registry uses one:
instance names are unvalidated and `id()` truncates UUIDs, so two
instances can collide on a `taskId` in different state trees.

## Protocol

1. **Register before the loop.** `runChatTask` (a fresh turn) and
   `resumeChatTask` (an approval-resume continuation) each call
   `registerTurn(instance, taskId)` before invoking `runLoop`, pass the
   returned controller's `signal` into `runLoop`, and MUST call
   `releaseTurn(instance, taskId, controller)` in a `finally` so the
   entry is reaped on every exit (completion / cancel / throw). The
   `runLoop` threads the same signal into each
   `generateToolCallingResponse` and `generateAuxText` call.
2. **Abort inside the status flip.** `cancelTask` — and the
   deny/fail cascades, via `recordInFlightAborted` — call
   `abortTurnForTask(instance, taskId, reason)` INSIDE their `mutateState`
   callback so the abort serializes with the task's status flip through
   the per-instance lock. This is the same ordering discipline the
   approved-action registry uses: either the abort fires against a
   registered turn, or the turn hasn't registered yet and observes the
   terminal status at its next loop checkpoint.
3. **Abort with an AbortError-shaped reason.** `abortTurnForTask` calls
   `controller.abort(new DOMException(reason, "AbortError"))`, NOT a bare
   string. A `fetch` rejects its body read with the signal's `reason`, so
   the reason must be error-shaped for `provider.isAbortError` to
   classify the rejection as an abort. The reason text
   (`task.cancelled` / `task.failed` / `sibling.denied` /
   `turn.superseded`) rides in the `DOMException` message for diagnostics.

## Provider signal threading

`generateToolCallingResponse` and `generateAuxText` take a trailing
optional `signal?: AbortSignal`. `dispatch` passes it into each provider
call path (`callToolCallingResponses`, `callOpenAIResponses`,
`callAnthropicMessages`, `callBedrockConverse`,
`callToolCallingChatCompletions`). Each `call*` passes the signal into
its `fetch` and into its SSE stream reader; each reader re-checks
`signal.aborted` at the top of its read loop and throws the signal's
reason so an abort that lands between reads also unwinds promptly. The
echo test provider's injected `delayMs` honors the signal via
`abortableSleep`, so a unit test can cancel a turn mid-call and observe
the same `AbortError` a real provider fetch would raise.

The codex session-rotation retry (`withCodexSessionRetry`) also carries
the signal on its two turn-facing paths so a cancel during the
pre-retry settle wait skips the second attempt at the source; see
[codex-session-rotation-retry.md](codex-session-rotation-retry.md).

## Supersede on re-register

`registerTurn` for a `taskId` whose entry is somehow still present (a
prior turn that failed to release) aborts and replaces the stale
controller with reason `turn.superseded` rather than throwing — a leaked
entry must never wedge a fresh turn. `releaseTurn` takes an optional
`controller`: when provided, the entry is removed only if it still holds
THAT controller, so a superseded turn's late release cannot evict the
entry a newer turn just registered for the same `taskId`.

## Bail-out and defense-in-depth

When the model call rejects with an abort that matches the turn's OWN
signal, `runLoop` drains any queued streaming flush and returns the
stale terminal task (`bailOnTurnAbort`) rather than treating the abort as
a context overflow (no compact-and-retry) or an auth failure (no
needs-reauth). The bail is gated on `turnSignal?.aborted` so an unrelated
`AbortError` is not mistaken for a turn cancel. `cancelTask` owns the
terminal status flip and the `phase("Cancelled")` block emission; the
loop just stops.

The source abort closes the issue-#395 stuck-cursor at the source, but a
brief window still exists between the abort firing and the stream fully
unwinding in which a buffered delta can arrive. As defense-in-depth the
streaming flush re-checks terminal status and drops post-cancel deltas
(no new `assistant_text` block is born after the cancel); the same
terminal-status guard also suppressed a stray `phase("Completed")` once
the task was terminal (formerly in the now-removed `switchTurnToThread`
turn-routing helper — superseded by Topics, see
[chat-topics-tasks-subagents.md](chat-topics-tasks-subagents.md)). A streaming block leaked by a process that
died mid-stream before this protocol landed is healed on the next boot
by `healOrphanedStreamingBlocks`. See
[chat-block-protocol.md](chat-block-protocol.md) for the block-level wire
shape.

## Interrupt-context marker

Stopping the in-flight call is silent to the model on its own: the
cancelled turn persists no assistant answer (`persistFinalAnswerRow`
fires only on `completed`) and no transcript rows (`persistTranscriptRow`
short-circuits once the task is terminal), so the cancelled user prompt
sits in history as the last user turn with no reply. The model on the
NEXT turn would have no signal it was interrupted and could blindly
re-attempt the abandoned work.

To match Claude Code's behavior, `cancelTask` persists an
interrupt-context marker as a durable `chatMessage` (top-level chat tasks
only — not subagents or jobs):

- `role: "user"` — it represents the user's interrupt action and replays
  through `priorChatMessages` as a user message the next turn sees.
- content is `[Request interrupted by user]`, or `[Request interrupted by
  user for tool use]` when the cancel landed while a tool was in flight
  (the task was `waiting_approval`, carried a pending tool-call snapshot,
  or had a live pending authorization/setup-request gate row — see the
  mid-dispatch note below).
- `kind: "tool_transcript"` — model-facing only. The human chat views
  (`chat.ts`) exclude `tool_transcript` rows, and `createChatMessage`
  only lets a non-transcript assistant row drive the session summary, so
  the marker never clutters the UI (which already shows the "Cancelled"
  block) and never becomes the session preview.

The marker is written INSIDE the same `mutateState` callback that flips
the task to `cancelled` and fires the abort fan-out (`createChatMessage`
is a pure state mutation with no I/O, so it runs safely under the lock).
This is deliberate: committing the marker atomically with the status flip
guarantees it is durable before any queue-drain triggered by the abort
(the in-flight turn's `submitTask.finally` →
`dispatchNextPendingChatMessage`) can start the next turn and read
`priorChatMessages`. It also inherits the early `isTerminalTaskStatus`
return as its gate — a duplicate/racing Stop on an already-terminal task
returns before reaching the marker, so no second marker is ever appended
(the same condition that guards `didCancel`).

The write is additionally guarded on the session still existing
(`state.chatSessions.some((s) => s.id === task.chatSessionId)`).
`deleteChatSession` removes a session and its `chatMessages` but does NOT
cancel the session's in-flight tasks, so a task can be cancelled after its
session is gone; `createChatMessage` would still push the row (it only
links it to a session `if (session)`), recreating the orphan the delete
just cleared — and there is no orphan-`chatMessages` sweep to reclaim it.
Running the existence check inside this `mutateState` serializes it with
`deleteChatSession` through the per-instance lock, so the guard is
decisive with no TOCTOU window — the same discipline
`persistAssistantTranscript` and the identity-snapshot write use for
their deferred session-scoped writes.

The `…for tool use` variant is chosen from three in-state signals unioned
together. The first is a snapshot read at status-flip time
(`waiting_approval` status, or a non-empty `toolCallState.pending`). The
second covers the mid-dispatch window (issue #395): between a gate being
created and the loop persisting its `waiting_approval` status + tool-call
snapshot, the only durable evidence a tool was in flight is the pending
authorization/setup-request row. `cancelTask` already computes that
pending-gate set (`pendingCallIds`) to settle orphaned tool-call rows to
`denied`, so it folds the same set into the variant choice
(`cancelledDuringToolUse ||= pendingCallIds.size > 0`) — a tool-gated
cancel in that window gets the correct `…for tool use` marker instead of
the plain one.

The third covers a non-gated tool mid-execution. A sync tool (`file_read`,
`web_fetch`, `web_search`, the `browser_*` actions, …) creates no gate row
and never populates `toolCallState.pending`, and `dispatchToolCall` runs
OUTSIDE any `mutateState` — between the loop committing a `running`
`recentToolCalls` entry and flipping it to `done`/`error`. So at cancel
time the only in-state evidence such a tool is in flight is a
`recentToolCalls` entry still at `status: "running"`. The variant union
includes `task.recentToolCalls?.some((c) => c.status === "running")`. This
is reliable because the dispatch loop's own terminal re-check (under the
same lock that pushes the `running` entry) means a `running` entry can
never be born after the cancel lands — its presence at cancel time always
means a tool was genuinely executing. A `done`/`error` entry from a tool
that finished earlier in the turn does NOT count: a tool that ran and
completed, after which the model's streamed text answer was cancelled, is
a plain interrupt.

Because replay can now legitimately place adjacent user turns (the
cancelled prompt, then the marker, then the next prompt), the provider
translators that require strict user/assistant alternation —
`translateMessagesToAnthropic` and `translateMessagesToConverse` — merge
any run of consecutive same-role messages into one, concatenating their
content blocks in order. (This also hardens a pre-existing latent case:
a cancelled prompt with no assistant answer followed by a new prompt
already produced two adjacent user turns before this marker existed.)
The codex `/responses` path is lenient on alternation and needs no merge.

## Context

Issue #395: a chat turn cancelled while a model call was in flight kept
painting deltas and ran tools the model produced after the cancel,
because the provider call took no `AbortSignal` and cancellation was
observed only at discrete `runLoop` checkpoints (between iterations,
after a model call returned). On mobile this surfaced as a "Cancelled"
banner over a turn that visibly kept working. The fix threads a real
`AbortSignal` end to end so the cancel deterministically stops the
in-flight call at its source rather than relying on the next checkpoint.

## Deferred

- **Aborting the pre-turn recall embedding.** `runChatTask` runs
  auto-recall (a Hindsight query that embeds the user's input) BEFORE it
  registers the turn controller, so a Stop landing during recall does not
  abort the embedding HTTP call — it completes in the background and the
  turn then proceeds to the model call, where the loop's terminal-status
  guard stops it. The wasted embedding (and the privacy nuance of
  embedding a cancelled query) is a known, bounded gap: recall is a single
  short call and the turn still stops before any model output is produced.
  Closing it means registering the controller before recall AND threading
  the signal through `recall` into the embedding provider's `embed()`
  fetch — a cross-cutting change to the embedding-provider interface,
  tracked as a follow-up rather than bundled here. Mirrors the
  terminal.exec grandchildren / browser late-completion deferrals in
  [approval-execution-abort.md](approval-execution-abort.md).

## Consequences

- A cancelled turn's provider fetch + stream reader stop within
  milliseconds of the cancel, not at the upstream connection's natural
  end. Tool calls the aborted model output would have produced are never
  dispatched.
- The turn registry and the approval registry are siblings: a cancel
  fires both via `recordInFlightAborted`. Adding a new model/aux call
  site means threading the turn signal into it; adding a new terminal
  transition means calling `abortTurnForTask` from inside its status-flip
  `mutateState`.
- Registry leaks are guarded by the `finally`-block `releaseTurn` plus
  the supersede-on-re-register fallback. Tests call `__resetTurns()`
  between cases; `__turnSnapshot()` exposes registry state as a
  deterministic latch (a turn's entry clears only when its model call
  actually returns/throws), which the regression suite waits on instead
  of a wall-clock budget.

## Acceptance checks

- `bun run typecheck` clean.
- `bun test src/execution/turn-abort.test.ts` clean (registry
  register/release/abort/supersede semantics).
- `bun test src/execution/cancel-abort-signal.test.ts` clean: a cancel
  during a long held echo call releases the turn registry entry well
  under the held-call delay (source abort), the turn is `cancelled` (not
  `failed`), no provider auth failure is recorded, and an approved action
  aborted mid-run settles `denied` (never `ok`).
- ADR [approval-execution-abort.md](approval-execution-abort.md)
  cross-links to this ADR.
