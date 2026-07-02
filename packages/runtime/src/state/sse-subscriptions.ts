// SSE presence tracking. Two in-process registries that record which
// chat sessions are currently being watched, consulted by the APNs
// dispatcher (src/integrations/apns/dispatcher.ts):
//
//   1. Per-DEVICE (this file's primary registry): maps an APNs device
//      token to the chat session ids that device has open over
//      /api/chat/:id/stream. Lets the dispatcher SKIP a redundant
//      completion push to THIS device — its open stream delivers the
//      block directly. Per-device (rather than per-credential)
//      suppression is load-bearing: two iOS installs of the same human
//      share one credential ("owner"), but only one might be foregrounded
//      on the chat — the other still needs the wake to refresh its badge.
//      Keying on the APNs token (sent as X-Device-Token on the SSE
//      handshake) keeps the two devices distinct.
//
//   2. PUSHLESS web/CLI presence (the second registry, below): web and
//      CLI clients carry no APNs device token, so they're absent from the
//      per-device registry — but their presence still matters. When a
//      human is reading a chat on the web app, the dispatcher DOWNGRADES
//      the user's phone completion ALERT to a silent badge refresh so the
//      phone doesn't buzz for a message they're already looking at. That
//      registry is keyed by session id (there's no token to key on).
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
// stored as `${sessionId}::${streamId}::${nonce}` when the client names
// its stream, or `${sessionId}::${nonce}` when it doesn't; membership
// checks scan the small Set for the session prefix. The middle
// `streamId` segment lets a client clear exactly the stream it opened
// (clearStreamWatch) without disturbing a sibling stream on the same
// session — on iOS the Thread View is presented as a card OVER the main
// chat, so both screens hold a stream on the same sessionId at once.
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
  sessionId: string,
  streamId?: string
): () => void {
  const bucket = instanceBucket(instance);
  let sessions = bucket.get(deviceToken);
  if (!sessions) {
    sessions = new Set();
    bucket.set(deviceToken, sessions);
  }
  const nonce = Math.random().toString(36).slice(2);
  // Encode the client-supplied streamId as a middle segment so
  // clearStreamWatch can target exactly this stream. Omitted when the
  // client doesn't name one (web/CLI/legacy), which keeps the bare
  // `${sessionId}::${nonce}` shape the session-prefix checks expect.
  const handle = streamId
    ? `${sessionId}::${streamId}::${nonce}`
    : `${sessionId}::${nonce}`;
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

// Drop watch entries for ONE stream of a device — the specific stream the
// client named with `streamId` on its SSE handshake. Used when a chat
// screen unmounts: it clears only the handle(s) that screen registered,
// leaving a sibling stream on the SAME session intact. This is the
// over-clear fix — on iOS the Thread View is pushed as a card over the
// main chat, so both screens open a stream on the same sessionId; a
// session-wide clear on the thread's unmount would wipe the still-mounted
// main chat's watch and unsuppress its completion pushes. Scoped to the
// `${sessionId}::${streamId}::` prefix so only the departed stream goes.
// Returns the number of handles cleared. Idempotent.
export function clearStreamWatch(
  instance: Instance,
  deviceToken: string,
  sessionId: string,
  streamId: string
): number {
  const bucket = subscriptions.get(instance);
  const sessions = bucket?.get(deviceToken);
  if (!bucket || !sessions) return 0;
  const prefix = `${sessionId}::${streamId}::`;
  let cleared = 0;
  for (const handle of [...sessions]) {
    if (handle.startsWith(prefix)) {
      sessions.delete(handle);
      cleared += 1;
    }
  }
  if (sessions.size === 0) bucket.delete(deviceToken);
  if (bucket.size === 0) subscriptions.delete(instance);
  return cleared;
}

// Pushless (web / CLI) presence. Web and CLI clients open a chat SSE
// stream but carry no APNs device token, so they never appear in the
// per-device registry above — and they never need a push (there's no
// APNs device behind them). Their presence still matters to the OTHER
// devices: when a human is reading a chat on the web app, the phone
// should not BUZZ for that chat's completion. The dispatcher downgrades
// the phone's completion alert to a silent badge refresh while a web/CLI
// client is live-watching the session (it can't fully suppress — web
// reads don't advance the phone's per-device read cursor, so the message
// genuinely is unread on the phone).
//
// Keyed by sessionId (there's no device token to key on) and
// reference-counted by an opaque per-connection nonce, so two web tabs
// open on the same chat coexist and one closing can't wipe the other.
//
// Evaluated LIVE at push time: an entry exists only while the stream is
// open. A client that sends a message and then closes the tab leaves no
// entry behind, so the phone receives its normal alert — there is no
// stickiness. Per-session rather than per-connection because the
// dispatcher's only question is "is ANY web/CLI client reading this chat
// right now"; it never needs to address an individual web connection.
const pushlessSessions: Map<string, Map<string, Set<string>>> = new Map();

// Register a live web/CLI stream on the session it is watching. Returns
// a cleanup function the stream MUST invoke from every teardown path
// (cancel, error, normal close) so the registry stays accurate. Idempotent.
export function addPushlessSubscription(
  instance: Instance,
  sessionId: string
): () => void {
  let sessions = pushlessSessions.get(instance);
  if (!sessions) {
    sessions = new Map();
    pushlessSessions.set(instance, sessions);
  }
  let conns = sessions.get(sessionId);
  if (!conns) {
    conns = new Set();
    sessions.set(sessionId, conns);
  }
  const nonce = Math.random().toString(36).slice(2);
  conns.add(nonce);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const liveSessions = pushlessSessions.get(instance);
    const liveConns = liveSessions?.get(sessionId);
    if (!liveSessions || !liveConns) return;
    liveConns.delete(nonce);
    if (liveConns.size === 0) liveSessions.delete(sessionId);
    if (liveSessions.size === 0) pushlessSessions.delete(instance);
  };
}

// True when at least one web/CLI client has a live SSE stream open on
// this session. The dispatcher consults this before firing a completion
// alert: if a human is reading the chat on the web app, the alert is
// downgraded to a silent badge refresh so the phone doesn't buzz for a
// message the user is already looking at.
export function isSessionWebWatched(
  instance: Instance,
  sessionId: string
): boolean {
  const conns = pushlessSessions.get(instance)?.get(sessionId);
  return Boolean(conns && conns.size > 0);
}

// Test-only entry — wipes every recorded subscription so tests that
// drive add/remove cycles don't leak into each other.
export function __resetSseSubscriptionsForTests(): void {
  subscriptions.clear();
  pushlessSessions.clear();
}
