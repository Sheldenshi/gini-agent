"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  Terminal as TerminalIcon,
  Trash2Icon,
  ZapIcon
} from "lucide-react";
import type { ProviderConfig } from "@runtime/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { AnthropicLogo, AzureLogo, BedrockLogo, DeepSeekLogo, OllamaLogo, OpenAILogo } from "@/components/provider-logos";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";
import { EditProviderDialog } from "./EditProviderDialog";

// Providers whose credentials are env-keyed and therefore safe to remove
// from this UI: scrubbing the env var + secrets.env line is reversible
// (the user can add it back). Codex is owned by the codex CLI and local
// has no key to clear; bedrock signs with ~/.aws credentials gini doesn't
// manage — so neither row exposes the trash button. Azure is excluded too:
// its row only renders while it is the active provider (it has no default
// endpoint, so an inactive azure config isn't "configured"), and the trash
// button is disabled for the active row — a permanently-dead affordance.
// Azure is managed by switch + re-add via Add Provider; key cleanup is the
// CLI `gini provider` path.
const REMOVABLE_PROVIDERS = new Set(["openai", "openrouter", "deepseek", "anthropic"]);

// Providers selectable on the Settings page. Echo is dev-only; the four
// real providers map onto the Pencil mock (Codex, OpenAI, DeepSeek, Ollama
// stand in for `local`).
const SELECTABLE_PROVIDERS = ["codex", "openai", "anthropic", "bedrock", "deepseek", "openrouter", "azure", "local"] as const;

// Per-provider visual identity. Brand logos for OpenAI/DeepSeek/Ollama
// come from the authoritative Pencil design file; codex (Terminal) and
// openrouter (Zap) use Lucide because they have no widely-recognized
// brand mark to swap in.
const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; authLabel: string }> = {
  codex: { icon: TerminalIcon, authLabel: "OAuth" },
  openai: { icon: OpenAILogo, authLabel: "API key" },
  anthropic: { icon: AnthropicLogo, authLabel: "API key" },
  bedrock: { icon: BedrockLogo, authLabel: "AWS" },
  deepseek: { icon: DeepSeekLogo, authLabel: "API key" },
  openrouter: { icon: ZapIcon, authLabel: "API key" },
  azure: { icon: AzureLogo, authLabel: "API key" },
  local: { icon: OllamaLogo, authLabel: "Local" }
};

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export function ProviderCard({
  catalog,
  activeProviderName,
  activeProviderModel,
  activeProviderAwsRegion,
  activeProvider
}: {
  catalog: ProviderCatalogItem[];
  activeProviderName?: string;
  activeProviderModel?: string;
  // Active bedrock provider's region — threaded into the Edit dialog so it
  // opens pre-filled.
  activeProviderAwsRegion?: string;
  // Full persisted config for the ACTIVE provider (from /status). Carries the
  // transport fields the static catalog doesn't — baseUrl + Azure routing —
  // so the Edit dialog can prefill them when editing the active row.
  activeProvider?: ProviderConfig;
}) {
  const invalidate = useInvalidate();
  const rows = SELECTABLE_PROVIDERS
    .map((name) => catalog.find((c) => c.name === name))
    .filter((c): c is ProviderCatalogItem => c !== undefined && c.configured === true);

  // Staged selection. Clicking a non-active row's radio sets this; the
  // Save Bar appears at the bottom of the list with Cancel / Save changes.
  // Null when no switch is pending (the active row shows its purple radio
  // fill in that state). Resets to null on save success or cancel.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  // Row whose Edit pencil opened the inline dialog. Null when closed.
  const [editingRow, setEditingRow] = useState<ProviderCatalogItem | null>(null);
  // Row whose Trash button is pending confirmation. Null when no
  // confirmation is open. Removal scrubs the env var + secrets.env line,
  // so the confirmation is mandatory.
  const [removingRow, setRemovingRow] = useState<ProviderCatalogItem | null>(null);
  const queryClient = useQueryClient();
  const switching = pendingProvider !== null && pendingProvider !== activeProviderName;
  const pendingRow = switching ? rows.find((r) => r.name === pendingProvider) : undefined;

  const removeProvider = useMutation({
    mutationFn: async (name: string): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider/remove", {
        method: "POST",
        body: JSON.stringify({ provider: name })
      }),
    onSuccess: async (result, name) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to remove ${name}.`);
        return;
      }
      toast.success(`${name} disconnected.`);
      setRemovingRow(null);
      // Refetch synchronously so the row drops from the list before the
      // confirmation dialog closes — visible state matches the toast.
      queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.refetchQueries({ queryKey: ["providers"] });
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const setActive = useMutation({
    mutationFn: async (vars: { provider: string; model: string }): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({ provider: vars.provider, model: vars.model })
      }),
    onSuccess: (result, vars) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to set ${vars.provider}.`);
        return;
      }
      toast.success(`Active provider: ${vars.provider} (${vars.model})`);
      setPendingProvider(null);
      invalidate(["status", "providers"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Model providers</h2>
          <p className="text-xs text-muted-foreground">
            Select the active provider for new chats, or connect a new one.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/settings/add-provider">
            <PlusIcon className="size-4" />
            Add provider
          </Link>
        </Button>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-background p-10 text-center">
          <p className="text-sm font-medium text-foreground">No providers connected yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
            Add a provider to start chatting. Gini stores keys locally in
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.gini/secrets.env</code>
            and never proxies them anywhere except the provider you pick.
          </p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const isActive = activeProviderName === row.name;
          const isPending = pendingProvider === row.name && !isActive;
          // While a switch is staged the active row's radio empties out
          // (the purple fill follows the pending row), but the green
          // "Active" badge stays so the user can still see what's
          // currently in effect.
          const showRadioFill = switching ? isPending : isActive;
          const radioBorderClass = isPending || (!switching && isActive)
            ? "border-[#4277FB]"
            : "border-border";
          const visual = PROVIDER_VISUAL[row.name] ?? { icon: TerminalIcon, authLabel: row.auth };
          const Icon = visual.icon;
          const authLabel = visual.authLabel;
          const model = isActive
            ? (activeProviderModel ?? row.models[0] ?? "")
            : (row.models[0] ?? "");

          // Whole row is the selection target. Clicking the active row
          // clears any pending switch, clicking any other row stages it.
          // Locked while the mutation is in flight so a quick second
          // click can't double-fire. Edit/Remove buttons stop propagation
          // below so they don't accidentally re-select the row.
          const toggleRow = () => {
            if (setActive.isPending) return;
            setPendingProvider(isActive ? null : row.name);
          };

          return (
            <li
              key={row.id}
              role="button"
              tabIndex={0}
              aria-pressed={isPending || isActive}
              aria-label={isActive ? `${displayProviderName(row)} (active)` : `Stage ${displayProviderName(row)} as active`}
              aria-disabled={setActive.isPending}
              onClick={toggleRow}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRow();
                }
              }}
              className="flex cursor-pointer items-center gap-4 rounded-2xl border border-border bg-card p-5 transition hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4277FB]/40 aria-disabled:cursor-not-allowed"
            >
              {/* Radio is purely visual now — the row itself is the
                  control. Kept aria-hidden so screen readers don't
                  announce a separate selection state alongside the
                  row's aria-pressed. */}
              <span
                aria-hidden
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition ${radioBorderClass}`}
              >
                {showRadioFill ? <span className="size-2.5 rounded-full bg-[#4277FB]" /> : null}
              </span>
              <span className="flex size-[42px] items-center justify-center rounded-[11px] bg-muted">
                <Icon className="size-5 text-foreground" />
              </span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-semibold text-foreground">{displayProviderName(row)}</span>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    {authLabel}
                  </span>
                  {isActive ? (
                    <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:bg-[#14321F] dark:text-[#4ADE80]">
                      Active
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full bg-emerald-400" aria-hidden />
                  <span>Connected</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-mono">{model}</span>
                </div>
              </div>
              {/*
                Codex authenticates via codex --login → ~/.codex/auth.json,
                so there's no key or model to edit from this UI and nothing
                to "remove" without breaking the user's shell auth. Hide
                both row-level actions for codex; the Verify flow on the
                Add Provider page is the only place codex re-auth lives.
              */}
              {row.name === "codex" ? null : (
                // Action buttons live inside the clickable row, so each
                // handler stops propagation — otherwise clicking Edit or
                // Remove would also stage a switch on this row.
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Edit ${displayProviderName(row)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingRow(row);
                    }}
                  >
                    <PencilIcon className="size-4 text-muted-foreground" />
                  </Button>
                  {REMOVABLE_PROVIDERS.has(row.name) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Remove ${displayProviderName(row)}`}
                      // Block removal of the currently-active provider —
                      // the user should switch first via the radio + Save
                      // Bar, then delete. Avoids surprise fallbacks
                      // mid-conversation and keeps the rule one sentence
                      // long.
                      disabled={isActive}
                      title={isActive ? "Switch to another provider before removing this one." : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRemovingRow(row);
                      }}
                    >
                      <Trash2Icon className="size-4 text-muted-foreground" />
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={Boolean(removingRow)}
        onOpenChange={(open) => {
          if (!open && !removeProvider.isPending) setRemovingRow(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Remove {removingRow ? displayProviderName(removingRow) : "provider"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            You can reconnect anytime.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemovingRow(null)}
              disabled={removeProvider.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => removingRow && removeProvider.mutate(removingRow.name)}
              disabled={!removingRow || removeProvider.isPending}
            >
              {removeProvider.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {editingRow ? (
        <EditProviderDialog
          row={editingRow}
          authLabel={PROVIDER_VISUAL[editingRow.name]?.authLabel ?? editingRow.auth}
          icon={PROVIDER_VISUAL[editingRow.name]?.icon ?? TerminalIcon}
          currentModel={editingRow.name === activeProviderName ? activeProviderModel : undefined}
          // Active bedrock region — prefilled only when editing the ACTIVE row.
          currentAwsRegion={editingRow.name === activeProviderName ? activeProviderAwsRegion : undefined}
          // Prefill transport fields only when editing the ACTIVE row — the
          // persisted config from /status describes the active provider only.
          activeConfig={editingRow.name === activeProviderName ? activeProvider : undefined}
          open={Boolean(editingRow)}
          onOpenChange={(open) => {
            if (!open) setEditingRow(null);
          }}
        />
      ) : null}

      {switching && pendingRow ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[#D7DEFA] bg-[#EEF2FF] px-5 py-4 dark:border-[#2E3650] dark:bg-[#15171F]">
          <div className="flex items-center gap-3">
            <span className="flex size-[30px] items-center justify-center rounded-lg bg-[#E0E8FF] dark:bg-[#1D2333]">
              <ArrowLeftRightIcon className="size-4 text-[#4277FB] dark:text-[#9DB4FF]" />
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground">
                Switch active provider to {displayProviderName(pendingRow)}
              </p>
              <p className="text-xs text-muted-foreground">
                {activeProviderName
                  ? `${displayProviderName(rows.find((r) => r.name === activeProviderName) ?? { displayName: activeProviderName, name: activeProviderName })} is currently active.`
                  : "No provider is currently active."}{" "}
                Save to apply your change.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPendingProvider(null)}
              disabled={setActive.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                setActive.mutate({ provider: pendingRow.name, model: pendingRow.models[0] ?? "" })
              }
              disabled={setActive.isPending}
            >
              <CheckIcon className="size-4" />
              {setActive.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
