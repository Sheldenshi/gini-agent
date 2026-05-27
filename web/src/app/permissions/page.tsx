"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate } from "@/lib/queries";
import type { Approval } from "@runtime/types";
import type { AgentRow } from "@/lib/view-types";

export default function PermissionsPage() {
  const approvals = useApprovals();
  const invalidate = useInvalidate();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const agentNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data?.agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data?.agents]);
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
  const agentLabelFor = (approval: Approval): string | undefined => {
    if (!approval.agentId) return undefined;
    return agentNamesById.get(approval.agentId) ?? approval.agentId;
  };

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
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    agentLabel={agentLabelFor(approval)}
                    onDecide={(op) => decide.mutate({ id: approval.id, op })}
                    pending={decide.isPending}
                  />
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
                  <ApprovalCard key={approval.id} approval={approval} agentLabel={agentLabelFor(approval)} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ApprovalCard({
  approval,
  agentLabel,
  onDecide,
  pending
}: {
  approval: Approval;
  agentLabel?: string;
  onDecide?: (op: "approve" | "deny") => void;
  pending?: boolean;
}) {
  const diff = typeof approval.payload?.diff === "string" ? approval.payload.diff : null;
  // `browser.connect` is a special case: there's no raw command to
  // audit, so render a friendlier label and use the reason as the
  // description instead of leaking the connect-endpoint internals.
  const isBrowserConnect = approval.action === "browser.connect";
  // `browser.fill_secret` is also a special case: the only valid
  // resolution path is /connect with per-slot values from the
  // amber chat card. The generic /approve endpoint refuses this
  // action with 400 (see decideApproval in src/agent.ts), so the
  // Approve button on this page would just toast an error. Hide
  // both action buttons and point the operator at the chat card
  // where they can actually enter the credentials.
  const isBrowserFillSecret = approval.action === "browser.fill_secret";
  // `messaging.add_bridge` is the same shape: /approve refuses it
  // (see decideApproval), so the only resolution path is the inline
  // chat card that collects the bridge name + bot token. Hide the
  // Approve button on this page and leave only Deny + a pointer at
  // the chat where the values can be entered.
  const isMessagingAddBridge = approval.action === "messaging.add_bridge";
  // The other two chat-only messaging actions follow the same
  // /approve-refused contract — only the chat card has the right
  // surface to display the per-action confirmation (verification
  // code + sender for approve_pairing, irreversibility warning for
  // remove_bridge), so this list page renders Deny only with a
  // "resolve in chat" hint.
  const isMessagingApprovePairing = approval.action === "messaging.approve_pairing";
  const isMessagingRemoveBridge = approval.action === "messaging.remove_bridge";
  // `||` (not `??`) so an empty-string reason also falls back to the
  // approval target. `??` only fires for null/undefined; a payload that
  // carried `reason: ""` would otherwise render a blank card body.
  const reasonText =
    (typeof approval.payload?.reason === "string" && approval.payload.reason.length > 0
      ? approval.payload.reason
      : undefined) || approval.target;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-mono text-sm">
              {isBrowserConnect ? "Connect to agent's browser" : approval.action}
            </CardTitle>
            <CardDescription className="line-clamp-1 font-mono text-[11px]">
              {isBrowserConnect ? reasonText : approval.target}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {agentLabel ? (
              <span
                className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                title={`Requesting agent: ${agentLabel}`}
              >
                {agentLabel}
              </span>
            ) : null}
            {/*
              Suppress the MEDIUM-RISK badge for `browser.connect`. The action
              is still gated (the user still has to click Connect to consent)
              but the visual framing is softer because this is a benign
              sign-in step, not a destructive action. All other approvals
              keep the badge.
            */}
            {isBrowserConnect ? null : <RiskPill value={approval.risk} />}
            <StatusPill value={approval.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/*
          For browser.connect the user-facing reason (payload.reason ?? target)
          is what we surface in chat and on the home pending list — match that
          here. For other actions, `approval.reason` is the policy engine's
          internal text (which is also what the rest of the UI shows).
         */}
        <p className="text-sm">{isBrowserConnect ? reasonText : approval.reason}</p>
        {isBrowserConnect ? null : diff ? (
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
            {diff}
          </pre>
        ) : (
          <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        )}
        {isBrowserFillSecret ? (
          <>
            <p className="text-xs text-muted-foreground">
              Open the chat session to enter credentials. Approve doesn&apos;t apply here — the values must be typed into the amber card in chat. Deny still cancels the request.
            </p>
            {onDecide ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
                  Deny
                </Button>
              </div>
            ) : null}
          </>
        ) : isMessagingAddBridge ? (
          <>
            <p className="text-xs text-muted-foreground">
              Open the chat session to add the bridge. Approve doesn&apos;t apply here — the bridge name and bot token must be entered into the card in chat. Deny still cancels the request.
            </p>
            {onDecide ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
                  Deny
                </Button>
              </div>
            ) : null}
          </>
        ) : isMessagingApprovePairing ? (
          <>
            <p className="text-xs text-muted-foreground">
              Open the chat session to approve or reject this pairing. The verification code must be confirmed against what the user reports on Telegram before enrollment. Deny still cancels the request.
            </p>
            {onDecide ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
                  Deny
                </Button>
              </div>
            ) : null}
          </>
        ) : isMessagingRemoveBridge ? (
          <>
            <p className="text-xs text-muted-foreground">
              Open the chat session to confirm bridge removal. The destructive confirmation lives in the chat card. Deny still cancels the request.
            </p>
            {onDecide ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
                  Deny
                </Button>
              </div>
            ) : null}
          </>
        ) : onDecide ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => onDecide("approve")}>
              {isBrowserConnect ? "Connect" : "Approve"}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
              {isBrowserConnect ? "Cancel" : "Deny"}
            </Button>
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
