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
import { useAuthorizations, useInvalidate, useSetupRequests } from "@/lib/queries";
import type { Authorization, SetupRequest } from "@runtime/types";
import type { AgentRow } from "@/lib/view-types";

export default function PermissionsPage() {
  const authorizations = useAuthorizations();
  const setupRequests = useSetupRequests();
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
  const decideAuth = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Authorization>(`/authorizations/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["authorizations", "approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const cancelSetup = useMutation({
    mutationFn: (id: string) =>
      api<SetupRequest>(`/setup-requests/${id}/cancel`, { method: "POST" }),
    onSuccess: (_, id) => {
      toast.success(`cancelled: ${id}`);
      invalidate(["setup-requests", "approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const pendingAuth = (authorizations.data ?? []).filter((a) => a.status === "pending");
  const decidedAuth = (authorizations.data ?? []).filter((a) => a.status !== "pending").slice().reverse();
  const pendingSetup = (setupRequests.data ?? []).filter((s) => s.status === "pending");
  const decidedSetup = (setupRequests.data ?? []).filter((s) => s.status !== "pending").slice().reverse();

  const agentLabelFor = (row: { agentId?: string }): string | undefined => {
    if (!row.agentId) return undefined;
    return agentNamesById.get(row.agentId) ?? row.agentId;
  };

  const pendingCount = pendingAuth.length + pendingSetup.length;
  const historyCount = decidedAuth.length + decidedSetup.length;

  return (
    <>
      <PageHeader title="Permissions" description="Review and decide pending approvals and setup steps" />
      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">Pending ({pendingCount})</TabsTrigger>
            <TabsTrigger value="history">History ({historyCount})</TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="mt-4 space-y-6">
            <section>
              <h2 className="mb-2 text-sm font-semibold">Authorizations ({pendingAuth.length})</h2>
              {pendingAuth.length === 0 ? (
                <EmptyState title="No pending authorizations" description="Agent actions waiting on your approval appear here." />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {pendingAuth.map((authorization) => (
                    <AuthorizationCard
                      key={authorization.id}
                      authorization={authorization}
                      agentLabel={agentLabelFor(authorization)}
                      onDecide={(op) => decideAuth.mutate({ id: authorization.id, op })}
                      pending={decideAuth.isPending}
                    />
                  ))}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold">Setup steps ({pendingSetup.length})</h2>
              {pendingSetup.length === 0 ? (
                <EmptyState title="No pending setup steps" description="Setup steps the agent is waiting on appear here." />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {pendingSetup.map((setup) => (
                    <SetupRequestCard
                      key={setup.id}
                      setup={setup}
                      agentLabel={agentLabelFor(setup)}
                      onCancel={() => cancelSetup.mutate(setup.id)}
                      pending={cancelSetup.isPending}
                    />
                  ))}
                </div>
              )}
            </section>
          </TabsContent>
          <TabsContent value="history" className="mt-4 space-y-6">
            <section>
              <h2 className="mb-2 text-sm font-semibold">Authorizations ({decidedAuth.length})</h2>
              {decidedAuth.length === 0 ? (
                <EmptyState title="No decided authorizations yet" />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {decidedAuth.map((authorization) => (
                    <AuthorizationCard key={authorization.id} authorization={authorization} agentLabel={agentLabelFor(authorization)} />
                  ))}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold">Setup steps ({decidedSetup.length})</h2>
              {decidedSetup.length === 0 ? (
                <EmptyState title="No completed setup steps yet" />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {decidedSetup.map((setup) => (
                    <SetupRequestCard key={setup.id} setup={setup} agentLabel={agentLabelFor(setup)} />
                  ))}
                </div>
              )}
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function AuthorizationCard({
  authorization,
  agentLabel,
  onDecide,
  pending
}: {
  authorization: Authorization;
  agentLabel?: string;
  onDecide?: (op: "approve" | "deny") => void;
  pending?: boolean;
}) {
  const diff = typeof authorization.payload?.diff === "string" ? authorization.payload.diff : null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-mono text-sm">{authorization.action}</CardTitle>
            <CardDescription className="line-clamp-1 font-mono text-[11px]">{authorization.target}</CardDescription>
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
            <RiskPill value={authorization.risk} />
            <StatusPill value={authorization.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{authorization.reason}</p>
        {diff ? (
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
            {diff}
          </pre>
        ) : (
          <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(authorization.payload, null, 2)}
          </pre>
        )}
        {onDecide ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => onDecide("approve")}>
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("deny")}>
              Deny
            </Button>
          </div>
        ) : null}
        <p className="font-mono text-[10px] text-muted-foreground">
          {authorization.taskId ? `task ${authorization.taskId} · ` : ""}
          {new Date(authorization.updatedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function SetupRequestCard({
  setup,
  agentLabel,
  onCancel,
  pending
}: {
  setup: SetupRequest;
  agentLabel?: string;
  onCancel?: () => void;
  pending?: boolean;
}) {
  const isBrowserConnect = setup.action === "browser.connect";
  const isConnectorRequest = setup.action === "connector.request";
  const isBrowserFillSecret = setup.action === "browser.fill_secret";
  const reasonText =
    (typeof setup.payload?.reason === "string" && setup.payload.reason.length > 0
      ? setup.payload.reason
      : undefined) || setup.target;
  const title = isBrowserConnect
    ? "Connect to agent's browser"
    : isConnectorRequest
      ? "Provider setup"
      : isBrowserFillSecret
        ? "Fill credentials"
        : setup.action;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-mono text-sm">{title}</CardTitle>
            <CardDescription className="line-clamp-1 font-mono text-[11px]">
              {isBrowserConnect ? reasonText : setup.target}
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
            <StatusPill value={setup.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{setup.reason || reasonText}</p>
        <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(setup.payload, null, 2)}
        </pre>
        <p className="text-xs text-muted-foreground">
          Open the chat session to complete this step. Cancel below to abort the request.
        </p>
        {onCancel ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : null}
        <p className="font-mono text-[10px] text-muted-foreground">
          {setup.taskId ? `task ${setup.taskId} · ` : ""}
          {new Date(setup.updatedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
