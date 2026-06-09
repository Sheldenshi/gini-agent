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
import { AnthropicLogo, BedrockLogo, DeepSeekLogo, OllamaLogo, OpenAILogo } from "@/components/provider-logos";
import { BedrockModelSelect } from "../_components/BedrockModelSelect";
import { api } from "@/lib/api";
import { displayProviderName, type ProviderCatalogItem } from "../_components/ProviderCard";

// Codex stays first so it lines up with where the Settings list shows
// its row. Echo is dev-only and never appears here.
const SELECTABLE_PROVIDERS = ["codex", "openai", "anthropic", "bedrock", "openrouter", "deepseek", "local"] as const;

const PROVIDER_VISUAL: Record<string, { icon: React.ComponentType<{ className?: string }>; description: string }> = {
  codex: { icon: TerminalIcon, description: "OAuth via codex --login" },
  openai: { icon: OpenAILogo, description: "GPT-5.4, GPT-5.4 mini, …" },
  anthropic: { icon: AnthropicLogo, description: "Claude (first-party API key)" },
  bedrock: { icon: BedrockLogo, description: "Claude, Nova, Llama… on AWS" },
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
  // Optional first-party endpoint override (anthropic/openai-compatible proxies).
  const [baseUrl, setBaseUrl] = useState("");
  // Optional AWS region for the bedrock provider (defaults to us-east-1).
  const [awsRegion, setAwsRegion] = useState("");

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
    setAwsRegion("");
  };

  const entry = tiles.find((t) => t.name === providerName);
  const isCodex = providerName === "codex";
  const isLocal = providerName === "local";
  const isAnthropic = providerName === "anthropic";
  const isBedrock = providerName === "bedrock";
  // Codex (OAuth), bedrock (AWS SigV4), and local (no-auth) hold no gini key.
  const requiresApiKey = providerName !== "" && !isCodex && !isLocal && !isBedrock;

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
          ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(isBedrock && awsRegion.trim() ? { awsRegion: awsRegion.trim() } : {})
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
      // Refetch providers BEFORE navigating so the settings list mounts
      // with the row already present. We can't use useInvalidate here —
      // it debounces 80ms and its unmount cleanup clears the pending set
      // when this page unmounts, so the invalidation never fires.
      queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.refetchQueries({ queryKey: ["providers"] });
      router.push("/settings");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const canSubmit =
    providerName !== "" &&
    !save.isPending &&
    (isCodex ? true : selectedModel.trim() !== "" && (!requiresApiKey || apiKey.trim().length > 0));

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
                : isBedrock
                  ? "Bedrock signs each request with your AWS credentials — no API key needed."
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
            ) : isBedrock ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Gini signs each Converse request with the AWS credentials it finds in
                  <code className="mx-1 rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">AWS_ACCESS_KEY_ID</code>/<code className="rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">AWS_SECRET_ACCESS_KEY</code>
                  (plus <code className="mx-1 rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">AWS_SESSION_TOKEN</code> for temporary sessions)
                  or your <code className="mx-1 rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">~/.aws/credentials</code> profile. No API key. SSO or assumed-role users: export the session first with <code className="mx-1 rounded bg-[#1C1C22] px-1 py-0.5 font-mono text-[11px]">aws configure export-credentials</code>.
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="bedrock-model">Model (cross-region inference profile)</Label>
                  <BedrockModelSelect
                    id="bedrock-model"
                    models={entry?.models ?? []}
                    value={selectedModel}
                    onChange={setSelectedModel}
                    disabled={!entry || save.isPending}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pick a model, or choose <span className="font-medium">Custom model id…</span> to enter any Bedrock inference-profile id.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bedrock-region">
                    AWS region <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="bedrock-region"
                    type="text"
                    autoComplete="off"
                    placeholder="us-east-1"
                    value={awsRegion}
                    onChange={(e) => setAwsRegion(e.target.value)}
                    disabled={save.isPending}
                  />
                </div>
              </>
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

                {isAnthropic ? (
                  <div className="grid gap-2">
                    <Label htmlFor="provider-base-url">
                      Base URL <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="provider-base-url"
                      type="text"
                      autoComplete="off"
                      placeholder="https://api.anthropic.com"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
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
