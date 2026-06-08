"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  CheckIcon,
  Terminal as TerminalIcon,
  ZapIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DeepSeekLogo, OllamaLogo, OpenAILogo } from "@/components/provider-logos";
import { api } from "@/lib/api";
import { displayProviderName, type ProviderCatalogItem } from "../_components/ProviderCard";

// Codex stays first so it lines up with where the Settings list shows
// its row. Echo is dev-only and never appears here.
const SELECTABLE_PROVIDERS = ["codex", "openai", "openrouter", "deepseek", "local"] as const;

const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; description: string }> = {
  codex: { icon: TerminalIcon, description: "OAuth via codex --login" },
  openai: { icon: OpenAILogo, description: "GPT-5.4, GPT-5.4 mini, …" },
  openrouter: { icon: ZapIcon, description: "Multi-model router" },
  deepseek: { icon: DeepSeekLogo, description: "DeepSeek V4 family" },
  local: { icon: OllamaLogo, description: "Ollama, LM Studio, vLLM" }
};

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export default function AddProviderPage() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
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
  // Transport overrides. baseUrl applies to every OpenAI-compatible provider;
  // the Azure fields (apiVersion/deployment/authScheme) only matter for openai
  // and are what point it at an Azure deployment.
  const [baseUrl, setBaseUrl] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [deployment, setDeployment] = useState("");
  const [authScheme, setAuthScheme] = useState("bearer");

  // Show the Azure fields when the base URL looks like an Azure endpoint OR an
  // api-version is already set (the runtime's actual Azure-mode signal), so a
  // custom Azure domain isn't hidden. A standard OpenAI setup has neither.
  // Blanking the base URL clears apiVersion/deployment (see onBaseUrlChange),
  // which drives this false so the section collapses.
  const isAzure = /azure/i.test(baseUrl) || apiVersion.trim().length > 0;

  // Blanking the Base URL is an explicit "leave this endpoint" action: clear the
  // Azure routing fields too so the section collapses and a later save reverts to
  // the standard OpenAI endpoint, rather than leaving a stranded apiVersion that
  // the backend rejects (apiVersion without an Azure base URL would 404).
  const onBaseUrlChange = (next: string) => {
    setBaseUrl(next);
    if (next.trim().length === 0) {
      setApiVersion("");
      setDeployment("");
      setAuthScheme("bearer");
    }
  };

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
    setBaseUrl("");
    setApiVersion("");
    setDeployment("");
    setAuthScheme("bearer");
  };

  const entry = tiles.find((t) => t.name === providerName);
  const isCodex = providerName === "codex";
  const isLocal = providerName === "local";
  const requiresApiKey = providerName !== "" && !isCodex && !isLocal;

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> => {
      // Codex doesn't take an apiKey or a user-picked model: the gateway
      // reads ~/.codex/auth.json on each call and the catalog only ships
      // gpt-5.5. Send a minimal payload so the backend's codex branch runs.
      if (isCodex) {
        return api<SetProviderResult>("/setup/provider", {
          method: "POST",
          body: JSON.stringify({ provider: "codex" })
        });
      }
      return api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: providerName,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          // baseUrl applies to any OpenAI-compatible provider; the Azure fields
          // are openai-only. Sent verbatim (blank included) so the backend
          // treats an empty value as "use the default endpoint".
          ...(!isCodex ? { baseUrl: baseUrl.trim() } : {}),
          ...(providerName === "openai"
            ? isAzure
              ? { apiVersion: apiVersion.trim(), deployment: deployment.trim(), authScheme }
              : { apiVersion: "", deployment: "", authScheme: "bearer" }
            : {})
        })
      });
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error ?? "Failed to save provider.");
        return;
      }
      toast.success(
        isCodex
          ? "Codex OAuth verified."
          : `Provider set to ${providerName} (${selectedModel}).`
      );
      // Refetch BOTH providers and status BEFORE navigating, so the settings
      // list mounts with the row present AND the Edit dialog's /status-sourced
      // prefill is fresh (a fast edit otherwise reopens with stale transport
      // fields). We can't use useInvalidate here — it debounces 80ms and its
      // unmount cleanup clears the pending set when this page unmounts, so the
      // invalidation never fires.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["providers"] }),
        queryClient.refetchQueries({ queryKey: ["status"] })
      ]);
      router.push("/settings");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const canSubmit =
    providerName !== "" &&
    !save.isPending &&
    (isCodex ? true : selectedModel !== "" && (!requiresApiKey || apiKey.trim().length > 0));

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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {tiles.map((tile) => {
              const visual = PROVIDER_VISUAL[tile.name] ?? { icon: TerminalIcon, description: "" };
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
                  <span className="text-sm font-semibold text-foreground">{displayProviderName(tile)}</span>
                  <span className="text-xs text-muted-foreground">{visual.description}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-[#1F1F24] bg-[#141418] p-7">
          <div className="mb-5 space-y-1">
            <h2 className="text-sm font-semibold">Configure {entry ? displayProviderName(entry) : "provider"}</h2>
            <p className="text-xs text-muted-foreground">
              {isCodex
                ? "Codex authenticates through your existing ChatGPT account — no API key needed."
                : isLocal
                  ? "Local providers accept no-auth requests; leave the key blank if your gateway is open."
                  : "Saved to ~/.gini/secrets.env (mode 0600). Not sent anywhere except the provider."}
            </p>
          </div>

          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) save.mutate();
            }}
          >
            {isCodex ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground">
                  Run this in your terminal, then click Verify Codex auth:
                </p>
                <pre className="rounded-md bg-[#0F0F13] px-4 py-3 font-mono text-xs text-[#C2C2C8]">codex --login</pre>
                <p className="text-xs text-muted-foreground">
                  Gini reads <code className="rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">~/.codex/auth.json</code> on
                  every request, so a future <code className="rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">codex --login</code> refresh is picked up automatically.
                </p>
              </div>
            ) : (
              <>
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

                <div className="grid gap-2">
                  <Label htmlFor="provider-base-url">
                    Base URL <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="provider-base-url"
                    autoComplete="off"
                    placeholder={
                      providerName === "openai"
                        ? "https://api.openai.com/v1 · Azure: https://<resource>.openai.azure.com"
                        : "Override the default endpoint"
                    }
                    value={baseUrl}
                    onChange={(e) => onBaseUrlChange(e.target.value)}
                    disabled={save.isPending}
                  />
                </div>

                {providerName === "openai" && isAzure ? (
                  <div className="grid gap-3">
                    <p className="text-xs font-semibold text-[#C2C2C8]">
                      Azure OpenAI{" "}
                      <span className="font-normal text-muted-foreground">— deployment settings for this endpoint</span>
                    </p>
                    <div className="grid gap-2">
                      <Label htmlFor="provider-api-version">API version</Label>
                      <Input
                        id="provider-api-version"
                        autoComplete="off"
                        placeholder="e.g. 2024-12-01-preview"
                        value={apiVersion}
                        onChange={(e) => setApiVersion(e.target.value)}
                        disabled={save.isPending}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="provider-deployment">Deployment</Label>
                      <Input
                        id="provider-deployment"
                        autoComplete="off"
                        placeholder="Defaults to the model name"
                        value={deployment}
                        onChange={(e) => setDeployment(e.target.value)}
                        disabled={save.isPending}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="provider-auth-scheme">Auth scheme</Label>
                      <Select value={authScheme} onValueChange={setAuthScheme} disabled={save.isPending}>
                        <SelectTrigger id="provider-auth-scheme"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bearer">Bearer (OpenAI / Azure Entra token)</SelectItem>
                          <SelectItem value="api-key">api-key (Azure resource key)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : null}
              </>
            )}

            <div className="flex items-center justify-end gap-3 border-t border-[#1F1F26] pt-5">
              <Button asChild variant="outline" type="button">
                <Link href="/settings">Cancel</Link>
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {save.isPending
                  ? (isCodex ? "Verifying…" : "Saving…")
                  : (isCodex ? "Verify Codex auth" : "Save provider")}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
