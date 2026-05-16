"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import type { JobRecord } from "@runtime/types";
import { scheduleLabel } from "./schedule-label";

export function JobList({
  jobs,
  selected,
  actionPending,
  onSelect,
  onAction
}: {
  jobs: JobRecord[];
  selected: string | null;
  actionPending: boolean;
  onSelect: (id: string) => void;
  onAction: (id: string, op: "run" | "pause" | "resume") => void;
}) {
  if (jobs.length === 0) {
    return <EmptyState title="No jobs" description="Add via `gini job add` for now." />;
  }
  return (
    <>
      {jobs.map((job) => (
        <Card
          key={job.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(job.id)}
          className={`cursor-pointer transition-colors ${selected === job.id ? "border-primary" : ""}`}
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="line-clamp-1 text-sm">{job.name}</CardTitle>
                <CardDescription
                  className="font-mono text-[11px]"
                  // Surface the raw cron expression as a hover tooltip on
                  // cron jobs so power users can inspect the source pattern
                  // without leaving the list. Interval jobs use the default
                  // browser tooltip (none) — the label already shows the
                  // cadence in full.
                  title={job.cronExpression ?? undefined}
                >
                  {job.id} · {scheduleLabel(job)}
                </CardDescription>
              </div>
              <StatusPill value={job.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-1 text-[11px] text-muted-foreground">
            <p>last run {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}</p>
            <p>next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</p>
            <p>{job.runCount} runs · {job.missedRuns} missed</p>
            <div className="flex gap-1.5 pt-1">
              <Button size="sm" variant="outline" disabled={actionPending} onClick={(event) => { event.stopPropagation(); onAction(job.id, "run"); }}>Run</Button>
              {job.status === "active" ? (
                <Button size="sm" variant="outline" disabled={actionPending} onClick={(event) => { event.stopPropagation(); onAction(job.id, "pause"); }}>Pause</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={actionPending} onClick={(event) => { event.stopPropagation(); onAction(job.id, "resume"); }}>Resume</Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
