"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface ProfileRow { id: string; name: string; status: string; providerName?: string; model?: string }

export function ProfileCard({
  profiles,
  activeProfileId,
  pending,
  onUse
}: {
  profiles: ProfileRow[];
  activeProfileId: string | undefined;
  pending: boolean;
  onUse: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Profiles</CardTitle>
        <CardDescription>{profiles.length} configured · click to activate</CardDescription>
      </CardHeader>
      <CardContent>
        {profiles.length === 0 ? (
          <EmptyState title="No profiles" description="Create one with `gini profile create <name>`." />
        ) : (
          <ul className="divide-y divide-border">
            {profiles.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{item.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{item.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.id === activeProfileId ? "active" : item.status} />
                  <Button
                    size="sm"
                    variant={item.id === activeProfileId ? "secondary" : "outline"}
                    disabled={item.id === activeProfileId || pending}
                    onClick={() => onUse(item.id)}
                  >
                    {item.id === activeProfileId ? "Active" : "Use"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
