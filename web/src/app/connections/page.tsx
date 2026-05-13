"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useIdentities, useInvalidate } from "@/lib/queries";
import type { IdentityRecord } from "@runtime/types";

export default function ConnectionsPage() {
  const identities = useIdentities();
  const invalidate = useInvalidate();
  const health = useMutation({
    mutationFn: (id: string) => api<IdentityRecord>(`/identities/${id}/health`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Health checked");
      invalidate(["identities", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader title="Connections" description="External identities and credential health" />
      <div className="flex-1 overflow-auto p-6">
        {(identities.data ?? []).length === 0 ? (
          <EmptyState title="No identities configured" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {(identities.data ?? []).map((identity) => (
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
                  {identity.message ? <p className="text-xs text-muted-foreground">{identity.message}</p> : null}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    last health {identity.lastHealthAt ? new Date(identity.lastHealthAt).toLocaleString() : "never"}
                  </p>
                  <Button size="sm" variant="outline" disabled={health.isPending} onClick={() => health.mutate(identity.id)}>
                    Check health
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
