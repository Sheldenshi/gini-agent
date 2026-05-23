import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import { api } from "./api";
import type {
  AgentRecord,
  AgentsResponse,
  ChatBlock,
  ChatSession,
  ChatSessionDetail,
  RuntimeStatus
} from "./types";

// Web parity: chat task statuses where partial text is no longer arriving.
// `waiting_approval` is included here on the polling side because the
// runtime can't make further progress without user input; we don't poll
// faster while sitting on it.
const CHAT_TERMINAL_TASK_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "waiting_approval"
]);

export function useStatus(options?: Partial<UseQueryOptions<RuntimeStatus>>) {
  return useQuery<RuntimeStatus>({
    queryKey: ["status"],
    queryFn: () => api<RuntimeStatus>("/status"),
    ...options
  });
}

export function useAgents() {
  return useQuery<AgentsResponse>({
    queryKey: ["agents"],
    queryFn: () => api<AgentsResponse>("/agents"),
    // Agent list rarely changes; a 30s polling floor is enough to pick
    // up the user creating an agent via the web while the mobile app is
    // backgrounded.
    refetchInterval: 30_000
  });
}

export function useUseAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (agentId: string) =>
      api<AgentRecord>(`/agents/${agentId}/use`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

// POST /api/agents only requires `name`; the runtime copies provider /
// toolsets / messaging targets from the default agent (see
// src/capabilities/agents.ts). The created agent is returned so callers
// can pivot the selection to it immediately.
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (name: string) =>
      api<AgentRecord>("/agents", {
        method: "POST",
        body: JSON.stringify({ name })
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
    }
  });
}

// Per-agent chat list. The gateway filters server-side via ?agentId, so
// the React Query key includes the agentId — switching agents triggers a
// fresh fetch instead of briefly flashing the previous agent's chats.
export function useChats(agentId: string | null) {
  return useQuery<ChatSession[]>({
    queryKey: ["chats", agentId],
    queryFn: () =>
      api<ChatSession[]>(`/chat?agentId=${encodeURIComponent(agentId ?? "")}`),
    enabled: Boolean(agentId),
    refetchInterval: 3000
  });
}

export function useChatSession(id: string | null) {
  return useQuery<ChatSessionDetail>({
    queryKey: ["chat", id],
    queryFn: () => api<ChatSessionDetail>(`/chat/${id}`),
    enabled: Boolean(id),
    // Match the web client: 800ms while a task is in flight so the
    // assistant placeholder phase indicator updates briskly, 3s when
    // everything is settled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const hasInflight = data.tasks?.some(
        (t) => !CHAT_TERMINAL_TASK_STATUSES.has(t.status)
      );
      return hasInflight ? 800 : 3000;
    }
  });
}

// Phase labels that mean "no task in flight". Anything else (Thinking,
// Working: <tool>, Waiting for approval, …) keeps the in-flight flag
// raised so the polling cadence stays brisk and the composer's busy
// state remains accurate.
const TERMINAL_PHASE_LABELS = new Set<string>(["Completed", "Cancelled", "Failed"]);

// Derives "is the runtime still doing work?" from the block list. The
// web client gets this for free from SSE; on mobile we poll, so the
// cadence below is what makes streaming text feel live.
//
// Rules (mirror src/execution/chat-task.ts emission anchors):
//   - The most recent phase block dictates the high-level state. If its
//     label is Completed / Cancelled / Failed → no task in flight.
//   - A tool_call(running) without a status flip means a tool is still
//     working even if the most recent phase block already moved past it
//     (e.g. the model said "Thinking" while a long-running parallel tool
//     is still going). callId pairs the running entry with its terminal
//     status, so we count distinct callIds with no later non-running row.
//   - An approval_requested block whose tool_call still reads "running"
//     means we're paused on the user — keep polling at the brisk cadence
//     so the bubble reflects the eventual approve/deny flip.
export function isTaskInFlight(blocks: ChatBlock[]): boolean {
  if (blocks.length === 0) return false;

  // Pass 1: find the most recent phase block.
  let latestPhaseLabel: string | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    if (b.kind === "phase") {
      latestPhaseLabel = b.label;
      break;
    }
  }

  // Pass 2: scan for unresolved tool_calls by callId. A `running` entry
  // is unresolved unless a later block with the same callId carries a
  // terminal status (ok / error / denied).
  const callStatus = new Map<string, "running" | "ok" | "error" | "denied">();
  for (const b of blocks) {
    if (b.kind === "tool_call") callStatus.set(b.callId, b.status);
  }
  let anyRunningCall = false;
  for (const status of callStatus.values()) {
    if (status === "running") {
      anyRunningCall = true;
      break;
    }
  }

  if (anyRunningCall) return true;
  if (!latestPhaseLabel) {
    // No phase block yet (a fresh user_text just landed) → assume the
    // runtime is about to emit Thinking; cadence stays brisk.
    return true;
  }
  return !TERMINAL_PHASE_LABELS.has(latestPhaseLabel);
}

// ChatBlock consumer for the detail screen. Polls /blocks at 800ms while
// any block-derived signal says a task is in flight, 3s otherwise.
// Mobile doesn't run SSE in this round (React Native's EventSource
// situation is messy), so polling is the live-update mechanism.
//
// Returns the typed block list directly — no derivation, no normalization;
// the renderer is exhaustive over the discriminated union.
export function useChatBlocks(sessionId: string | null) {
  return useQuery<ChatBlock[]>({
    queryKey: ["chat-blocks", sessionId],
    queryFn: () => api<ChatBlock[]>(`/chat/${sessionId}/blocks`),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const blocks = query.state.data ?? [];
      return isTaskInFlight(blocks) ? 800 : 3000;
    }
  });
}

// POST /api/chat always creates the chat under the runtime's currently
// active agent — there's no body field to pin it to a specific agent.
// Without re-asserting our route's agentId first, another client (web
// session, CLI) switching agents would silently misroute the new chat.
export function useCreateChat(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation<ChatSession, Error, void>({
    mutationFn: async () => {
      if (agentId) {
        await api(`/agents/${agentId}/use`, { method: "POST" });
      }
      return api<ChatSession>("/chat", {
        method: "POST",
        body: JSON.stringify({ title: "" })
      });
    },
    onSuccess: () => {
      // Invalidate this agent's list explicitly so the new chat shows
      // up immediately, plus the broader keys other clients depend on.
      qc.invalidateQueries({ queryKey: ["chats", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    }
  });
}

export function useSendMessage(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ taskId: string }, Error, string>({
    mutationFn: (content: string) => {
      if (!sessionId) throw new Error("No session selected");
      return api<{ taskId: string }>(`/chat/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
    },
    onSuccess: () => {
      // Invalidate both the legacy session query and the block list so the
      // chat detail screen picks up the new user_text block (and the
      // runtime's follow-up phase / assistant_text blocks) on the next
      // poll tick rather than waiting for the 3s idle cadence to expire.
      qc.invalidateQueries({ queryKey: ["chat", sessionId] });
      qc.invalidateQueries({ queryKey: ["chat-blocks", sessionId] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

export function useSyncChatTask(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (taskId: string) => {
      if (!sessionId) throw new Error("No session selected");
      return api(`/chat/${sessionId}/tasks/${taskId}/sync`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", sessionId] });
    }
  });
}
