// Active SSE subscription tracking. A small in-process registry that
// maps a device token to the set of chat session ids that device
// currently has open over /api/chat/:id/stream.
//
// Used by the APNs dispatcher (src/integrations/apns/dispatcher.ts) so
// that "completion" silent pushes — phase blocks with label `Completed`
// or `Failed` — are suppressed when THIS device is actively watching
// the session. Per-device (rather than per-credential) suppression is
// load-bearing: two iOS installs of the same human share one
// credential ("owner"), but only one of them might be foregrounded on
// the chat — the other still needs the silent wake to refresh its
// badge. Keying on the APNs token (which the device sends as
// X-Device-Token on the SSE handshake) keeps the two devices distinct.
//
// Web and CLI clients without a device token never register here —
// they don't need silent-push suppression (there's no APNs device
// behind them), and including them would collapse onto the same
// credential key and break the per-device guarantee above.
//
// The state is per-process and per-instance because SSE connections
// terminate at this gateway process; a future multi-process deployment
// would need a shared store or a cross-process emitter, but that's out
// of scope for the single-Bun-runtime model.
//
// Lifecycle: callers `addSseSubscription` on handshake (after the
// optional X-Device-Token is validated against the devices table) and
// `removeSseSubscription` from every cleanup path (cancel, error,
// normal close). The returned cleanup function makes both legs of the
// pair impossible to forget.

import type { Instance } from "../types";

// instance → deviceToken → set of opaque per-call handles. Each
// addSseSubscription call inserts its own handle (so two concurrent
// streams for the same (device, session) don't collapse to one slot
// and a single cleanup can't yank the peer's record). Handles are
// stored as `${sessionId}::${nonce}`; membership checks scan the small
// Set for the session prefix.
const subscriptions: Map<string, Map<string, Set<string>>> = new Map();

function instanceBucket(instance: Instance): Map<string, Set<string>> {
  let bucket = subscriptions.get(instance);
  if (!bucket) {
    bucket = new Map();
    subscriptions.set(instance, bucket);
  }
  return bucket;
}

// Register an active SSE subscription for a specific device. Returns a
// cleanup function that callers MUST invoke from every teardown path
// (stream cancel, error, normal close) so the registry stays accurate.
// Multiple opens of the same (device, session) tuple are tolerated —
// the registry reference-counts internally so two reconnect attempts
// or peers coexist; the entry survives until the last subscription
// closes.
export function addSseSubscription(
  instance: Instance,
  deviceToken: string,
  sessionId: string
): () => void {
  const bucket = instanceBucket(instance);
  let sessions = bucket.get(deviceToken);
  if (!sessions) {
    sessions = new Set();
    bucket.set(deviceToken, sessions);
  }
  const handle = `${sessionId}::${Math.random().toString(36).slice(2)}`;
  sessions.add(handle);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const live = bucket.get(deviceToken);
    if (!live) return;
    live.delete(handle);
    if (live.size === 0) bucket.delete(deviceToken);
    if (bucket.size === 0) subscriptions.delete(instance);
  };
}

// True when the given device has at least one open SSE subscription
// for the given session. The dispatcher consults this per-device
// before emitting a completion silent push — if THIS device is already
// watching, the SSE channel will deliver the block and the push is
// redundant. Other devices for the same credential are evaluated
// independently.
export function isDeviceWatching(
  instance: Instance,
  deviceToken: string,
  sessionId: string
): boolean {
  const sessions = subscriptions.get(instance)?.get(deviceToken);
  if (!sessions) return false;
  for (const handle of sessions) {
    if (handle.startsWith(`${sessionId}::`)) return true;
  }
  return false;
}

// True when the given device has ANY active SSE subscription on this
// instance, regardless of session. Coarser than the per-session
// predicate; reserved for future broadcast-level signals.
export function hasAnyActiveSubscription(
  instance: Instance,
  deviceToken: string
): boolean {
  const sessions = subscriptions.get(instance)?.get(deviceToken);
  return Boolean(sessions && sessions.size > 0);
}

// Drop ALL watch entries for a device in one shot. The stream's own
// `cancel()` cleanup is the normal path, but it only fires when the
// gateway observes the SSE connection close — and behind a relay the
// gateway-side socket can be held open after the phone is gone (the
// keepalive writes keep succeeding into the relay buffer), so `cancel()`
// may never run and the watch entry goes stale, permanently suppressing
// completion pushes for that session. The mobile client therefore POSTs
// /api/push/unwatch when it backgrounds (it is no longer watching
// anything), and this clears the device's entire bucket so the next
// completion push is delivered rather than suppressed. Returns the number
// of session handles cleared (0 when the device had none). Idempotent.
export function clearDeviceWatch(instance: Instance, deviceToken: string): number {
  const bucket = subscriptions.get(instance);
  const sessions = bucket?.get(deviceToken);
  if (!bucket || !sessions) return 0;
  const cleared = sessions.size;
  bucket.delete(deviceToken);
  if (bucket.size === 0) subscriptions.delete(instance);
  return cleared;
}

// Drop watch entries for ONE session of a device, leaving the device's
// other watched sessions intact. Used by the mobile client when it
// navigates away from a chat (or the chat screen unmounts) WITHOUT
// backgrounding the app — the departed session's relay-held stream may
// never fire cancel(), so its entry would otherwise linger and suppress
// that chat's completion pushes. Scoped to the one session (not the whole
// device) so it can't race-clear a different chat the client just opened.
// Returns the number of handles cleared. Idempotent.
export function clearSessionWatch(
  instance: Instance,
  deviceToken: string,
  sessionId: string
): number {
  const bucket = subscriptions.get(instance);
  const sessions = bucket?.get(deviceToken);
  if (!bucket || !sessions) return 0;
  let cleared = 0;
  for (const handle of [...sessions]) {
    if (handle.startsWith(`${sessionId}::`)) {
      sessions.delete(handle);
      cleared += 1;
    }
  }
  if (sessions.size === 0) bucket.delete(deviceToken);
  if (bucket.size === 0) subscriptions.delete(instance);
  return cleared;
}

// Test-only entry — wipes every recorded subscription so tests that
// drive add/remove cycles don't leak into each other.
export function __resetSseSubscriptionsForTests(): void {
  subscriptions.clear();
}
