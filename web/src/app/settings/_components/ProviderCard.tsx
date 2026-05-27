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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { DeepSeekLogo, OllamaLogo, OpenAILogo } from "@/components/provider-logos";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import { EditProviderDialog } from "./EditProviderDialog";

// Providers whose credentials are env-keyed and therefore safe to remove
// from this UI: scrubbing the env var + secrets.env line is reversible
// (the user can add it back). Codex is owned by the codex CLI and local
// has no key to clear, so neither row exposes the trash button.
const REMOVABLE_PROVIDERS = new Set(["openai", "openrouter", "deepseek"]);

export interface ProviderCatalogItem {
  id: string;
  name: string;
  displayName: string;
  auth: string;
  models: string[];
  baseUrl?: string;
  // True when credentials for this provider are available in the running
  // gateway (env var set, codex auth.json present, or local explicitly
  // activated). Settings hides un-configured rows; Add Provider treats the
  // flag as informational.
  configured?: boolean;
}

// Trim suffixes that the static catalog stacks on top of the brand name.
// The Pencil mocks reference providers by short name (OpenAI, OpenRouter,
// Codex, …); the auth badge alongside each row carries the "how" (OAuth /
// API key / Local) so the brand label doesn't need to repeat it.
export function displayProviderName(item: { displayName: string; name: string }): string {
  if (item.name === "local") return "Local";
  if (item.name === "codex") return "Codex";
  return item.displayName.replace(/\s+Compatible$/i, "");
}

// Providers selectable on the Settings page. Echo is dev-only; the four
// real providers map onto the Pencil mock (Codex, OpenAI, DeepSeek, Ollama
// stand in for `local`).
const SELECTABLE_PROVIDERS = ["codex", "openai", "deepseek", "openrouter", "local"] as const;

// Per-provider visual identity. Brand logos for OpenAI/DeepSeek/Ollama
// come from the authoritative Pencil design file; codex (Terminal) and
// openrouter (Zap) use Lucide because they have no widely-recognized
// brand mark to swap in.
const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; authLabel: string }> = {
  codex: { icon: TerminalIcon, authLabel: "OAuth" },
  openai: { icon: OpenAILogo, authLabel: "API key" },
  deepseek: { icon: DeepSeekLogo, authLabel: "API key" },
  openrouter: { icon: ZapIcon, authLabel: "API key" },
  local: { icon: OllamaLogo, authLabel: "Local" }
};

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export function ProviderCard({
  catalog,
  activeProviderName,
  activeProviderModel
}: {
  catalog: ProviderCatalogItem[];
  activeProviderName?: string;
  activeProviderModel?: string;
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
        <div className="rounded-2xl border border-dashed border-[#23232B] bg-[#0F0F13] p-10 text-center">
          <p className="text-sm font-medium text-foreground">No providers connected yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
            Add a provider to start chatting. Gini stores keys locally in
            <code className="mx-1 rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">~/.gini/secrets.env</code>
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
            : "border-[#3A3A40]";
          const visual = PROVIDER_VISUAL[row.name] ?? { icon: TerminalIcon, authLabel: row.auth };
          const Icon = visual.icon;
          const model = isActive
            ? (activeProviderModel ?? row.models[0] ?? "")
            : (row.models[0] ?? "");

          return (
            <li
              key={row.id}
              className="flex items-center gap-4 rounded-2xl border border-[#1F1F24] bg-[#141418] p-5"
            >
              {/* Radio doubles as the row's selection control: clicking
                  the active row clears any pending switch, clicking any
                  other row stages it. Disabled while the mutation is in
                  flight so a quick second click can't double-fire. */}
              <button
                type="button"
                aria-label={isActive ? `${displayProviderName(row)} (active)` : `Stage ${displayProviderName(row)} as active`}
                aria-pressed={isPending || isActive}
                onClick={() => setPendingProvider(isActive ? null : row.name)}
                disabled={setActive.isPending}
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition disabled:cursor-not-allowed ${radioBorderClass}`}
              >
                {showRadioFill ? <span className="size-2.5 rounded-full bg-[#4277FB]" /> : null}
              </button>
              <span className="flex size-[42px] items-center justify-center rounded-[11px] bg-[#1C1C22]">
                <Icon className="size-5 text-[#C2C2C8]" />
              </span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-semibold text-foreground">{displayProviderName(row)}</span>
                  <span className="rounded-md bg-[#1C1C22] px-2 py-0.5 text-[11px] font-semibold text-[#9A9AA0]">
                    {visual.authLabel}
                  </span>
                  {isActive ? (
                    <span className="rounded-md bg-[#14321F] px-2 py-0.5 text-[11px] font-semibold text-[#4ADE80]">
                      Active
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full bg-emerald-400" aria-hidden />
                  <span>Connected</span>
                  <span className="text-[#4A4A50]">·</span>
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
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Edit ${displayProviderName(row)}`}
                    onClick={() => setEditingRow(row)}
                  >
                    <PencilIcon className="size-4 text-[#9A9AA0]" />
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
                      onClick={() => setRemovingRow(row)}
                    >
                      <Trash2Icon className="size-4 text-[#9A9AA0]" />
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
        <DialogContent className="gap-5 border-[#1F1F24] bg-[#141418] p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Remove {removingRow ? displayProviderName(removingRow) : "provider"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            You can reconnect anytime.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-[#1F1F26] pt-4">
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
          open={Boolean(editingRow)}
          onOpenChange={(open) => {
            if (!open) setEditingRow(null);
          }}
        />
      ) : null}

      {switching && pendingRow ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[#2E3650] bg-[#15171F] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-[30px] items-center justify-center rounded-lg bg-[#1D2333]">
              <ArrowLeftRightIcon className="size-4 text-[#9DB4FF]" />
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
