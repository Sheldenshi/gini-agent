"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RiskPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate } from "@/lib/queries";
import type { Approval } from "@runtime/types";

// Inline Approve / Deny actions rendered under the synthetic
// "Waiting for approval..." placeholder bubble in the chat. Filters
// approvals by the in-flight task id so the user doesn't have to
// navigate to /permissions while in a conversation.
//
// Visibility rules:
//   - Only renders when there's at least one PENDING approval bound to
//     `taskId`. Once decided, the placeholder swaps to the real
//     summary (or the task fails) and this component unmounts.
//   - The "Show command" disclosure is collapsed by default to keep the
//     bubble compact; opening it shows the full payload so the user can
//     audit before deciding.
export function ApprovalActions({ taskId }: { taskId: string }) {
  const approvals = useApprovals();
  const invalidate = useInvalidate();
  const [expanded, setExpanded] = useState(false);

  const pending = (approvals.data ?? []).filter(
    (a) => a.taskId === taskId && a.status === "pending"
  );

  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${id}/${op}`, { method: "POST" }),
    onSuccess: () => {
      // Invalidate everything the chat surface depends on so the placeholder
      // swaps to running → summary as soon as the runtime acks.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  if (pending.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {pending.map((approval) => (
        <div
          key={approval.id}
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-foreground">{approval.action}</span>
            <RiskPill value={approval.risk} />
            <button
              type="button"
              className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide command" : "Show command"}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{approval.reason}</p>
          <p className="mt-1 break-all font-mono text-[11px] text-foreground/90">
            {truncate(approval.target, expanded ? 4000 : 200)}
          </p>
          {expanded ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
              {JSON.stringify(approval.payload, null, 2)}
            </pre>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, op: "approve" })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
