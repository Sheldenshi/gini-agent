"use client";

// Shared provider selection + configuration surface. Both the first-run
// /setup screen and Settings → Add provider render this: an eight-tile grid
// (the SELECTABLE catalog providers) plus the per-provider config form, and a
// single POST /api/setup/provider on submit. The two routes differ only in
// chrome and what happens after a successful save, so those are injected:
//   - onSaved(summary): navigation + any toast (setup redirects home; add
//     provider refetches the lists and pushes /settings).
//   - onError(message): when present, the caller owns failure presentation
//     (Settings toasts). When absent, the picker renders the error inline
//     (the centered /setup card has nowhere better to put it).
//   - secondaryAction: an optional node rendered left of the submit button
//     (Settings puts a Cancel link there; setup has none — onboarding can't
//     be cancelled).
//
// The branching logic (which fields a provider needs, the POST payload, the
// submit gate) lives in exported pure helpers so it can be unit-tested without
// driving the DOM, mirroring ModelPicker's split.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { providerIcon } from "@/components/provider-logos";
import { BedrockModelSelect } from "@/app/settings/_components/BedrockModelSelect";
import { BedrockRegionSelect } from "@/app/settings/_components/BedrockRegionSelect";
import { DocReference } from "@/components/DocReference";
import { api } from "@/lib/api";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";

// Codex stays first so it lines up with where the Settings list shows its row.
// Echo is dev-only and never appears here.
export const SELECTABLE_PROVIDERS = [
  "codex",
  "openai",
  "anthropic",
  "bedrock",
  "openrouter",
  "deepseek",
  "azure",
  "local"
] as const;

// One-line tile blurb per provider. The icon comes from the shared
// provider-logos map (providerIcon), so this only carries the wording.
export const PROVIDER_DESCRIPTION: Record<string, string> = {
  codex: "OAuth via codex login",
  openai: "GPT-5.4, GPT-5.4 mini, …",
  anthropic: "Claude (first-party API key)",
  bedrock: "Claude, Nova, Llama… on AWS",
  openrouter: "Multi-model router",
  deepseek: "DeepSeek V4 family",
  azure: "Azure OpenAI deployments",
  local: "Ollama, LM Studio, vLLM"
};

// The full set of form fields a provider config can carry. A given provider
// only reads the subset its branch needs; the rest stay at their empty
// defaults and are dropped from the payload.
export interface ProviderFormState {
  providerName: string;
  selectedModel: string;
  apiKey: string;
  baseUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  apiVersion: string;
  deployment: string;
  authScheme: string;
}

export interface ProviderFlags {
  isCodex: boolean;
  isLocal: boolean;
  isAnthropic: boolean;
  isBedrock: boolean;
  isAzure: boolean;
  // Codex (OAuth), bedrock (AWS SigV4), and local (no-auth) hold no gini key.
  requiresApiKey: boolean;
}

export function providerFlags(name: string): ProviderFlags {
  return {
    isCodex: name === "codex",
    isLocal: name === "local",
    isAnthropic: name === "anthropic",
    isBedrock: name === "bedrock",
    isAzure: name === "azure",
    requiresApiKey: name !== "" && name !== "codex" && name !== "local" && name !== "bedrock"
  };
}

// Build the POST /api/setup/provider body for the current form state. Codex
// takes no apiKey or user-picked model — the gateway reads ~/.codex/auth.json
// on each call and the catalog only ships gpt-5.5 — so it posts the minimal
// branch trigger. Everyone else sends only the fields they actually use.
export function buildProviderPayload(state: ProviderFormState): Record<string, unknown> {
  const flags = providerFlags(state.providerName);
  if (flags.isCodex) {
    return { provider: "codex" };
  }
  return {
    provider: state.providerName,
    ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
    ...(state.selectedModel.trim() ? { model: state.selectedModel.trim() } : {}),
    // baseUrl applies to anthropic and every OpenAI-compatible provider
    // (local / openai / openrouter / deepseek / azure); bedrock ignores it.
    // For azure it is the required resource endpoint, for the others an
    // optional override, so only send it when non-empty.
    ...(!flags.isBedrock && state.baseUrl.trim() ? { baseUrl: state.baseUrl.trim() } : {}),
    // Bedrock signs with AWS creds; an optional region override travels here.
    ...(flags.isBedrock && state.awsRegion.trim() ? { awsRegion: state.awsRegion.trim() } : {}),
    // Bedrock AWS credentials, entered on add (gini doesn't read ~/.aws). The
    // backend writes them to secrets.env under the AWS_* names.
    ...(flags.isBedrock && state.awsAccessKeyId.trim() ? { awsAccessKeyId: state.awsAccessKeyId.trim() } : {}),
    ...(flags.isBedrock && state.awsSecretAccessKey.trim() ? { awsSecretAccessKey: state.awsSecretAccessKey.trim() } : {}),
    // Azure routing fields default server-side when blank.
    ...(flags.isAzure
      ? {
          apiVersion: state.apiVersion.trim(),
          deployment: state.deployment.trim(),
          authScheme: state.authScheme
        }
      : {})
  };
}

// Whether the current form is submittable. Codex needs nothing beyond being
// selected; every other provider needs a model, an API key when its auth
// requires one, an https resource endpoint for azure, and both AWS keys for
// bedrock (gini does not read ~/.aws, so the pair is entered here).
export function canSubmitProvider(state: ProviderFormState, isPending: boolean): boolean {
  if (state.providerName === "" || isPending) return false;
  const flags = providerFlags(state.providerName);
  if (flags.isCodex) return true;
  return (
    state.selectedModel.trim() !== "" &&
    (!flags.requiresApiKey || state.apiKey.trim().length > 0) &&
    (!flags.isAzure || state.baseUrl.trim().length > 0) &&
    (!flags.isBedrock || (state.awsAccessKeyId.trim().length > 0 && state.awsSecretAccessKey.trim().length > 0))
  );
}

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export interface ProviderSaveSummary {
  provider: string;
  model: string;
  isCodex: boolean;
}

export interface ProviderPickerProps {
  // Honor a ?provider= preselection (Settings' Edit button); else first tile.
  preselect?: string;
  // Submit-button wording for the non-codex case. Codex always reads
  // "Verify Codex auth" / "Verifying…" regardless.
  submitLabel?: string;
  pendingLabel?: string;
  // Rendered left of the submit button (e.g. a Cancel link).
  secondaryAction?: ReactNode;
  onSaved: (summary: ProviderSaveSummary) => void | Promise<void>;
  // When provided, the caller owns failure presentation (toast). When omitted,
  // the picker shows the message inline above the footer.
  onError?: (message: string) => void;
}

export function ProviderPicker({
  preselect = "",
  submitLabel = "Save provider",
  pendingLabel = "Saving…",
  secondaryAction,
  onSaved,
  onError
}: ProviderPickerProps) {
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog")
  });

  const tiles = useMemo(
    () =>
      SELECTABLE_PROVIDERS.map((name) => catalog.data?.find((c) => c.name === name)).filter(
        (c): c is ProviderCatalogItem => Boolean(c)
      ),
    [catalog.data]
  );

  const [providerName, setProviderName] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [awsRegion, setAwsRegion] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [deployment, setDeployment] = useState("");
  const [authScheme, setAuthScheme] = useState("api-key");
  const [error, setError] = useState<string | null>(null);

  // Seed once the catalog arrives: honor a ?provider= preselection, else the
  // first tile.
  useEffect(() => {
    if (providerName !== "" || tiles.length === 0) return;
    const initial = tiles.find((t) => t.name === preselect) ?? tiles[0]!;
    setProviderName(initial.name);
    setSelectedModel(initial.models[0] ?? "");
  }, [tiles, preselect, providerName]);

  const onProviderChange = (next: string) => {
    setProviderName(next);
    const tile = tiles.find((t) => t.name === next);
    setSelectedModel(tile?.models[0] ?? "");
    setApiKey("");
    setBaseUrl("");
    setAwsRegion("");
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setApiVersion("");
    setDeployment("");
    setAuthScheme("api-key");
    setError(null);
  };

  const entry = tiles.find((t) => t.name === providerName);
  const flags = providerFlags(providerName);
  const { isCodex, isLocal, isAnthropic, isBedrock, isAzure, requiresApiKey } = flags;

  const formState: ProviderFormState = {
    providerName,
    selectedModel,
    apiKey,
    baseUrl,
    awsRegion,
    awsAccessKeyId,
    awsSecretAccessKey,
    apiVersion,
    deployment,
    authScheme
  };

  const reportError = (message: string) => {
    if (onError) onError(message);
    else setError(message);
  };

  // Freeze the payload and the success summary together at submit time and
  // thread them through the mutation. Reading state in onSuccess instead would
  // report whichever provider is selected when the POST RESOLVES — if the user
  // clicks a different tile mid-flight, the toast/redirect would announce a
  // provider the backend never received. A single frozen snapshot keeps the
  // request body and the reported summary in agreement.
  const save = useMutation({
    mutationFn: ({ payload }: { payload: Record<string, unknown>; summary: ProviderSaveSummary }): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    onSuccess: async (result, { summary }) => {
      if (!result.ok) {
        reportError(result.error ?? "Failed to save provider.");
        return;
      }
      setError(null);
      await onSaved(summary);
    },
    onError: (e: Error) => reportError(e.message)
  });

  const submit = () => {
    save.mutate({
      payload: buildProviderPayload(formState),
      summary: { provider: providerName, model: selectedModel, isCodex }
    });
  };

  const canSubmit = canSubmitProvider(formState, save.isPending);

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-2xl border border-border bg-card p-7">
        <div className="mb-5 space-y-1">
          <h2 className="text-sm font-semibold">Provider type</h2>
          <p className="text-xs text-muted-foreground">Choose the model API surface to configure.</p>
        </div>
        {catalog.isError ? (
          // A catalog fetch failure (e.g. the local gateway restarting — the BFF
          // answers 503 gateway_unreachable, which api() throws on) must surface
          // as a terminal error, not a spinner that never resolves.
          <p className="text-xs text-destructive">
            Couldn&apos;t load providers. Check that the gateway is running, then retry.
          </p>
        ) : tiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading providers…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((tile) => {
              const Icon = providerIcon(tile.name);
              const selected = providerName === tile.name;
              return (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => onProviderChange(tile.name)}
                  // Lock tile switching while a save is in flight, matching the
                  // config inputs below — the success summary is snapshotted at
                  // submit, but disabling here also keeps the visible selection
                  // honest about what's being saved.
                  disabled={save.isPending}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "border-[#4277FB] bg-[#EEF2FF] dark:border-[#3D3DC8] dark:bg-[#1B1B33]"
                      : "border-border bg-card hover:bg-accent"
                  }`}
                >
                  {selected ? (
                    <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-[#4277FB]">
                      <CheckIcon className="size-3 text-white" />
                    </span>
                  ) : null}
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-5 text-foreground" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{displayProviderName(tile)}</span>
                  <span className="text-xs text-muted-foreground">{PROVIDER_DESCRIPTION[tile.name] ?? ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* The config form only makes sense once a real provider is selected.
          Before the catalog seeds (or if it errors), `entry` is undefined —
          rendering the form then would show an empty "Configure provider"
          shell with a disabled, optionless model select. */}
      {entry ? (
      <section className="rounded-2xl border border-border bg-card p-7">
        <div className="mb-5 space-y-1">
          <h2 className="text-sm font-semibold">Configure {displayProviderName(entry)}</h2>
          <p className="text-xs text-muted-foreground">
            {isCodex
              ? "Codex authenticates through your existing ChatGPT account — no API key needed."
              : isBedrock
                ? "Enter your AWS access key — saved to ~/.gini/secrets.env (mode 0600), used to sign each request."
                : isLocal
                  ? "Local providers accept no-auth requests; leave the key blank if your gateway is open."
                  : "Saved to ~/.gini/secrets.env (mode 0600). Not sent anywhere except the provider."}
          </p>
          {entry?.setupDocUrl ? (
            <p className="text-xs text-muted-foreground">
              Need help?{" "}
              <DocReference url={entry.setupDocUrl}>
                <button type="button" className="underline underline-offset-2 hover:text-foreground">
                  Read the {displayProviderName(entry)} setup guide
                </button>
              </DocReference>
            </p>
          ) : null}
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) submit();
          }}
        >
          {isCodex ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">Run this in your terminal, then click Verify Codex auth:</p>
              <pre className="rounded-md bg-muted px-4 py-3 font-mono text-xs text-foreground">codex login</pre>
              <p className="text-xs text-muted-foreground">
                Gini reads <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.codex/auth.json</code>{" "}
                on every request, so a future{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">codex login</code> refresh is picked
                up automatically.
              </p>
            </div>
          ) : isBedrock ? (
            <>
              <p className="text-xs text-muted-foreground">
                Create an IAM user access key in the AWS console (IAM → Users → Security credentials → Create access
                key) and paste both parts below. Gini signs each Converse request with them using AWS SigV4 — it never
                reads <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.aws</code>.
              </p>
              <div className="grid gap-2">
                <Label htmlFor="bedrock-access-key-id">AWS Access Key ID</Label>
                <Input
                  id="bedrock-access-key-id"
                  type="text"
                  autoComplete="off"
                  placeholder="AKIA…"
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  disabled={save.isPending}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bedrock-secret-access-key">AWS Secret Access Key</Label>
                <Input
                  id="bedrock-secret-access-key"
                  type="password"
                  autoComplete="off"
                  placeholder="Secret access key"
                  value={awsSecretAccessKey}
                  onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                  disabled={save.isPending}
                />
              </div>
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
                  Pick a model, or choose <span className="font-medium">Custom model id…</span> to enter any Bedrock
                  inference-profile id.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bedrock-region">AWS region</Label>
                <BedrockRegionSelect
                  id="bedrock-region"
                  value={awsRegion}
                  onChange={setAwsRegion}
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

              {isAzure ? (
                <div className="grid gap-5">
                  <div className="grid gap-2">
                    <Label htmlFor="provider-base-url">Resource endpoint</Label>
                    <Input
                      id="provider-base-url"
                      type="text"
                      autoComplete="off"
                      placeholder="https://<resource>.openai.azure.com"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={save.isPending}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="provider-api-version">API version</Label>
                      <Input
                        id="provider-api-version"
                        type="text"
                        autoComplete="off"
                        placeholder="2024-10-21"
                        value={apiVersion}
                        onChange={(e) => setApiVersion(e.target.value)}
                        disabled={save.isPending}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="provider-deployment">Deployment</Label>
                      <Input
                        id="provider-deployment"
                        type="text"
                        autoComplete="off"
                        placeholder="Defaults to model"
                        value={deployment}
                        onChange={(e) => setDeployment(e.target.value)}
                        disabled={save.isPending}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="provider-auth-scheme">Auth scheme</Label>
                    <Select value={authScheme} onValueChange={setAuthScheme} disabled={save.isPending}>
                      <SelectTrigger id="provider-auth-scheme">
                        <SelectValue placeholder="Select auth scheme" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="api-key">api-key (resource key)</SelectItem>
                        <SelectItem value="bearer">bearer (Entra token)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : isAnthropic ? (
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
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="provider-base-url">
                    Base URL <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="provider-base-url"
                    type="text"
                    autoComplete="off"
                    placeholder="Override the default endpoint"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={save.isPending}
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="provider-model">Model</Label>
                <Select
                  key={providerName}
                  defaultValue={selectedModel}
                  onValueChange={setSelectedModel}
                  disabled={!entry || save.isPending}
                >
                  <SelectTrigger id="provider-model">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {entry?.models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
            {secondaryAction}
            <Button type="submit" disabled={!canSubmit}>
              {save.isPending
                ? isCodex
                  ? "Verifying…"
                  : pendingLabel
                : isCodex
                  ? "Verify Codex auth"
                  : submitLabel}
            </Button>
          </div>
        </form>
      </section>
      ) : null}
    </div>
  );
}
