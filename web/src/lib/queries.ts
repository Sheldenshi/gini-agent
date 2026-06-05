import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Authorization,
  BrowserConnectionRecord,
  ChatBlock,
  ConnectorRecord,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  RuntimeEvent,
  RuntimeStatus,
  SetupRequest,
  SkillRecord,
  SubagentRecord,
  Task,
  TraceRecord,
  AuditEvent
} from "@runtime/types";
import type {
  ChatMessage,
  ChatSession,
  RuntimeStateSnapshot,
  ThreadSummary
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

// Active agent for scoping per-agent listings. Reads /status; returns
// undefined until /status resolves. Consumers below gate their fetches on
// this being defined (`enabled: Boolean(agentId)`) so the unfiltered list
// never lands in the cache during bootstrapping.
function useActiveAgentId(): string | undefined {
  const status = useStatus();
  return status.data?.activeAgent?.id;
}

function scopedPath(path: string, agentId: string | undefined): string {
  if (!agentId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}agentId=${encodeURIComponent(agentId)}`;
}

export function useTasks(options?: Partial<UseQueryOptions<Task[]>>) {
  const agentId = useActiveAgentId();
  const { enabled: callerEnabled, ...rest } = options ?? {};
  return useQuery<Task[]>({
    queryKey: ["tasks", agentId ?? null],
    queryFn: () => api<Task[]>(scopedPath("/tasks", agentId)),
    refetchInterval: 60_000,
    // Defer the first fetch until /status resolves the active agent so the
    // unfiltered payload doesn't briefly land in the cache under the `null`
    // key during bootstrapping. The Activity page can still opt into the
    // "all agents" view by passing the filter through its own useQuery.
    enabled: Boolean(agentId) && (callerEnabled ?? true),
    ...rest
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

export function useAuthorizations() {
  return useQuery<Authorization[]>({
    queryKey: ["authorizations"],
    queryFn: () => api<Authorization[]>("/authorizations"),
    refetchInterval: 60_000
  });
}

export function useSetupRequests() {
  return useQuery<SetupRequest[]>({
    queryKey: ["setup-requests"],
    queryFn: () => api<SetupRequest[]>("/setup-requests"),
    refetchInterval: 60_000
  });
}

// `useMemories` was removed alongside the state.memories
// consolidation. The Memory page now surfaces Hindsight only — see
// the per-unit/per-bank hooks below. See ADR
// runtime-identity-files.md.

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
  const agentId = useActiveAgentId();
  return useQuery<SubagentRecord[]>({
    queryKey: ["subagents", agentId ?? null],
    queryFn: () => api<SubagentRecord[]>(scopedPath("/subagents", agentId)),
    refetchInterval: 60_000,
    enabled: Boolean(agentId)
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
  const agentId = useActiveAgentId();
  return useQuery<JobRecord[]>({
    queryKey: ["jobs", agentId ?? null],
    queryFn: () => api<JobRecord[]>(scopedPath("/jobs", agentId)),
    refetchInterval: 60_000,
    enabled: Boolean(agentId)
  });
}

export function useJobRuns(jobId?: string) {
  const agentId = useActiveAgentId();
  return useQuery<JobRunRecord[]>({
    queryKey: ["jobRuns", jobId ?? "all", agentId ?? null],
    queryFn: () => api<JobRunRecord[]>(
      scopedPath(jobId ? `/jobs/${jobId}/runs` : "/job-runs", agentId)
    ),
    refetchInterval: 60_000,
    enabled: Boolean(agentId)
  });
}

export function useConnectors() {
  return useQuery<ConnectorRecord[]>({
    queryKey: ["connectors"],
    queryFn: () => api<ConnectorRecord[]>("/connectors"),
    // Poll fast only while a connector is provisioned but signed out — the
    // window where the user is completing OAuth and wants the row to flip to
    // connected promptly. Otherwise idle at 60s. (Server caches the underlying
    // gws auth status ~15s, so this won't spawn gws on every tick.)
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.session?.clientConfigured && !c.session.signedIn)
        ? 5_000
        : 60_000
  });
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  description: string;
  docsUrl?: string;
  fields: Array<{ name: string; label: string; description?: string; secret: boolean; required?: boolean; placeholder?: string }>;
  secrets?: { purposes: string[]; envBindings: Record<string, string> };
  hasProbe: boolean;
  hasDetect: boolean;
  // Whether the provider declares a chat-driven setup skill (e.g.
  // google-workspace-setup). Skills page routes these to "Set up via chat".
  hasSetupSkill?: boolean;
  // The setup skill NAME (e.g. "google-workspace-setup"). Lets the Skills
  // page match a service skill's required-credential connector to its setup
  // skill so the service pill defers to the setup card's sign-in status.
  setupSkill?: string;
  probeIntervalMs?: number;
  // Defaults the Add Connector dialog prefills when this provider is picked
  // as a credential template. Present only for providers whose module
  // declares secret bindings (linear → api-key LINEAR_API_KEY + MCP URL,
  // google-oauth-desktop → oauth2 + envMap). Plain api keys carry none.
  credentialTemplate?: {
    type: "api-key" | "oauth2";
    name: string;
    mcpUrl?: string;
    mcpName?: string;
    envMap?: Record<string, string>;
  };
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
  const agentId = useActiveAgentId();
  return useQuery<ChatSession[]>({
    queryKey: ["chat", agentId ?? null],
    queryFn: () => api<ChatSession[]>(scopedPath("/chat", agentId)),
    // 3s safety net so the sidebar's read/unread indicator picks up
    // task completions even when an SSE event for the change is missed
    // or arrives without invalidating ["chat"]. SSE is still the
    // primary signal — the interval just bounds the worst case.
    refetchInterval: 3000,
    enabled: Boolean(agentId)
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

// ChatBlock protocol consumer. Fetches the ordered block list once and
// subscribes to the per-session SSE stream for live updates. The block
// list is the single source of truth for the chat page — clients render
// it as-is (no client-side phase synthesis, no partialSummary swap, no
// approval join). See ADR chat-block-protocol.md.
//
// Merge rules (matching the wire contract):
//   - Incoming frames are upserted by `id`. The streaming `assistant_text`
//     kind emits the same id repeatedly with the FULL accreted text on
//     every delta; merging by id keeps the rendered string monotonically
//     growing without splicing deltas client-side.
//   - `tool_call` rows flip status (running -> ok / error / denied) under
//     a stable id, so the same upsert path covers them.
//   - All other kinds are append-only, but the merge logic is uniform.

// Merge the REST seed snapshot with whatever's already in state. A live
// SSE frame can arrive BEFORE the seed promise resolves; a naive
// setBlocks(seed) would wipe it. For id collisions, prev (live) wins
// because the live frame is fresher than the REST snapshot — assistant
// streaming deltas in particular keep updating the same block id, and
// the seed's older copy would visibly clobber the running total.
// Exported for unit testing the merge-vs-replace behavior.
export function mergeSeedWithLive(seed: ChatBlock[], prev: ChatBlock[]): ChatBlock[] {
  const merged = new Map<string, ChatBlock>();
  for (const b of seed) merged.set(b.id, b);
  for (const b of prev) merged.set(b.id, b);
  // Sort defensively — the server returns ordinal-asc, but a future
  // server-side change shouldn't silently re-order the UI, and the
  // merge can interleave seed+live arbitrarily.
  return [...merged.values()].sort((a, b) => a.ordinal - b.ordinal);
}

// The SSE stream auto-attaches Last-Event-ID on browser-driven reconnects.
// On open we still issue a fresh GET /blocks so a tab waking from sleep or
// a fresh navigation gets the durable list before any live frames land.
export function useChatBlocks(sessionId: string | null) {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(sessionId));
  const [error, setError] = useState<Error | null>(null);

  // Stash sessionId in a ref so the effect cleanup observes the exact
  // sessionId it opened against rather than whatever the latest render
  // captured. Without this, a quick session switch could leak an
  // EventSource because the closed-over id no longer matches.
  const activeSessionRef = useRef<string | null>(sessionId);
  activeSessionRef.current = sessionId;

  useEffect(() => {
    // Reset on EVERY sessionId change, not just null transitions. Caller
    // (chat/page.tsx) re-runs the hook with a new id on chat switch but
    // does not remount the component, so the useState slot above persists
    // the previous chat's blocks. Without this reset, the seed fetch for
    // the new session merges its initial list with the prior session's
    // blocks (mergeSeedWithLive de-dupes by id only, no session check),
    // leaking blocks from chat A into chat B's transcript. Resetting here
    // also clears the loading/error slot so the new session starts from
    // a clean slate; the seed fetch below flips loading off on resolve.
    setBlocks([]);
    setError(null);

    if (!sessionId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const merge = (incoming: ChatBlock) => {
      if (cancelled || activeSessionRef.current !== sessionId) return;
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === incoming.id);
        if (idx >= 0) {
          // Upsert in place. assistant_text streaming deltas hit this
          // path with the running total; tool_call status flips also.
          const next = prev.slice();
          next[idx] = incoming;
          return next;
        }
        // Append + re-sort by ordinal. SSE generally arrives in order
        // but a backfill batch can interleave with live frames on
        // reconnect; keep the render ordering authoritative.
        const next = [...prev, incoming];
        next.sort((a, b) => a.ordinal - b.ordinal);
        return next;
      });
    };

    // Always seed with the durable list first so the first paint
    // contains the chat's known history regardless of transport.
    api<ChatBlock[]>(`/chat/${sessionId}/blocks`)
      .then((initial) => {
        if (cancelled || activeSessionRef.current !== sessionId) return;
        // Merge with whatever's already in state — a live SSE
        // block can arrive BEFORE the seed promise resolves, and a
        // plain setBlocks(sorted) would silently drop it.
        setBlocks((prev) => mergeSeedWithLive(initial, prev));
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled || activeSessionRef.current !== sessionId) return;
        setError(err);
        setIsLoading(false);
      });

    const source = new EventSource(`/api/runtime/chat/${sessionId}/stream`);
    source.addEventListener("chat_block", (event) => {
      const messageEvent = event as MessageEvent;
      try {
        const block = JSON.parse(messageEvent.data) as ChatBlock;
        merge(block);
      } catch {
        // A malformed frame shouldn't kill the stream — ignore and
        // wait for the next one. The SSE browser implementation
        // handles reconnect with Last-Event-ID on transport errors.
      }
    });
    // EventSource has built-in reconnect with backoff; don't close on
    // error or transient hiccups turn into permanent disconnects.
    source.onerror = () => {};
    return () => {
      cancelled = true;
      source.close();
    };
  }, [sessionId]);

  return { blocks, isLoading, error };
}

// The single canonical chat for an agent. Resolves via
// GET /api/agents/:agentId/chat (the runtime get-or-create resolver), so the
// first read for a fresh agent materializes its one session. Gated on a
// defined agentId so the unscoped path never fires.
export function useAgentChat(agentId: string | null | undefined) {
  return useQuery<ChatSession>({
    queryKey: ["agent-chat", agentId ?? null],
    queryFn: () => api<ChatSession>(`/agents/${encodeURIComponent(agentId!)}/chat`),
    enabled: Boolean(agentId),
    // Match the session-list cadence so the header/tab badges pick up new
    // activity even when an SSE invalidation is missed.
    refetchInterval: 3000
  });
}

// Split a session's block list into the main chat (threadId absent) and a
// per-thread map. The chat transcript renders `main`; the thread panel reads
// `byThread.get(threadId)`. Pure derivation over the live block list so both
// views stay in lock-step with the same SSE stream — no second source of
// truth. Exported for the chat page and ThreadPanel to share one fetch.
export function splitBlocks(blocks: ChatBlock[]): {
  main: ChatBlock[];
  byThread: Map<string, ChatBlock[]>;
} {
  const main: ChatBlock[] = [];
  const byThread = new Map<string, ChatBlock[]>();
  for (const block of blocks) {
    if (block.threadId) {
      const list = byThread.get(block.threadId);
      if (list) list.push(block);
      else byThread.set(block.threadId, [block]);
    } else {
      main.push(block);
    }
  }
  return { main, byThread };
}

// Thread summaries for one session — drives the per-agent Threads tab and the
// inline reply chips. Validates the session exists server-side (404s a stale
// link). Polled like the session list so reply counts stay fresh.
export function useThreads(sessionId: string | null) {
  return useQuery<ThreadSummary[]>({
    queryKey: ["threads", sessionId ?? null],
    queryFn: () => api<ThreadSummary[]>(`/chat/${sessionId}/threads`),
    enabled: Boolean(sessionId),
    refetchInterval: 3000
  });
}

// One thread's blocks. Seeds from GET /chat/:id/threads/:threadId/blocks and
// then rides the shared per-session SSE, filtering live frames by threadId —
// so a reply streaming into the thread updates the open panel without a
// second poll. Mirrors useChatBlocks' merge/seed/reset contract, narrowed to
// the one thread.
export function useThread(sessionId: string | null, threadId: string | null) {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(sessionId && threadId));
  const [error, setError] = useState<Error | null>(null);

  const activeKeyRef = useRef<string | null>(sessionId && threadId ? `${sessionId}::${threadId}` : null);
  const key = sessionId && threadId ? `${sessionId}::${threadId}` : null;
  activeKeyRef.current = key;

  useEffect(() => {
    setBlocks([]);
    setError(null);

    if (!sessionId || !threadId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const merge = (incoming: ChatBlock) => {
      if (cancelled || activeKeyRef.current !== key) return;
      // The shared session stream carries main-chat and thread frames alike;
      // keep only this thread's.
      if (incoming.threadId !== threadId) return;
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === incoming.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = incoming;
          return next;
        }
        const next = [...prev, incoming];
        next.sort((a, b) => a.ordinal - b.ordinal);
        return next;
      });
    };

    api<ChatBlock[]>(`/chat/${sessionId}/threads/${threadId}/blocks`)
      .then((initial) => {
        if (cancelled || activeKeyRef.current !== key) return;
        setBlocks((prev) => mergeSeedWithLive(initial, prev));
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled || activeKeyRef.current !== key) return;
        setError(err);
        setIsLoading(false);
      });

    const source = new EventSource(`/api/runtime/chat/${sessionId}/stream`);
    source.addEventListener("chat_block", (event) => {
      const messageEvent = event as MessageEvent;
      try {
        merge(JSON.parse(messageEvent.data) as ChatBlock);
      } catch {
        // Ignore a malformed frame; the next one will land.
      }
    });
    source.onerror = () => {};
    return () => {
      cancelled = true;
      source.close();
    };
  }, [sessionId, threadId, key]);

  return { blocks, isLoading, error };
}

// Cross-agent thread inbox. The server returns the full list (enriched with
// agentName, newest first); `filter=unread` is applied client-side from
// read-state, so we always fetch `all` and let the caller hide read rows.
export function useThreadsInbox() {
  return useQuery<ThreadSummary[]>({
    queryKey: ["threads-inbox"],
    queryFn: () => api<ThreadSummary[]>("/threads?filter=all"),
    refetchInterval: 3000
  });
}

// Post a reply into a thread. Invalidates chat/threads so the chip count and
// inbox advance once the run is accepted. `parentBlockId` is required only when
// the user starts a brand-new thread (no blocks yet) — it tells the backend
// which main-chat message the thread branches from. Replies to an existing
// thread omit it and the backend inherits the parent from the thread's blocks.
export function useReplyToThread(sessionId: string | null, threadId: string | null) {
  const qc = useQueryClient();
  return useMutation<
    { sessionId: string; threadId: string; runId: string; taskId: string; status: string },
    Error,
    {
      content: string;
      images?: { id: string; mimeType: string; size: number }[];
      alsoToMain?: boolean;
      parentBlockId?: string;
    }
  >({
    mutationFn: (input) =>
      api(`/chat/${sessionId}/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify(input)
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["threads-inbox"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
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
