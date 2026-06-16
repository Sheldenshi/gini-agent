"use client";

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

export function ArchiveAgentDialog({
  agent,
  open,
  onOpenChange
}: {
  agent: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();

  const archive = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/archive`, { method: "POST" }),
    onSuccess: () => {
      toast.success(agent ? `Agent "${agent.name}" archived` : "Agent archived");
      invalidate(["agents", "state", "status", "memory", "agent-chat"]);
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {agent?.name}?</DialogTitle>
          <DialogDescription>
            {agent?.name} will move to your Archived section and stop running.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={archive.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => agent && archive.mutate(agent.id)}
            disabled={archive.isPending}
          >
            {archive.isPending ? "Archiving…" : "Archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
