"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

// Providers selectable in this form. `codex` uses its own OAuth/auth.json
// flow handled by the /setup page and is intentionally omitted here.
const SELECTABLE_PROVIDERS = new Set(["openai", "openrouter", "deepseek", "local"]);

interface SetProviderResult {
  ok: boolean;
  error?: string;
  provider: { provider: { name: string; model: string } };
}

export function ProviderCard({
  displayName,
  model,
  catalog
}: {
  displayName?: string;
  model?: string;
  catalog: ProviderCatalogItem[];
}) {
  const invalidate = useInvalidate();
  const selectable = useMemo(
    () => catalog.filter((c) => SELECTABLE_PROVIDERS.has(c.name)),
    [catalog]
  );

  const [providerName, setProviderName] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [apiKey, setApiKey] = useState("");

  // Seed defaults the first time the catalog arrives.
  useEffect(() => {
    if (providerName === "" && selectable.length > 0) {
      const first = selectable[0]!;
      setProviderName(first.name);
      setSelectedModel(first.models[0] ?? "");
    }
  }, [selectable, providerName]);

  // When the user picks a different provider, reset the model to that
  // provider's first catalog entry. Otherwise a stale model id leaks
  // into the request body (e.g. openrouter model selected, then user
  // switches to deepseek — would send openrouter/auto to deepseek).
  const onProviderChange = (next: string) => {
    setProviderName(next);
    const entry = selectable.find((c) => c.name === next);
    setSelectedModel(entry?.models[0] ?? "");
    setApiKey("");
  };

  const entry = selectable.find((c) => c.name === providerName);
  const requiresApiKey = providerName !== "local" && providerName !== "";

  const setProvider = useMutation({
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
        toast.error(result.error ?? "Failed to set provider.");
        return;
      }
      toast.success(`Provider set to ${providerName} (${selectedModel}).`);
      setApiKey("");
      invalidate(["state", "providers"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const canSubmit =
    providerName !== "" &&
    selectedModel !== "" &&
    (!requiresApiKey || apiKey.trim().length > 0) &&
    !setProvider.isPending;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Provider</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {displayName ? (
          <div>
            <p className="text-sm">{displayName}</p>
            {model ? <p className="mt-1 text-xs text-muted-foreground">{model}</p> : null}
          </div>
        ) : (
          <EmptyState title="No active provider" />
        )}

        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) setProvider.mutate();
          }}
        >
          <p className="text-xs font-medium text-muted-foreground">Change provider</p>
          <div className="grid gap-2">
            <Label htmlFor="provider-name">Provider</Label>
            <Select value={providerName} onValueChange={onProviderChange} disabled={setProvider.isPending}>
              <SelectTrigger id="provider-name"><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>
                {selectable.map((c) => (
                  <SelectItem key={c.id} value={c.name}>{c.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="provider-model">Model</Label>
            <Select
              value={selectedModel}
              onValueChange={setSelectedModel}
              disabled={!entry || setProvider.isPending}
            >
              <SelectTrigger id="provider-model"><SelectValue placeholder="Select model" /></SelectTrigger>
              <SelectContent>
                {entry?.models.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {requiresApiKey ? (
            <div className="grid gap-2">
              <Label htmlFor="provider-api-key">API key</Label>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                placeholder={providerName === "deepseek" ? "ds-…" : "sk-…"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={setProvider.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Saved to ~/.gini/secrets.env (mode 0600). Not sent anywhere except the provider you pick.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Local providers (Ollama, LM Studio) accept no-auth requests. Leave the key blank if your gateway is open.
            </p>
          )}
          <Button type="submit" disabled={!canSubmit}>
            {setProvider.isPending ? "Saving…" : "Save provider"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
