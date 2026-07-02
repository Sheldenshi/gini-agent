"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { ModelPicker, type ModelSelection } from "@/components/ModelPicker";
import type { AgentRow } from "@/lib/view-types";

interface SetDefaultModelResult {
  ok: boolean;
  error?: string;
}

// "Default model" — what a new chat starts with (ADR model-first-selection.md).
//
// Reads the default agent's provider/model pair: new agents copy it at
// creation and the default chat resolves through it, so it — not the raw
// instance provider — is what a new chat actually starts with. The instance
// provider is only the pre-seed fallback. Saving posts
// /settings/default-model, which updates the instance provider AND the
// default agent's override together; writing just one would let the other
// shadow it.
export function DefaultModelControl() {
  const status = useStatus();
  const invalidate = useInvalidate();
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });

  // Legacy instances carry the pre-rename "profile_default" id for the
  // default agent — same id pair the runtime's seeding targets.
  const defaultAgent =
    agents.data?.agents.find((agent) => agent.id === "agent_default") ??
    agents.data?.agents.find((agent) => agent.id === "profile_default");
  const instanceProvider = status.data?.provider?.provider;
  const value: ModelSelection | null =
    defaultAgent?.providerName && defaultAgent.model
      ? { provider: defaultAgent.providerName, model: defaultAgent.model }
      : instanceProvider
        ? { provider: instanceProvider.name, model: instanceProvider.model }
        : null;

  const save = useMutation({
    mutationFn: (selection: ModelSelection) =>
      api<SetDefaultModelResult>("/settings/default-model", {
        method: "POST",
        body: JSON.stringify({ provider: selection.provider, model: selection.model })
      }),
    onSuccess: (result, selection) => {
      if (!result.ok) {
        toast.error(result.error ?? "Failed to set the default model.");
        return;
      }
      toast.success(`Default model: ${selection.model}`);
      invalidate(["status", "agents", "providers", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Default model</h2>
        <p className="text-xs text-muted-foreground">What a new chat starts with.</p>
      </div>
      <ModelPicker
        value={value}
        onSelect={(selection) => save.mutate(selection)}
        disabled={save.isPending || agents.isLoading}
        ariaLabel="Default model"
      />
    </section>
  );
}
