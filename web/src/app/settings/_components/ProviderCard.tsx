"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BotIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
  Terminal as TerminalIcon,
  Trash2Icon,
  ZapIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  displayName: string;
  auth: string;
  models: string[];
  baseUrl?: string;
}

// Providers selectable on the Settings page. Echo is dev-only; the four
// real providers map onto the Pencil mock (Codex, OpenAI, DeepSeek, Ollama
// stand in for `local`).
const SELECTABLE_PROVIDERS = ["codex", "openai", "deepseek", "openrouter", "local"] as const;

// Per-provider visual identity. Lucide icons mirror the iconography in the
// Pencil mock; auth label is what shows up in the small pill next to the
// provider name.
const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; authLabel: string }> = {
  codex: { icon: TerminalIcon, authLabel: "OAuth" },
  openai: { icon: SparklesIcon, authLabel: "API key" },
  deepseek: { icon: BotIcon, authLabel: "API key" },
  openrouter: { icon: ZapIcon, authLabel: "API key" },
  local: { icon: ServerIcon, authLabel: "Local" }
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
    .filter((c): c is ProviderCatalogItem => Boolean(c));

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

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const isActive = activeProviderName === row.name;
          const visual = PROVIDER_VISUAL[row.name] ?? { icon: SparklesIcon, authLabel: row.auth };
          const Icon = visual.icon;
          const model = isActive
            ? (activeProviderModel ?? row.models[0] ?? "")
            : (row.models[0] ?? "");

          return (
            <li
              key={row.id}
              className="flex items-center gap-4 rounded-2xl border border-[#1F1F24] bg-[#141418] p-5"
            >
              <span
                aria-hidden
                className={`flex size-5 items-center justify-center rounded-full border-[1.5px] ${
                  isActive ? "border-[#B57BBE]" : "border-[#3A3A40]"
                }`}
              >
                {isActive ? <span className="size-2.5 rounded-full bg-[#B57BBE]" /> : null}
              </span>
              <span className="flex size-[42px] items-center justify-center rounded-[11px] bg-[#1C1C22]">
                <Icon className="size-5 text-[#C2C2C8]" />
              </span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-semibold text-foreground">{row.displayName}</span>
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
              <div className="flex items-center gap-2">
                {isActive ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate({ provider: row.name, model })}
                  >
                    Set active
                  </Button>
                )}
                <Button asChild type="button" variant="outline" size="icon" aria-label={`Edit ${row.displayName}`}>
                  <Link href={`/settings/add-provider?provider=${row.name}`}>
                    <PencilIcon className="size-4 text-[#9A9AA0]" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Remove ${row.displayName}`}
                  disabled
                >
                  <Trash2Icon className="size-4 text-[#9A9AA0]" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
