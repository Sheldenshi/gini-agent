// In-flight registry for approved actions whose side effect is currently
// running. Closes the cancel-during-execute window described in issue
// #23: before this registry, `cancelTask` would flip the task to
// `cancelled` but a concurrently-running approved action (especially a
// 10s `setInputFiles` or a long-running `terminal.exec`) would still
// run to completion and write its `<action>` audit row against the
// cancelled task.
//
// Protocol:
//   1. `executeApprovedAction` calls `claimApproval(instance, approvalId,
//      taskId)` INSIDE its task-terminal mutateState callback so the
//      claim is serialized with `cancelTask`'s mutation. This makes
//      "is the task cancelled?" and "is this executor registered?"
//      atomic relative to each other.
//   2. `cancelTask` / `decideApproval(deny)` / `failTask` call
//      `abortApprovalsForTask(instance, taskId, reason)` INSIDE their
//      own mutateState callbacks so the abort fans out to any
//      executor that won the lock-race and is now between the claim
//      and the actual side effect. The executor reads `signal.aborted`
//      at each integration point and reacts (kills the proc, races
//      against the upload promise, skips the writeFileSync).
//   3. `executeApprovedAction` calls `releaseApproval(instance,
//      approvalId)` in a `finally` so the entry is reaped regardless
//      of success / abort / thrown error.
//
// The registry is a nested `Map<instance, Map<approvalId, entry>>`
// so the instance dimension is a true partition rather than a string
// prefix. A composite `${instance}:${approvalId}` key would be
// fragile: instance names are unvalidated, and a name containing
// `:` could make a `startsWith` match hit the wrong partition. The
// nested map drops the string-format coupling entirely; instance
// keys can be any string without breaking
// `abortApprovalsForTask` / `__resetInFlight` semantics.
//
// (`id()` only keeps the first 8 chars of a UUID — see
// `src/state/ids.ts` — so two instances CAN produce the same
// approvalId in different state trees, which is the original
// motivation for the instance partition.)

interface InFlightEntry {
  taskId: string | undefined;
  controller: AbortController;
}

const inFlight = new Map<string, Map<string, InFlightEntry>>();

function getInstanceMap(instance: string, create: boolean): Map<string, InFlightEntry> | undefined {
  let m = inFlight.get(instance);
  if (!m && create) {
    m = new Map();
    inFlight.set(instance, m);
  }
  return m;
}

// Register an in-flight approved-action executor. Returns the
// AbortController whose signal is threaded into the action's side
// effect. Callers MUST pair every successful claim with a
// `releaseApproval(instance, approvalId)` in a `finally` so the
// registry doesn't leak entries across runs. Throws if an entry with
// the same `(instance, approvalId)` already exists — duplicate claims
// would otherwise leave the first controller unabortable.
export function claimApproval(instance: string, approvalId: string, taskId: string | undefined): AbortController {
  const m = getInstanceMap(instance, true)!;
  if (m.has(approvalId)) {
    throw new Error(`Duplicate approval execution claim: ${instance}/${approvalId}`);
  }
  const controller = new AbortController();
  m.set(approvalId, { taskId, controller });
  return controller;
}

// Drop an in-flight entry. Idempotent: re-releases are silent. Also
// cleans up an empty inner map so a long-running process churning
// through many short-lived instances doesn't accumulate dead
// `Map<approvalId, ...>` shells.
export function releaseApproval(instance: string, approvalId: string): void {
  const m = inFlight.get(instance);
  if (!m) return;
  m.delete(approvalId);
  if (m.size === 0) inFlight.delete(instance);
}

// Abort every in-flight approved-action executor for `(instance,
// taskId)`. Returns the approval IDs that received the abort signal
// so callers can include the list in audit / trace records.
// Idempotent: already-aborted controllers are skipped so a
// re-cancellation (decideApproval deny cascade hitting an
// already-cancelled task) is a no-op rather than a duplicate signal.
export function abortApprovalsForTask(instance: string, taskId: string, reason: string): string[] {
  const m = inFlight.get(instance);
  if (!m) return [];
  const aborted: string[] = [];
  for (const [approvalId, entry] of m) {
    if (entry.taskId !== taskId) continue;
    if (entry.controller.signal.aborted) continue;
    entry.controller.abort(reason);
    aborted.push(approvalId);
  }
  return aborted;
}

// Race a lazily-started promise against the abort signal. The
// `start` factory is only invoked when the signal is NOT already
// aborted, so an uncancellable side effect (Playwright's
// `setInputFiles`) is never launched when the cancellation has
// already arrived — the audit row reflects what the runtime
// acknowledged AND what the browser actually did.
//
// Returns either `{ kind: "value", value }` when the promise wins,
// or `{ kind: "aborted", detached }` when the signal wins. The
// `detached` promise lets callers observe what the underlying side
// effect ultimately did so they can emit a late-completion audit row
// for the case where a detached browser upload still commits the file
// after the runtime acknowledged the cancellation. The detached
// promise always resolves (never rejects) with
// `{ resolved: true, value }` or `{ resolved: false, error }` so
// callers can attach handlers without managing rejection swallowing
// themselves.
//
// The abort listener is registered BEFORE `start()` is invoked so a
// synchronous re-entrant abort during factory execution still wins
// the race. The listener is removed in `finally` so callers holding
// a long-lived signal don't accumulate listeners across calls.
export type RaceOutcome<T> =
  // The aborted variant distinguishes "signal was already aborted at
  // entry so the factory was never invoked" (`started: false`,
  // `detached: undefined`) from "factory started and the signal won
  // the race" (`started: true`, `detached: <observable>`). Callers
  // that emit a late-completion audit row should skip the row when
  // `started: false` because there is no side effect to observe.
  | { kind: "value"; value: T }
  | { kind: "aborted"; started: false; detached: undefined }
  | { kind: "aborted"; started: true; detached: Promise<{ resolved: true; value: T } | { resolved: false; error: unknown }> };

export async function raceWithAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal
): Promise<RaceOutcome<T>> {
  if (signal.aborted) {
    return { kind: "aborted", started: false, detached: undefined };
  }
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
    abortListener = (): void => resolve({ kind: "aborted" });
    signal.addEventListener("abort", abortListener, { once: true });
  });
  // Wrap start() in try/catch so a synchronous throw inside the
  // factory still removes the abort listener. Without this the
  // listener leaks on a sync-throwing factory and a later abort
  // fires a callback resolving a no-longer-awaited promise.
  let promise: Promise<T>;
  try {
    // Start the factory AFTER attaching the listener so a re-entrant
    // synchronous abort triggered by the factory itself still wins.
    promise = start();
  } catch (err) {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    throw err;
  }
  try {
    const winner = await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      abortPromise
    ]);
    if (winner.kind === "aborted") {
      const detached = promise.then(
        (value) => ({ resolved: true as const, value }),
        (error) => ({ resolved: false as const, error })
      );
      return { kind: "aborted", started: true, detached };
    }
    return winner;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

// Test-only helpers. Kept under the same module so the registry's
// internal state stays encapsulated; tests import these explicitly
// via the `__` prefix. Pass `instance` to clear a single instance's
// entries; omit it to clear the entire registry (used by suites that
// want a fully clean slate per test).
export function __resetInFlight(instance?: string): void {
  if (!instance) {
    inFlight.clear();
    return;
  }
  inFlight.delete(instance);
}

export function __inFlightSnapshot(instance?: string): Array<{ approvalId: string; taskId: string | undefined; aborted: boolean }> {
  const out: Array<{ approvalId: string; taskId: string | undefined; aborted: boolean }> = [];
  const visit = (m: Map<string, InFlightEntry>): void => {
    for (const [approvalId, entry] of m) {
      out.push({ approvalId, taskId: entry.taskId, aborted: entry.controller.signal.aborted });
    }
  };
  if (instance) {
    const m = inFlight.get(instance);
    if (m) visit(m);
  } else {
    for (const m of inFlight.values()) visit(m);
  }
  return out;
}
