"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { inferTunnelTransport } from "@/lib/transport";
import { isQuickTunnelOrigin } from "@/lib/tunnel-policy";

// Runtime-side event kinds. Source of truth: src/types.ts RuntimeEventKind.
// The server emits each event as `event: <kind>` (named SSE events), so the
// client must register a listener per kind — `EventSource.onmessage` only fires
// for unnamed default events, which the runtime never sends.
const EVENT_KINDS = [
  "task",
  "approval",
  "job",
  "memory",
  "skill",
  "connector",
  "mcp",
  "messaging",
  "provider",
  "runtime",
  "notification",
  "run"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };
type Listener = (event: RuntimeStreamEvent) => void;

// Backoff schedule for the long-polling retry loop. Doubles up to 8 s,
// then stays at 8 s — matching the mobile fallback and the EventSource
// reconnect feel (frequent retry early so a momentary tunnel hiccup
// recovers fast, then a sane ceiling so a sustained outage doesn't
// pin the event loop).
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

// Module-level singletons — one transport per browser tab, shared by every
// `useRuntimeStream` caller and the global `RuntimeStreamBridge`. Subscribing
// from N places does not open N connections / N polling loops.
let source: EventSource | null = null;
let pollAbort: AbortController | null = null;
let activeTransport: "sse" | "poll" | null = null;
// In-flight connection guard. `ensureConnection()` awaits
// `fetchTunnelTransport()` before assigning `source`/`pollAbort`, so without
// a synchronously-claimed guard, two `subscribe()` calls in rapid
// succession (StrictMode dev double-invocation is the canonical trigger)
// would both pass the `source || pollAbort` check, both fetch the
// transport, and both construct a transport — leaking one orphaned
// EventSource or, worse, an orphaned poll loop whose AbortController is
// no longer reachable from `closeConnection()`.
let connecting: Promise<void> | null = null;
// If the last subscriber unmounts WHILE a connection is mid-fetch, we
// can't tear down anything yet (no controller exists). Latch the request
// and honor it once the connection lands.
let closeRequestedWhileConnecting = false;
const listeners = new Set<Listener>();

async function fetchTunnelTransport(): Promise<"sse" | "poll"> {
  try {
    const res = await fetch("/api/runtime/tunnel", { credentials: "same-origin" });
    if (!res.ok) return "sse";
    const snap = (await res.json()) as { publicUrl?: string | null; tunnelTransport?: "sse" | "poll" };
    // Prefer the server-computed value when it's present (the runtime
    // sets it whenever publicUrl changes). Fall back to re-classifying
    // publicUrl on the client so older gateway builds still get the
    // poll path — same input, same classifier.
    if (snap.tunnelTransport === "sse" || snap.tunnelTransport === "poll") return snap.tunnelTransport;
    return inferTunnelTransport(snap.publicUrl ?? null);
  } catch {
    // Network failure pulling the snapshot — assume SSE works; the
    // EventSource path has its own reconnect logic.
    return "sse";
  }
}

// Tunnel-host check — when the gateway is reachable via a quick tunnel
// the page itself is loaded over `*.trycloudflare.com`. We only need
// the poll fallback when the browser is actually talking to a quick
// tunnel, not when an operator inspects the tunnel snapshot from
// localhost while a tunnel happens to be open.
function pageIsOnTunnelHost(): boolean {
  if (typeof window === "undefined") return false;
  return isQuickTunnelOrigin(window.location.origin);
}

function openSseTransport(): void {
  const next = new EventSource("/api/runtime/events/stream");
  const fanOut = (kind: string) => (event: MessageEvent) => {
    for (const listener of listeners) listener({ kind, data: event.data });
  };
  for (const kind of EVENT_KINDS) next.addEventListener(kind, fanOut(kind));
  // Default `message` listener kept as a fallback for servers that emit
  // unnamed events; the local runtime does not, but this avoids breakage if
  // the upstream surface changes.
  next.addEventListener("message", fanOut("message"));
  // Intentionally NOT closing on error — EventSource has built-in reconnect
  // with backoff, and closing turns transient hiccups into permanent
  // disconnects. Some browsers fire onerror on every reconnect attempt during
  // a brief outage, so we stay quiet.
  next.onerror = () => {};
  source = next;
}

function openPollTransport(): void {
  const controller = new AbortController();
  pollAbort = controller;
  let cursor = "";
  let consecutiveErrors = 0;
  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`/api/runtime/events/poll?since=${encodeURIComponent(cursor)}`, {
          signal: controller.signal,
          credentials: "same-origin"
        });
        if (!res.ok) throw new Error(`poll failed (${res.status})`);
        const payload = (await res.json()) as { events: Array<Record<string, unknown>>; cursor: string };
        consecutiveErrors = 0;
        cursor = payload.cursor ?? cursor;
        // Dispatch each event to the same listeners the SSE path
        // uses. The wire shape mirrors the SSE `data:` line — a
        // serialized RuntimeEvent — so listeners can parse it
        // identically and consumers don't have to branch on
        // transport. `kind` is the event kind (the SSE `event:`
        // line equivalent).
        for (const event of payload.events) {
          const kind = typeof event.kind === "string" ? event.kind : "message";
          const data = JSON.stringify(event);
          for (const listener of listeners) listener({ kind, data });
        }
      } catch (err) {
        // Aborted is the planned shutdown path; the while loop catches
        // it at the next iteration check. Any other error backs off
        // before retrying — POLL_BACKOFF_MS doubles up to 8 s and
        // then stays there.
        if (controller.signal.aborted) return;
        const idx = Math.min(consecutiveErrors, POLL_BACKOFF_MS.length - 1);
        const delay = POLL_BACKOFF_MS[idx]!;
        consecutiveErrors += 1;
        const { promise: wait, resolve: settle } = Promise.withResolvers<void>();
        const timer = setTimeout(settle, delay);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          settle();
        });
        await wait;
      }
    }
  };
  void loop();
}

function ensureConnection(): void {
  if (source || pollAbort) return;
  if (connecting !== null) return;
  // Synchronously claim the in-flight guard BEFORE the first await so any
  // second `subscribe()` call lands on the `connecting !== null` short
  // circuit above. We use an IIFE that returns the promise so the
  // assignment to `connecting` happens before the awaited work runs.
  connecting = (async () => {
    try {
      // Use the poll fallback only when BOTH (a) the runtime publishes a
      // quick-tunnel hostname AND (b) the page is actually being served
      // over that tunnel. Otherwise SSE is the right transport — loopback
      // can still hit Bun.serve directly even if the gateway exposes a
      // quick tunnel to other clients.
      const transport = pageIsOnTunnelHost() ? await fetchTunnelTransport() : "sse";
      // If the last subscriber unmounted while we were awaiting the
      // transport snapshot AND no fresh subscriber has arrived since,
      // don't open a connection at all — the closeRequestedWhileConnecting
      // flag is the only signal we have (source/pollAbort were null when
      // closeConnection() ran). But if a NEW subscriber landed during the
      // close (i.e. unmount → remount before the IIFE settled), honor it
      // by proceeding to open the transport — otherwise the new
      // subscriber is stranded with no source, no pollAbort, and no
      // in-flight `connecting` to await once this IIFE exits.
      if (closeRequestedWhileConnecting && listeners.size === 0) return;
      activeTransport = transport;
      if (transport === "poll") {
        openPollTransport();
      } else {
        openSseTransport();
      }
    } finally {
      connecting = null;
      closeRequestedWhileConnecting = false;
    }
  })();
}

function closeConnection(): void {
  // Defense in depth: callers gate this on `listeners.size === 0`, but a
  // resubscribe that races the unsubscribe could leave the listener set
  // non-empty when we arrive here. Closing in that case would strand
  // those subscribers — bail out and let the existing transport keep
  // serving them.
  if (listeners.size > 0) return;
  if (source) {
    source.close();
    source = null;
  }
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  activeTransport = null;
  // If a connection is mid-fetch when the last subscriber unmounts, no
  // controller exists yet to abort. Latch the intent so the in-flight
  // ensureConnection() body bails out before opening the transport.
  if (connecting !== null) {
    closeRequestedWhileConnecting = true;
  }
}

function subscribe(listener: Listener): () => void {
  // ensureConnection() spawns an async IIFE that fetches the tunnel
  // snapshot before opening either transport. It synchronously claims a
  // module-level `connecting` promise so a second `subscribe()` call
  // (e.g. StrictMode dev double-invocation) can't race it and open a
  // second transport. The listener is registered synchronously — any
  // event arriving before the transport opens has no listeners yet, but
  // the runtime emits state-change events, not a replay, so a brief
  // pre-open window is acceptable.
  ensureConnection();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      closeConnection();
    }
  };
}

/**
 * Subscribes to /api/runtime/events/stream (SSE) or /api/runtime/events/poll
 * (long-polling) depending on whether the page is loaded over a Cloudflare
 * quick-tunnel hostname. Multiple callers share a single underlying
 * transport (module-level singleton), so mounting many subscribers across
 * the app does not open many connections.
 *
 * Stability:
 *   The effect deps are EMPTY and `onEvent` is captured via a ref so callers
 *   can pass a fresh closure each render without retriggering the effect or
 *   re-opening the connection.
 */
export function useRuntimeStream(onEvent: Listener): void {
  const callbackRef = useRef(onEvent);
  // Layout effect so the ref updates synchronously after every commit, before
  // any subsequent message can fire.
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    return subscribe((event) => callbackRef.current(event));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Test-only: exposed for unit tests to assert which transport opened. */
export function __activeTransportForTests(): "sse" | "poll" | null {
  return activeTransport;
}

/**
 * Test-only: drives the race-fix unit test in useRuntimeStream.test.ts.
 *
 * Returns the module-level state the test pins:
 *   - `subscribe`: the same singleton-managed subscribe path the hook uses
 *   - `getState`: read the current source/pollAbort/connecting/activeTransport
 *     without race-prone direct module imports across async ticks
 *   - `reset`: tear everything down between cases so each test starts clean
 */
export const __raceTestHooks = {
  subscribe,
  getState(): {
    source: EventSource | null;
    pollAbort: AbortController | null;
    activeTransport: "sse" | "poll" | null;
    connecting: Promise<void> | null;
    listenerCount: number;
  } {
    return { source, pollAbort, activeTransport, connecting, listenerCount: listeners.size };
  },
  reset(): void {
    if (source) {
      source.close();
      source = null;
    }
    if (pollAbort) {
      pollAbort.abort();
      pollAbort = null;
    }
    activeTransport = null;
    connecting = null;
    closeRequestedWhileConnecting = false;
    listeners.clear();
  }
};
