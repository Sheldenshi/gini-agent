// Active SSE subscription tracking. A small in-process registry that
// maps a credential id to the set of chat session ids it currently has
// open over /api/chat/:id/stream.
//
// Used by the APNs dispatcher (src/integrations/apns/dispatcher.ts) so
// that "completion" silent pushes — phase blocks with label `Completed`
// or `Failed` — are suppressed when the user is actively watching the
// session. There's no point waking the device to refetch a block that
// just arrived over the open SSE channel; the suppression keeps APNs
// traffic down and avoids redundant badge math.
//
// The state is per-process and per-instance because SSE connections
// terminate at this gateway process; a future multi-process deployment
// would need a shared store or a cross-process emitter, but that's out
// of scope for the single-Bun-runtime model.
//
// Lifecycle: callers `addSseSubscription` on handshake (after auth
// resolves a credential) and `removeSseSubscription` from every cleanup
// path (cancel, error, normal close). The returned cleanup function
// makes both legs of the pair impossible to forget.

import type { Instance } from "../types";

// instance::credentialId → set of sessionIds currently subscribed.
// Map nesting keeps lookups O(1) on the dispatcher's hot path
// (isCredentialWatching) without scanning a flat array on every push.
const subscriptions: Map<string, Map<string, Set<string>>> = new Map();

function instanceBucket(instance: Instance): Map<string, Set<string>> {
  let bucket = subscriptions.get(instance);
  if (!bucket) {
    bucket = new Map();
    subscriptions.set(instance, bucket);
  }
  return bucket;
}

// Register an active SSE subscription. Returns a cleanup function that
// callers MUST invoke from every teardown path (stream cancel, error,
// normal close) so the registry stays accurate. Multiple opens of the
// same (credential, session) tuple are tolerated — the registry
// reference-counts internally so two tabs / two devices for the same
// credential coexist; the entry survives until the last subscription
// closes.
export function addSseSubscription(
  instance: Instance,
  credentialId: string,
  sessionId: string
): () => void {
  const bucket = instanceBucket(instance);
  let sessions = bucket.get(credentialId);
  if (!sessions) {
    sessions = new Set();
    bucket.set(credentialId, sessions);
  }
  // Add a unique handle per call so concurrent subscriptions to the
  // same session from the same credential don't collapse to one entry
  // (and so the first cleanup doesn't yank the still-open peer's
  // record). The Set holds opaque tokens; we expose membership only
  // via the predicate helpers below.
  const handle = `${sessionId}::${Math.random().toString(36).slice(2)}`;
  sessions.add(handle);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const live = bucket.get(credentialId);
    if (!live) return;
    live.delete(handle);
    if (live.size === 0) bucket.delete(credentialId);
    if (bucket.size === 0) subscriptions.delete(instance);
  };
}

// True when the given credential has at least one open SSE subscription
// for the given session. The dispatcher consults this before emitting a
// completion silent push — if the user is already watching, the SSE
// channel will deliver the block and the push is redundant.
export function isCredentialWatching(
  instance: Instance,
  credentialId: string,
  sessionId: string
): boolean {
  const sessions = subscriptions.get(instance)?.get(credentialId);
  if (!sessions) return false;
  // Handles are stored as `${sessionId}::${nonce}` — checking
  // membership is a prefix scan, but Sets are small (typically 1-2
  // open streams per credential) so this stays cheap.
  for (const handle of sessions) {
    if (handle.startsWith(`${sessionId}::`)) return true;
  }
  return false;
}

// True when the given credential has ANY active SSE subscription on
// this instance, regardless of session. Coarser than the per-session
// predicate; used in cases where "is the app app-active for this
// human?" is the right signal (e.g. a future broadcast-level push that
// wakes the badge without targeting a specific chat).
export function hasAnyActiveSubscription(
  instance: Instance,
  credentialId: string
): boolean {
  const sessions = subscriptions.get(instance)?.get(credentialId);
  return Boolean(sessions && sessions.size > 0);
}

// Test-only entry — wipes every recorded subscription so tests that
// drive add/remove cycles don't leak into each other.
export function __resetSseSubscriptionsForTests(): void {
  subscriptions.clear();
}
