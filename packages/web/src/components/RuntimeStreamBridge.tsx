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
  // Keep `approval` mapped to all three caches during the alias window so
  // legacy events from old clients/servers still wake up the new query
  // keys. Once the alias is removed this can drop "approvals".
  approval: ["approvals", "authorizations", "setup-requests", "tasks", "task", "chat"],
  authorization: ["authorizations", "approvals", "tasks", "task", "chat"],
  setup: ["setup-requests", "approvals", "tasks", "task", "chat"],
  task: ["tasks", "task", "chat"],
  connector: ["connectors"],
  skill: ["skills"],
  memory: ["memory"],
  job: ["jobs", "jobRuns", "improvements"],
  subagent: ["subagents"],
  chat: ["chat"],
  // `provider.auth.needs_reauth` / `provider.auth.cleared` (issue #233) must
  // refresh the Settings catalog query, not just the status card.
  provider: ["status", "providers"],
  mcp: [],
  messaging: ["chat"],
  notification: [],
  runtime: ["status"],
  run: ["tasks", "task", "chat"]
};

// Fallback when the event has no parseable action — uses the SSE kind only.
const KIND_TO_KEYS: Record<string, string[]> = {
  task: ["tasks", "task", "chat"],
  approval: ["approvals", "authorizations", "setup-requests"],
  job: ["jobs", "jobRuns", "improvements"],
  memory: ["memory"],
  skill: ["skills"],
  connector: ["connectors"],
  mcp: [],
  messaging: ["chat"],
  provider: ["status", "providers"],
  runtime: ["status"],
  // Every pairing mutator (request/approve/reject/claim/cancel) emits a
  // content-free kind:"pairing" tick; refresh the operator's pending-requests
  // list AND the Active Sessions (devices) list — the latter so a device's
  // claim shows up without the dialog being open.
  pairing: ["pairingRequests", "devices"],
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
