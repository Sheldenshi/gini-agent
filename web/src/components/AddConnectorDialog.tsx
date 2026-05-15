"use client";

// Reusable Add Connector dialog. Originally lived in
// web/src/app/connectors/page.tsx; lifted here so the Skills page can
// open it inline next to a missing-connector row without navigating.
// Stays a controlled component (open/onOpenChange owned by the caller)
// so the call site decides when to surface it.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProviderDescriptor } from "@/lib/queries";

export interface CreateConnectorBody {
  provider: string;
  name: string;
  scopes: string[];
  secrets: Record<string, string>;
  metadata?: Record<string, unknown>;
}

interface GenericField {
  name: string;
  value: string;
  secret: boolean;
}

export interface AddConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: CreateConnectorBody) => void;
  pending?: boolean;
  providers: ProviderDescriptor[];
  // Pre-select a provider id (e.g. when opened next to a Linear-needs-setup
  // row on the Skills page). When omitted, the first registered provider
  // is selected.
  defaultProvider?: string;
  // Pre-fill the connector name. Useful for the auto-suggest case.
  defaultName?: string;
  // Lock the provider dropdown when the caller wants the dialog scoped to
  // a single provider — the Skills page rows pass this so the user can't
  // accidentally create a Linear connector from the "Set up Codex" button.
  lockProvider?: boolean;
}

export function AddConnectorDialog({
  open,
  onOpenChange,
  onSubmit,
  pending = false,
  providers,
  defaultProvider,
  defaultName,
  lockProvider = false
}: AddConnectorDialogProps) {
  const initialProvider = useMemo(() => {
    if (defaultProvider && providers.some((p) => p.id === defaultProvider)) return defaultProvider;
    return providers[0]?.id ?? "demo";
  }, [defaultProvider, providers]);

  const [provider, setProvider] = useState(initialProvider);
  const [name, setName] = useState(defaultName ?? "");
  const [scopes, setScopes] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [genericFields, setGenericFields] = useState<GenericField[]>([{ name: "", value: "", secret: false }]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      setName(defaultName ?? "");
      setScopes("");
      setFieldValues({});
      setGenericFields([{ name: "", value: "", secret: false }]);
      setError(null);
    }
  }, [open, initialProvider, defaultName]);

  const selectedProvider = providers.find((p) => p.id === provider);

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!selectedProvider) {
      setError(`Provider ${provider} is not registered.`);
      return;
    }
    const secrets: Record<string, string> = {};
    const metadataFields: Record<string, string> = {};

    if (provider === "generic") {
      const cleaned = genericFields.filter((f) => f.name.trim().length > 0);
      if (cleaned.length === 0) {
        setError("Generic connectors need at least one field.");
        return;
      }
      for (const field of cleaned) {
        const key = field.name.trim();
        const value = field.value.trim();
        if (!value) continue;
        if (field.secret) secrets[key] = value;
        else metadataFields[key] = value;
      }
    } else {
      for (const field of selectedProvider.fields) {
        const raw = fieldValues[field.name] ?? "";
        if (field.required && !raw.trim()) {
          setError(`${field.label} is required.`);
          return;
        }
        if (!raw.trim()) continue;
        if (field.secret) secrets[field.name] = raw.trim();
        else metadataFields[field.name] = raw.trim();
      }
    }

    onSubmit({
      provider,
      name: name.trim(),
      scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean),
      secrets,
      metadata: Object.keys(metadataFields).length > 0 ? { fields: metadataFields } : undefined
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add connector</DialogTitle>
          <DialogDescription>{selectedProvider?.description ?? "Connect a new external system."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="connector-name">Name</Label>
            <Input id="connector-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="primary linear" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="connector-provider">Provider</Label>
            <Select value={provider} onValueChange={setProvider} disabled={lockProvider}>
              <SelectTrigger id="connector-provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label} ({p.id})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="connector-scopes">Scopes (comma-separated)</Label>
            <Input id="connector-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="read, write" />
          </div>

          {provider === "generic" ? (
            <GenericFieldEditor fields={genericFields} onChange={setGenericFields} />
          ) : (
            selectedProvider?.fields.map((field) => (
              <div key={field.name} className="space-y-1">
                <Label htmlFor={`connector-${field.name}`}>{field.label}{field.required ? " *" : ""}</Label>
                <Input
                  id={`connector-${field.name}`}
                  type={field.secret ? "password" : "text"}
                  value={fieldValues[field.name] ?? ""}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  placeholder={field.placeholder}
                  autoComplete="off"
                />
                {field.description ? <p className="text-[11px] text-muted-foreground">{field.description}</p> : null}
              </div>
            ))
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>{pending ? "Adding…" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GenericFieldEditor({
  fields,
  onChange
}: {
  fields: GenericField[];
  onChange: (next: GenericField[]) => void;
}) {
  function update(index: number, patch: Partial<GenericField>) {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function add() {
    onChange([...fields, { name: "", value: "", secret: false }]);
  }
  function remove(index: number) {
    onChange(fields.filter((_, i) => i !== index));
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Fields</Label>
        <Button type="button" size="sm" variant="outline" onClick={add}>Add field</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Define the credentials and config the dependent skill expects. Secret fields are stored encrypted.
      </p>
      {fields.map((field, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border border-border p-2">
          <Input
            placeholder="field name (e.g. base_url)"
            value={field.name}
            onChange={(e) => update(index, { name: e.target.value })}
          />
          <Input
            placeholder={field.secret ? "secret value" : "value"}
            type={field.secret ? "password" : "text"}
            value={field.value}
            onChange={(e) => update(index, { value: e.target.value })}
          />
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={field.secret}
              onChange={(e) => update(index, { secret: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            secret
          </label>
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => remove(index)}>
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}
