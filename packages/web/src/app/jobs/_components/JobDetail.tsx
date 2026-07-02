"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import type { JobRecord, JobRunRecord } from "@runtime/types";
import { JobFanout } from "@/components/chat/JobFanout";
import { RunList } from "./RunList";
import { EditJobDialog } from "./EditJobDialog";
import { scheduleLabel } from "./schedule-label";

export function JobDetail({
  job,
  runs,
  replayPending,
  onReplay
}: {
  job: JobRecord | null;
  runs: JobRunRecord[];
  replayPending: boolean;
  onReplay: (id: string) => void;
}) {
  if (!job) return <EmptyState title="Job not found" />;
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{job.name}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{job.id} · {scheduleLabel(job)}</CardDescription>
            {job.cronExpression ? (
              // Surface the raw cron expression as a smaller monospace
              // line so power users can still inspect the source-of-truth
              // pattern even though the primary label renders the human
              // English version above.
              <p className="font-mono text-[10px] text-muted-foreground" title="Raw cron expression">
                {job.cronExpression}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <StatusPill value={job.status} />
            <EditJobDialog job={job} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <KV label="Last run" value={job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"} />
                  <KV label="Next run" value={job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"} />
                  <KV label="Last success" value={job.lastSuccessAt ? new Date(job.lastSuccessAt).toLocaleString() : "—"} />
                  <KV label="Last failure" value={job.lastFailureAt ? new Date(job.lastFailureAt).toLocaleString() : "—"} />
                  <KV label="Run count" value={String(job.runCount)} />
                  <KV label="Missed runs" value={String(job.missedRuns)} />
                  <KV label="Retry limit" value={String(job.retryLimit ?? "—")} />
                  <KV label="Timeout" value={`${job.timeoutSeconds ?? "—"}s`} />
                  {typeof job.costBudget === "number" ? <KV label="Cost budget" value={`$${job.costBudget.toFixed(2)}`} /> : null}
                </div>
                {(job.deliveryTargets?.length ?? 0) > 0 ? (
                  <Section title="Delivery targets">
                    <ul className="flex flex-wrap gap-1">
                      {job.deliveryTargets.map((target) => (
                        <li key={target} className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {target}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {(job.context?.length ?? 0) > 0 ? (
                  <Section title="Context">
                    <ul className="flex flex-wrap gap-1">
                      {job.context.map((c) => (
                        <li key={c} className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {c}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {/* Fan-out concerns. Renders nothing when the job has no
                    routes; JobFanout owns the generic-vs-email branch. */}
                <JobFanout job={job} />
                {job.lastError ? (
                  <Section title="Last error">
                    <pre className="whitespace-pre-wrap text-xs text-red-400">{job.lastError}</pre>
                  </Section>
                ) : null}
                <Section title="Alerts (coming soon)">
                  {/* Placeholder. No alert endpoints exist in the runtime yet,
                      so we acknowledge the surface rather than fake controls. */}
                  <p className="text-xs text-muted-foreground">
                    Per-job failure alerts will land alongside the notifications surface.
                  </p>
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="runs" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              {runs.length === 0 ? (
                <EmptyState title="No runs yet" />
              ) : (
                <RunList runs={runs} replayPending={replayPending} onReplay={onReplay} />
              )}
            </ScrollArea>
          </TabsContent>
          <TabsContent value="prompt" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <Section title="Prompt">
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 font-mono text-xs">{job.prompt}</pre>
              </Section>
              {job.script ? (
                <div className="mt-4">
                  <Section title="Script">
                    <pre className="whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 font-mono text-xs">{job.script}</pre>
                  </Section>
                </div>
              ) : null}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  );
}
