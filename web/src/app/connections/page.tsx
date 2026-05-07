"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useConnectors, useInvalidate } from "@/lib/queries";
import type { ConnectorRecord } from "@/lib/types";

export default function ConnectionsPage() {
  const connectors = useConnectors();
  const invalidate = useInvalidate();
  const health = useMutation({
    mutationFn: (id: string) => api<ConnectorRecord>(`/connectors/${id}/health`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Health checked");
      invalidate(["connectors", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader title="Connections" description="External integrations and connectors" />
      <div className="flex-1 overflow-auto p-6">
        {(connectors.data ?? []).length === 0 ? (
          <EmptyState title="No connectors configured" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {(connectors.data ?? []).map((connector) => (
              <Card key={connector.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-sm">{connector.name}</CardTitle>
                      <CardDescription className="font-mono text-[11px]">{connector.kind} · {connector.id}</CardDescription>
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
                  {connector.message ? <p className="text-xs text-muted-foreground">{connector.message}</p> : null}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    last health {connector.lastHealthAt ? new Date(connector.lastHealthAt).toLocaleString() : "never"}
                  </p>
                  <Button size="sm" variant="outline" disabled={health.isPending} onClick={() => health.mutate(connector.id)}>
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
