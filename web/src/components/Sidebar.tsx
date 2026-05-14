"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Boxes,
  Cable,
  Cog,
  Download,
  Globe,
  Home,
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
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import type { GiniUpdateResult } from "@runtime/types";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/memory", label: "Memory", icon: Sparkles },
  { href: "/skills", label: "Skills", icon: Wrench },
  { href: "/subagents", label: "Subagents", icon: Users },
  { href: "/jobs", label: "Jobs", icon: Timer },
  { href: "/connections", label: "Connections", icon: Cable },
  { href: "/browser", label: "Browser", icon: Globe },
  { href: "/permissions", label: "Permissions", icon: AlertTriangle },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Cog }
] as const;

function SidebarBody({ instance, onNavigate }: { instance: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Boxes className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold">Gini</span>
            <span className="font-mono text-[10px] text-sidebar-foreground/70">{instance}</span>
          </div>
        </div>
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
        {NAV.map((item) => {
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
      </nav>
      <UpdateReminder />
    </div>
  );
}

function UpdateReminder() {
  const status = useStatus();
  const qc = useQueryClient();
  const version = status.data?.version;
  const updateAvailable = version?.git.updateAvailable === true;
  const update = useMutation({
    mutationFn: () => api<GiniUpdateResult>("/update", { method: "POST" }),
    onSuccess: (result) => {
      if (result.upToDate) {
        toast.success("Gini is already current");
        qc.invalidateQueries({ queryKey: ["status"] });
        return;
      }
      toast.success("Gini updated. Restarting...");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["status"] }), 4000);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] text-sidebar-foreground/65">
            v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
          </div>
          {updateAvailable ? (
            <div className="text-xs font-medium text-sidebar-foreground">Update ready</div>
          ) : (
            <div className="text-xs text-sidebar-foreground/65">Gini runtime</div>
          )}
        </div>
        <Button
          size="sm"
          variant={updateAvailable ? "default" : "outline"}
          className="h-7 shrink-0"
          disabled={update.isPending}
          onClick={() => update.mutate()}
        >
          {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Update
        </Button>
      </div>
    </div>
  );
}

export function Sidebar({ instance }: { instance: string }) {
  return (
    <aside className="hidden h-full w-60 shrink-0 border-r border-border md:flex md:flex-col">
      <SidebarBody instance={instance} />
    </aside>
  );
}

export function MobileTopBar({ instance }: { instance: string }) {
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
          <SidebarBody instance={instance} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-2 leading-none">
          <span className="text-sm font-semibold">Gini</span>
          <span className="font-mono text-[10px] text-muted-foreground">{instance}</span>
        </div>
      </div>
    </header>
  );
}
