"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
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

interface AgentRecord {
  id: string;
  name: string;
}

export function CreateAgentDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: async (input: { name: string }) => {
      const created = await api<AgentRecord>("/agents", {
        method: "POST",
        body: JSON.stringify({ name: input.name })
      });
      // The new agent exists server-side from this point on, even if /use
      // fails below. Refresh caches so it's visible in the dropdown and a
      // retry doesn't create a duplicate (the API has no name-uniqueness
      // check).
      invalidate(["agents", "state", "status", "memory"]);
      try {
        await api(`/agents/${encodeURIComponent(created.id)}/use`, { method: "POST" });
        return { record: created, activated: true as const };
      } catch (activationErr) {
        const message = activationErr instanceof Error ? activationErr.message : String(activationErr);
        return { record: created, activated: false as const, activationError: message };
      }
    },
    onSuccess: (result) => {
      if (result.activated) {
        toast.success(`Agent "${result.record.name}" created`);
      } else {
        toast.success(`Agent "${result.record.name}" created`);
        toast.error(`Could not activate: ${result.activationError}`);
      }
      invalidate(["agents", "state", "status", "memory"]);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const submit = () => {
    if (create.isPending) return;
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    create.mutate({ name: trimmed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            A new agent inherits provider, toolsets, and messaging from the default agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. research"
              autoFocus
              required
              aria-invalid={!!error}
              aria-describedby="agent-name-error"
              disabled={create.isPending}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          {error ? (
            <p id="agent-name-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
