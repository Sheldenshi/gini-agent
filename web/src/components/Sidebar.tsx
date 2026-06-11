"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  Menu,
  MessagesSquare,
  Moon,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Sun,
  WandSparkles
} from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAllChatSessions, useInvalidate, useStatus, useThreadsInbox } from "@/lib/queries";
import { useChatReadState, useThreadReadState } from "@/lib/use-chat-read-state";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import { TunnelMenu } from "@/components/tunnel/TunnelMenu";
import { useUpdateGate } from "@/components/UpdateGate";
import type { AgentRow } from "@/lib/view-types";
import type { JobRecord } from "@runtime/types";

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const invalidate = useInvalidate();
  const [createOpen, setCreateOpen] = useState(false);
  const [agentsCollapsed, toggleAgents] = useSectionCollapsed("agents");
  const [jobsCollapsed, toggleJobs] = useSectionCollapsed("jobs");

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const agents = agentsQuery.data?.agents ?? [];

  // Recurring jobs and channel read-state are a constant union across all
  // agents, so both source from unscoped fetches rather than the
  // active-agent-scoped useJobs/useChatSessions.
  const allJobs = useQuery({
    queryKey: ["jobs", "all"],
    queryFn: () => api<JobRecord[]>("/jobs"),
    refetchInterval: 3000
  });
  const allSessions = useAllChatSessions();

  // A job is recurring when it isn't a one-shot reminder and carries an active
  // schedule (cron or interval). Stable-sorted by createdAt (then name) so the
  // list doesn't reorder as jobs fire.
  const recurringJobs = useMemo<JobRecord[]>(() => {
    return (allJobs.data ?? [])
      .filter((j) => !j.oneShot && (j.cronExpression != null || (j.intervalSeconds ?? 0) > 0))
      .sort(
        (a, b) =>
          (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.name.localeCompare(b.name)
      );
  }, [allJobs.data]);

  const { isUnread } = useChatReadState(allSessions.data);

  // Per-agent unread: the sidebar shows one row per agent, but read-state is
  // tracked per chat session. Match each agent to its canonical `kind:"agent"`
  // session and reuse the same boolean unread signal as the channel rows.
  const agentUnread = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const s of allSessions.data ?? []) {
      if (s.kind !== "agent" || !s.agentId) continue;
      if (isUnread(s)) map.set(s.agentId, true);
    }
    return map;
  }, [allSessions.data, isUnread]);

  const threadsInbox = useThreadsInbox();
  const { isThreadUnread } = useThreadReadState(threadsInbox.data);
  const unreadThreadCount = useMemo(
    () => (threadsInbox.data ?? []).filter((t) => isThreadUnread(t)).length,
    [threadsInbox.data, isThreadUnread]
  );

  const selectedSession = params?.get("session") ?? null;
  const onChat = pathname === "/chat";
  const onThreads = pathname === "/threads";

  const useAgentMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status", "memory", "agent-chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  const selectAgent = (id: string) => {
    if (id !== activeAgentId) useAgentMutation.mutate(id);
    router.push("/chat");
    onNavigate?.();
  };
  const selectChannel = (sessionId: string) => {
    router.push(`/chat?session=${sessionId}`);
    onNavigate?.();
  };

  const navItem = (
    active: boolean
  ): string =>
    cn(
      "flex items-center gap-3 rounded-lg px-2.5 py-[9px] text-[13px] font-medium transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-accent/50"
    );

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-3 pt-[18px] pb-2">
        <Link href="/" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5">
          <Image src="/gini-agent-logo.png" alt="Gini" width={20} height={20} unoptimized className="size-5 shrink-0" />
          <span className="text-sm font-semibold text-sidebar-accent-foreground">Gini</span>
        </Link>
        <div className="flex-1" />
        {mounted ? (
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
            className="flex size-[22px] items-center justify-center rounded-md border border-sidebar-border bg-transparent text-sidebar-foreground/70"
          >
            {theme === "dark" ? <Sun className="size-3" /> : <Moon className="size-3" />}
          </button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-[18px] px-3 py-2">
          {/* Agents (DMs) */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <button
                type="button"
                onClick={toggleAgents}
                aria-expanded={!agentsCollapsed}
                className="flex items-center gap-1.5 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
              >
                <ChevronDown
                  className={cn("size-3 transition-transform", agentsCollapsed && "-rotate-90")}
                />
                <span className="text-[11px] font-semibold tracking-[0.5px]">Agents</span>
              </button>
              <button
                type="button"
                aria-label="New agent"
                onClick={() => setCreateOpen(true)}
                className="flex items-center justify-center text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <ul className={cn("flex flex-col gap-0.5", agentsCollapsed && "hidden")}>
              {agents.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-sidebar-foreground/55">No agents yet</li>
              ) : (
                agents.map((agent) => {
                  const active = onChat && !selectedSession && agent.id === activeAgentId;
                  const unread = !active && agentUnread.get(agent.id) === true;
                  return (
                    <li key={agent.id}>
                      <button
                        type="button"
                        onClick={() => selectAgent(agent.id)}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                        )}
                      >
                        <AgentAvatar name={agent.name} seed={agent.id} size={22} initialColor="#0A0A0C" />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active || unread ? "font-semibold text-sidebar-accent-foreground" : "font-medium text-sidebar-foreground"
                          )}
                        >
                          {agent.name}
                        </span>
                        {unread ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Recurring jobs */}
          {recurringJobs.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2">
                <button
                  type="button"
                  onClick={toggleJobs}
                  aria-expanded={!jobsCollapsed}
                  className="flex items-center gap-1.5 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
                >
                  <ChevronDown
                    className={cn("size-3 transition-transform", jobsCollapsed && "-rotate-90")}
                  />
                  <span className="text-[11px] font-semibold tracking-[0.5px]">Recurring jobs</span>
                </button>
              </div>
              <ul className={cn("flex flex-col gap-0.5", jobsCollapsed && "hidden")}>
                {recurringJobs.map((job) => {
                  const channelSession = (allSessions.data ?? []).find((s) => s.id === job.chatSessionId);
                  const active = onChat && selectedSession === job.chatSessionId;
                  const unread = !active && channelSession ? isUnread(channelSession) : false;
                  const onClick = () => {
                    if (job.chatSessionId) {
                      selectChannel(job.chatSessionId);
                    } else {
                      router.push("/jobs");
                      onNavigate?.();
                    }
                  };
                  return (
                    <li key={job.id}>
                      <button
                        type="button"
                        onClick={onClick}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                        )}
                      >
                        <span
                          aria-hidden
                          className="w-3.5 shrink-0 text-center text-sm font-medium text-sidebar-foreground/55"
                        >
                          #
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active || unread ? "font-semibold text-sidebar-accent-foreground" : "font-medium text-sidebar-foreground"
                          )}
                        >
                          {job.name}
                        </span>
                        {unread ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="h-px bg-sidebar-border" />

          {/* Nav: Threads, Skills, Settings */}
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link href="/threads" onClick={onNavigate} className={navItem(onThreads)}>
                <MessagesSquare className="size-3.5 text-sidebar-foreground/70" />
                <span className="flex-1">Threads</span>
                {unreadThreadCount > 0 ? (
                  <span className="flex items-center justify-center rounded-full bg-sidebar-primary px-[7px] py-px text-[10px] font-bold text-sidebar-primary-foreground">
                    {unreadThreadCount}
                  </span>
                ) : null}
              </Link>
            </li>
            <li>
              <Link href="/skills" onClick={onNavigate} className={navItem(pathname === "/skills")}>
                <WandSparkles className="size-3.5 text-sidebar-foreground/70" />
                Skills
              </Link>
            </li>
            <li>
              <Link href="/logs" onClick={onNavigate} className={navItem(pathname === "/logs")}>
                <ScrollText className="size-3.5 text-sidebar-foreground/70" />
                Logs
              </Link>
            </li>
            <li>
              <Link href="/settings" onClick={onNavigate} className={navItem(pathname === "/settings")}>
                <Settings className="size-3.5 text-sidebar-foreground/70" />
                Settings
              </Link>
            </li>
          </ul>
        </div>
      </ScrollArea>

      <div className="px-3 pb-2 pt-3">
        <TunnelMenu />
      </div>
      <div className="h-px bg-sidebar-border" />
      <UpdateReminder />
      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
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

// Per-device collapse state for sidebar sections, persisted in localStorage so
// a collapsed section stays collapsed across reloads. Mirrors the
// useSyncExternalStore + localStorage idiom used for chat/thread read state.
const COLLAPSE_STORAGE_KEY = "gini.sidebar.collapsed";

type CollapseMap = Record<string, boolean>;
let collapseCache: CollapseMap | null = null;
const collapseListeners = new Set<() => void>();

function readCollapse(): CollapseMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as CollapseMap;
    }
  } catch {
    // Corrupt or disabled storage — fall through to default.
  }
  return {};
}

function getCollapse(): CollapseMap {
  if (collapseCache === null) collapseCache = readCollapse();
  return collapseCache;
}

function toggleCollapse(key: string) {
  const current = getCollapse();
  const next = { ...current, [key]: !current[key] };
  collapseCache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or disabled storage — keep the in-memory toggle, skip persisting.
    }
  }
  for (const listener of collapseListeners) listener();
}

function subscribeCollapse(listener: () => void) {
  collapseListeners.add(listener);
  return () => {
    collapseListeners.delete(listener);
  };
}

const EMPTY_COLLAPSE: CollapseMap = {};

function useSectionCollapsed(key: string): [boolean, () => void] {
  const map = useSyncExternalStore(subscribeCollapse, getCollapse, () => EMPTY_COLLAPSE);
  return [map[key] === true, () => toggleCollapse(key)];
}

// The update lifecycle (mutation, polling, the full-app blur overlay) lives in
// UpdateGateProvider; this row is just its trigger + version line. The button
// hides once an update is in flight because the gate's overlay takes over.
function UpdateReminder() {
  const { version, updateSupported, updateAvailable, phase, start } = useUpdateGate();
  const showUpdate = updateAvailable && phase === "idle";

  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-[18px] pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-[11px] font-medium text-sidebar-foreground/55">
          v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
        </div>
        {showUpdate ? (
          <div className="text-[11px] font-medium text-sidebar-accent-foreground">Update ready</div>
        ) : (
          <div className="text-[11px] font-medium text-sidebar-foreground/55">Gini agent</div>
        )}
      </div>
      {showUpdate ? (
        <button
          type="button"
          disabled={!updateSupported}
          onClick={start}
          className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-sidebar-border bg-sidebar-accent px-[11px] py-[7px] text-xs font-semibold text-sidebar-accent-foreground disabled:opacity-60"
        >
          <RefreshCw className="size-[13px] text-sidebar-foreground/80" />
          Update
        </button>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-[266px] shrink-0 border-r border-sidebar-border md:flex md:flex-col">
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
        <SheetContent side="left" className="w-[266px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="text-sm font-semibold">Gini</span>
    </header>
  );
}
