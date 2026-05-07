"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate } from "@/lib/queries";
import type { Approval } from "@runtime/types";

export default function PermissionsPage() {
  const approvals = useApprovals();
  const invalidate = useInvalidate();
  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  const decided = (approvals.data ?? []).filter((a) => a.status !== "pending").slice().reverse();

  return (
    <>
      <PageHeader title="Permissions" description="Review and decide pending approvals" />
      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
            <TabsTrigger value="history">History ({decided.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="mt-4">
            {pending.length === 0 ? (
              <EmptyState title="No pending approvals" description="Approvals created by tasks appear here." />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {pending.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} onDecide={(op) => decide.mutate({ id: approval.id, op })} pending={decide.isPending} />
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            {decided.length === 0 ? (
              <EmptyState title="No decisions yet" />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {decided.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ApprovalCard({ approval, onDecide, pending }: { approval: Approval; onDecide?: (op: "approve" | "deny") => void; pending?: boolean }) {
  const diff = typeof approval.payload?.diff === "string" ? approval.payload.diff : null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-mono text-sm">{approval.action}</CardTitle>
            <CardDescription className="line-clamp-1 font-mono text-[11px]">{approval.target}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <RiskPill value={approval.risk} />
            <StatusPill value={approval.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{approval.reason}</p>
        {diff ? (
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
            {diff}
          </pre>
        ) : (
          <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        )}
        {onDecide ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => onDecide("approve")}>Approve</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>Deny</Button>
          </div>
        ) : null}
        <p className="font-mono text-[10px] text-muted-foreground">
          {approval.taskId ? `task ${approval.taskId} · ` : ""}
          {new Date(approval.updatedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
