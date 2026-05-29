"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Bug,
  Cog,
  Download,
  Loader2,
  ListTodo,
  Menu,
  MessageSquare,
  Moon,
  Sparkles,
  Sun,
  Timer,
  Users,
  Wrench
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import { AgentSwitcher } from "@/components/AgentSwitcher";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

const REPORT_BUG_URL = "https://github.com/Lilac-Labs/gini-agent/issues";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = readonly NavItem[];

const NAV_GROUPS: readonly NavGroup[] = [
  [
    { href: "/chat", label: "Chat", icon: MessageSquare },
    { href: "/tasks", label: "Tasks", icon: ListTodo },
    { href: "/memory", label: "Memory", icon: Sparkles },
    { href: "/subagents", label: "Subagents", icon: Users },
    { href: "/jobs", label: "Jobs", icon: Timer }
  ],
  [
    { href: "/skills", label: "Skills", icon: Wrench },
    { href: "/permissions", label: "Permissions", icon: AlertTriangle },
    { href: "/activity", label: "Activity", icon: Activity },
    { href: "/settings", label: "Settings", icon: Cog }
  ]
] as const;

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 px-3 py-4">
        <AgentSwitcher variant="sidebar" />
        {mounted ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex} className="flex flex-col gap-0.5">
            {groupIndex > 0 ? (
              <div className="my-2 border-t border-sidebar-border" />
            ) : null}
            {group.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
        <div className="mt-2 border-t border-sidebar-border pt-2">
          <a
            href={REPORT_BUG_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onNavigate}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <Bug className="h-4 w-4" />
            Report a bug
          </a>
        </div>
      </nav>
      <UpdateReminder />
    </div>
  );
}

function useMounted() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  );
}

function UpdateReminder() {
  const qc = useQueryClient();
  const [appliedSha, setAppliedSha] = useState<string | null>(null);
  const status = useStatus({ refetchInterval: appliedSha ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
  const updateSupported = statusVersion?.update.supported === true;
  const versionCheck = useQuery({
    queryKey: ["version", "check"],
    queryFn: () => api<GiniVersionInfo>("/update/check", { method: "POST" }),
    enabled: updateSupported,
    refetchInterval: 5 * 60_000
  });
  const version = versionCheck.data ?? statusVersion;
  const updateAvailable = version?.git.updateAvailable === true;

  useEffect(() => {
    if (!appliedSha) return;
    if (statusVersion?.git.sha === appliedSha) {
      setAppliedSha(null);
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }
  }, [appliedSha, statusVersion?.git.sha, qc]);

  useEffect(() => {
    if (!appliedSha) return;
    const timer = setTimeout(() => {
      setAppliedSha(null);
      toast.error("Update applied, but the runtime hasn't reported back. Reload to check.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [appliedSha, qc]);

  const update = useMutation({
    mutationFn: () => api<GiniUpdateResult>("/update", { method: "POST" }),
    onSuccess: (result) => {
      if (result.upToDate) {
        toast.success("Gini is already current");
        qc.invalidateQueries({ queryKey: ["status"] });
        qc.invalidateQueries({ queryKey: ["version", "check"] });
        return;
      }
      toast.success("Gini updated. Restarting...");
      setAppliedSha(result.afterSha);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const showUpdate = updateAvailable && !appliedSha;

  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] text-sidebar-foreground/65">
            v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
          </div>
          {showUpdate ? (
            <div className="text-xs font-medium text-sidebar-foreground">Update ready</div>
          ) : (
            <div className="text-xs text-sidebar-foreground/65">Gini agent</div>
          )}
        </div>
        {showUpdate ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 shrink-0"
            disabled={update.isPending || !updateSupported}
            onClick={() => update.mutate()}
          >
            {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Update
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-60 shrink-0 border-r border-border md:flex md:flex-col">
      <SidebarBody />
    </aside>
  );
}

export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-60 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <AgentSwitcher variant="mobile" />
    </header>
  );
}
