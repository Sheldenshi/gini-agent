"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface McpRow { id: string; name: string; status: string; command: string; lastHealthAt?: string }

export function McpCard({
  servers,
  healthPending,
  disablePending,
  onHealth,
  onDisable
}: {
  servers: McpRow[];
  healthPending: boolean;
  disablePending: boolean;
  onHealth: (id: string) => void;
  onDisable: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">MCP servers</CardTitle>
        <CardDescription>{servers.length} configured</CardDescription>
      </CardHeader>
      <CardContent>
        {servers.length === 0 ? (
          <EmptyState title="No MCP servers" />
        ) : (
          <ul className="divide-y divide-border">
            {servers.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{item.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{item.command}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.status} />
                  <Button size="sm" variant="outline" disabled={healthPending} onClick={() => onHealth(item.id)}>Health</Button>
                  <Button size="sm" variant="outline" disabled={disablePending || item.status === "disabled"} onClick={() => onDisable(item.id)}>Disable</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
