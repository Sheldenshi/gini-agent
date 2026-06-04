"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/PageHeader";
import { JobList } from "@/app/jobs/_components/JobList";
import { JobDetail } from "@/app/jobs/_components/JobDetail";
import { RunList } from "@/app/jobs/_components/RunList";
import { api } from "@/lib/api";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord } from "@runtime/types";

// Per-agent Jobs tab — design `pu4J9`. Split pane: the agent's scheduled jobs
// on the left, the selected job's detail / all-run history on the right.
// Reuses the standalone Jobs page components; `useJobs`/`useJobRuns` are
// already scoped to the active agent.
export function JobsTab() {
  const jobs = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useJobRuns(selected ?? undefined);
  const invalidate = useInvalidate();

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
    onSuccess: () => invalidate(["jobs", "jobRuns", "events"])
  });

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4 md:p-6">
      <div className="flex w-full shrink-0 flex-col gap-2 overflow-auto md:w-80">
        <JobList
          jobs={jobs.data ?? []}
          selected={selected}
          actionPending={action.isPending}
          onSelect={setSelected}
          onAction={(id, op) => action.mutate({ id, op })}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <JobDetail
            job={(jobs.data ?? []).find((j) => j.id === selected) ?? null}
            runs={runs.data ?? []}
            replayPending={replay.isPending}
            onReplay={(id) => replay.mutate(id)}
          />
        ) : (
          <Card className="flex flex-1 flex-col overflow-hidden">
            <CardHeader>
              <CardTitle className="text-sm">All run history</CardTitle>
              <CardDescription>Select a job to filter and inspect</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden">
              <ScrollArea className="h-full pr-3">
                {(runs.data ?? []).length === 0 ? (
                  <EmptyState title="No runs yet" />
                ) : (
                  <RunList
                    runs={runs.data ?? []}
                    replayPending={replay.isPending}
                    onReplay={(id) => replay.mutate(id)}
                  />
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
