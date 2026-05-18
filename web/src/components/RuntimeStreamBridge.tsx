"use client";

import { useCallback } from "react";
import { useRuntimeStream } from "@/lib/useRuntimeStream";
import { useInvalidate } from "@/lib/queries";

// Maps domain prefixes (the first segment of an event's `action` field, e.g.
// `approval.create` → "approval") to react-query keys that should refetch.
//
// Action-based dispatch is the primary discriminator because addAudit() funnels
// every domain mutation through `kind: "runtime"`, so the SSE `kind` alone is
// too coarse — a connector.create and a skill.enable both arrive as "runtime"
// events.
const ACTION_TO_KEYS: Record<string, string[]> = {
  approval: ["approvals"],
  task: ["tasks", "task", "chat"],
  connector: ["connectors"],
  skill: ["skills"],
  memory: ["memory"],
  job: ["jobs", "jobRuns", "improvements"],
  subagent: ["subagents"],
  chat: ["chat"],
  provider: ["status"],
  mcp: [],
  messaging: ["chat"],
  notification: [],
  runtime: ["status"],
  run: ["tasks", "task", "chat"]
};

// Fallback when the event has no parseable action — uses the SSE kind only.
const KIND_TO_KEYS: Record<string, string[]> = {
  task: ["tasks", "task", "chat"],
  approval: ["approvals"],
  job: ["jobs", "jobRuns", "improvements"],
  memory: ["memory"],
  skill: ["skills"],
  connector: ["connectors"],
  mcp: [],
  messaging: ["chat"],
  provider: ["status"],
  runtime: ["status"],
  notification: [],
  run: ["tasks", "task", "chat"]
};

const ALWAYS = ["events", "audit", "state"];

function parseAction(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { action?: unknown };
    return typeof parsed.action === "string" ? parsed.action : null;
  } catch {
    return null;
  }
}

/**
 * Mounted once at the app root. Subscribes to the runtime SSE stream and
 * invalidates the matching react-query keys on every event. With this in
 * place, per-query `refetchInterval` only needs to be a slow safety net
 * (~60s) rather than the primary mechanism — state changes propagate within
 * ~50ms via SSE.
 */
export function RuntimeStreamBridge(): null {
  const invalidate = useInvalidate();
  useRuntimeStream(
    useCallback(
      ({ kind, data }) => {
        const action = parseAction(data);
        const head = action?.split(".")[0];
        const keysFromAction = head ? ACTION_TO_KEYS[head] ?? [] : [];
        const keysFromKind = KIND_TO_KEYS[kind] ?? [];
        invalidate([...new Set([...keysFromAction, ...keysFromKind, ...ALWAYS])]);
      },
      [invalidate]
    )
  );
  return null;
}
