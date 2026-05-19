"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RiskPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate, useProviders } from "@/lib/queries";
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
//   - When `approval.action === "connector.request"` (raised by the
//     `request_connector` tool) we swap the default Approve/Deny pair
//     for a "Connect <provider>" button that opens AddConnectorDialog in
//     `request` mode. Submitting the dialog calls
//     POST /api/approvals/<id>/connect, which creates the connector,
//     probes it, and resolves the approval on success — that drives the
//     existing resume flow without any extra chat plumbing.
export function ApprovalActions({ taskId }: { taskId: string }) {
  const approvals = useApprovals();
  const providers = useProviders();
  const invalidate = useInvalidate();
  const [expanded, setExpanded] = useState(false);
  const [connectFor, setConnectFor] = useState<Approval | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

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

  // POSTs the user-entered secrets to the approval connect endpoint. On
  // probe failure we keep the dialog open with the inline error message
  // so the user can correct the credential without losing context. On
  // success the endpoint resolves the approval — invalidating the chat
  // surface lets the resumed task's running/summary message render.
  const connect = useMutation({
    mutationFn: async ({ approvalId, body }: { approvalId: string; body: CreateConnectorBody }) => {
      const response = await api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/approvals/${approvalId}/connect`,
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
        setConnectFor(null);
        setConnectError(null);
        invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        setConnectError(result.message ?? "Could not connect. Please verify the credentials and try again.");
        // The unhealthy connector row was still created; refresh the list
        // so the Connectors page reflects reality if the user opens it.
        invalidate(["connectors"]);
      }
    },
    onError: (error: Error) => {
      setConnectError(error.message);
    }
  });

  if (pending.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {pending.map((approval) => {
        const isConnectorRequest = approval.action === "connector.request";
        const providerLabel = isConnectorRequest
          ? (typeof approval.payload?.providerLabel === "string"
              ? approval.payload.providerLabel
              : String(approval.payload?.provider ?? "provider"))
          : "";
        // `browser.connect` is a special case: the action's
        // "command" is just opening a Chrome window — there is no
        // raw command line to audit, and surfacing the connect
        // endpoint / bearer token in a "Show command" panel would
        // be more confusing than useful. Render a friendlier label
        // and use the reason (carried on the approval's target /
        // payload.reason) as the body.
        const isBrowserConnect = approval.action === "browser.connect";
        const reasonText =
          (typeof approval.payload.reason === "string" ? approval.payload.reason : undefined) ??
          approval.target;
        return (
          <div
            key={approval.id}
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">
                {isBrowserConnect ? "Open a browser window" : approval.action}
              </span>
              <RiskPill value={approval.risk} />
              {isBrowserConnect ? null : (
                <button
                  type="button"
                  className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? "Hide details" : "Show details"}
                </button>
              )}
            </div>
            {isBrowserConnect ? (
              <p className="mt-1 text-xs text-foreground/90">{reasonText}</p>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted-foreground">{approval.reason}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-foreground/90">
                  {truncate(approval.target, expanded ? 4000 : 200)}
                </p>
                {expanded ? (
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
                    {JSON.stringify(approval.payload, null, 2)}
                  </pre>
                ) : null}
              </>
            )}
            <div className="mt-2 flex gap-2">
              {isConnectorRequest ? (
                <>
                  <Button
                    size="sm"
                    disabled={connect.isPending}
                    onClick={() => {
                      setConnectError(null);
                      setConnectFor(approval);
                    }}
                  >
                    Connect {providerLabel}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        );
      })}
      {connectFor ? (
        <AddConnectorDialog
          open={!!connectFor}
          onOpenChange={(open) => {
            if (!open) {
              setConnectFor(null);
              setConnectError(null);
            }
          }}
          providers={providers.data ?? []}
          defaultProvider={String(connectFor.payload?.provider ?? "")}
          lockProvider
          mode="request"
          pending={connect.isPending}
          externalError={connectError}
          onSubmit={(body) => connect.mutate({ approvalId: connectFor.id, body })}
        />
      ) : null}
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
