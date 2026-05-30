"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useSetupRequests, useInvalidate, useProviders } from "@/lib/queries";
import type { SetupRequest, SetupRequestedBlock } from "@runtime/types";
import { parseFillSecretSlots, type FillSecretSlot } from "@/lib/fill-secrets-types";

// User-actor gate: the user performs a setup step (sign in, enter
// credentials, fill a form). No risk pill — the rule is structural per
// docs/adr/authorization-vs-setup-request.md. The action determines the
// layout (Connect button vs credential dialog vs inline inputs); all three
// paths POST to /api/setup-requests/<id>/{complete,cancel,open-browser}.
export function BlockSetupRequested({ block }: { block: SetupRequestedBlock }) {
  const invalidate = useInvalidate();
  const setupRequests = useSetupRequests();
  const providers = useProviders();
  const [expanded, setExpanded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;

  const cancel = useMutation({
    mutationFn: () =>
      api<SetupRequest>(`/setup-requests/${block.setupRequestId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setFillValues({})
  });

  const connect = useMutation({
    mutationFn: async (body: CreateConnectorBody) => {
      return api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ secrets: body.secrets, scopes: body.scopes, name: body.name })
        }
      );
    },
    onSuccess: (result) => {
      if (result.ok) {
        setConnectOpen(false);
        setConnectError(null);
        invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        setConnectError(result.message ?? "Could not connect. Please verify the credentials and try again.");
        invalidate(["connectors"]);
      }
    },
    onError: (error: Error) => setConnectError(error.message)
  });

  const browserConnect = useMutation({
    mutationFn: async () => {
      const signInStarted = setup?.payload?.signInStarted === true;
      if (signInStarted) {
        return api<{ ok: boolean }>(`/setup-requests/${block.setupRequestId}/complete`, {
          method: "POST",
          body: JSON.stringify({})
        });
      }
      return api<{ ok: boolean }>(`/setup-requests/${block.setupRequestId}/open-browser`, {
        method: "POST"
      });
    },
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "browser"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const isBrowserConnect = block.action === "browser.connect";
  const isConnectorRequest = block.action === "connector.request";
  const isBrowserFillSecret = block.action === "browser.fill_secret";

  const providerId = isConnectorRequest && setup ? String(setup.payload?.provider ?? "") : "";
  const providerLabel = isConnectorRequest && setup
    ? typeof setup.payload?.providerLabel === "string"
      ? (setup.payload.providerLabel as string)
      : providerId
    : "";
  const fillSlots: FillSecretSlot[] = isBrowserFillSecret && setup
    ? parseFillSecretSlots(setup.payload?.slots)
    : [];
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const fillSubmit = useMutation({
    mutationFn: async () => {
      const response = await api<{ ok: boolean; message?: string; filledSlots?: string[] }>(
        `/setup-requests/${block.setupRequestId}/complete`,
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
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setFillValues({})
  });
  const fillReady = isBrowserFillSecret
    && fillSlots.length > 0
    && fillSlots.every((s) => typeof fillValues[s.name] === "string" && fillValues[s.name].length > 0);

  const signInStarted = setup?.payload?.signInStarted === true;

  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">
          {isBrowserConnect ? "Connect to agent's browser" : block.action}
        </span>
        {!isPending && setup ? <StatusPill value={setup.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      {!isConnectorRequest ? (
        <p className="mt-1 text-xs text-muted-foreground">{block.summary}</p>
      ) : null}
      {expanded && setup ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(setup.payload, null, 2)}
        </pre>
      ) : null}
      {isBrowserFillSecret && fillSlots.length > 0 && isPending ? (
        <div className="mt-2 space-y-2">
          {(() => {
            const approvedUrlField = typeof setup?.payload?.approvedUrl === "string"
              ? setup.payload.approvedUrl
              : undefined;
            const destination = approvedUrlField ?? setup?.target;
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
              <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.setupRequestId}-${slot.name}`}>
                {slot.label}
              </label>
              <Input
                id={`${block.setupRequestId}-${slot.name}`}
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
      <div className={isPending ? "mt-2 flex gap-2" : "hidden"}>
        {isBrowserConnect ? (
          <>
            <Button
              size="sm"
              disabled={browserConnect.isPending || !isPending}
              onClick={() => browserConnect.mutate()}
            >
              {signInStarted ? "I've signed in" : "Connect"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isConnectorRequest ? (
          <>
            <Button
              size="sm"
              disabled={connect.isPending || !isPending || !setup}
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
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
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
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : null}
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
