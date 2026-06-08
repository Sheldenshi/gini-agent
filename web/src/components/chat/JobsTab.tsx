"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, List, Calendar } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { scheduleLabel } from "@/app/jobs/_components/schedule-label";
import { CalendarView } from "@/app/jobs/_components/calendar/calendar-view";
import { adaptJob, adaptRun } from "@/app/jobs/_components/calendar/types";
import { api } from "@/lib/api";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord, JobStatus } from "@runtime/types";

type View = "list" | "calendar";
type StatusFilter = "all" | "active" | "paused";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All",
  active: "Active",
  paused: "Paused"
};

// Per-agent Jobs tab — design `pu4J9` ("Agent Page — Jobs list").
// A Page Header (Jobs title + subtitle and a List⇆Calendar toggle) sits above
// a two-column list body: jobs on the left, recent runs on the right.
// `useJobs`/`useJobRuns` are already scoped to the active agent, so both
// columns show only this agent's jobs and runs.
export function JobsTab() {
  const jobs = useJobs();
  const runs = useJobRuns();
  const invalidate = useInvalidate();
  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "run" | "pause" | "resume" }) =>
      api<JobRecord>(`/jobs/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const replay = useMutation({
    mutationFn: (runId: string) => api<JobRunRecord>(`/job-runs/${runId}/replay`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Replay queued");
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const allJobs = jobs.data ?? [];
  const filteredJobs = useMemo(
    () => (statusFilter === "all" ? allJobs : allJobs.filter((j) => j.status === statusFilter)),
    [allJobs, statusFilter]
  );

  // Recent runs, newest first, capped. The header count is runs whose
  // createdAt falls within the last 24h (the JobRunRecord has no separate
  // startedAt; createdAt is when the run was claimed).
  const allRuns = runs.data ?? [];
  const recentRuns = useMemo(
    () => allRuns.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    [allRuns]
  );
  const runsLast24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return allRuns.filter((r) => new Date(r.createdAt).getTime() >= cutoff).length;
  }, [allRuns]);

  const calendarJobs = allJobs.map(adaptJob);
  const calendarRuns = allRuns.map(adaptRun);
  const calendarLoading = jobs.isLoading || runs.isLoading;
  const calendarError = jobs.error?.message ?? runs.error?.message ?? null;
  const handleCalendarRefresh = async () => {
    await Promise.all([jobs.refetch(), runs.refetch()]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Page Header — design `ZR4lj` */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-[22px]">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[28px] font-bold leading-none text-foreground">Jobs</h2>
          <p className="text-sm font-medium text-muted-foreground">
            Scheduled prompts and scripts owned by this agent
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {view === "list" ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex gap-6 px-8 pb-8 pt-6">
            {/* Jobs column */}
            <div className="flex w-[520px] shrink-0 flex-col gap-3.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
                  Jobs · {allJobs.length}
                </span>
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <SelectTrigger
                    size="sm"
                    className="h-auto gap-1 border-0 bg-transparent px-0 py-0 text-[11px] font-semibold text-foreground shadow-none focus-visible:ring-0 [&_svg]:text-muted-foreground"
                  >
                    <SelectValue>{STATUS_FILTER_LABELS[statusFilter]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {filteredJobs.length === 0 ? (
                <EmptyColumn label={allJobs.length === 0 ? "No jobs yet" : "No jobs match this filter"} />
              ) : (
                filteredJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    actionPending={action.isPending}
                    onAction={(op) => action.mutate({ id: job.id, op })}
                  />
                ))
              )}
            </div>

            {/* Runs column */}
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
                  Recent runs · {runsLast24h} in the last 24h
                </span>
                <Link
                  href="/jobs"
                  className="flex items-center gap-1 text-[11px] font-semibold text-foreground transition-opacity hover:opacity-80"
                >
                  View all runs
                  <ArrowRight className="size-[11px] text-muted-foreground" />
                </Link>
              </div>
              {recentRuns.length === 0 ? (
                <EmptyColumn label="No runs yet" />
              ) : (
                recentRuns.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    replayPending={replay.isPending}
                    onReplay={() => replay.mutate(run.id)}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-8">
          <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-card">
            <CalendarView
              status={{ enabled: true }}
              jobs={calendarJobs}
              runs={calendarRuns}
              loading={calendarLoading}
              error={calendarError}
              onRefresh={handleCalendarRefresh}
              highlightJobId={null}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Segmented List ⇆ Calendar control — design View Toggle (`nw3zd`):
// #141418 container, 4px padding, rounded-10; the active segment fills
// #E8E8EC with dark text.
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const segments: { id: View; label: string; Icon: typeof List }[] = [
    { id: "list", label: "List", Icon: List },
    { id: "calendar", label: "Calendar", Icon: Calendar }
  ];
  return (
    <div className="flex gap-1 rounded-[10px] border border-border bg-card p-1">
      {segments.map(({ id, label, Icon }) => {
        const isActive = view === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-[7px] px-4 py-[7px] text-[13px] transition-colors",
              isActive ? "bg-primary font-semibold text-primary-foreground" : "font-bold text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-[13px]" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Job card — design `y6aU9` (Job List Item).
function JobCard({
  job,
  actionPending,
  onAction
}: {
  job: JobRecord;
  actionPending: boolean;
  onAction: (op: "run" | "pause" | "resume") => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[10px] border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="truncate text-[15px] font-semibold text-foreground">{job.name}</p>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={job.cronExpression ?? undefined}>
            {job.id} · {scheduleLabel(job)}
          </p>
        </div>
        <JobStatusBadge status={job.status} />
      </div>
      <div className="flex flex-col gap-[5px] text-[12.5px] text-muted-foreground">
        <span>last run {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}</span>
        <span>next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</span>
        <span className="font-medium text-muted-foreground">
          {job.runCount} runs · {job.missedRuns} missed
        </span>
      </div>
      <div className="flex gap-2.5">
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onAction("run")}
          className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Run
        </button>
        {job.status === "active" ? (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAction("pause")}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAction("resume")}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Resume
          </button>
        )}
      </div>
    </div>
  );
}

// Run card — design `k0gv7` (Run History Item).
function RunCard({
  run,
  replayPending,
  onReplay
}: {
  run: JobRunRecord;
  replayPending: boolean;
  onReplay: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <p className="truncate font-mono text-[13px] font-medium text-foreground">{run.id}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {run.trigger} · attempt {run.attempt} · {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RunStatusBadge status={run.status} />
          {run.taskId ? (
            <Link
              href={`/tasks?id=${run.taskId}`}
              className="rounded-[7px] border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              View trace
            </Link>
          ) : null}
          <button
            type="button"
            disabled={replayPending}
            onClick={onReplay}
            className="rounded-[7px] border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Replay
          </button>
        </div>
      </div>
      {run.summary ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground">{run.summary}</p>
      ) : null}
      {run.error ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-red-400">{run.error}</p>
      ) : null}
      {run.taskId ? (
        <div className="border-t border-border pt-2.5">
          <p className="font-mono text-[11.5px] text-muted-foreground">
            task {run.taskId} · {run.status}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Job status badge — ACTIVE (green) / PAUSED (gray) / FAILED (red), per the
// design's badge styling (`yvi2R` active, `w3otfA` paused).
function JobStatusBadge({ status }: { status: JobStatus }) {
  const tone =
    status === "active"
      ? "bg-[#14331E] text-[#4ADE80]"
      : status === "failed"
        ? "bg-[#3A1A1A] text-[#F87171]"
        : "bg-[#2A2A2E] text-[#C2C2C8]";
  return (
    <span className={cn("shrink-0 rounded-md px-[9px] py-1 text-[10px] font-bold uppercase tracking-[0.6px]", tone)}>
      {status}
    </span>
  );
}

// Run status badge — COMPLETED (green) / FAILED (red) / RUNNING (blue), per
// the design's run badge (`wTUcV`).
function RunStatusBadge({ status }: { status: JobRunRecord["status"] }) {
  const tone =
    status === "completed"
      ? "bg-[#14331E] text-[#4ADE80]"
      : status === "failed"
        ? "bg-[#3A1A1A] text-[#F87171]"
        : "bg-[#16243B] text-[#60A5FA]";
  return (
    <span className={cn("rounded-md px-[9px] py-1 text-[10px] font-bold uppercase tracking-[0.6px]", tone)}>
      {status}
    </span>
  );
}

function EmptyColumn({ label }: { label: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-border bg-card/40 px-4 py-8 text-center text-[13px] text-muted-foreground">
      {label}
    </div>
  );
}
