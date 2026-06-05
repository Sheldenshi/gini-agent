"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

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
  "pairing",
  "notification",
  "run"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };
type Listener = (event: RuntimeStreamEvent) => void;

// Module-level singletons — one EventSource per browser tab, shared by every
// `useRuntimeStream` caller and the global `RuntimeStreamBridge`. Subscribing
// from N places does not open N connections.
let source: EventSource | null = null;
const listeners = new Set<Listener>();

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

function ensureConnection(): void {
  if (source) return;
  openSseTransport();
}

function closeConnection(): void {
  // Defense in depth: callers gate this on `listeners.size === 0`, but a
  // resubscribe that races the unsubscribe could leave the listener set
  // non-empty when we arrive here. Closing in that case would strand those
  // subscribers — bail out and let the existing source keep serving them.
  if (listeners.size > 0) return;
  if (source) {
    source.close();
    source = null;
  }
}

function subscribe(listener: Listener): () => void {
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
 * Subscribes to /api/runtime/events/stream (SSE). Multiple callers share a
 * single underlying EventSource (module-level singleton), so mounting many
 * subscribers across the app does not open many connections.
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

/** Test-only hooks for the SSE singleton. */
export const __streamTestHooks = {
  subscribe,
  getSource(): EventSource | null {
    return source;
  },
  listenerCount(): number {
    return listeners.size;
  },
  reset(): void {
    if (source) {
      source.close();
      source = null;
    }
    listeners.clear();
  }
};
