"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/PageHeader";

export interface ProviderCatalogItem {
  id: string;
  displayName: string;
  auth: string;
  models: string[];
}

export function ProviderCard({ catalog }: { catalog: ProviderCatalogItem[] | undefined }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Provider catalog</CardTitle></CardHeader>
      <CardContent>
        {catalog && catalog.length > 0 ? (
          <ul className="divide-y divide-border text-xs">
            {catalog.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate">{item.displayName}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {item.auth} · {item.models.length.toString().padStart(2, " ")} models
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No catalog" />
        )}
      </CardContent>
    </Card>
  );
}
