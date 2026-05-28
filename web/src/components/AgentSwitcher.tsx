"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { AgentRow } from "@/lib/view-types";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";

export function AgentSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const [createOpen, setCreateOpen] = useState(false);
  const invalidate = useInvalidate();
  const status = useStatus();
  const pathname = usePathname();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });

  const useAgent = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Agent activated");
      invalidate(["agents", "state", "status", "memory"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const agents = agentsQuery.data?.agents ?? [];
  const activeAgentId = agentsQuery.data?.activeAgentId;
  const activeName = status.data?.activeAgent?.name
    ?? agents.find((a) => a.id === activeAgentId)?.name
    ?? "Gini";

  const isMobile = variant === "mobile";
  const homeActive = pathname === "/";

  const hoverBg = isMobile
    ? "hover:bg-accent/60 focus-visible:bg-accent/60"
    : "hover:bg-sidebar-accent/60 focus-visible:bg-sidebar-accent/60";

  return (
    <>
    <div className="flex min-w-0 items-center gap-1">
      <Link
        href="/"
        aria-label="Home"
        title="Home"
        aria-current={homeActive ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md outline-none transition-shadow",
          isMobile ? "h-6 w-6" : "h-7 w-7",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          isMobile ? "focus-visible:ring-offset-background" : "focus-visible:ring-offset-sidebar",
          homeActive
            ? isMobile
              ? "ring-2 ring-ring ring-offset-1 ring-offset-background"
              : "ring-2 ring-sidebar-ring ring-offset-1 ring-offset-sidebar"
            : null
        )}
      >
        <Image
          src="/gini-agent-logo.png"
          alt="Gini"
          width={isMobile ? 24 : 28}
          height={isMobile ? 24 : 28}
          priority
          className={isMobile ? "h-6 w-6" : "h-7 w-7"}
        />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
              hoverBg
            )}
          >
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
            <DropdownMenuRadioGroup
              value={activeAgentId ?? ""}
              onValueChange={(id) => {
                if (!id || id === activeAgentId) return;
                useAgent.mutate(id);
              }}
            >
              {agents.map((agent) => (
                <DropdownMenuRadioItem
                  key={agent.id}
                  value={agent.id}
                  disabled={useAgent.isPending}
                >
                  <span className="truncate">{agent.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setCreateOpen(true);
            }}
          >
            <span>+ New agent</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
