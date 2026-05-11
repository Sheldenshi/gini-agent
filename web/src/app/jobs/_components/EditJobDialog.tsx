"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { JobRecord } from "@runtime/types";

export function EditJobDialog({ job }: { job: JobRecord }) {
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  // Per the brief: editable fields are schedule (intervalSeconds in the
  // runtime), retryLimit, timeoutSeconds, costBudget, deliveryTargets[].
  const [intervalSeconds, setIntervalSeconds] = useState(String(job.intervalSeconds));
  const [retryLimit, setRetryLimit] = useState(String(job.retryLimit));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(job.timeoutSeconds));
  const [costBudget, setCostBudget] = useState(typeof job.costBudget === "number" ? String(job.costBudget) : "");
  const [deliveryTargetsRaw, setDeliveryTargetsRaw] = useState((job.deliveryTargets ?? []).join(", "));

  // The selected job can change while this component instance is reused
  // (parent JobDetail re-renders with a different `job` when the user picks
  // a different row in the list). Reset form state when the job id changes
  // OR when the dialog opens — otherwise edits silently overwrite the wrong
  // record with stale field values from the previous selection.
  useEffect(() => {
    setIntervalSeconds(String(job.intervalSeconds));
    setRetryLimit(String(job.retryLimit));
    setTimeoutSeconds(String(job.timeoutSeconds));
    setCostBudget(typeof job.costBudget === "number" ? String(job.costBudget) : "");
    setDeliveryTargetsRaw((job.deliveryTargets ?? []).join(", "));
  }, [job.id, job.intervalSeconds, job.retryLimit, job.timeoutSeconds, job.costBudget, job.deliveryTargets, open]);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<JobRecord>(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success(`Job updated: ${job.id}`);
      invalidate(["jobs", "events"]);
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  function submit() {
    const patch: Record<string, unknown> = {};
    const interval = Number(intervalSeconds);
    if (Number.isFinite(interval) && interval > 0) patch.intervalSeconds = interval;
    const retry = Number(retryLimit);
    if (Number.isFinite(retry) && retry >= 0) patch.retryLimit = retry;
    const timeout = Number(timeoutSeconds);
    if (Number.isFinite(timeout) && timeout > 0) patch.timeoutSeconds = timeout;
    if (costBudget.trim() === "") {
      // Empty input means "clear the budget". The runtime's updateJob
      // explicitly handles `costBudget: null` as the clearing path; sending
      // `undefined` (or omitting the field) would leave the prior value
      // in place.
      patch.costBudget = null;
    } else {
      const budget = Number(costBudget);
      if (Number.isFinite(budget) && budget >= 0) patch.costBudget = budget;
    }
    const targets = deliveryTargetsRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    patch.deliveryTargets = targets;
    update.mutate(patch);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit job</DialogTitle>
          <DialogDescription className="font-mono text-[11px]">{job.id}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="job-interval">Schedule (interval seconds)</Label>
            <Input
              id="job-interval"
              type="number"
              min={1}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="job-retry">Retry limit</Label>
              <Input
                id="job-retry"
                type="number"
                min={0}
                value={retryLimit}
                onChange={(event) => setRetryLimit(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-timeout">Timeout (seconds)</Label>
              <Input
                id="job-timeout"
                type="number"
                min={1}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-budget">Cost budget (USD)</Label>
            <Input
              id="job-budget"
              type="number"
              min={0}
              step="0.01"
              placeholder="—"
              value={costBudget}
              onChange={(event) => setCostBudget(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-targets">Delivery targets</Label>
            <Input
              id="job-targets"
              placeholder="local, slack-bridge"
              value={deliveryTargetsRaw}
              onChange={(event) => setDeliveryTargetsRaw(event.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Comma-separated.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={update.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
