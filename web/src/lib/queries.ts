import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Approval,
  BrowserConnectionRecord,
  ConnectorRecord,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  MemoryRecord,
  RuntimeEvent,
  RuntimeStatus,
  SkillRecord,
  SubagentRecord,
  Task,
  TraceRecord,
  AuditEvent
} from "@runtime/types";
import type {
  ChatMessage,
  ChatSession,
  RuntimeStateSnapshot
} from "@/lib/view-types";

export function useStatus(options?: Partial<UseQueryOptions<RuntimeStatus>>) {
  return useQuery<RuntimeStatus>({
    queryKey: ["status"],
    queryFn: () => api<RuntimeStatus>("/status"),
    refetchInterval: 60_000,
    ...options
  });
}

export function useState_(options?: Partial<UseQueryOptions<RuntimeStateSnapshot>>) {
  return useQuery<RuntimeStateSnapshot>({
    queryKey: ["state"],
    queryFn: () => api<RuntimeStateSnapshot>("/state"),
    refetchInterval: 60_000,
    ...options
  });
}

export function useTasks(options?: Partial<UseQueryOptions<Task[]>>) {
  return useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api<Task[]>("/tasks"),
    refetchInterval: 60_000,
    ...options
  });
}

export function useTask(id: string | null) {
  return useQuery<{ task: Task; trace: TraceRecord[] }>({
    queryKey: ["task", id],
    queryFn: () => api<{ task: Task; trace: TraceRecord[] }>(`/tasks/${id}`),
    enabled: Boolean(id),
    refetchInterval: 60_000
  });
}

export function useApprovals() {
  return useQuery<Approval[]>({
    queryKey: ["approvals"],
    queryFn: () => api<Approval[]>("/approvals"),
    refetchInterval: 60_000
  });
}

export function useMemories() {
  return useQuery<MemoryRecord[]>({
    queryKey: ["memory"],
    queryFn: () => api<MemoryRecord[]>("/memory"),
    refetchInterval: 60_000
  });
}

import type { HindsightUnitView, HindsightBankView } from "@/lib/view-types";

export function useHindsightUnits(network: string = "all") {
  return useQuery<HindsightUnitView[]>({
    queryKey: ["memory", "hindsight", network],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "200" });
      if (network !== "all") params.set("network", network);
      return api<HindsightUnitView[]>(`/memory/units?${params.toString()}`);
    },
    refetchInterval: 60_000
  });
}

export function useHindsightBanks() {
  return useQuery<HindsightBankView[]>({
    queryKey: ["memory", "banks"],
    queryFn: () => api<HindsightBankView[]>("/memory/banks"),
    refetchInterval: 60_000
  });
}

export function useSubagents() {
  return useQuery<SubagentRecord[]>({
    queryKey: ["subagents"],
    queryFn: () => api<SubagentRecord[]>("/subagents"),
    refetchInterval: 60_000
  });
}

export function useSkills(query?: string) {
  const trimmed = query?.trim() ?? "";
  return useQuery<SkillRecord[]>({
    queryKey: ["skills", trimmed],
    queryFn: () => api<SkillRecord[]>(trimmed ? `/skills?q=${encodeURIComponent(trimmed)}` : "/skills"),
    refetchInterval: 60_000
  });
}

export function useJobs() {
  return useQuery<JobRecord[]>({
    queryKey: ["jobs"],
    queryFn: () => api<JobRecord[]>("/jobs"),
    refetchInterval: 60_000
  });
}

export function useJobRuns(jobId?: string) {
  return useQuery<JobRunRecord[]>({
    queryKey: ["jobRuns", jobId ?? "all"],
    queryFn: () => api<JobRunRecord[]>(jobId ? `/jobs/${jobId}/runs` : "/job-runs"),
    refetchInterval: 60_000
  });
}

export function useConnectors() {
  return useQuery<ConnectorRecord[]>({
    queryKey: ["connectors"],
    queryFn: () => api<ConnectorRecord[]>("/connectors"),
    refetchInterval: 60_000
  });
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  description: string;
  fields: Array<{ name: string; label: string; description?: string; secret: boolean; required?: boolean; placeholder?: string }>;
  secrets?: { purposes: string[]; envBindings: Record<string, string> };
  hasProbe: boolean;
  hasDetect: boolean;
  probeIntervalMs?: number;
}

export function useProviders() {
  return useQuery<ProviderDescriptor[]>({
    queryKey: ["connector-providers"],
    queryFn: () => api<ProviderDescriptor[]>("/connectors/providers"),
    // The registry is built at runtime startup; it doesn't change between
    // reloads, so a long stale time avoids unnecessary refetches.
    staleTime: 5 * 60_000
  });
}

export function useImprovements() {
  return useQuery<ImprovementProposal[]>({
    queryKey: ["improvements"],
    queryFn: () => api<ImprovementProposal[]>("/improvements"),
    refetchInterval: 60_000
  });
}

export function useEvents() {
  return useQuery<RuntimeEvent[]>({
    queryKey: ["events"],
    queryFn: () => api<RuntimeEvent[]>("/events"),
    refetchInterval: 60_000
  });
}

export function useAudit() {
  return useQuery<AuditEvent[]>({
    queryKey: ["audit"],
    queryFn: () => api<AuditEvent[]>("/audit"),
    refetchInterval: 60_000
  });
}

export function useChatSessions() {
  return useQuery<ChatSession[]>({
    queryKey: ["chat"],
    queryFn: () => api<ChatSession[]>("/chat"),
    refetchInterval: 60_000
  });
}

export type ChatSessionDetail = ChatSession & { messages: ChatMessage[]; tasks: Task[] };

// Statuses where a chat task is no longer producing partial text — used to
// decide polling cadence below.
const CHAT_TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "waiting_approval"
]);

export function useChatSession(id: string | null) {
  return useQuery<ChatSessionDetail>({
    queryKey: ["chat", id],
    queryFn: () => api<ChatSessionDetail>(`/chat/${id}`),
    enabled: Boolean(id),
    // While a task is in flight we want the streaming partialSummary to feel
    // live, so we drop to ~800ms. Once everything is terminal we relax back
    // to 3s to avoid unnecessary network chatter.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const hasInflight = data.tasks?.some((t) => !CHAT_TERMINAL_TASK_STATUSES.has(t.status));
      return hasInflight ? 800 : 3000;
    }
  });
}

export function useDeleteChatSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id: string) => api<{ ok: true }>(`/chat/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
    }
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation<Task, Error, string>({
    mutationFn: (taskId: string) => api<Task>(`/tasks/${taskId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    }
  });
}

export function useRenameChatSession() {
  const qc = useQueryClient();
  return useMutation<ChatSession, Error, { id: string; title: string }>({
    mutationFn: ({ id, title }) =>
      api<ChatSession>(`/chat/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
    }
  });
}

// Browser-connect status. Shape mirrors the gateway response from
// /api/browser: { connected: boolean, record?: BrowserConnectionRecord }.
// Polled every 5s when idle, and every 1s while a connect/disconnect
// mutation is in flight, so the status card reflects an external `gini
// browser connect/disconnect` without a manual refresh.
export interface BrowserConnectionStatus {
  connected: boolean;
  record?: BrowserConnectionRecord;
}

// Polls `GET /api/browser` to keep the Settings browser panel in sync with the
// runtime. The default cadence is 5s when nothing's happening — that's
// well below the 3-minute Chrome dev-tools cookie lifetime and noticeably
// less chatter than the previous 3s. Pass `isActive: true` while a
// connect / disconnect mutation is in flight to drop to 1s; once
// settled the caller flips the flag back. We deliberately do NOT switch
// to SSE — the cost of holding an EventSource open across every chat
// session that lands the Settings panel outweighs the gain.
export function useBrowserConnection(options?: { isActive?: boolean }) {
  const isActive = options?.isActive ?? false;
  return useQuery<BrowserConnectionStatus>({
    queryKey: ["browser"],
    queryFn: () => api<BrowserConnectionStatus>("/browser"),
    refetchInterval: isActive ? 1000 : 5000
  });
}

export function useConnectBrowser() {
  const qc = useQueryClient();
  return useMutation<BrowserConnectionStatus, Error, { cdpUrl?: string; port?: number }>({
    mutationFn: (input) =>
      api<BrowserConnectionStatus>("/browser/connect", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["browser"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    }
  });
}

export function useDisconnectBrowser() {
  const qc = useQueryClient();
  return useMutation<BrowserConnectionStatus, Error, void>({
    mutationFn: () =>
      api<BrowserConnectionStatus>("/browser/disconnect", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["browser"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    }
  });
}


/**
 * Returns a function that batches invalidate() calls within a short time
 * window.
 *
 * Why this matters: the SSE stream fires many events in rapid succession on
 * connection open (the runtime replays its recent event log — 100+ events).
 * Each event arrives in its own task tick, so microtask-level coalescing
 * does NOT batch them. We need a small wall-clock window.
 *
 * Trailing-edge debounce with a hard max-wait:
 *   - First call: schedule a flush BURST_MS later.
 *   - Subsequent calls within the window: add keys, reset the timer (up to
 *     BURST_MAX_MS total wait so we still flush during a sustained stream).
 *
 * 80ms is below human perception latency for "instant" UI updates and well
 * above the inter-arrival gap of replayed SSE events (~ms apart), so the
 * historical replay collapses to a single flush per unique key.
 *
 * The returned function reference is stable across renders.
 */
const BURST_MS = 80;
const BURST_MAX_MS = 500;

export function useInvalidate() {
  const qc = useQueryClient();
  const pendingRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstScheduledAtRef = useRef<number>(0);
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const set = pendingRef.current;
    pendingRef.current = null;
    firstScheduledAtRef.current = 0;
    if (!set) return;
    for (const key of set) qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;
    };
  }, []);
  return useCallback(
    (keys: string[]) => {
      if (!pendingRef.current) {
        pendingRef.current = new Set();
        firstScheduledAtRef.current = Date.now();
      }
      for (const key of keys) pendingRef.current.add(key);
      if (timerRef.current) clearTimeout(timerRef.current);
      const elapsed = Date.now() - firstScheduledAtRef.current;
      const wait = Math.min(BURST_MS, Math.max(0, BURST_MAX_MS - elapsed));
      timerRef.current = setTimeout(flush, wait);
    },
    [flush]
  );
}
