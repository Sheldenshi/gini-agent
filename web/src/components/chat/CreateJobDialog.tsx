"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { JobRecord } from "@runtime/types";
import { humanCron } from "@/app/jobs/_components/schedule-label";

type ScheduleMode = "interval" | "cron";

// Minimal create-job dialog wired to POST /jobs (createScheduledJob). Required
// fields: name, prompt, and a schedule — either an interval in minutes
// (converted to `intervalSeconds`) or a 5-field cron expression
// (`cronExpression` + `cronTimezone`). The backend validates the rest; any
// rejection surfaces via toast.
export function CreateJobDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ScheduleMode>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [cronExpression, setCronExpression] = useState("");
  const [cronTimezone, setCronTimezone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPrompt("");
    setMode("interval");
    setIntervalMinutes("60");
    setCronExpression("");
    setCronTimezone("UTC");
    setError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<JobRecord>("/jobs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (job) => {
      toast.success(`Job created: ${job.name}`);
      invalidate(["jobs", "jobRuns", "events"]);
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message)
  });

  function submit() {
    if (create.isPending) return;
    setError(null);
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!trimmedPrompt) {
      setError("Prompt is required.");
      return;
    }
    const body: Record<string, unknown> = { name: trimmedName, prompt: trimmedPrompt };
    if (mode === "interval") {
      const minutes = Number(intervalMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setError("Interval must be a positive number of minutes.");
        return;
      }
      body.intervalSeconds = Math.round(minutes * 60);
    } else {
      const expr = cronExpression.trim();
      if (!expr) {
        setError("Cron expression is required.");
        return;
      }
      body.cronExpression = expr;
      const tz = cronTimezone.trim();
      body.cronTimezone = tz.length > 0 ? tz : "UTC";
    }
    create.mutate(body);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>A scheduled prompt this agent runs on a recurring basis.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-job-name">Name</Label>
            <Input
              id="new-job-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. daily-standup"
              autoFocus
              disabled={create.isPending}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-job-prompt">Prompt</Label>
            <Textarea
              id="new-job-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do each run?"
              rows={4}
              disabled={create.isPending}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Schedule</Label>
            <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Schedule mode">
              <Button
                type="button"
                size="sm"
                variant={mode === "interval" ? "default" : "ghost"}
                role="radio"
                aria-checked={mode === "interval"}
                onClick={() => setMode("interval")}
              >
                Interval
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "cron" ? "default" : "ghost"}
                role="radio"
                aria-checked={mode === "cron"}
                onClick={() => setMode("cron")}
              >
                Cron
              </Button>
            </div>
          </div>
          {mode === "interval" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="new-job-interval">Every (minutes)</Label>
              <Input
                id="new-job-interval"
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(event.target.value)}
                disabled={create.isPending}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="new-job-cron">Cron expression</Label>
                <Input
                  id="new-job-cron"
                  className="font-mono"
                  placeholder="0 9 * * *"
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.target.value)}
                  disabled={create.isPending}
                />
                {(() => {
                  const human = humanCron(cronExpression);
                  return human ? <p className="text-[11px] text-foreground">{human}</p> : null;
                })()}
                <p className="text-[10px] text-muted-foreground">
                  5-field Unix cron: minute hour day-of-month month day-of-week. 0=Sunday.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-job-tz">Timezone</Label>
                <Input
                  id="new-job-tz"
                  className="font-mono"
                  placeholder="America/Los_Angeles"
                  value={cronTimezone}
                  onChange={(event) => setCronTimezone(event.target.value)}
                  disabled={create.isPending}
                />
              </div>
            </>
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
