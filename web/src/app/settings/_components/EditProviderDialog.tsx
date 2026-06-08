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
import { api } from "@/lib/api";
import { displayProviderName, type ProviderCatalogItem } from "./ProviderCard";

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export function EditProviderDialog({
  row,
  authLabel,
  icon: Icon,
  currentModel,
  currentBaseUrl,
  currentApiVersion,
  currentDeployment,
  currentAuthScheme,
  open,
  onOpenChange
}: {
  row: ProviderCatalogItem;
  authLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  currentModel?: string;
  // Active provider's persisted transport config, for prefill. Only passed
  // when this row is the active provider (a non-active row has no stored
  // config to show), so the dialog opens blank for non-active providers.
  currentBaseUrl?: string;
  currentApiVersion?: string;
  currentDeployment?: string;
  currentAuthScheme?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState<string>(currentModel ?? row.models[0] ?? "");
  const [baseUrl, setBaseUrl] = useState(currentBaseUrl ?? "");
  const [apiVersion, setApiVersion] = useState(currentApiVersion ?? "");
  const [deployment, setDeployment] = useState(currentDeployment ?? "");
  const [authScheme, setAuthScheme] = useState(currentAuthScheme ?? "bearer");

  // Show the Azure fields when the base URL looks like an Azure endpoint OR an
  // api-version is already set — the latter is the runtime's actual Azure-mode
  // signal, so a config on a custom Azure domain still shows (and doesn't get
  // its routing cleared on an unrelated edit). A standard OpenAI setup has
  // neither, so it never shows Azure-only inputs. Blanking the base URL clears
  // apiVersion/deployment (see onBaseUrlChange), which drives this false.
  const isAzure = /azure/i.test(baseUrl) || apiVersion.trim().length > 0;

  // Blanking the Base URL is an explicit "leave this endpoint" action: clear the
  // Azure routing fields too so the section collapses and a save reverts to the
  // standard OpenAI endpoint, rather than leaving a stranded apiVersion that the
  // backend rejects (apiVersion without an Azure base URL would 404).
  const onBaseUrlChange = (next: string) => {
    setBaseUrl(next);
    if (next.trim().length === 0) {
      setApiVersion("");
      setDeployment("");
      setAuthScheme("bearer");
    }
  };

  // Reset transient inputs whenever the dialog opens for a new row.
  // currentModel can shift if the active provider changes elsewhere; we
  // want the dialog to reflect the most recent values on each open.
  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setShowKey(false);
    setModel(currentModel ?? row.models[0] ?? "");
    setBaseUrl(currentBaseUrl ?? "");
    setApiVersion(currentApiVersion ?? "");
    setDeployment(currentDeployment ?? "");
    setAuthScheme(currentAuthScheme ?? "bearer");
  }, [open, row.id, currentModel, row.models, currentBaseUrl, currentApiVersion, currentDeployment, currentAuthScheme]);

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: row.name,
          // The backend treats apiKey as optional when the env var is
          // already set, so edits work without a re-type.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(model ? { model } : {}),
          // The dialog shows the full transport state, so it posts every
          // field — a blanked value clears it (e.g. blanking baseUrl +
          // apiVersion swaps an Azure config back to standard OpenAI).
          baseUrl: baseUrl.trim(),
          // Azure fields only when the base URL is an Azure endpoint; otherwise
          // send blanks so clearing the Azure base URL also clears them and
          // swaps the config back to standard OpenAI.
          ...(row.name === "openai"
            ? isAzure
              ? { apiVersion: apiVersion.trim(), deployment: deployment.trim(), authScheme }
              : { apiVersion: "", deployment: "", authScheme: "bearer" }
            : {})
        })
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to update ${displayProviderName(row)}.`);
        return;
      }
      toast.success(`${displayProviderName(row)} updated.`);
      // Await BOTH refetches before the dialog can reopen — the prefill reads
      // the active provider's transport config from /status, so closing before
      // status refreshes could reopen with stale fields and revert this save on
      // the next one.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["status"] }),
        queryClient.refetchQueries({ queryKey: ["providers"] })
      ]);
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Save is allowed when the user changed something. apiKey is optional
  // for an env-already-set edit; model is required and defaults to the
  // current selection, so toggling it back to the same value still lets
  // the user dismiss via Cancel without nagging.
  const dirty =
    apiKey.trim().length > 0 ||
    (model !== "" && model !== (currentModel ?? row.models[0] ?? "")) ||
    baseUrl !== (currentBaseUrl ?? "") ||
    apiVersion !== (currentApiVersion ?? "") ||
    deployment !== (currentDeployment ?? "") ||
    authScheme !== (currentAuthScheme ?? "bearer");
  const canSubmit = dirty && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 border-[#1F1F24] bg-[#141418] p-7 sm:max-w-md">
        <div className="flex items-start gap-3">
          <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[#1D2333]">
            <Icon className="size-5 text-[#C2C2C8]" />
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-api-key" className="text-[13px] font-semibold text-[#C2C2C8]">API key</Label>
              <span className="text-xs text-[#6A6A70]">Stored encrypted</span>
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
                className="h-11 border-[#2A2A2E] bg-[#0E0E11] pr-11 font-mono text-[13px]"
              />
              <button
                type="button"
                aria-label={showKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7A7A80] hover:text-foreground"
              >
                {showKey ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-model" className="text-[13px] font-semibold text-[#C2C2C8]">Default model</Label>
              <span className="text-xs text-[#6A6A70]">
                {row.models.length} available
              </span>
            </div>
            <Select value={model} onValueChange={setModel} disabled={save.isPending}>
              <SelectTrigger
                id="edit-model"
                className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
              >
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {row.models.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-[13px]">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-base-url" className="text-[13px] font-semibold text-[#C2C2C8]">
              Base URL <span className="font-normal text-[#6A6A70]">(blank = default endpoint)</span>
            </Label>
            <Input
              id="edit-base-url"
              autoComplete="off"
              placeholder={row.name === "openai" ? "https://<resource>.openai.azure.com for Azure" : "Override the default endpoint"}
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              disabled={save.isPending}
              className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
            />
          </div>

          {row.name === "openai" && isAzure ? (
            <div className="space-y-3">
              <p className="text-[12px] font-semibold text-[#C2C2C8]">
                Azure OpenAI <span className="font-normal text-[#6A6A70]">— deployment settings for this endpoint</span>
              </p>
              <div className="space-y-2">
                <Label htmlFor="edit-api-version" className="text-[13px] font-semibold text-[#C2C2C8]">API version</Label>
                <Input
                  id="edit-api-version"
                  autoComplete="off"
                  placeholder="e.g. 2024-12-01-preview"
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-deployment" className="text-[13px] font-semibold text-[#C2C2C8]">Deployment</Label>
                <Input
                  id="edit-deployment"
                  autoComplete="off"
                  placeholder="Defaults to the model name"
                  value={deployment}
                  onChange={(e) => setDeployment(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-auth-scheme" className="text-[13px] font-semibold text-[#C2C2C8]">Auth scheme</Label>
                <Select value={authScheme} onValueChange={setAuthScheme} disabled={save.isPending}>
                  <SelectTrigger id="edit-auth-scheme" className="h-11 border-[#2A2A2E] bg-[#0E0E11] text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bearer">Bearer (OpenAI / Azure Entra token)</SelectItem>
                    <SelectItem value="api-key">api-key (Azure resource key)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 border-t border-[#1F1F26] pt-4">
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
