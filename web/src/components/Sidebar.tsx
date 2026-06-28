"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  ArchiveRestore,
  ChevronDown,
  Menu,
  Moon,
  MoreVertical,
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
import { useAllChatSessions, useInvalidate, useStatus } from "@/lib/queries";
import { useChatReadState } from "@/lib/use-chat-read-state";
import { isOpenableJobChannel } from "@/lib/job-channel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import { ArchiveAgentDialog } from "@/components/ArchiveAgentDialog";
import { TunnelMenu } from "@/components/tunnel/TunnelMenu";
import { useUpdateGate } from "@/components/UpdateGate";
import type { AgentRow, ChatSession } from "@/lib/view-types";
import type { JobRecord, JobRoute } from "@runtime/types";

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const invalidate = useInvalidate();
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<AgentRow | null>(null);
  const [agentsCollapsed, toggleAgents] = useSectionCollapsed("agents");
  const [archivedCollapsed, toggleArchived] = useSectionCollapsed("agents-archived");
  const [jobsCollapsed, toggleJobs] = useSectionCollapsed("jobs");
  const [topicsCollapsed, toggleTopics] = useSectionCollapsed("topics");

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string; defaultAgentId?: string }>("/agents")
  });
  const allAgents = agentsQuery.data?.agents ?? [];
  const defaultAgentId = agentsQuery.data?.defaultAgentId;
  // `archivedAt` is a soft-delete marker, orthogonal to `status`. Split the
  // roster so archived agents render in their own collapsible group instead
  // of the active list.
  const agents = useMemo(() => allAgents.filter((a) => !a.archivedAt), [allAgents]);
  const archivedAgents = useMemo(() => allAgents.filter((a) => a.archivedAt), [allAgents]);

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
  // schedule (cron or interval). Only channel-bound jobs get a sidebar row: a
  // deliverTo:"chat" job delivers into — and is managed from — its bound
  // conversation (Jobs tab), so a rail row would just be a confusing alias for
  // that chat. A missing/unresolved bound session is treated as not-channel
  // and hidden, as is an archived channel (archived sessions keep history and
  // stay addressable by URL but leave the lists). Stable-sorted by createdAt
  // (then name) so the list doesn't reorder as jobs fire.
  const recurringJobs = useMemo<JobRecord[]>(() => {
    const sessionsById = new Map((allSessions.data ?? []).map((s) => [s.id, s]));
    return (allJobs.data ?? [])
      .filter((j) => !j.oneShot && (j.cronExpression != null || (j.intervalSeconds ?? 0) > 0))
      .filter((j) => {
        if (j.chatSessionId == null) return false;
        return isOpenableJobChannel(sessionsById.get(j.chatSessionId));
      })
      .sort(
        (a, b) =>
          (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.name.localeCompare(b.name)
      );
  }, [allJobs.data, allSessions.data]);

  // Topics for the active agent: `kind:"topic"` sessions that aren't archived,
  // newest-activity first so the most recently touched subject sits on top.
  // Scoped to the active agent (each Topic belongs to that agent's Chat) so the
  // section tracks the selected agent, like the Messages/agent rows.
  const topics = useMemo<ChatSession[]>(() => {
    return (allSessions.data ?? [])
      .filter(
        (s) =>
          s.kind === "topic" &&
          !s.archivedAt &&
          (activeAgentId == null || s.agentId === activeAgentId)
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [allSessions.data, activeAgentId]);

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

  const selectedSession = params?.get("session") ?? null;
  const onChat = pathname === "/chat";

  const useAgentMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status", "memory", "agent-chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  // Restore is a direct, no-confirm action: the restored agent rejoins the
  // active list but stays inactive (the server never auto-activates it).
  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/unarchive`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status"]),
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
                  // The default agent has no kebab: it's the always-present
                  // fallback selection and can't be archived server-side, so
                  // don't offer a guaranteed error. Every other agent — the
                  // active one included — gets it.
                  const canArchive = agent.id !== defaultAgentId;
                  return (
                    <li key={agent.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => selectAgent(agent.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
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
                          <span aria-hidden className="mr-1 size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
                        ) : null}
                      </button>
                      {canArchive ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Agent options for ${agent.name}`}
                            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreVertical className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-32">
                            <DropdownMenuItem variant="destructive" onSelect={() => setArchiveTarget(agent)}>
                              Archive
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>

            {/* Archived agents — collapsible, dimmed, indented. Rendered only
                when at least one agent is archived. */}
            {archivedAgents.length > 0 ? (
              <div className="mt-1 flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={toggleArchived}
                  aria-expanded={!archivedCollapsed}
                  className="flex items-center gap-1.5 px-2 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
                >
                  <ChevronDown
                    className={cn("size-3 transition-transform", archivedCollapsed && "-rotate-90")}
                  />
                  <span className="text-[11px] font-semibold tracking-[0.5px]">Archived</span>
                  <span className="rounded-full bg-sidebar-accent px-[7px] py-px text-[10px] font-semibold text-sidebar-foreground/70">
                    {archivedAgents.length}
                  </span>
                </button>
                <ul className={cn("flex flex-col gap-0.5 pl-[18px]", archivedCollapsed && "hidden")}>
                  {archivedAgents.map((agent) => (
                    <li key={agent.id} className="group flex items-center gap-1.5 rounded-lg px-2.5 py-2 opacity-70 hover:bg-sidebar-accent/50">
                      <AgentAvatar name={agent.name} seed={agent.id} size={20} initialColor="#0A0A0C" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sidebar-foreground/70">
                        {agent.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Restore ${agent.name}`}
                        disabled={unarchiveMutation.isPending}
                        onClick={() => unarchiveMutation.mutate(agent.id)}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                      >
                        <ArchiveRestore className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                  const routeEntries = fanoutRoutes(job);
                  if (routeEntries) {
                    return (
                      <FanoutJobRow
                        key={job.id}
                        job={job}
                        routeEntries={routeEntries}
                        sessions={allSessions.data}
                        selectedSession={selectedSession}
                        onChat={onChat}
                        isUnread={isUnread}
                        selectChannel={selectChannel}
                      />
                    );
                  }
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

          {/* Topics */}
          {topics.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2">
                <button
                  type="button"
                  onClick={toggleTopics}
                  aria-expanded={!topicsCollapsed}
                  className="flex items-center gap-1.5 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
                >
                  <ChevronDown
                    className={cn("size-3 transition-transform", topicsCollapsed && "-rotate-90")}
                  />
                  <span className="text-[11px] font-semibold tracking-[0.5px]">Topics</span>
                </button>
              </div>
              <ul className={cn("flex flex-col gap-0.5", topicsCollapsed && "hidden")}>
                {topics.map((topic) => {
                  const active = onChat && selectedSession === topic.id;
                  const unread = !active && isUnread(topic);
                  return (
                    <li key={topic.id}>
                      <button
                        type="button"
                        onClick={() => selectChannel(topic.id)}
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
                            active || unread
                              ? "font-semibold text-sidebar-accent-foreground"
                              : "font-medium text-sidebar-foreground"
                          )}
                        >
                          {topic.title}
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

          {/* Nav: Skills, Logs, Settings */}
          <ul className="flex flex-col gap-0.5">
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
      <ArchiveAgentDialog
        agent={archiveTarget}
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      />
    </div>
  );
}

// A fan-out email-watch job routes each detection bucket to its OWN per-concern
// channel (`job.routes[routeKey].chatSessionId`); the job's shared
// `chatSessionId` is a dead, empty session no route writes to. The sidebar
// special-cases the gmail-watch marker to surface those concern channels
// directly (the generic job machinery stays generic). Returns the route entries
// when this is a fan-out email-watch job, else null (render as today).
function fanoutRoutes(job: JobRecord): [string, JobRoute][] | null {
  const isEmailWatch = job.preRunHook?.config?.skill === "gmail-watch";
  if (!isEmailWatch) return null;
  const entries = Object.entries(job.routes ?? {});
  return entries.length > 0 ? entries : null;
}

// One "Recurring jobs" row for a fan-out email-watch job: the job name is an
// expand/collapse toggle (it is NOT a link to the dead shared session), and its
// per-concern channels nest underneath as clickable rows with unread dots.
function FanoutJobRow({
  job,
  routeEntries,
  sessions,
  selectedSession,
  onChat,
  isUnread,
  selectChannel
}: {
  job: JobRecord;
  routeEntries: [string, JobRoute][];
  sessions: ChatSession[] | undefined;
  selectedSession: string | null;
  onChat: boolean;
  isUnread: (session: ChatSession) => boolean;
  selectChannel: (sessionId: string) => void;
}) {
  const [collapsed, toggle] = useSectionCollapsed(`job:${job.id}`);
  const byId = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const s of sessions ?? []) map.set(s.id, s);
    return map;
  }, [sessions]);
  const anyConcernUnread = routeEntries.some(([, route]) => {
    const session = byId.get(route.chatSessionId);
    return session ? isUnread(session) : false;
  });

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-sidebar-foreground/55 transition-transform",
            collapsed && "-rotate-90"
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            anyConcernUnread ? "font-semibold text-sidebar-accent-foreground" : "font-medium text-sidebar-foreground"
          )}
        >
          {job.name}
        </span>
        {collapsed && anyConcernUnread ? (
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
        ) : null}
      </button>
      <ul className={cn("flex flex-col gap-0.5 pl-[18px]", collapsed && "hidden")}>
        {routeEntries.map(([routeKey, route]) => {
          const session = byId.get(route.chatSessionId);
          const active = onChat && selectedSession === route.chatSessionId;
          const unread = !active && session ? isUnread(session) : false;
          const title = session?.title ?? routeKey;
          return (
            <li key={routeKey}>
              <button
                type="button"
                onClick={() => selectChannel(route.chatSessionId)}
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
                  {title}
                </span>
                {unread ? (
                  <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
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
