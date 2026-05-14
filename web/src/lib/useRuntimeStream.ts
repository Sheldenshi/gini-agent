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
  "identity",
  "mcp",
  "messaging",
  "provider",
  "runtime",
  "notification"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };

/**
 * Subscribes to /api/runtime/events/stream once per mount.
 *
 * Stability rules (these matter — get them wrong and you'll re-open the
 * EventSource on every render, which causes the runtime to re-replay all
 * historical events from src/http.ts:eventStream() and produces a
 * connection/invalidation storm):
 *
 *  1. The effect deps must be EMPTY. The stream URL is constant, and `onEvent`
 *     is captured via a ref so callers can pass a fresh closure each render
 *     without retriggering the effect.
 *  2. Do NOT close() the EventSource in onerror. EventSource has built-in
 *     reconnect with backoff; calling close() turns transient hiccups into
 *     permanent disconnects. Callers can read state from `onopen`/`onerror` if
 *     they want to surface UI, but the connection itself must persist.
 */
export function useRuntimeStream(onEvent: (event: RuntimeStreamEvent) => void): void {
  const callbackRef = useRef(onEvent);
  // Layout effect so the ref updates synchronously after every commit, before
  // any subsequent SSE message can fire from the long-lived EventSource.
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    const source = new EventSource("/api/runtime/events/stream");
    const dispatch = (kind: string) => (event: MessageEvent) =>
      callbackRef.current({ kind, data: event.data });
    const handlers: Array<{ kind: string; handler: (event: MessageEvent) => void }> = [];
    for (const kind of EVENT_KINDS) {
      const handler = dispatch(kind);
      source.addEventListener(kind, handler);
      handlers.push({ kind, handler });
    }
    // Default `message` listener kept as a fallback for servers that emit
    // unnamed events; the local runtime does not, but this avoids breakage if
    // the upstream surface changes.
    const defaultHandler = dispatch("message");
    source.addEventListener("message", defaultHandler);
    // Intentionally NOT closing on error — let the browser auto-reconnect.
    // Logging is fine; closing is not.
    source.onerror = () => {
      // EventSource will transition to readyState=CONNECTING and retry; nothing
      // to do here. We avoid console noise because some browsers fire onerror
      // on every reconnect attempt during a brief upstream outage.
    };
    return () => {
      for (const { kind, handler } of handlers) source.removeEventListener(kind, handler);
      source.removeEventListener("message", defaultHandler);
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
