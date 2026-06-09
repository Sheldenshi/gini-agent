"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";
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
// and model-first-selection.md). "Use default model" clears the override so
// the agent follows the instance default again. Credential setup (API keys,
// AWS, Codex) stays on the instance-level Settings page; the picker only
// offers routes through already-configured providers.
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

  const activeAgent = status.data?.activeAgent;
  // The instance default the agent falls back to when it carries no override.
  const instanceProvider = status.data?.provider?.provider;
  // Clean brand label for the instance provider, resolved through the catalog
  // so the default-model line reads "OpenAI" / "Amazon Bedrock" rather than a
  // raw lowercase id.
  const instanceLabel = useMemo(() => {
    if (!instanceProvider) return "";
    const row = (catalog.data ?? []).find((r) => r.name === instanceProvider.name);
    return displayProviderName(row ?? { displayName: instanceProvider.name, name: instanceProvider.name });
  }, [catalog.data, instanceProvider?.name]);

  // The agent's CURRENT effective selection — override or inherited.
  const resolved = activeAgent?.resolvedProvider;
  const value: ModelSelection | null = resolved
    ? { provider: resolved.name, model: resolved.model }
    : null;
  // The DEFAULT agent's pair IS the default model (the Settings control
  // displays it; new agents copy it), so it is always "on the default" —
  // surfacing its own pair as an override would contradict the Settings
  // page, and a clear action would silently swap the real default for the
  // instance fallback. A NON-default agent's override is a copy, not a
  // link — even when it currently equals the instance pair it will not
  // follow later default changes, so it must read as an override and keep
  // the clear affordance. "profile_default" is the legacy pre-rename id.
  const isDefaultAgent = agentId === "agent_default" || agentId === "profile_default";
  const isDefault = isDefaultAgent || activeAgent?.providerSource !== "agent";

  const save = useMutation({
    // The default agent's pair IS the default model, so its picks route
    // through the two-layer default-model write — a bare agent-override
    // write would move what new chats start with while config.provider
    // (embeddings/reranker anchor, provider-removal gate) stayed behind.
    // Other agents save their own override; clearing one (blank pair) is
    // always the per-agent endpoint's contract.
    mutationFn: (vars: { providerName: string; model: string }) =>
      isDefaultAgent && vars.providerName
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
        vars.providerName
          ? isDefaultAgent
            ? `Default model: ${vars.model} via ${vars.providerName}`
            : `${vars.model} via ${vars.providerName} for this agent`
          : "Reverted to the default model"
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
            <section className="flex flex-col gap-4">
              <header className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">Model</h3>
                <p className="text-xs text-muted-foreground">
                  This agent&apos;s chats use the model below. Manage API keys and connect new
                  providers in{" "}
                  <Link href="/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
                    Settings
                  </Link>
                  .
                </p>
              </header>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                <ModelPicker
                  value={value}
                  onSelect={(selection) =>
                    save.mutate({ providerName: selection.provider, model: selection.model })
                  }
                  disabled={save.isPending}
                  ariaLabel={`Model for ${activeAgent?.name ?? "this agent"}`}
                />
                {isDefault ? (
                  <p className="text-xs text-muted-foreground">
                    Using the default model
                    {/* The default agent's own pair IS the default — the
                        trigger already names it, and the instance pair could
                        lag behind a /setup/provider write. */}
                    {!isDefaultAgent && instanceProvider ? (
                      <>
                        {" "}· {instanceLabel} ·{" "}
                        <span className="font-mono">{instanceProvider.model}</span>
                      </>
                    ) : null}
                  </p>
                ) : (
                  <div className="flex items-center gap-2.5">
                    <p className="text-xs text-muted-foreground">Overriding the default model</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={save.isPending}
                      onClick={() => save.mutate({ providerName: "", model: "" })}
                    >
                      Use default model
                    </Button>
                  </div>
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
