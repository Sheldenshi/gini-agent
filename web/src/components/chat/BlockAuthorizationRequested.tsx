"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useAuthorizations, useInvalidate } from "@/lib/queries";
import type { Authorization, AuthorizationRequestedBlock } from "@runtime/types";

// Agent-actor gate: the user approves or denies; the runtime performs the
// side effect. Renders with a risk pill and Approve/Deny buttons. See
// docs/adr/authorization-vs-setup-request.md.
export function BlockAuthorizationRequested({ block }: { block: AuthorizationRequestedBlock }) {
  const invalidate = useInvalidate();
  const authorizations = useAuthorizations();
  const [expanded, setExpanded] = useState(false);

  const authorization = (authorizations.data ?? []).find((a) => a.id === block.authorizationId) ?? null;
  const isPending = authorization ? authorization.status === "pending" : true;

  const decide = useMutation({
    mutationFn: ({ op }: { op: "approve" | "deny" }) =>
      api<Authorization>(`/authorizations/${block.authorizationId}/${op}`, { method: "POST" }),
    onSuccess: () => {
      invalidate(["authorizations", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{block.action}</span>
        <RiskPill value={block.risk} />
        {!isPending && authorization ? <StatusPill value={authorization.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{block.summary}</p>
      {expanded && authorization ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(authorization.payload, null, 2)}
        </pre>
      ) : null}
      <div className={isPending ? "mt-2 flex gap-2" : "hidden"}>
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
      </div>
    </div>
  );
}
