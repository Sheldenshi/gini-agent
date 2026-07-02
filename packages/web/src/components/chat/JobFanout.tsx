"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useEmailWatchers, useRemoveEmailWatcher, useUpdateEmailWatcher } from "@/lib/queries";
import type { EmailWatcherRecord, JobRecord, JobRoute } from "@runtime/types";

// Fan-out view for a job. Two render paths that mirror the runtime's
// domain-agnostic / email boundary:
//   - Generic: any job with routes renders a flat "Fans out to" list of
//     routeKey -> channel rows. Zero email knowledge.
//   - Email: a job whose pre-run hook is the gmail-watch skill renders the same
//     routes joined with the email watchers as editable concern cards (plus the
//     read-only "Inbox triage" catch-all). Edits write to the watchers API; the
//     job's routes are recomputed server-side, so jobs is invalidated after.
export function JobFanout({ job }: { job: JobRecord }) {
  const isEmailWatch = job.preRunHook?.config?.skill === "gmail-watch";
  if (isEmailWatch) return <EmailConcerns job={job} />;
  return <GenericRoutes routes={job.routes} />;
}

// The literal route key the email layer uses for the unmatched-mail catch-all.
const TRIAGE_ROUTE_KEY = "triage";

function GenericRoutes({ routes }: { routes?: Record<string, JobRoute> }) {
  const entries = Object.entries(routes ?? {});
  if (entries.length === 0) return null;
  return (
    <FanoutSection count={entries.length}>
      {entries.map(([routeKey, route]) => (
        <div
          key={routeKey}
          className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-card p-3.5"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-[13.5px] font-semibold text-foreground">{routeKey}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{route.chatSessionId}</p>
          </div>
          <OpenChannelLink chatSessionId={route.chatSessionId} />
        </div>
      ))}
    </FanoutSection>
  );
}

function EmailConcerns({ job }: { job: JobRecord }) {
  const watchers = useEmailWatchers();
  const entries = Object.entries(job.routes ?? {});
  if (entries.length === 0) return null;
  const byId = new Map((watchers.data ?? []).map((w) => [w.id, w]));
  return (
    <FanoutSection count={entries.length}>
      {entries.map(([routeKey, route]) => {
        if (routeKey === TRIAGE_ROUTE_KEY) {
          return <TriageCard key={routeKey} route={route} />;
        }
        const watcher = byId.get(routeKey);
        if (!watcher) {
          // The watcher list hasn't loaded yet (or was removed out from under
          // us). Fall back to the generic row so the channel is still reachable.
          return (
            <div
              key={routeKey}
              className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-card p-3.5"
            >
              <p className="truncate font-mono text-[11px] text-muted-foreground">{routeKey}</p>
              <OpenChannelLink chatSessionId={route.chatSessionId} />
            </div>
          );
        }
        return <ConcernCard key={routeKey} watcher={watcher} route={route} />;
      })}
    </FanoutSection>
  );
}

function FanoutSection({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="px-1 text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
        Fans out to · {count}
      </span>
      {children}
    </div>
  );
}

// Human-readable matcher label for a watcher. Mirrors the runtime's
// sender / thread / raw-query precedence.
function matcherLabel(watcher: EmailWatcherRecord): string {
  if (watcher.sender) return `Email: ${watcher.sender}`;
  if (watcher.threadId) return `Email thread: ${watcher.threadId}`;
  return watcher.query;
}

function ConcernCard({ watcher, route }: { watcher: EmailWatcherRecord; route: JobRoute }) {
  const update = useUpdateEmailWatcher();
  const remove = useRemoveEmailWatcher();
  const [objective, setObjective] = useState(watcher.objective ?? "");

  const dirty = objective.trim() !== (watcher.objective ?? "");
  const saveObjective = () => {
    if (!dirty) return;
    const next = objective.trim();
    update.mutate(
      { id: watcher.id, objective: next === "" ? null : next },
      {
        onSuccess: () => toast.success("Objective updated"),
        onError: (error) => toast.error(error.message)
      }
    );
  };
  const toggleEnabled = () => {
    update.mutate(
      { id: watcher.id, enabled: !watcher.enabled },
      {
        onSuccess: () => toast.success(watcher.enabled ? "Concern paused" : "Concern enabled"),
        onError: (error) => toast.error(error.message)
      }
    );
  };
  const removeConcern = () => {
    if (!window.confirm(`Remove this concern (${matcherLabel(watcher)})?`)) return;
    remove.mutate(watcher.id, {
      onSuccess: () => toast.success("Concern removed"),
      onError: (error) => toast.error(error.message)
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3.5">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-[13.5px] font-semibold text-foreground">{matcherLabel(watcher)}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{route.chatSessionId}</p>
        </div>
        <OpenChannelLink chatSessionId={route.chatSessionId} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">Objective</label>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          onBlur={saveObjective}
          rows={2}
          placeholder="What should the reply achieve?"
          disabled={update.isPending}
          className="resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
      </div>

      <div className="flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={update.isPending}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50",
            watcher.enabled
              ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:bg-[#14331E] dark:text-[#4ADE80]"
              : "border border-border bg-card text-muted-foreground hover:bg-muted"
          )}
        >
          {watcher.enabled ? "Enabled" : "Paused"}
        </button>
        <button
          type="button"
          onClick={removeConcern}
          disabled={remove.isPending}
          className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-[12px] font-semibold text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function TriageCard({ route }: { route: JobRoute }) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-dashed border-border bg-card/40 p-3.5">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-[13.5px] font-semibold text-foreground">Inbox triage</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{route.chatSessionId}</p>
        </div>
        <OpenChannelLink chatSessionId={route.chatSessionId} />
      </div>
      <p className="text-[12px] text-muted-foreground">Catch-all: drafts or flags unmatched mail.</p>
    </div>
  );
}

function OpenChannelLink({ chatSessionId }: { chatSessionId: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/chat?session=${chatSessionId}`)}
      className="flex shrink-0 items-center gap-1 rounded-[7px] border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted"
    >
      Open
      <ArrowUpRight className="size-[13px] text-muted-foreground" />
    </button>
  );
}
