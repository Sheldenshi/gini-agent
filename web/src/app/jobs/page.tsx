"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useAllJobs, useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord } from "@runtime/types";
import { JobList } from "./_components/JobList";
import { JobDetail } from "./_components/JobDetail";
import { RunList } from "./_components/RunList";
import { CalendarView } from "./_components/calendar/calendar-view";
import { adaptJob, adaptRun } from "./_components/calendar/types";

export default function JobsPage() {
  const jobs = useJobs();
  // Warm unscoped list (shared with the sidebar) — fallback for resolving a
  // deep-linked job whose owning agent isn't the active one yet.
  const allJobs = useAllJobs();
  const params = useSearchParams();
  // Deep-link from a channel's "Back to job" link: ?job=<id> preselects that
  // job in JobDetail. The initializer runs once on mount, which is sufficient.
  const [selected, setSelected] = useState<string | null>(params?.get("job") ?? null);
  // Job pending delete confirmation. Null when the dialog is closed. Deleting a
  // job cascade-removes its run history, so the confirmation is mandatory.
  const [deleting, setDeleting] = useState<JobRecord | null>(null);
  const runs = useJobRuns(selected ?? undefined);
  // For the calendar tab we need every run (across all jobs), not just the
  // selected job's runs. `useJobRuns(undefined)` resolves to `/job-runs`.
  const allRuns = useJobRuns();
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

  const remove = useMutation({
    mutationFn: (id: string) => api<JobRecord>(`/jobs/${id}`, { method: "DELETE" }),
    onSuccess: (job) => {
      toast.success(`Deleted ${job.name}`);
      setDeleting(null);
      // Clear the detail panel if the deleted job was selected.
      setSelected((current) => (current === job.id ? null : current));
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const calendarJobs = (jobs.data ?? []).map(adaptJob);
  const calendarRuns = (allRuns.data ?? []).map(adaptRun);
  const calendarLoading = jobs.isLoading || allRuns.isLoading;
  const calendarError =
    jobs.error?.message ?? allRuns.error?.message ?? null;
  const handleCalendarRefresh = async () => {
    await Promise.all([jobs.refetch(), allRuns.refetch()]);
  };

  return (
    <>
      <PageHeader title="Jobs" description="Scheduled prompts and scripts" />
      <div className="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
        <Tabs defaultValue="list" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="flex-1 overflow-hidden">
            <div className="flex h-full flex-col gap-4 overflow-hidden md:flex-row">
              <div className="flex w-full shrink-0 flex-col gap-2 overflow-auto md:w-96">
                <JobList
                  jobs={jobs.data ?? []}
                  selected={selected}
                  actionPending={action.isPending}
                  onSelect={setSelected}
                  onAction={(id, op) => action.mutate({ id, op })}
                  onRequestDelete={(id) =>
                    setDeleting(
                      (jobs.data ?? []).find((j) => j.id === id) ??
                        (allJobs.data ?? []).find((j) => j.id === id) ??
                        null
                    )
                  }
                />
              </div>

              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {selected ? (
                  <JobDetail
                    job={
                      (jobs.data ?? []).find((j) => j.id === selected) ??
                      (allJobs.data ?? []).find((j) => j.id === selected) ??
                      null
                    }
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
          </TabsContent>
          <TabsContent value="calendar" className="flex-1 overflow-hidden">
            <Card className="flex h-full flex-col overflow-hidden">
              <CalendarView
                status={{ enabled: true }}
                jobs={calendarJobs}
                runs={calendarRuns}
                loading={calendarLoading}
                error={calendarError}
                onRefresh={handleCalendarRefresh}
                highlightJobId={null}
              />
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Delete {deleting?.name ?? "job"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            This permanently removes the job and its run history. This can&rsquo;t be undone.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => setDeleting(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleting && remove.mutate(deleting.id)}
              disabled={!deleting || remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
