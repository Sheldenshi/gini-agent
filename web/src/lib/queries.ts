import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Approval,
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
    refetchInterval: 5000,
    ...options
  });
}

export function useState_(options?: Partial<UseQueryOptions<RuntimeStateSnapshot>>) {
  return useQuery<RuntimeStateSnapshot>({
    queryKey: ["state"],
    queryFn: () => api<RuntimeStateSnapshot>("/state"),
    refetchInterval: 5000,
    ...options
  });
}

export function useTasks(options?: Partial<UseQueryOptions<Task[]>>) {
  return useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api<Task[]>("/tasks"),
    refetchInterval: 3000,
    ...options
  });
}

export function useTask(id: string | null) {
  return useQuery<{ task: Task; trace: TraceRecord[] }>({
    queryKey: ["task", id],
    queryFn: () => api<{ task: Task; trace: TraceRecord[] }>(`/tasks/${id}`),
    enabled: Boolean(id),
    refetchInterval: 3000
  });
}

export function useApprovals() {
  return useQuery<Approval[]>({
    queryKey: ["approvals"],
    queryFn: () => api<Approval[]>("/approvals"),
    refetchInterval: 3000
  });
}

export function useMemories() {
  return useQuery<MemoryRecord[]>({
    queryKey: ["memory"],
    queryFn: () => api<MemoryRecord[]>("/memory"),
    refetchInterval: 5000
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
    refetchInterval: 5000
  });
}

export function useHindsightBanks() {
  return useQuery<HindsightBankView[]>({
    queryKey: ["memory", "banks"],
    queryFn: () => api<HindsightBankView[]>("/memory/banks"),
    refetchInterval: 10_000
  });
}

export function useSubagents() {
  return useQuery<SubagentRecord[]>({
    queryKey: ["subagents"],
    queryFn: () => api<SubagentRecord[]>("/subagents"),
    refetchInterval: 3000
  });
}

export function useSkills(query?: string) {
  const trimmed = query?.trim() ?? "";
  return useQuery<SkillRecord[]>({
    queryKey: ["skills", trimmed],
    queryFn: () => api<SkillRecord[]>(trimmed ? `/skills?q=${encodeURIComponent(trimmed)}` : "/skills"),
    refetchInterval: 5000
  });
}

export function useJobs() {
  return useQuery<JobRecord[]>({
    queryKey: ["jobs"],
    queryFn: () => api<JobRecord[]>("/jobs"),
    refetchInterval: 5000
  });
}

export function useJobRuns(jobId?: string) {
  return useQuery<JobRunRecord[]>({
    queryKey: ["jobRuns", jobId ?? "all"],
    queryFn: () => api<JobRunRecord[]>(jobId ? `/jobs/${jobId}/runs` : "/job-runs"),
    refetchInterval: 5000
  });
}

export function useConnectors() {
  return useQuery<ConnectorRecord[]>({
    queryKey: ["connectors"],
    queryFn: () => api<ConnectorRecord[]>("/connectors"),
    refetchInterval: 10_000
  });
}

export function useImprovements() {
  return useQuery<ImprovementProposal[]>({
    queryKey: ["improvements"],
    queryFn: () => api<ImprovementProposal[]>("/improvements"),
    refetchInterval: 5000
  });
}

export function useEvents() {
  return useQuery<RuntimeEvent[]>({
    queryKey: ["events"],
    queryFn: () => api<RuntimeEvent[]>("/events"),
    refetchInterval: 3000
  });
}

export function useAudit() {
  return useQuery<AuditEvent[]>({
    queryKey: ["audit"],
    queryFn: () => api<AuditEvent[]>("/audit"),
    refetchInterval: 5000
  });
}

export function useChatSessions() {
  return useQuery<ChatSession[]>({
    queryKey: ["chat"],
    queryFn: () => api<ChatSession[]>("/chat"),
    refetchInterval: 5000
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

/**
 * Returns a function that batches invalidate() calls within a tick.
 *
 * Why this matters: the SSE stream can fire many events in rapid succession
 * (e.g. on connection open the runtime replays the recent event log). If every
 * event triggers a separate invalidateQueries() call, React Query schedules a
 * refetch + render per call, which re-runs the SSE-subscribing component's
 * effects, which can re-open the EventSource, which replays again. Coalescing
 * via queueMicrotask collapses N events in the same tick into a single
 * invalidate-per-key, breaking the feedback loop.
 *
 * The returned function reference is stable across renders so it can be used
 * directly as a dep without retriggering effects.
 */
export function useInvalidate() {
  const qc = useQueryClient();
  const pendingRef = useRef<Set<string> | null>(null);
  const flush = useCallback(() => {
    const set = pendingRef.current;
    pendingRef.current = null;
    if (!set) return;
    for (const key of set) qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);
  useEffect(() => {
    // On unmount, drop any pending batch.
    return () => {
      pendingRef.current = null;
    };
  }, []);
  return useCallback(
    (keys: string[]) => {
      if (!pendingRef.current) {
        pendingRef.current = new Set();
        queueMicrotask(flush);
      }
      for (const key of keys) pendingRef.current.add(key);
    },
    [flush]
  );
}
