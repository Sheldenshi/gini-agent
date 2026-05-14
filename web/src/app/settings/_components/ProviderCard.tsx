"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/PageHeader";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  displayName: string;
  auth: string;
  models: string[];
}

export function ProviderCard({ displayName, model }: { displayName?: string; model?: string }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Current provider</CardTitle></CardHeader>
      <CardContent>
        {displayName ? (
          <div>
            <p className="text-sm">{displayName}</p>
            {model ? <p className="mt-1 text-xs text-muted-foreground">{model}</p> : null}
          </div>
        ) : (
          <EmptyState title="No active provider" />
        )}
      </CardContent>
    </Card>
  );
}
