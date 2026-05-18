"use client";

import { useState } from "react";
import { Boxes, Check, ChevronsUpDown } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { AgentRow } from "@/app/settings/_components/AgentCard";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";

export function AgentSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const [createOpen, setCreateOpen] = useState(false);
  const invalidate = useInvalidate();
  const status = useStatus();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });

  const useAgent = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Agent activated");
      invalidate(["agents", "state", "status"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const agents = agentsQuery.data?.agents ?? [];
  const activeAgentId = agentsQuery.data?.activeAgentId;
  const activeName = status.data?.activeAgent?.name
    ?? agents.find((a) => a.id === activeAgentId)?.name
    ?? "Gini";

  const isMobile = variant === "mobile";

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
            isMobile ? "hover:bg-accent/60 focus-visible:bg-accent/60" : "hover:bg-sidebar-accent/60 focus-visible:bg-sidebar-accent/60"
          )}
          aria-label="Switch agent"
        >
          <div
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground",
              isMobile ? "h-6 w-6" : "h-7 w-7"
            )}
          >
            <Boxes className={isMobile ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </div>
          <div className={cn("flex min-w-0 leading-none", isMobile ? "items-center gap-2" : "flex-col")}>
            <span className="text-sm font-semibold">Gini</span>
            <span
              className={cn(
                "truncate text-[11px] font-medium",
                isMobile ? "text-muted-foreground" : "text-sidebar-foreground/80"
              )}
            >
              {activeName}
            </span>
          </div>
          <ChevronsUpDown
            className={cn(
              "ml-1 h-3.5 w-3.5 shrink-0 opacity-60",
              isMobile ? "text-muted-foreground" : "text-sidebar-foreground/70"
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {agents.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No agents configured</div>
        ) : (
          agents.map((agent) => {
            const active = agent.id === activeAgentId;
            return (
              <DropdownMenuItem
                key={agent.id}
                disabled={active || useAgent.isPending}
                onSelect={(event) => {
                  if (active) return;
                  event.preventDefault();
                  useAgent.mutate(agent.id);
                }}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{agent.name}</span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setCreateOpen(true);
          }}
        >
          <span>+ New agent</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
