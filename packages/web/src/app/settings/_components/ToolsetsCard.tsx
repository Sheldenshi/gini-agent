"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface ToolsetRow { id: string; name: string; status: string; description: string }

export function ToolsetsCard({
  toolsets,
  pending,
  onToggle
}: {
  toolsets: ToolsetRow[];
  pending: boolean;
  onToggle: (id: string, op: "enable" | "disable") => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Toolsets</CardTitle>
        <CardDescription>{toolsets.length} configured</CardDescription>
      </CardHeader>
      <CardContent>
        {toolsets.length === 0 ? (
          <EmptyState title="No toolsets" />
        ) : (
          <ul className="divide-y divide-border">
            {toolsets.map((item) => {
              const enabled = item.status === "enabled" || item.status === "active";
              return (
                <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-sm">{item.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{item.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill value={item.status} />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => onToggle(item.id, enabled ? "disable" : "enable")}
                    >
                      {enabled ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
