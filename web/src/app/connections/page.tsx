"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useConnectors, useInvalidate, useProviders, useSkills } from "@/lib/queries";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";

interface CreateBody {
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

export default function ConnectionsPage() {
  const connectors = useConnectors();
  const providers = useProviders();
  const skills = useSkills();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);

  const skillsByProvider = useMemo(() => groupDependentsByProvider(skills.data ?? []), [skills.data]);

  const health = useMutation({
    mutationFn: (id: string) => api<ConnectorRecord>(`/connectors/${id}/health`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Health checked");
      invalidate(["connectors", "events", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const create = useMutation({
    mutationFn: (body: CreateBody) =>
      api<ConnectorRecord>("/connectors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (created) => {
      toast.success(`Added ${created.name}`);
      invalidate(["connectors", "events", "skills"]);
      await api(`/connectors/${created.id}/health`, { method: "POST" }).catch(() => undefined);
      invalidate(["connectors", "skills"]);
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/connectors/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Connector removed");
      invalidate(["connectors", "events", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader
        title="Connections"
        description="External connectors and credential health"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add connector</Button>
            </DialogTrigger>
            <AddConnectorDialog
              open={open}
              onSubmit={(body) => create.mutate(body)}
              pending={create.isPending}
              providers={providers.data ?? []}
            />
          </Dialog>
        }
      />
      <div className="flex-1 overflow-auto p-6">
        {(connectors.data ?? []).length === 0 ? (
          <EmptyState title="No connectors configured" description="Add one to activate skills that depend on it." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {(connectors.data ?? []).map((connector) => {
              const dependents = skillsByProvider.get(connector.provider) ?? [];
              return (
                <Card key={connector.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-sm">{connector.name}</CardTitle>
                        <CardDescription className="font-mono text-[11px]">{connector.provider} · {connector.id}</CardDescription>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <StatusPill value={connector.status} />
                        <StatusPill value={connector.health} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div>
                      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Scopes</h4>
                      {connector.scopes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">none</p>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {connector.scopes.map((scope) => (
                            <span key={scope} className="rounded border border-border bg-card/50 px-1.5 py-0.5 font-mono text-[10px]">{scope}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Dependent skills</h4>
                      {dependents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">none</p>
                      ) : (
                        <ul className="space-y-1">
                          {dependents.map((skill) => {
                            const active = connector.health === "healthy" && skill.status === "trusted";
                            return (
                              <li key={skill.id} className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-mono">{skill.name}</span>
                                <span className={`rounded px-1.5 py-0.5 text-[10px] ${active ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>
                                  {active ? "active" : "needs setup"}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    {connector.message ? <p className="text-xs text-muted-foreground">{connector.message}</p> : null}
                    <p className="font-mono text-[10px] text-muted-foreground">
                      last health {connector.lastHealthAt ? new Date(connector.lastHealthAt).toLocaleString() : "never"}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={health.isPending}
                        onClick={() => health.mutate(connector.id)}
                      >
                        {health.isPending && health.variables === connector.id ? "Checking…" : "Check health"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Delete connector ${connector.name}?`)) remove.mutate(connector.id);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function groupDependentsByProvider(skills: SkillRecord[]): Map<string, SkillRecord[]> {
  const byProvider = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const required = skill.requiredConnectors ?? [];
    for (const requirement of required) {
      const list = byProvider.get(requirement.provider) ?? [];
      list.push(skill);
      byProvider.set(requirement.provider, list);
    }
  }
  return byProvider;
}

type ProviderField = {
  name: string;
  label: string;
  description?: string;
  secret: boolean;
  required?: boolean;
  placeholder?: string;
};

type ProviderDescriptor = {
  id: string;
  label: string;
  description: string;
  fields: ProviderField[];
};

function AddConnectorDialog({
  open,
  onSubmit,
  pending,
  providers
}: {
  open: boolean;
  onSubmit: (body: CreateBody) => void;
  pending: boolean;
  providers: ProviderDescriptor[];
}) {
  // Resolve a sensible initial provider once the providers list arrives.
  // Read the URL once on mount so a `?provider=linear` deeplink (used by
  // the Skills page "Connect →" affordance) pre-selects the right
  // provider. Falls back to the first registered provider.
  const initialProvider = useMemo(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const candidate = url.searchParams.get("provider");
      if (candidate && providers.some((p) => p.id === candidate)) return candidate;
    }
    return providers[0]?.id ?? "demo";
  }, [providers]);

  const [provider, setProvider] = useState(initialProvider);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [genericFields, setGenericFields] = useState<GenericField[]>([{ name: "", value: "", secret: false }]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      setName("");
      setScopes("");
      setFieldValues({});
      setGenericFields([{ name: "", value: "", secret: false }]);
      setError(null);
    }
  }, [open, initialProvider]);

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
      // Validate dynamic fields. Each field must have a non-empty name.
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
      // Fixed-shape providers: validate against the declared field list.
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
          <Select value={provider} onValueChange={setProvider}>
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
