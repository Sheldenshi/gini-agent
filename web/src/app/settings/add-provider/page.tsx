"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ServerIcon,
  SparklesIcon,
  Terminal as TerminalIcon,
  ZapIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { ProviderCatalogItem } from "../_components/ProviderCard";

const SELECTABLE_PROVIDERS = ["openai", "openrouter", "deepseek", "local"] as const;

const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; description: string }> = {
  openai: { icon: SparklesIcon, description: "GPT-5.4, GPT-5.4 mini, …" },
  openrouter: { icon: ZapIcon, description: "Multi-model router" },
  deepseek: { icon: BotIcon, description: "DeepSeek V4 family" },
  local: { icon: ServerIcon, description: "Ollama, LM Studio, vLLM" }
};

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export default function AddProviderPage() {
  const router = useRouter();
  const params = useSearchParams();
  const invalidate = useInvalidate();
  const preselect = params.get("provider") ?? "";

  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog")
  });

  const tiles = useMemo(
    () =>
      SELECTABLE_PROVIDERS
        .map((name) => catalog.data?.find((c) => c.name === name))
        .filter((c): c is ProviderCatalogItem => Boolean(c)),
    [catalog.data]
  );

  const [providerName, setProviderName] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [apiKey, setApiKey] = useState("");

  // Seed once the catalog arrives: honor a ?provider= preselection from the
  // settings list (Edit button on a row), else fall back to the first tile.
  useEffect(() => {
    if (providerName !== "" || tiles.length === 0) return;
    const initial = tiles.find((t) => t.name === preselect) ?? tiles[0]!;
    setProviderName(initial.name);
    setSelectedModel(initial.models[0] ?? "");
  }, [tiles, preselect, providerName]);

  const onProviderChange = (next: string) => {
    setProviderName(next);
    const entry = tiles.find((t) => t.name === next);
    setSelectedModel(entry?.models[0] ?? "");
    setApiKey("");
  };

  const entry = tiles.find((t) => t.name === providerName);
  const requiresApiKey = providerName !== "local" && providerName !== "";

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: providerName,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(selectedModel ? { model: selectedModel } : {})
        })
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.error ?? "Failed to save provider.");
        return;
      }
      toast.success(`Provider set to ${providerName} (${selectedModel}).`);
      invalidate(["status", "providers"]);
      router.push("/settings");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const canSubmit =
    providerName !== "" &&
    selectedModel !== "" &&
    (!requiresApiKey || apiKey.trim().length > 0) &&
    !save.isPending;

  return (
    <>
      <header className="flex items-center justify-between border-b border-[#1C1C1E] px-10 py-6">
        <div className="flex items-center gap-4">
          <Button asChild variant="outline" size="icon" aria-label="Back to settings">
            <Link href="/settings">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Add provider</h1>
            <p className="text-xs text-muted-foreground">
              Connect a model provider for Gini to use on new chats.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings">Cancel</Link>
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-5 overflow-auto p-10">
        <section className="rounded-2xl border border-[#23232B] bg-[#121217] p-7">
          <div className="mb-5 space-y-1">
            <h2 className="text-sm font-semibold">Provider type</h2>
            <p className="text-xs text-muted-foreground">Choose the model API surface to configure.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((tile) => {
              const visual = PROVIDER_VISUAL[tile.name] ?? { icon: SparklesIcon, description: "" };
              const Icon = visual.icon;
              const selected = providerName === tile.name;
              return (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => onProviderChange(tile.name)}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition ${
                    selected
                      ? "border-[#3D3DC8] bg-[#1B1B33]"
                      : "border-[#23232B] bg-[#16161B] hover:border-[#2E2E38]"
                  }`}
                >
                  {selected ? (
                    <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-[#4F4FE0]">
                      <CheckIcon className="size-3 text-white" />
                    </span>
                  ) : null}
                  <span className="flex size-9 items-center justify-center rounded-lg bg-[#1C1C22]">
                    <Icon className="size-5 text-[#C2C2C8]" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{tile.displayName}</span>
                  <span className="text-xs text-muted-foreground">{visual.description}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-[#1F1F24] bg-[#141418] p-7">
          <div className="mb-5 space-y-1">
            <h2 className="text-sm font-semibold">Configure {entry?.displayName ?? "provider"}</h2>
            <p className="text-xs text-muted-foreground">
              {requiresApiKey
                ? "Saved to ~/.gini/secrets.env (mode 0600). Not sent anywhere except the provider."
                : "Local providers accept no-auth requests; leave the key blank if your gateway is open."}
            </p>
          </div>

          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) save.mutate();
            }}
          >
            {requiresApiKey ? (
              <div className="grid gap-2">
                <Label htmlFor="provider-api-key">API key</Label>
                <Input
                  id="provider-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder={providerName === "deepseek" ? "sk-… (DeepSeek)" : "sk-…"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={save.isPending}
                />
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="provider-model">Default model</Label>
              <Select
                key={providerName}
                defaultValue={selectedModel}
                onValueChange={setSelectedModel}
                disabled={!entry || save.isPending}
              >
                <SelectTrigger id="provider-model"><SelectValue placeholder="Select model" /></SelectTrigger>
                <SelectContent>
                  {entry?.models.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-[#1F1F26] pt-5">
              <Button asChild variant="outline" type="button">
                <Link href="/settings">Cancel</Link>
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {save.isPending ? "Saving…" : "Save provider"}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
