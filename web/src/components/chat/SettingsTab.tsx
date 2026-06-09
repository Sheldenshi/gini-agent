"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckIcon } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";

// Sentinel radio value for "no agent override → inherit the instance default".
const INSTANCE_DEFAULT = "";

// Friendly labels for the catalog `auth` mechanism, matching the global
// Settings provider rows (the raw catalog values are "env"/"aws"/…).
const AUTH_LABEL: Record<string, string> = {
  env: "API key",
  aws: "AWS",
  "codex-oauth": "OAuth",
  none: "Local"
};

interface AgentProviderResult {
  id: string;
  providerName?: string;
  model?: string;
}

// Per-agent Settings tab. Picks the provider/model THIS agent uses for its
// chats and memory LLM calls. The agent record's providerName + model are the
// override resolveEffectiveContext reads — set both to route the agent through
// a provider, or clear them to inherit the instance default. Credential setup
// (API keys, AWS, Codex) stays on the instance-level Settings page; this tab
// only selects among already-configured providers. See ADR
// per-agent-provider-settings.md.
//
// `agentId` is the mutation target and the displayed current selection is read
// from `/status.activeAgent`. The chat surface renders this tab only on the
// active agent's own canonical chat — it is hidden on pinned sessions and
// channels (which may belong to a different agent) — so `agentId` is always the
// active agent and the read and write always refer to the same agent.
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
  // so the inherited-from line reads "OpenAI" / "Amazon Bedrock" rather than a
  // raw lowercase id.
  const instanceLabel = useMemo(() => {
    if (!instanceProvider) return "";
    const row = (catalog.data ?? []).find((r) => r.name === instanceProvider.name);
    return displayProviderName(row ?? { displayName: instanceProvider.name, name: instanceProvider.name });
  }, [catalog.data, instanceProvider?.name]);

  // The agent's CURRENT effective selection. providerSource === "agent" means
  // the agent owns the override (resolvedProvider is the agent's pick);
  // "instance" means it's inheriting, which we represent with the sentinel.
  const current = useMemo(() => {
    if (activeAgent?.providerSource === "agent") {
      return { provider: activeAgent.resolvedProvider.name, model: activeAgent.resolvedProvider.model };
    }
    return { provider: INSTANCE_DEFAULT, model: "" };
  }, [activeAgent?.providerSource, activeAgent?.resolvedProvider.name, activeAgent?.resolvedProvider.model]);

  // Providers with usable credentials are selectable — an override to an
  // unconfigured provider would fail at the next chat turn, and echo is never
  // reported configured, so both drop out. But always surface the agent's
  // CURRENT override provider even if it has since become unconfigured (its key
  // was removed): hiding it would leave the user unable to see what the agent is
  // on or switch away from it.
  const rows = useMemo(() => {
    const all = catalog.data ?? [];
    const configured = all.filter((row) => row.configured === true);
    if (current.provider !== INSTANCE_DEFAULT && !configured.some((r) => r.name === current.provider)) {
      const currentRow = all.find((r) => r.name === current.provider);
      if (currentRow) return [...configured, currentRow];
    }
    return configured;
  }, [catalog.data, current.provider]);

  // Staged selection. Initialized to the current selection and reset whenever
  // the agent or its resolved provider changes (e.g. after a save lands).
  const [draftProvider, setDraftProvider] = useState<string>(current.provider);
  const [draftModel, setDraftModel] = useState<string>(current.model);
  useEffect(() => {
    setDraftProvider(current.provider);
    setDraftModel(current.model);
  }, [agentId, current.provider, current.model]);

  const save = useMutation({
    mutationFn: (vars: { providerName: string; model: string }) =>
      api<AgentProviderResult>(`/agents/${encodeURIComponent(agentId ?? "")}/provider`, {
        method: "POST",
        body: JSON.stringify(vars)
      }),
    onSuccess: (_result, vars) => {
      toast.success(
        vars.providerName
          ? `${vars.providerName} (${vars.model}) for this agent`
          : "Reverted to the instance default"
      );
      invalidate(["status", "agents", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Pick a provider row: stage it and default its model to the agent's current
  // model when re-selecting the active provider; when selecting the provider the
  // instance is already on, default to the instance's model so promoting the
  // inherited default to an explicit override keeps its (possibly custom) model
  // rather than snapping to the first catalog id; otherwise the provider's first
  // catalog model. The instance-default sentinel carries no model.
  const selectProvider = (name: string) => {
    if (save.isPending) return;
    setDraftProvider(name);
    if (name === INSTANCE_DEFAULT) {
      setDraftModel("");
      return;
    }
    if (name === current.provider) {
      setDraftModel(current.model);
      return;
    }
    const row = rows.find((r) => r.name === name);
    const instanceModel = name === instanceProvider?.name ? instanceProvider.model : undefined;
    setDraftModel(instanceModel ?? row?.models[0] ?? "");
  };

  const dirty =
    draftProvider !== current.provider ||
    (draftProvider !== INSTANCE_DEFAULT && draftModel !== current.model);

  const onSave = () => {
    if (!agentId || !dirty || save.isPending) return;
    save.mutate(
      draftProvider === INSTANCE_DEFAULT
        ? { providerName: "", model: "" }
        : { providerName: draftProvider, model: draftModel }
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-[22px]">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[28px] font-bold leading-none text-foreground">Settings</h2>
          <p className="text-sm font-medium text-muted-foreground">
            Provider and model for {activeAgent?.name ?? "this agent"}
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
                <h3 className="text-base font-semibold text-foreground">Model provider</h3>
                <p className="text-xs text-muted-foreground">
                  This agent&apos;s chats use the provider below. Manage API keys and connect new
                  providers in{" "}
                  <Link href="/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
                    Settings
                  </Link>
                  .
                </p>
              </header>

              <ul className="flex flex-col gap-3">
                {/* Instance-default row — clears the agent override. */}
                <ProviderRow
                  selected={draftProvider === INSTANCE_DEFAULT}
                  active={current.provider === INSTANCE_DEFAULT}
                  disabled={save.isPending}
                  title="Instance default"
                  subtitle={
                    instanceProvider
                      ? `Inherits ${instanceLabel} · ${instanceProvider.model}`
                      : "Inherits the instance provider"
                  }
                  onSelect={() => selectProvider(INSTANCE_DEFAULT)}
                />

                {rows.length === 0 ? (
                  <li className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-6 text-center text-[13px] text-muted-foreground">
                    No providers connected. Add one in{" "}
                    <Link href="/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
                      Settings
                    </Link>
                    .
                  </li>
                ) : (
                  rows.map((row) => {
                    const isSelected = draftProvider === row.name;
                    return (
                      <ProviderRow
                        key={row.id}
                        selected={isSelected}
                        active={current.provider === row.name}
                        disabled={save.isPending}
                        title={displayProviderName(row)}
                        // `local` is env-keyed in the catalog but reads as "Local"
                        // in the global settings rows; key off the name there so
                        // the two surfaces don't drift.
                        authLabel={row.name === "local" ? "Local" : AUTH_LABEL[row.auth] ?? row.auth}
                        // Only the agent's current override survives the configured
                        // filter while unconfigured; flag it so the user sees why
                        // it's broken.
                        notConnected={row.configured !== true}
                        subtitle={isSelected ? undefined : row.models[0] ?? ""}
                        onSelect={() => selectProvider(row.name)}
                      >
                        {isSelected ? (
                          // Stop both mouse and keyboard events here: the row is
                          // itself a button, and a Space/Enter that opens the model
                          // Select would otherwise bubble to the row's onKeyDown and
                          // re-run selectProvider, discarding the staged model.
                          <div
                            className="mt-3.5 space-y-2"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <span className="block text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
                              Model
                            </span>
                            <Select value={draftModel} onValueChange={setDraftModel} disabled={save.isPending}>
                              <SelectTrigger className="h-10 w-full border-border bg-secondary font-mono text-[13px]">
                                <SelectValue placeholder="Select model" />
                              </SelectTrigger>
                              <SelectContent>
                                {/* The agent's saved model may not be in the
                                    catalog list (a custom bedrock/openrouter/local
                                    id set via the global provider editor) — surface
                                    it so the select still shows the current value. */}
                                {row.models.includes(draftModel) ? null : draftModel ? (
                                  <SelectItem value={draftModel} className="font-mono text-[13px]">
                                    {draftModel}
                                  </SelectItem>
                                ) : null}
                                {row.models.map((m) => (
                                  <SelectItem key={m} value={m} className="font-mono text-[13px]">
                                    {m}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : null}
                      </ProviderRow>
                    );
                  })
                )}
              </ul>

              {dirty ? (
                <div className="flex items-center justify-end gap-2.5 rounded-xl border border-border bg-card px-5 py-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraftProvider(current.provider);
                      setDraftModel(current.model);
                    }}
                    disabled={save.isPending}
                  >
                    Cancel
                  </Button>
                  <Button type="button" size="sm" onClick={onSave} disabled={save.isPending}>
                    <CheckIcon className="size-4" />
                    {save.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              ) : null}
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// A selectable provider row. The whole row is the radio control (mirrors the
// global ProviderCard); children render inside the selected row (the model
// picker). `active` marks the agent's current effective selection.
function ProviderRow({
  selected,
  active,
  disabled,
  title,
  subtitle,
  authLabel,
  notConnected,
  onSelect,
  children
}: {
  selected: boolean;
  active: boolean;
  disabled?: boolean;
  title: string;
  subtitle?: string;
  authLabel?: string;
  notConnected?: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-disabled={disabled}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer rounded-2xl border border-border bg-card p-5 transition hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4277FB]/40 aria-disabled:cursor-not-allowed"
    >
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition",
            selected ? "border-[#4277FB]" : "border-border"
          )}
        >
          {selected ? <span className="size-2.5 rounded-full bg-[#4277FB]" /> : null}
        </span>
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-semibold text-foreground">{title}</span>
            {authLabel ? (
              <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {authLabel}
              </span>
            ) : null}
            {active ? (
              <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:bg-[#14321F] dark:text-[#4ADE80]">
                Active
              </span>
            ) : null}
            {notConnected ? (
              <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:bg-[#33270F] dark:text-[#FBBF24]">
                Not connected
              </span>
            ) : null}
          </div>
          {subtitle ? <p className="font-mono text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </li>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
