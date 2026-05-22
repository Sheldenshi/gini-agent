"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RiskPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate, useProviders } from "@/lib/queries";
import type { Approval, ApprovalRequestedBlock } from "@runtime/types";

// Inline Approve / Deny / Connect actions for an approval_requested block.
// The block itself carries `approvalId`, `action`, `risk`, and `summary`
// directly from the wire, so the bubble can render without a join. The
// `connector.request` Connect flow still needs the approval payload
// (provider id, provider label) for the AddConnectorDialog — we fetch
// that lazily through the existing useApprovals() cache rather than
// adding a new per-id endpoint.
//
// Once the approval is resolved (approved / denied / connected), the
// runtime updates the corresponding tool_call block's status and the
// approval_requested block becomes historical. We keep rendering the
// bubble so the chat log stays complete; the buttons disable themselves
// once the approval is no longer pending.
export function BlockApprovalRequested({ block }: { block: ApprovalRequestedBlock }) {
  const invalidate = useInvalidate();
  const approvals = useApprovals();
  const providers = useProviders();
  const [expanded, setExpanded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Find the matching approval row so the Connect dialog has the
  // provider id from `approval.payload.provider`. The approval may not
  // yet be in the cache on first render — the Connect button stays
  // disabled until the row loads so the dialog never opens without the
  // provider id it needs.
  const approval = (approvals.data ?? []).find((a) => a.id === block.approvalId) ?? null;
  const isPending = approval ? approval.status === "pending" : true;

  const decide = useMutation({
    mutationFn: ({ op }: { op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${block.approvalId}/${op}`, { method: "POST" }),
    onSuccess: () => {
      // Refresh the surfaces that mirror approval state. The chat page
      // itself updates via the per-session SSE block stream, but
      // /permissions and /activity rely on the React Query cache.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const connect = useMutation({
    mutationFn: async (body: CreateConnectorBody) => {
      const response = await api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/approvals/${block.approvalId}/connect`,
        {
          method: "POST",
          body: JSON.stringify({
            secrets: body.secrets,
            scopes: body.scopes,
            name: body.name
          })
        }
      );
      return response;
    },
    onSuccess: (result) => {
      if (result.ok) {
        setConnectOpen(false);
        setConnectError(null);
        invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        setConnectError(
          result.message ?? "Could not connect. Please verify the credentials and try again."
        );
        invalidate(["connectors"]);
      }
    },
    onError: (error: Error) => {
      setConnectError(error.message);
    }
  });

  const isConnectorRequest = block.action === "connector.request";
  const providerId = isConnectorRequest && approval
    ? String(approval.payload?.provider ?? "")
    : "";
  const providerLabel = isConnectorRequest && approval
    ? typeof approval.payload?.providerLabel === "string"
      ? (approval.payload.providerLabel as string)
      : providerId
    : "";

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{block.action}</span>
        <RiskPill value={block.risk} />
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{block.summary}</p>
      {expanded && approval ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      ) : null}
      <div className="mt-2 flex gap-2">
        {isConnectorRequest ? (
          <>
            <Button
              size="sm"
              disabled={connect.isPending || !isPending || !approval}
              onClick={() => {
                setConnectError(null);
                setConnectOpen(true);
              }}
            >
              Connect {providerLabel || "provider"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "approve" })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Deny
            </Button>
          </>
        )}
      </div>
      {connectOpen ? (
        <AddConnectorDialog
          open={connectOpen}
          onOpenChange={(open) => {
            if (!open) {
              setConnectOpen(false);
              setConnectError(null);
            }
          }}
          providers={providers.data ?? []}
          defaultProvider={providerId}
          lockProvider
          mode="request"
          pending={connect.isPending}
          externalError={connectError}
          onSubmit={(body) => connect.mutate(body)}
        />
      ) : null}
    </div>
  );
}
