"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RiskPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate, useProviders } from "@/lib/queries";
import type { Approval, ApprovalRequestedBlock } from "@runtime/types";
import { parseFillSecretSlots, type FillSecretSlot } from "@/lib/fill-secrets-types";

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
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      // Clear any typed credentials regardless of outcome. The Deny
      // button on a fill_secret card never invokes fillSubmit (and
      // therefore never hits fillSubmit's onSettled clear), so
      // without this hook a user who typed a credential and then
      // clicked Deny would leave the typed value sitting in React
      // state until the chat view unmounts. Cheap on every other
      // approval action — setFillValues({}) is a no-op when the
      // record is already empty.
      setFillValues({});
    }
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
  const isBrowserFillSecret = block.action === "browser.fill_secret";
  const providerId = isConnectorRequest && approval
    ? String(approval.payload?.provider ?? "")
    : "";
  const providerLabel = isConnectorRequest && approval
    ? typeof approval.payload?.providerLabel === "string"
      ? (approval.payload.providerLabel as string)
      : providerId
    : "";
  const fillSlots: FillSecretSlot[] = isBrowserFillSecret && approval
    ? parseFillSecretSlots(approval.payload?.slots)
    : [];
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const fillSubmit = useMutation({
    mutationFn: async () => {
      // Submit value never leaves this function's request scope.
      // The /connect endpoint detects action=browser.fill_secret and
      // pipes each entry's value into playwright.fill on the live
      // page. Local state is cleared in onSettled below regardless of
      // outcome so the value never lingers in React state past the
      // click — including on partial-fail (where the gateway has
      // already resolved the approval and retry is meaningless) and
      // on network/abort errors.
      const response = await api<{ ok: boolean; message?: string; filledSlots?: string[] }>(
        `/approvals/${block.approvalId}/connect`,
        {
          method: "POST",
          body: JSON.stringify({ secrets: fillValues })
        }
      );
      return response;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? "Fill failed; the agent will decide whether to retry.");
      }
      // Always invalidate approvals: the gateway resolves the
      // approval atomically before running fills, so on both ok and
      // !ok paths the approval status has flipped out of "pending"
      // and the card needs to re-render with isPending=false (Submit
      // disabled, inputs hidden). Without this, ok:false would leave
      // a stale "pending" cache and the Submit button would stay
      // enabled offering a retry that the gateway would 410-Gone.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      // Belt-and-braces: clear typed credentials from React state
      // regardless of outcome (success, partial-fail, network error,
      // abort). The card stays mounted across the chat session for
      // history-completeness, so without this hook a stale value
      // would linger in the React fiber tree (and React DevTools)
      // for the duration of the session.
      setFillValues({});
    }
  });
  const fillReady = isBrowserFillSecret
    && fillSlots.length > 0
    && fillSlots.every((s) => typeof fillValues[s.name] === "string" && fillValues[s.name].length > 0);

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
      {isBrowserFillSecret && fillSlots.length > 0 && isPending ? (
        <div className="mt-2 space-y-2">
          {/*
            Prominent "fill destination" badge so the user can spot a
            mismatch between the agent's claimed labels and the actual
            page the secret will land on. The agent controls
            slot.label and block.summary; the page URL is captured by
            the gateway at approval-creation time and is the only
            non-spoofable element on this card. If the agent were
            prompt-injected to ask for "GitHub password" while the
            captured page is `https://evil.com/phishing`, this badge
            is what lets the user see the mismatch.
          */}
          {(() => {
            // Read from approval.payload.approvedUrl — the canonical
            // load-bearing field the gateway compares against the
            // live page URL. approval.target currently mirrors the
            // same value, but the dispatcher's own comment marks
            // target as "the human-readable label" and approvedUrl
            // as "the load-bearing equality check," so a future
            // change to target's format must not silently change
            // what the user sees on the card. Fall back to target
            // for legacy approvals minted before the payload field
            // existed.
            const approvedUrlField = typeof approval?.payload?.approvedUrl === "string"
              ? approval.payload.approvedUrl
              : undefined;
            const destination = approvedUrlField ?? approval?.target;
            if (!destination) return null;
            return (
              <div className="rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">Fill destination: </span>
                <span className="font-mono">{destination}</span>
              </div>
            );
          })()}
          {fillSlots.map((slot) => (
            <div key={slot.name} className="space-y-1">
              <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.approvalId}-${slot.name}`}>
                {slot.label}
              </label>
              <Input
                id={`${block.approvalId}-${slot.name}`}
                type={slot.kind}
                value={fillValues[slot.name] ?? ""}
                onChange={(e) => setFillValues((prev) => ({ ...prev, [slot.name]: e.target.value }))}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                disabled={fillSubmit.isPending}
              />
            </div>
          ))}
        </div>
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
        ) : isBrowserFillSecret ? (
          <>
            <Button
              size="sm"
              disabled={fillSubmit.isPending || !isPending || !fillReady}
              onClick={() => fillSubmit.mutate()}
            >
              Submit
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
