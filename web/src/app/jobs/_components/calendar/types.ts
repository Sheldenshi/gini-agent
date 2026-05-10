// Calendar-local view types. The ported calendar components were originally
// written against babyclaw's `CronJob` / `CronRunLogEntry` shape; gini uses
// `JobRecord` / `JobRunRecord` which carry richer (and slightly different)
// fields. Rather than rewrite every component, we keep their internal type
// names (re-aliased per file) and adapt the runtime shapes here.
import type { JobRecord, JobRunRecord } from "@runtime/types";

export type CalendarSchedule = { kind: "every"; everyMs: number; anchorMs?: number };

export interface CalendarJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  schedule: CalendarSchedule;
  state?: { nextRunAtMs?: number; lastRunAtMs?: number };
  prompt: string;
  script?: string;
}

export interface CalendarRunEntry {
  jobId: string;
  ts: number; // sort key: completedAt or createdAt
  status: "ok" | "error" | "skipped";
  runAtMs?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  model?: string;
}

export interface CalendarStatus {
  enabled: boolean; // scheduler enabled? Always true for gini.
}

export function adaptJob(job: JobRecord): CalendarJob {
  const createdAtMs = Date.parse(job.createdAt);
  return {
    id: job.id,
    name: job.name,
    enabled: job.status === "active",
    createdAtMs,
    schedule: {
      kind: "every",
      everyMs: job.intervalSeconds * 1000,
      anchorMs: createdAtMs
    },
    state: {
      nextRunAtMs: job.nextRunAt ? Date.parse(job.nextRunAt) : undefined,
      lastRunAtMs: job.lastRunAt ? Date.parse(job.lastRunAt) : undefined
    },
    prompt: job.prompt,
    script: job.script
  };
}

export function adaptRun(run: JobRunRecord): CalendarRunEntry {
  const tsSource = run.completedAt ?? run.createdAt;
  const createdMs = Date.parse(run.createdAt);
  const completedMs = run.completedAt ? Date.parse(run.completedAt) : undefined;
  return {
    jobId: run.jobId,
    ts: Date.parse(tsSource),
    status:
      run.status === "completed" ? "ok" : run.status === "failed" ? "error" : "skipped",
    runAtMs: createdMs,
    durationMs: completedMs ? completedMs - createdMs : undefined,
    summary: run.summary,
    error: run.error
  };
}
