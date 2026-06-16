"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BedrockModelSelect } from "./BedrockModelSelect";
import { BedrockRegionSelect } from "./BedrockRegionSelect";
import { api } from "@/lib/api";
import type { ProviderConfig } from "@runtime/types";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export function EditProviderDialog({
  row,
  authLabel,
  icon: Icon,
  currentModel,
  currentAwsRegion,
  activeConfig,
  open,
  onOpenChange
}: {
  row: ProviderCatalogItem;
  authLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  currentModel?: string;
  // The active bedrock provider's persisted region, so the dialog opens pre-filled.
  currentAwsRegion?: string;
  // Persisted transport config for this provider when it is the active one —
  // used to prefill the Azure base URL + routing fields on open.
  activeConfig?: ProviderConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isAnthropic = row.name === "anthropic";
  // Bedrock signs with an AWS access key + secret (no bearer API key) and takes
  // any model id, so its edit surface is the two key fields + a model + region.
  const isBedrock = row.name === "bedrock";
  const isAzure = row.name === "azure";
  const initialModel = currentModel ?? row.models[0] ?? "";
  const initialRegion = currentAwsRegion ?? "";
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState<string>(initialModel);
  const [awsRegion, setAwsRegion] = useState(initialRegion);
  // Bedrock AWS credentials. Blank keeps the saved keys (model/region-only edit);
  // entering both rotates them. gini does not read ~/.aws.
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  // Endpoint override, shared by anthropic and azure. Anthropic leaves it blank
  // to keep the current endpoint; azure prefills the required resource endpoint
  // from the active config and the remaining transport fields below.
  const [baseUrl, setBaseUrl] = useState<string>(activeConfig?.baseUrl ?? "");
  const [apiVersion, setApiVersion] = useState<string>(activeConfig?.apiVersion ?? "");
  const [deployment, setDeployment] = useState<string>(activeConfig?.deployment ?? "");
  const [authScheme, setAuthScheme] = useState<string>(activeConfig?.authScheme ?? "api-key");

  // Reset transient inputs whenever the dialog opens for a new row. currentModel
  // /region can shift if the active provider changes elsewhere; reflect the most
  // recent values on each open.
  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setShowKey(false);
    setModel(initialModel);
    setAwsRegion(initialRegion);
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setBaseUrl(activeConfig?.baseUrl ?? "");
    setApiVersion(activeConfig?.apiVersion ?? "");
    setDeployment(activeConfig?.deployment ?? "");
    setAuthScheme(activeConfig?.authScheme ?? "api-key");
  }, [open, row.id, initialModel, initialRegion, activeConfig]);

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: row.name,
          // bedrock uses its own AWS key fields below (not this bearer apiKey);
          // for the others apiKey is optional when the env var is already set, so
          // model-only edits work without a re-type.
          ...(!isBedrock && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          // baseUrl applies to every OpenAI-compatible provider plus anthropic
          // (first-party endpoint override). Bedrock derives its endpoint from
          // awsRegion, so it never sends baseUrl. For the rest it is sent as the
          // full state (present-clears: blanking it reverts to the provider
          // default; for azure it is the required resource endpoint, enforced by
          // canSubmit below).
          ...(!isBedrock ? { baseUrl: baseUrl.trim() } : {}),
          // Bedrock sends awsRegion as full state (present-clears): a blank value
          // clears it so the host resolves from AWS_REGION / the us-east-1
          // default, rather than being silently dropped and preserved.
          ...(isBedrock ? { awsRegion: awsRegion.trim() } : {}),
          // Bedrock AWS keys: sent when EITHER field is filled (a rotation), so a
          // half-entered pair reaches the backend's "enter BOTH" guard instead of
          // being silently dropped. Both blank keeps the saved credentials, so a
          // model/region-only edit needs no re-type. gini does not read ~/.aws.
          ...(isBedrock && (awsAccessKeyId.trim() || awsSecretAccessKey.trim())
            ? { awsAccessKeyId: awsAccessKeyId.trim(), awsSecretAccessKey: awsSecretAccessKey.trim() }
            : {}),
          // Azure routing — sent as the full transport state (present-clears),
          // so blanking api-version/deployment falls back to the GA default /
          // the model id.
          ...(isAzure
            ? {
                apiVersion: apiVersion.trim(),
                deployment: deployment.trim(),
                authScheme
              }
            : {})
        })
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to update ${displayProviderName(row)}.`);
        return;
      }
      toast.success(`${displayProviderName(row)} updated.`);
      // Await BOTH refetches before closing. `activeConfig` (this dialog's
      // prefill source) is threaded from the `status` query, so closing before
      // status refetches lets a quick reopen read a stale config and overwrite a
      // just-saved endpoint/deployment on the next save.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["status"] }),
        queryClient.refetchQueries({ queryKey: ["providers"] })
      ]);
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Save is allowed when the user changed something. apiKey is optional for an
  // env-already-set edit; model defaults to the current selection, so toggling
  // it back to the same value still lets the user dismiss via Cancel.
  // transportDirty covers the shared baseUrl (present-clears) and azure's
  // routing fields; bedrock's region change is tracked separately below.
  const transportDirty =
    (!isBedrock && baseUrl.trim() !== (activeConfig?.baseUrl ?? "")) ||
    (isAzure &&
      (apiVersion.trim() !== (activeConfig?.apiVersion ?? "") ||
        deployment.trim() !== (activeConfig?.deployment ?? "") ||
        authScheme !== (activeConfig?.authScheme ?? "api-key")));
  // Entering an AWS key counts as a change. A half-entered pair (one field) is
  // dirty so the user can submit and get the backend's "enter BOTH" error rather
  // than a silently-disabled button.
  const bedrockKeyDirty = isBedrock && (awsAccessKeyId.trim().length > 0 || awsSecretAccessKey.trim().length > 0);
  const dirty =
    apiKey.trim().length > 0 ||
    bedrockKeyDirty ||
    (isBedrock && awsRegion.trim() !== initialRegion.trim()) ||
    (model.trim() !== "" && model.trim() !== initialModel) ||
    transportDirty;
  // Azure has no default endpoint — a base URL is required on every save.
  const azureValid = !isAzure || baseUrl.trim().length > 0;
  const canSubmit = dirty && azureValid && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
        <div className="flex items-start gap-3">
          <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-muted">
            <Icon className="size-5 text-foreground" />
          </span>
          <div className="flex-1 space-y-0.5">
            <DialogTitle className="text-base font-bold text-foreground">Edit provider</DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              {displayProviderName(row)} · {authLabel}
            </DialogDescription>
          </div>
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) save.mutate();
          }}
        >
          {!isBedrock ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-api-key" className="text-[13px] font-semibold text-foreground">API key</Label>
                <span className="text-xs text-muted-foreground">Stored encrypted</span>
              </div>
              <div className="relative">
                <Input
                  id="edit-api-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  placeholder="Leave blank to keep the saved key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-border bg-secondary pr-11 font-mono text-[13px]"
                />
                <button
                  type="button"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
                </button>
              </div>
            </div>
          ) : null}

          {isBedrock ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-aws-access-key-id" className="text-[13px] font-semibold text-foreground">AWS Access Key ID</Label>
                  <span className="text-xs text-muted-foreground">Stored in ~/.gini/secrets.env</span>
                </div>
                <Input
                  id="edit-aws-access-key-id"
                  type="text"
                  autoComplete="off"
                  placeholder="Leave blank to keep the saved key"
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-border bg-secondary font-mono text-[13px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-aws-secret-access-key" className="text-[13px] font-semibold text-foreground">AWS Secret Access Key</Label>
                <div className="relative">
                  <Input
                    id="edit-aws-secret-access-key"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    placeholder="Leave blank to keep the saved key"
                    value={awsSecretAccessKey}
                    onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                    disabled={save.isPending}
                    className="h-11 border-border bg-secondary pr-11 font-mono text-[13px]"
                  />
                  <button
                    type="button"
                    aria-label={showKey ? "Hide secret access key" : "Show secret access key"}
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">Enter both to rotate your AWS credentials, or leave blank to keep the saved ones. gini does not read ~/.aws.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-aws-region" className="text-[13px] font-semibold text-foreground">AWS region</Label>
                <BedrockRegionSelect
                  id="edit-aws-region"
                  value={awsRegion}
                  onChange={setAwsRegion}
                  disabled={save.isPending}
                  triggerClassName="h-11 border-border bg-secondary font-mono text-[13px]"
                />
              </div>
            </>
          ) : null}

          {isAnthropic ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-base-url" className="text-[13px] font-semibold text-foreground">Base URL</Label>
                <span className="text-xs text-muted-foreground">optional</span>
              </div>
              <Input
                id="edit-base-url"
                type="text"
                autoComplete="off"
                placeholder="Leave blank to keep the current endpoint"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={save.isPending}
                className="h-11 border-border bg-secondary font-mono text-[13px]"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-model" className="text-[13px] font-semibold text-foreground">Model</Label>
              <span className="text-xs text-muted-foreground">
                {row.models.length} available
              </span>
            </div>
            {isBedrock ? (
              <BedrockModelSelect
                id="edit-model"
                models={row.models}
                value={model}
                onChange={setModel}
                disabled={save.isPending}
                triggerClassName="h-11 border-border bg-secondary font-mono text-[13px]"
              />
            ) : (
              <Select value={model} onValueChange={setModel} disabled={save.isPending}>
                <SelectTrigger
                  id="edit-model"
                  className="h-11 border-border bg-secondary font-mono text-[13px]"
                >
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {row.models.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-[13px]">{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {isAzure ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="edit-base-url" className="text-[13px] font-semibold text-foreground">Resource endpoint</Label>
                <Input
                  id="edit-base-url"
                  type="text"
                  autoComplete="off"
                  placeholder="https://<resource>.openai.azure.com"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-border bg-secondary font-mono text-[13px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-api-version" className="text-[13px] font-semibold text-foreground">API version</Label>
                  <Input
                    id="edit-api-version"
                    type="text"
                    autoComplete="off"
                    placeholder="2024-10-21"
                    value={apiVersion}
                    onChange={(e) => setApiVersion(e.target.value)}
                    disabled={save.isPending}
                    className="h-11 border-border bg-secondary font-mono text-[13px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-deployment" className="text-[13px] font-semibold text-foreground">Deployment</Label>
                  <Input
                    id="edit-deployment"
                    type="text"
                    autoComplete="off"
                    placeholder="Defaults to model"
                    value={deployment}
                    onChange={(e) => setDeployment(e.target.value)}
                    disabled={save.isPending}
                    className="h-11 border-border bg-secondary font-mono text-[13px]"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-auth-scheme" className="text-[13px] font-semibold text-foreground">Auth scheme</Label>
                <Select value={authScheme} onValueChange={setAuthScheme} disabled={save.isPending}>
                  <SelectTrigger id="edit-auth-scheme" className="h-11 border-border bg-secondary text-[13px]">
                    <SelectValue placeholder="Select auth scheme" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api-key" className="text-[13px]">api-key (resource key)</SelectItem>
                    <SelectItem value="bearer" className="text-[13px]">bearer (Entra token)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : !isAnthropic && !isBedrock ? (
            // Generic OpenAI-compatible base URL. anthropic renders its own
            // Base URL field above; bedrock derives its endpoint from awsRegion,
            // so neither uses this fallback.
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-base-url" className="text-[13px] font-semibold text-foreground">Base URL</Label>
                <span className="text-xs text-muted-foreground">Blank = default endpoint</span>
              </div>
              <Input
                id="edit-base-url"
                type="text"
                autoComplete="off"
                placeholder="Override the default endpoint"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={save.isPending}
                className="h-11 border-border bg-secondary font-mono text-[13px]"
              />
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
