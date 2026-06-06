"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  Loader2,
  Menu,
  MessagesSquare,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  WandSparkles
} from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useInvalidate, useStatus, useThreadsInbox } from "@/lib/queries";
import { useChatReadState, useThreadReadState } from "@/lib/use-chat-read-state";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import { TunnelMenu } from "@/components/tunnel/TunnelMenu";
import type { AgentRow, ChatSession } from "@/lib/view-types";
import type { GiniUpdateResult, GiniVersionInfo, JobRecord } from "@runtime/types";

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const invalidate = useInvalidate();
  const [createOpen, setCreateOpen] = useState(false);

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
  const allSessions = useQuery({
    queryKey: ["chat", "all"],
    queryFn: () => api<ChatSession[]>("/chat"),
    refetchInterval: 3000
  });

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
      active ? "bg-[#1C1C22] text-white" : "text-[#B6B6BC] hover:bg-[#1C1C22]/50"
    );

  return (
    <div className="flex h-full flex-col bg-[#0A0A0C] text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-3 pt-[18px] pb-2">
        <Link href="/" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5">
          <Image src="/gini-agent-logo.png" alt="Gini" width={20} height={20} unoptimized className="size-5 shrink-0" />
          <span className="text-sm font-semibold text-white">Gini</span>
        </Link>
        <div className="flex-1" />
        {mounted ? (
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
            className="flex size-[22px] items-center justify-center rounded-md border border-[#2E2E34] bg-transparent text-[#8A8A90]"
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
              <div className="flex items-center gap-1.5">
                <ChevronDown className="size-3 text-[#6A6A70]" />
                <span className="text-[11px] font-semibold tracking-[0.5px] text-[#6A6A70]">Agents</span>
              </div>
              <button
                type="button"
                aria-label="New agent"
                onClick={() => setCreateOpen(true)}
                className="flex items-center justify-center text-[#8A8A90] hover:text-white"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <ul className="flex flex-col gap-0.5">
              {agents.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-[#6A6A70]">No agents yet</li>
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
                          active ? "bg-[#1C1C22]" : "hover:bg-[#1C1C22]/50"
                        )}
                      >
                        <AgentAvatar name={agent.name} seed={agent.id} size={22} initialColor="#0A0A0C" />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active || unread ? "font-semibold text-white" : "font-medium text-[#B6B6BC]"
                          )}
                        >
                          {agent.name}
                        </span>
                        {unread ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[#4277FB]" />
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
                <div className="flex items-center gap-1.5">
                  <ChevronDown className="size-3 text-[#6A6A70]" />
                  <span className="text-[11px] font-semibold tracking-[0.5px] text-[#6A6A70]">Recurring jobs</span>
                </div>
              </div>
              <ul className="flex flex-col gap-0.5">
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
                          active ? "bg-[#1C1C22]" : "hover:bg-[#1C1C22]/50"
                        )}
                      >
                        <span
                          aria-hidden
                          className="w-3.5 shrink-0 text-center text-sm font-medium text-[#6A6A70]"
                        >
                          #
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active || unread ? "font-semibold text-white" : "font-medium text-[#B6B6BC]"
                          )}
                        >
                          {job.name}
                        </span>
                        {unread ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[#4277FB]" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="h-px bg-[#1C1C1E]" />

          {/* Nav: Threads, Skills, Settings */}
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link href="/threads" onClick={onNavigate} className={navItem(onThreads)}>
                <MessagesSquare className="size-3.5 text-[#8A8A90]" />
                <span className="flex-1">Threads</span>
                {unreadThreadCount > 0 ? (
                  <span className="flex items-center justify-center rounded-full bg-[#4277FB] px-[7px] py-px text-[10px] font-bold text-white">
                    {unreadThreadCount}
                  </span>
                ) : null}
              </Link>
            </li>
            <li>
              <Link href="/skills" onClick={onNavigate} className={navItem(pathname === "/skills")}>
                <WandSparkles className="size-3.5 text-[#8A8A90]" />
                Skills
              </Link>
            </li>
            <li>
              <Link href="/settings" onClick={onNavigate} className={navItem(pathname === "/settings")}>
                <Settings className="size-3.5 text-[#8A8A90]" />
                Settings
              </Link>
            </li>
          </ul>
        </div>
      </ScrollArea>

      <div className="px-3 pb-2 pt-3">
        <TunnelMenu />
      </div>
      <div className="h-px bg-[#1C1C1E]" />
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
    <div className="flex items-center justify-between gap-2 px-3 pb-[18px] pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-[11px] font-medium text-[#6A6A70]">
          v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
        </div>
        {showUpdate ? (
          <div className="text-[11px] font-medium text-white">Update ready</div>
        ) : (
          <div className="text-[11px] font-medium text-[#6A6A70]">Gini agent</div>
        )}
      </div>
      {showUpdate ? (
        <button
          type="button"
          disabled={update.isPending || !updateSupported}
          onClick={() => update.mutate()}
          className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-[#2E2E34] bg-[#1C1C22] px-[11px] py-[7px] text-xs font-semibold text-white disabled:opacity-60"
        >
          {update.isPending ? (
            <Loader2 className="size-[13px] animate-spin text-[#C2C2C8]" />
          ) : (
            <RefreshCw className="size-[13px] text-[#C2C2C8]" />
          )}
          Update
        </button>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-[266px] shrink-0 border-r border-[#1C1C1E] md:flex md:flex-col">
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
