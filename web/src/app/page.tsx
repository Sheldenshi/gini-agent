"use client";

import { useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { useApprovals, useConnectors, useEvents, useInvalidate, useJobs, useStatus, useTasks } from "@/lib/queries";
import { useRuntimeStream } from "@/lib/useRuntimeStream";

export default function HomePage() {
  const status = useStatus();
  const tasks = useTasks();
  const approvals = useApprovals();
  const jobs = useJobs();
  const connectors = useConnectors();
  const events = useEvents();
  const invalidate = useInvalidate();

  useRuntimeStream(useCallback(() => {
    invalidate(["status", "state", "tasks", "approvals", "jobs", "connectors", "events"]);
  }, [invalidate]));

  const activeTasks = (tasks.data ?? []).filter((t) => ["queued", "running", "waiting_approval"].includes(t.status));
  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  const failedJobs = (jobs.data ?? []).filter((j) => j.status === "failed");
  const connectorIssues = (connectors.data ?? []).filter((c) => c.health === "unhealthy" || c.status === "error");
  const recent = (events.data ?? []).slice().reverse().slice(0, 8);

  return (
    <>
      <PageHeader title="Home" description="Live runtime overview" />
      <div className="flex-1 space-y-6 overflow-auto p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat title="Health" value={status.data?.ok ? "Healthy" : status.isLoading ? "…" : "Down"} sub={`port ${status.data?.port ?? "—"}`} />
          <Stat title="Active tasks" value={String(activeTasks.length)} sub={activeTasks.length > 0 ? `of ${tasks.data?.length ?? 0} lifetime` : "no work in flight"} />
          <Stat title="Pending approvals" value={String(pending.length)} sub={pending.length > 0 ? "needs review" : "all clear"} />
          <Stat title="Failed jobs" value={String(failedJobs.length)} sub={`${jobs.data?.length ?? 0} jobs`} />
          <Stat title="Connector issues" value={String(connectorIssues.length)} sub={`${connectors.data?.length ?? 0} configured`} />
        </div>

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
                {activeTasks.map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{task.title}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{task.id}</p>
                    </div>
                    <StatusPill value={task.status} />
                  </li>
                ))}
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
