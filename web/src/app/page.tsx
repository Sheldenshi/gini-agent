"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill, shouldHideRiskBadge } from "@/components/StatusPill";
import { api } from "@/lib/api";
import {
  useApprovals,
  useChatSessions,
  useEvents,
  useInvalidate,
  useStatus,
  useTasks
} from "@/lib/queries";
import type { Approval } from "@runtime/types";

const HOME_APPROVAL_LIMIT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export default function HomePage() {
  const status = useStatus();
  const tasks = useTasks();
  const approvals = useApprovals();
  const events = useEvents();
  const chatSessions = useChatSessions();
  const invalidate = useInvalidate();

  // SSE invalidation is handled globally by RuntimeStreamBridge — no local
  // useRuntimeStream subscription needed.

  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Tasks don't carry back-refs to their chat session, so build a lookup from
  // session.taskIds. Last-write-wins is fine; in practice a task lives in one
  // session.
  const taskToSession = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of chatSessions.data ?? []) {
      for (const taskId of session.taskIds ?? []) {
        map.set(taskId, session.id);
      }
    }
    return map;
  }, [chatSessions.data]);

  const activeTasks = (tasks.data ?? []).filter((t) => ["queued", "running", "waiting_approval"].includes(t.status));
  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  const pendingVisible = pending.slice(0, HOME_APPROVAL_LIMIT);
  const pendingExtra = pending.length - pendingVisible.length;
  const recent = (events.data ?? []).slice().reverse().slice(0, 8);

  // "Today's cost" = sum of estimatedUsd on tasks updated in the last 24h.
  // The runtime tracks cost on Task and JobRun; we sum across recent tasks
  // because tasks are the unit users submit, and job runs roll up into tasks
  // anyway via taskId. Using a 24h rolling cutoff (vs midnight) keeps it
  // stable across timezones and feels right for a control plane.
  const todaysCost = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    let usd = 0;
    let counted = 0;
    for (const task of tasks.data ?? []) {
      if (!task.cost?.estimatedUsd) continue;
      const at = Date.parse(task.updatedAt);
      if (Number.isNaN(at) || at < cutoff) continue;
      usd += task.cost.estimatedUsd;
      counted += 1;
    }
    return { usd, counted };
  }, [tasks.data]);

  return (
    <>
      <PageHeader title="Home" description="Live runtime overview" />
      <div className="flex-1 space-y-6 overflow-auto p-4 md:p-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat title="Health" value={status.data?.ok ? "Healthy" : status.isLoading ? "…" : "Down"} sub={`port ${status.data?.port ?? "—"}`} />
          <Stat title="Active tasks" value={String(activeTasks.length)} sub={activeTasks.length > 0 ? "in flight" : "no work in flight"} />
          <Stat title="Pending approvals" value={String(pending.length)} sub={pending.length > 0 ? "needs review" : "all clear"} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Today&apos;s cost</CardTitle>
              <CardDescription>Estimated USD across tasks updated in the last 24h</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">${todaysCost.usd.toFixed(4)}</p>
              <p className="text-xs text-muted-foreground">{todaysCost.counted} tasks with cost data</p>
            </CardContent>
          </Card>
          {/* "Memory changes needing review" card removed alongside the
              state.memories consolidation — pinned-memory proposals no
              longer exist as a surface. USER.md / SOUL.md / Hindsight are
              the three memory surfaces now. See ADR
              runtime-identity-files.md. */}
        </div>

        {pending.length > 0 ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="text-sm">Needs your approval</CardTitle>
                  <CardDescription>Pending actions blocking tasks</CardDescription>
                </div>
                {pendingExtra > 0 ? (
                  <Link
                    href="/permissions"
                    className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-accent"
                  >
                    View all ({pending.length})
                  </Link>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {pendingVisible.map((approval) => {
                  // browser.connect uses the reason as the body and a
                  // friendlier label as the title — the raw target
                  // is the same reason string, so the per-row
                  // rendering stays compact.
                  const isBrowserConnect = approval.action === "browser.connect";
                  // `browser.fill_secret` can only be resolved via /connect
                  // with per-slot values from the amber chat card. The
                  // generic /approve route refuses this action with 400.
                  // Hide both action buttons and point the operator to
                  // the chat session instead.
                  const isBrowserFillSecret = approval.action === "browser.fill_secret";
                  // The user-facing reason for browser.connect lives on
                  // payload.reason (set by the dispatch); fall back to the
                  // approval target (same string) if it's missing. We
                  // surface this instead of `approval.reason` (the policy
                  // engine's internal "why this needs approval" text)
                  // because the chat-side ApprovalActions card shows the
                  // user-facing reason — the home pending list should match.
                  // `||` (not `??`) so an empty-string reason also falls
                  // back to the approval target. `??` only fires for
                  // null/undefined; a payload that carried `reason: ""`
                  // would otherwise render a blank card body.
                  const browserConnectBody =
                    (typeof approval.payload.reason === "string" && approval.payload.reason.length > 0
                      ? approval.payload.reason
                      : undefined) || approval.target;
                  return (
                  <li key={approval.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px]">
                          {isBrowserConnect ? "Connect to agent's browser" : approval.action}
                        </span>
                        {shouldHideRiskBadge(approval.action) ? null : <RiskPill value={approval.risk} />}
                      </div>
                      {isBrowserConnect ? null : (
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{approval.target}</p>
                      )}
                      <p className="line-clamp-2 text-sm">
                        {isBrowserConnect ? browserConnectBody : approval.reason}
                      </p>
                    </div>
                    {isBrowserFillSecret ? (
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[11px] text-muted-foreground">
                          Enter credentials in chat.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
                        >
                          Deny
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: approval.id, op: "approve" })}
                        >
                          {isBrowserConnect ? "Connect" : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
                        >
                          {isBrowserConnect ? "Cancel" : "Deny"}
                        </Button>
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Active tasks</CardTitle>
            <CardDescription>Tasks currently queued, running, or waiting for approval</CardDescription>
          </CardHeader>
          <CardContent>
            {activeTasks.length === 0 ? (
              <EmptyState title="No active tasks" description="Submit a task from the Tasks tab." />
            ) : (
              <ul className="divide-y divide-border">
                {activeTasks.map((task) => {
                  const sessionId = taskToSession.get(task.id);
                  const body = (
                    <>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{task.title}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{task.id}</p>
                      </div>
                      <StatusPill value={task.status} />
                    </>
                  );
                  return (
                    <li key={task.id}>
                      {sessionId ? (
                        <Link
                          href={`/chat?session=${sessionId}`}
                          className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="flex items-center justify-between gap-3 py-2">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent events</CardTitle>
            <CardDescription>Latest runtime activity from /api/events</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              <ul className="space-y-2">
                {recent.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 rounded-md border border-border bg-card/50 px-3 py-2">
                    <StatusPill value={event.kind} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{event.summary || event.action}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {event.action} · {event.target}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">{new Date(event.at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-[11px] uppercase tracking-wide">{title}</CardDescription>
        <CardTitle className="text-2xl font-semibold">{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
