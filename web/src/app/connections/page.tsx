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
import { useIdentities, useInvalidate, useSkills } from "@/lib/queries";
import type { IdentityRecord, SkillRecord } from "@runtime/types";

interface CreateBody {
  kind: string;
  name: string;
  scopes: string[];
  secrets: Record<string, string>;
}

export default function ConnectionsPage() {
  const identities = useIdentities();
  const skills = useSkills();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);

  const skillsByKind = useMemo(() => groupDependentsByKind(skills.data ?? []), [skills.data]);

  const health = useMutation({
    mutationFn: (id: string) => api<IdentityRecord>(`/identities/${id}/health`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Health checked");
      invalidate(["identities", "events", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const create = useMutation({
    mutationFn: (body: CreateBody) =>
      api<IdentityRecord>("/identities", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (created) => {
      toast.success(`Added ${created.name}`);
      invalidate(["identities", "events", "skills"]);
      // Run an initial health probe so the dependents become active right
      // away when the credentials are correct.
      await api(`/identities/${created.id}/health`, { method: "POST" }).catch(() => undefined);
      invalidate(["identities", "skills"]);
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/identities/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Identity removed");
      invalidate(["identities", "events", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader
        title="Connections"
        description="External identities and credential health"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add identity</Button>
            </DialogTrigger>
            <AddIdentityDialog open={open} onSubmit={(body) => create.mutate(body)} pending={create.isPending} />
          </Dialog>
        }
      />
      <div className="flex-1 overflow-auto p-6">
        {(identities.data ?? []).length === 0 ? (
          <EmptyState title="No identities configured" description="Add one to activate skills that depend on it." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {(identities.data ?? []).map((identity) => {
              const dependents = skillsByKind.get(identity.kind) ?? [];
              return (
                <Card key={identity.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-sm">{identity.name}</CardTitle>
                        <CardDescription className="font-mono text-[11px]">{identity.kind} · {identity.id}</CardDescription>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <StatusPill value={identity.status} />
                        <StatusPill value={identity.health} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div>
                      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Scopes</h4>
                      {identity.scopes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">none</p>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {identity.scopes.map((scope) => (
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
                            const active = identity.health === "healthy" && skill.status === "trusted";
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
                    {identity.message ? <p className="text-xs text-muted-foreground">{identity.message}</p> : null}
                    <p className="font-mono text-[10px] text-muted-foreground">
                      last health {identity.lastHealthAt ? new Date(identity.lastHealthAt).toLocaleString() : "never"}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={health.isPending}
                        onClick={() => health.mutate(identity.id)}
                      >
                        {health.isPending && health.variables === identity.id ? "Checking…" : "Check health"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Delete identity ${identity.name}?`)) remove.mutate(identity.id);
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

function groupDependentsByKind(skills: SkillRecord[]): Map<string, SkillRecord[]> {
  const byKind = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const required = skill.requiredIdentities ?? [];
    for (const requirement of required) {
      const list = byKind.get(requirement.kind) ?? [];
      list.push(skill);
      byKind.set(requirement.kind, list);
    }
  }
  return byKind;
}

function AddIdentityDialog({
  open,
  onSubmit,
  pending
}: {
  open: boolean;
  onSubmit: (body: CreateBody) => void;
  pending: boolean;
}) {
  const [kind, setKind] = useState("demo");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind("demo");
      setName("");
      setScopes("");
      setToken("");
      setError(null);
    }
  }, [open]);

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (kind === "linear" && !token.trim()) {
      setError("Linear identities need an API token.");
      return;
    }
    const secrets: Record<string, string> = {};
    if (token.trim()) secrets.token = token.trim();
    onSubmit({
      kind,
      name: name.trim(),
      scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean),
      secrets
    });
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add identity</DialogTitle>
        <DialogDescription>Connect a new identity for skills to use.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="identity-name">Name</Label>
          <Input id="identity-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="primary linear" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="identity-kind">Kind</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="identity-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="demo">demo</SelectItem>
              <SelectItem value="linear">linear</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="identity-scopes">Scopes (comma-separated)</Label>
          <Input id="identity-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="read, write" />
        </div>
        {kind === "linear" ? (
          <div className="space-y-1">
            <Label htmlFor="identity-token">Linear API token</Label>
            <Input
              id="identity-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="lin_api_…"
              autoComplete="off"
            />
          </div>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={pending}>{pending ? "Adding…" : "Add"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
