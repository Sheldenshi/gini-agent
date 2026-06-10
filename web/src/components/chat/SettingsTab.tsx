"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import type { ProviderCatalogItem } from "@/lib/providers";
import type { AgentRow } from "@/lib/view-types";
import { ModelPicker, type ModelSelection } from "@/components/ModelPicker";

interface AgentProviderResult {
  id: string;
  providerName?: string;
  model?: string;
}

// Per-agent Settings tab: the model THIS agent's chats and memory LLM calls
// use. Picking a model in the ModelPicker saves the agent's provider/model
// override immediately (the exact { provider, model } route pair —
// resolveEffectiveContext reads it; see ADRs per-agent-provider-settings.md
// and model-first-selection.md). Agents are snapshots, not live links: "Use
// default model" copies the CURRENT default pair onto the agent as a new
// pin — it never clears the override, so a later default change can't
// silently move this agent. Credential setup (API keys, AWS, Codex) stays
// on the instance-level Settings page; the picker only offers routes
// through already-configured providers.
//
// `agentId` is the mutation target and the displayed current selection is
// read from `/status.activeAgent`. The chat surface renders this tab only on
// the active agent's own canonical chat — it is hidden on pinned sessions
// and channels (which may belong to a different agent) — so `agentId` is
// always the active agent and the read and write always refer to the same
// agent.
export function SettingsTab({ agentId }: { agentId?: string }) {
  const status = useStatus();
  const invalidate = useInvalidate();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
    refetchInterval: 60_000
  });
  // The default agent's pair is the default model ("Use default model"
  // copies it). Legacy instances carry the pre-rename "profile_default" id.
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const defaultAgent =
    agents.data?.agents.find((agent) => agent.id === "agent_default") ??
    agents.data?.agents.find((agent) => agent.id === "profile_default");

  const activeAgent = status.data?.activeAgent;
  // The instance fallback an override-less agent resolves through.
  const instanceProvider = status.data?.provider?.provider;
  // The agent's CURRENT effective selection — pinned or inherited.
  const resolved = activeAgent?.resolvedProvider;
  const value: ModelSelection | null = resolved
    ? { provider: resolved.name, model: resolved.model }
    : null;
  // The current default pair — what "Use default model" copies onto the
  // agent. The default agent's pair is authoritative; the instance provider
  // is the pre-seed fallback.
  const defaultPair: ModelSelection | null =
    defaultAgent?.providerName && defaultAgent.model
      ? { provider: defaultAgent.providerName, model: defaultAgent.model }
      : instanceProvider
        ? { provider: instanceProvider.name, model: instanceProvider.model }
        : null;
  // "profile_default" is the legacy pre-rename id for the default agent.
  const isDefaultAgent = agentId === "agent_default" || agentId === "profile_default";
  // An override-less agent still resolves through config.provider live (the
  // runtime fallback); the next default change pins it where it stands.
  const isFollowing = !isDefaultAgent && activeAgent?.providerSource !== "agent";

  const save = useMutation({
    // The default agent's pair IS the default model, so its picks route
    // through the two-layer default-model write — a bare agent-override
    // write would move what new chats start with while config.provider
    // (embeddings/reranker anchor, provider-removal gate) stayed behind.
    // Other agents save their own pinned pair.
    mutationFn: (vars: { providerName: string; model: string }) =>
      isDefaultAgent
        ? api("/settings/default-model", {
            method: "POST",
            body: JSON.stringify({ provider: vars.providerName, model: vars.model })
          })
        : api<AgentProviderResult>(`/agents/${encodeURIComponent(agentId ?? "")}/provider`, {
            method: "POST",
            body: JSON.stringify(vars)
          }),
    onSuccess: (_result, vars) => {
      toast.success(
        isDefaultAgent
          ? `Default model: ${vars.model} via ${vars.providerName}`
          : `${vars.model} via ${vars.providerName} for this agent`
      );
      invalidate(["status", "agents", "state", "providers"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-[22px]">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[28px] font-bold leading-none text-foreground">Settings</h2>
          <p className="text-sm font-medium text-muted-foreground">
            Model for {activeAgent?.name ?? "this agent"}
          </p>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-8 pb-8 pt-6">
          {!agentId ? (
            <EmptyState label="No active agent." />
          ) : catalog.isLoading ? (
            <EmptyState label="Loading providers…" />
          ) : (
            // Same card shape as the Settings page's Default model control:
            // title + description inside the card, control cluster on the
            // right.
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">Model</h3>
                <p className="text-xs text-muted-foreground">
                  This agent&apos;s chats use the model on the right. Manage API keys and connect
                  new providers in{" "}
                  <Link href="/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
                    Settings
                  </Link>
                  .
                </p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <ModelPicker
                  value={value}
                  onSelect={(selection) =>
                    save.mutate({ providerName: selection.provider, model: selection.model })
                  }
                  disabled={save.isPending}
                  ariaLabel={`Model for ${activeAgent?.name ?? "this agent"}`}
                />
                {/* Status line under the control: the trigger already names
                    the pair and its route, so this only states where the
                    selection comes from. */}
                {isDefaultAgent ? (
                  <p className="text-xs text-muted-foreground">This is the default model</p>
                ) : isFollowing ? (
                  <p className="text-xs text-muted-foreground">Using the default model</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Pinned for this agent
                    {defaultPair ? (
                      <>
                        {" "}·{" "}
                        <button
                          type="button"
                          disabled={save.isPending}
                          onClick={() =>
                            // Copy the CURRENT default as a new pin — the
                            // agent stays a snapshot, unsynced from future
                            // default changes.
                            save.mutate({ providerName: defaultPair.provider, model: defaultPair.model })
                          }
                          className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Use default model
                        </button>
                      </>
                    ) : null}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
