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
  open,
  onOpenChange
}: {
  row: ProviderCatalogItem;
  authLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  currentModel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState<string>(currentModel ?? row.models[0] ?? "");

  // Reset transient inputs whenever the dialog opens for a new row.
  // currentModel can shift if the active provider changes elsewhere; we
  // want the dialog to reflect the most recent values on each open.
  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setShowKey(false);
    setModel(currentModel ?? row.models[0] ?? "");
  }, [open, row.id, currentModel, row.models]);

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: row.name,
          // The backend treats apiKey as optional when the env var is
          // already set, so model-only edits work without a re-type.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(model ? { model } : {})
        })
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to update ${displayProviderName(row)}.`);
        return;
      }
      toast.success(`${displayProviderName(row)} updated.`);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.refetchQueries({ queryKey: ["providers"] });
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
    (model !== "" && model !== (currentModel ?? row.models[0] ?? ""));
  const canSubmit = dirty && !save.isPending;

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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-model" className="text-[13px] font-semibold text-foreground">Default model</Label>
              <span className="text-xs text-muted-foreground">
                {row.models.length} available
              </span>
            </div>
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
          </div>

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
