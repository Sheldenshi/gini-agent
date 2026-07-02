// Per-turn abort registry for the in-flight model call.
//
// The provider model call (generateToolCallingResponse / generateAuxText)
// streams over an HTTP connection that, before this registry, took no
// AbortSignal — so a turn cancelled mid-stream kept reading deltas until the
// connection closed on its own. Cancellation was purely state-based and only
// observed at discrete loop checkpoints (issue #395). This registry threads a
// real AbortController into the in-flight call so `cancelTask` can abort the
// fetch + stream reader the instant the cancel lands, stopping the request at
// the source.
//
// Protocol (mirrors approval-execution.ts's in-flight registry):
//   1. The turn entry points — `runChatTask` (fresh turn) and `resumeChatTask`
//      (approval resume) — call `registerTurn(instance, taskId)` before
//      invoking `runLoop`, thread the returned controller's signal into every
//      model/aux call for that turn, and MUST call
//      `releaseTurn(instance, taskId, controller)` in a `finally` so the entry
//      is reaped on every exit (completion / cancel / throw).
//   2. `cancelTask` (and the deny/fail cascades, via recordInFlightAborted) call
//      `abortTurnForTask(instance, taskId, reason)` INSIDE their mutateState
//      callback so the abort serializes with the task's status flip through
//      the per-instance lock — the same ordering discipline the approved-
//      action registry uses.
//
// Unlike approvals (a task can have several pending at once), a task runs at
// most ONE turn at a time, so the registry is a flat
// `Map<instance, Map<taskId, entry>>` keyed by taskId. A re-register for a
// taskId that is somehow still present (a prior turn that didn't release)
// aborts and replaces the stale controller rather than throwing — a leaked
// entry must never wedge a fresh turn.
//
// The instance dimension is a true nested-Map partition (not a string-prefix
// key) for the same reason approval-execution.ts uses one: instance names are
// unvalidated and `id()` truncates UUIDs, so two instances can collide on a
// taskId in different state trees.

interface TurnEntry {
  controller: AbortController;
}

const inFlightTurns = new Map<string, Map<string, TurnEntry>>();

function getInstanceMap(instance: string, create: boolean): Map<string, TurnEntry> | undefined {
  let m = inFlightTurns.get(instance);
  if (!m && create) {
    m = new Map();
    inFlightTurns.set(instance, m);
  }
  return m;
}

// Register the in-flight turn for `(instance, taskId)` and return the
// AbortController whose signal is threaded into the turn's model/aux calls.
// Callers MUST pair every register with a `releaseTurn(instance, taskId)` in a
// `finally`. If an entry already exists for this taskId (a prior turn that
// failed to release), it is aborted and replaced so a stale controller can
// never leave a fresh turn unabortable.
export function registerTurn(instance: string, taskId: string): AbortController {
  const m = getInstanceMap(instance, true)!;
  const existing = m.get(taskId);
  if (existing && !existing.controller.signal.aborted) {
    existing.controller.abort(abortReason("turn.superseded"));
  }
  const controller = new AbortController();
  m.set(taskId, { controller });
  return controller;
}

// Abort with an AbortError-shaped DOMException (not a bare string) so the
// resulting signal.reason — which a fetch rejects its body read with — is
// classified by provider.isAbortError. The reason text rides in the message
// for diagnostics. Aborting with a plain string would set signal.reason to
// that string, and the fetch rejection would then NOT be recognizable as an
// abort by error shape.
function abortReason(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

// Drop the in-flight turn entry. Idempotent: re-releases are silent. Cleans up
// an empty inner map so a long-running process churning through instances
// doesn't accumulate dead shells. Releasing does NOT abort — a turn that
// completed normally releases its (un-aborted) controller here.
//
// `controller` (optional): when provided, the entry is only removed if it
// still holds THIS controller. This guards the release of a superseded turn
// from evicting the entry a newer turn just registered for the same taskId.
export function releaseTurn(instance: string, taskId: string, controller?: AbortController): void {
  const m = inFlightTurns.get(instance);
  if (!m) return;
  if (controller) {
    const entry = m.get(taskId);
    if (entry && entry.controller !== controller) return;
  }
  m.delete(taskId);
  if (m.size === 0) inFlightTurns.delete(instance);
}

// Abort the in-flight turn for `(instance, taskId)` if one is registered.
// Returns true when an abort signal was actually fired (a turn was in flight
// and not already aborted), false otherwise. Idempotent: an already-aborted or
// absent turn is a no-op, so a re-cancellation (cancel racing a deny cascade)
// doesn't double-signal.
export function abortTurnForTask(instance: string, taskId: string, reason: string): boolean {
  const m = inFlightTurns.get(instance);
  if (!m) return false;
  const entry = m.get(taskId);
  if (!entry || entry.controller.signal.aborted) return false;
  entry.controller.abort(abortReason(reason));
  return true;
}

// Test-only helpers. Mirror approval-execution.ts's `__`-prefixed seams so the
// registry's internal state stays encapsulated. Pass `instance` to clear a
// single instance; omit to clear the whole registry.
export function __resetTurns(instance?: string): void {
  if (!instance) {
    inFlightTurns.clear();
    return;
  }
  inFlightTurns.delete(instance);
}

export function __turnSnapshot(instance?: string): Array<{ taskId: string; aborted: boolean }> {
  const out: Array<{ taskId: string; aborted: boolean }> = [];
  const visit = (m: Map<string, TurnEntry>): void => {
    for (const [taskId, entry] of m) {
      out.push({ taskId, aborted: entry.controller.signal.aborted });
    }
  };
  if (instance) {
    const m = inFlightTurns.get(instance);
    if (m) visit(m);
  } else {
    for (const m of inFlightTurns.values()) visit(m);
  }
  return out;
}
