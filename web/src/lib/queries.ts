import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Approval,
  ChatMessage,
  ChatSession,
  ConnectorRecord,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  MemoryRecord,
  ReadinessResult,
  RuntimeEvent,
  RuntimeStateSnapshot,
  RuntimeStatus,
  SkillRecord,
  Task,
  AuditEvent
} from "@/lib/types";

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
  return useQuery<{ task: Task; trace: unknown[] }>({
    queryKey: ["task", id],
    queryFn: () => api<{ task: Task; trace: unknown[] }>(`/tasks/${id}`),
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

export function useChatSession(id: string | null) {
  return useQuery<ChatSessionDetail>({
    queryKey: ["chat", id],
    queryFn: () => api<ChatSessionDetail>(`/chat/${id}`),
    enabled: Boolean(id),
    refetchInterval: 3000
  });
}

export function useReadiness() {
  return useQuery<ReadinessResult>({
    queryKey: ["readiness"],
    queryFn: () => api<ReadinessResult>("/readiness/v1"),
    refetchInterval: 30_000
  });
}

export function useParity() {
  return useQuery<ReadinessResult>({
    queryKey: ["parity"],
    queryFn: () => api<ReadinessResult>("/parity/hermes"),
    refetchInterval: 30_000
  });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}
