"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/PageHeader";

export interface SnapshotRow { id: string; reason: string; createdAt: string; path?: string }

export function SnapshotsCard({ snapshots }: { snapshots: SnapshotRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Snapshots</CardTitle>
        <CardDescription>{snapshots.length} on disk · create with `gini snapshot create`</CardDescription>
      </CardHeader>
      <CardContent>
        {snapshots.length === 0 ? (
          <EmptyState title="No snapshots" description="Run `gini snapshot create <reason>` from the CLI to make one." />
        ) : (
          <ul className="divide-y divide-border">
            {snapshots.map((snap) => (
              <li key={snap.id} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{snap.reason}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {snap.id} · {new Date(snap.createdAt).toLocaleString()}
                    </p>
                    {snap.path ? (
                      <p className="truncate font-mono text-[10px] text-muted-foreground">{snap.path}</p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
