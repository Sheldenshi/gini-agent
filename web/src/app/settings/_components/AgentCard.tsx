"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface AgentRow { id: string; name: string; status: string }

export function AgentCard({
  agents,
  activeAgentId,
  pending,
  onUse
}: {
  agents: AgentRow[];
  activeAgentId: string | undefined;
  pending: boolean;
  onUse: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Agents</CardTitle>
        <CardDescription>{agents.length} configured · click to activate</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <EmptyState title="No agents" description="Create one with `gini agent create <name>`." />
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{item.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{item.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.id === activeAgentId ? "active" : item.status} />
                  <Button
                    size="sm"
                    variant={item.id === activeAgentId ? "secondary" : "outline"}
                    disabled={item.id === activeAgentId || pending}
                    onClick={() => onUse(item.id)}
                  >
                    {item.id === activeAgentId ? "Active" : "Use"}
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
