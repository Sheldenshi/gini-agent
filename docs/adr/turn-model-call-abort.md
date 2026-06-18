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
(no new `assistant_text` block is born after the cancel), and
`switchTurnToThread` refuses to emit a main-chat `phase("Completed")`
once the task is terminal. A streaming block leaked by a process that
died mid-stream before this protocol landed is healed on the next boot
by `healOrphanedStreamingBlocks`. See
[chat-block-protocol.md](chat-block-protocol.md) for the block-level wire
shape.

## Context

Issue #395: a chat turn cancelled while a model call was in flight kept
painting deltas and ran tools the model produced after the cancel,
because the provider call took no `AbortSignal` and cancellation was
observed only at discrete `runLoop` checkpoints (between iterations,
after a model call returned). On mobile this surfaced as a "Cancelled"
banner over a turn that visibly kept working. The fix threads a real
`AbortSignal` end to end so the cancel deterministically stops the
in-flight call at its source rather than relying on the next checkpoint.

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
