"use client";

import { useEffect } from "react";

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
  "notification"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };

export function useRuntimeStream(onEvent: (event: RuntimeStreamEvent) => void): void {
  useEffect(() => {
    const source = new EventSource("/api/runtime/events/stream");
    const handlers: Array<{ kind: string; handler: (event: MessageEvent) => void }> = [];
    for (const kind of EVENT_KINDS) {
      const handler = (event: MessageEvent) => onEvent({ kind, data: event.data });
      source.addEventListener(kind, handler);
      handlers.push({ kind, handler });
    }
    // Default `message` listener kept as a fallback for servers that emit
    // unnamed events; the local runtime does not, but this avoids breakage if
    // the upstream surface changes.
    const defaultHandler = (event: MessageEvent) => onEvent({ kind: "message", data: event.data });
    source.addEventListener("message", defaultHandler);
    source.onerror = () => source.close();
    return () => {
      for (const { kind, handler } of handlers) source.removeEventListener(kind, handler);
      source.removeEventListener("message", defaultHandler);
      source.close();
    };
  }, [onEvent]);
}
