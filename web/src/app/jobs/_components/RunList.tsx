"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import type { JobRunRecord, Task } from "@runtime/types";

export function RunList({
  runs,
  replayPending,
  onReplay
}: {
  runs: JobRunRecord[];
  replayPending: boolean;
  onReplay: (id: string) => void;
}) {
  return (
    <ul className="space-y-2 pb-6">
      {runs.slice().reverse().map((run) => (
        <li key={run.id} className="rounded-md border border-border bg-card/50 px-3 py-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[11px]">{run.id}</p>
              <p className="text-[11px] text-muted-foreground">
                {run.trigger} · attempt {run.attempt} · {new Date(run.createdAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill value={run.status} />
              {run.taskId ? (
                <Button asChild size="sm" variant="outline">
                  {/* Tasks page (after R3-M1) renders a Timeline tab that
                      surfaces logs/tools/files for each run. We deep-link to
                      that page so reviewers can trace any run from here. */}
                  <Link href={`/tasks?id=${run.taskId}`}>View trace</Link>
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={replayPending} onClick={() => onReplay(run.id)}>Replay</Button>
            </div>
          </div>
          {run.summary ? <p className="mt-1 text-xs">{run.summary}</p> : null}
          {run.error ? <p className="mt-1 text-xs text-red-400">{run.error}</p> : null}
          {run.taskId ? <RunTaskLink taskId={run.taskId} /> : null}
          {run.cost ? (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              cost: {run.cost.provider}/{run.cost.model}
              {typeof run.cost.totalTokens === "number" ? ` · ${run.cost.totalTokens.toLocaleString()} tokens` : ""}
              {typeof run.cost.estimatedUsd === "number" ? ` · $${run.cost.estimatedUsd.toFixed(4)}` : ""}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RunTaskLink({ taskId }: { taskId: string }) {
  // Pulls the task summary so the run row links to a useful preview rather than
  // a bare id. We poll on the same cadence as the runs list so it self-refreshes
  // while a task moves from running → completed.
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<{ task: Task }>(`/tasks/${taskId}`),
    enabled: Boolean(taskId),
    refetchInterval: 5000
  });
  return (
    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
      task {taskId}
      {task.data?.task?.status ? ` · ${task.data.task.status}` : ""}
    </p>
  );
}
