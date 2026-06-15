"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useAuthorizations, useInvalidate } from "@/lib/queries";
import type { Authorization, AuthorizationRequestedBlock } from "@runtime/types";

// Agent-actor gate: the user approves or denies; the runtime performs the
// side effect. Renders with Approve/Deny buttons. See
// docs/adr/authorization-vs-setup-request.md.
//
// skill.run gets a friendlier treatment: the agent's announce message right
// above the card already states what's being confirmed, so the card stays
// minimal — a "Confirm <Skill Name>" title and Confirm/Deny buttons. The raw
// payload (script + args) stays reachable via "Show details". Every other
// action keeps the generic action-label + reason rendering.

type SkillRunDetails = {
  skillName: string;
};

function parseSkillRunDetails(payload: Record<string, unknown> | undefined): SkillRunDetails | null {
  if (!payload) return null;
  const { skillName, scriptName, scriptArgs } = payload;
  if (typeof skillName !== "string" || skillName.length === 0) return null;
  if (typeof scriptName !== "string" || scriptName.length === 0) return null;
  if (!scriptArgs || typeof scriptArgs !== "object" || Array.isArray(scriptArgs)) return null;
  return { skillName };
}

// "phone-call" → "Phone Call"
function titleizeSkillName(name: string): string {
  return name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function BlockAuthorizationRequested({ block }: { block: AuthorizationRequestedBlock }) {
  const invalidate = useInvalidate();
  const authorizations = useAuthorizations();
  const [expanded, setExpanded] = useState(false);

  const authorization = (authorizations.data ?? []).find((a) => a.id === block.authorizationId) ?? null;
  const isPending = authorization ? authorization.status === "pending" : true;
  const skillRun = block.action === "skill.run" ? parseSkillRunDetails(authorization?.payload) : null;

  const decide = useMutation({
    mutationFn: ({ op }: { op: "approve" | "deny" }) =>
      api<Authorization>(`/authorizations/${block.authorizationId}/${op}`, { method: "POST" }),
    onSuccess: () => {
      invalidate(["authorizations", "approvals", "tasks", "task", "chat", "threads", "threads-inbox", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        {skillRun ? (
          <span className="text-sm font-medium text-foreground">
            Confirm {titleizeSkillName(skillRun.skillName)}
          </span>
        ) : (
          <span className="font-mono text-xs text-foreground">{block.action}</span>
        )}
        {!isPending && authorization ? <StatusPill value={authorization.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      {skillRun ? null : <p className="mt-1 text-xs text-muted-foreground">{block.summary}</p>}
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
          {skillRun ? "Confirm" : "Approve"}
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
