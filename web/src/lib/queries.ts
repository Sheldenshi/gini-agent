import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { openResilientEventSource } from "@/lib/resilient-event-source";
import type {
  Authorization,
  BrowserConnectionRecord,
  ChatBlock,
  ConnectorRecord,
  EmailWatcherRecord,
  GoogleAccountStatus,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  PendingChatMessage,
  RunRecord,
  RuntimeEvent,
  RuntimeStatus,
  SetupRequest,
  SkillRecord,
  SubagentRecord,
  Task,
  TraceRecord,
  AuditEvent,
  UsageSource
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

// One day's token usage from GET /api/usage — the server-side rollup of the
// durable usage ledger (chat, jobs, subagents, memory, titles, vision …),
// scoped to the active agent. Mirrors DayUsage in src/state/usage.ts.
export interface UsageDay {
  day: string;
  dayStart: number;
  input: number;
  output: number;
  total: number;
  estimatedUsd: number;
  bySource: Partial<Record<UsageSource, { input: number; output: number; total: number; estimatedUsd: number; calls: number }>>;
}

export function useUsage(days: number, options?: Partial<UseQueryOptions<UsageDay[]>>) {
  const agentId = useActiveAgentId();
  const { enabled: callerEnabled, ...rest } = options ?? {};
  return useQuery<UsageDay[]>({
    queryKey: ["usage", agentId ?? null, days],
    queryFn: () => api<UsageDay[]>(scopedPath(`/usage?days=${days}`, agentId)),
    refetchInterval: 60_000,
    enabled: Boolean(agentId) && (callerEnabled ?? true),
    ...rest
  });
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

// Unscoped jobs list (all agents) — mirrors the sidebar's inline query so the
// React Query cache key is shared and the two dedupe. Used by the chat surface
// to resolve a recurring-job channel back to its originating job.
export function useAllJobs() {
  return useQuery<JobRecord[]>({
    queryKey: ["jobs", "all"],
    queryFn: () => api<JobRecord[]>("/jobs"),
    refetchInterval: 3000
  });
}

// Unscoped chat list (all agents) — shares the sidebar's cache key so the two
// dedupe. Used to resolve a pinned/channel session regardless of which agent
// is active.
export function useAllChatSessions() {
  return useQuery<ChatSession[]>({
    queryKey: ["chat", "all"],
    queryFn: () => api<ChatSession[]>("/chat"),
    refetchInterval: 3000
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

// Email watchers backing the fan-out concern UI. The list is read-only here;
// edits go through the mutations below, never job.routes (the routes are
// recomputed server-side from the watchers, so jobs is invalidated too).
export function useEmailWatchers() {
  return useQuery<EmailWatcherRecord[]>({
    queryKey: ["email-watchers"],
    queryFn: () => api<EmailWatcherRecord[]>("/email/watchers"),
    refetchInterval: 60_000
  });
}

// PATCH a watcher's enabled flag and/or objective. `objective: null` clears it;
// omitting a field leaves it unchanged (matches the gateway contract).
export function useUpdateEmailWatcher() {
  const invalidate = useInvalidate();
  return useMutation<EmailWatcherRecord, Error, { id: string; enabled?: boolean; objective?: string | null }>({
    mutationFn: ({ id, ...body }) =>
      api<EmailWatcherRecord>(`/email/watchers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidate(["email-watchers", "jobs"])
  });
}

export function useRemoveEmailWatcher() {
  const invalidate = useInvalidate();
  return useMutation<unknown, Error, string>({
    mutationFn: (id: string) => api(`/email/watchers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(["email-watchers", "jobs"])
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
  // Live result of the provider's credentialExternallySatisfied hook (e.g.
  // registered machine-global Google accounts). deriveActivation mirrors the
  // runtime gate with it: the fallthrough applies only when NO connector
  // record with the credential name exists — an existing record of any
  // status (including disabled) keeps the record-based gate.
  // Mapping caveat: the web routes a required credential name to its
  // provider via `credentialTemplate.name`, which exists only for modules
  // declaring secret envBindings — while the runtime maps via
  // canonicalCredentialName, where an explicit module `credentialName`
  // suffices. A future hook-implementing provider must declare envBindings
  // too, or this bit will never reach the activation pills.
  externallySatisfied?: boolean;
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
    // The registry itself is built at runtime startup, but the payload also
    // carries the live `externallySatisfied` bit (machine-global account
    // registry), so poll at the same 60s cadence the connectors query idles
    // at. staleTime alone never refetches an idle page — without the
    // interval, accounts added/removed out-of-band (e.g. from a chat-driven
    // OAuth flow) would leave the activation pills stale indefinitely.
    staleTime: 60_000,
    refetchInterval: 60_000
  });
}

// Machine-global tagged Google accounts (GET /api/google/accounts), each
// joined with live `gws auth status`. Exists independently of any
// google-oauth-desktop connector record, so the Skills page can render the
// accounts card on a registry-only machine. The GoogleAccountsCard
// mutations invalidate the "google-accounts" key.
export function useGoogleAccounts() {
  return useQuery<GoogleAccountStatus[]>({
    queryKey: ["google-accounts"],
    queryFn: () => api<GoogleAccountStatus[]>("/google/accounts"),
    refetchInterval: 60_000
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

export type ChatSessionDetail = ChatSession & { messages: ChatMessage[]; tasks: Task[]; runs: RunRecord[] };

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

// Run records for one session — used to mark job-delivered chat messages
// with a "from <job name>" badge. GET /chat/:id returns the session's full
// run list (incl. kind/jobId); we select just `runs` and join jobId → name
// against the jobs list at the call site. Far leaner than useChatSession,
// which polls the full detail at ~800ms while a task is in flight; the badge
// name set only changes when a new run lands, so ~30s is ample.
export function useChatRuns(id: string | null) {
  return useQuery<ChatSessionDetail, Error, RunRecord[]>({
    queryKey: ["chat-runs", id],
    queryFn: () => api<ChatSessionDetail>(`/chat/${id}`),
    enabled: Boolean(id),
    refetchInterval: 30_000,
    select: (detail) => detail.runs ?? []
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

// The block's wall-clock freshness. ChatBlockBase always carries
// `createdAt`; only `assistant_text` and `tool_call` add `updatedAt`,
// which advances on every streaming delta / status flip. The
// `"updatedAt" in b` guard narrows the union safely — kinds without it
// fall back to `createdAt`.
function blockTimestamp(b: ChatBlock): string {
  return "updatedAt" in b ? b.updatedAt : b.createdAt;
}

// Merge an `incoming` snapshot with whatever's already in state, used by
// BOTH the initial seed fetch and the recovery refetch (one function so
// the two paths reconcile identically). A live SSE frame can arrive
// BEFORE the seed promise resolves; a naive setBlocks(incoming) would
// wipe it. So we merge by id and pick the FRESHEST committed copy: on an
// id collision keep the block whose timestamp (`updatedAt ?? createdAt`)
// is STRICTLY GREATER, and on a TIE keep `prev` (the live frame).
//
// Why freshest-wins matters: during normal streaming the live `prev`
// copy is at least as fresh as the seed (equal or later updatedAt), so
// the tie/greater rules keep the running total and never regress to the
// seed's older text. But on a RECOVERY refetch the durable list can be
// fresher than a stranded live frame — if the terminal SSE was missed,
// `prev` still holds a stale `streaming:true` assistant block while the
// refetched copy is the finalized `streaming:false` one with a later
// updatedAt. Freshest-wins lets that finalized copy replace the stale
// cursor; ties still favor the live frame so steady-state streaming is
// unaffected. New ids from either side are kept; sort by ordinal.
// Exported for unit testing the merge-vs-replace behavior.
export function mergeSeedWithLive(seed: ChatBlock[], prev: ChatBlock[]): ChatBlock[] {
  const merged = new Map<string, ChatBlock>();
  for (const b of seed) merged.set(b.id, b);
  for (const b of prev) {
    const existing = merged.get(b.id);
    // Keep `prev` on a tie (>=), so the live frame wins when timestamps
    // match; only an older `prev` yields to a strictly-fresher seed copy.
    if (!existing || blockTimestamp(b) >= blockTimestamp(existing)) merged.set(b.id, b);
  }
  // Sort defensively — the server returns ordinal-asc, but a future
  // server-side change shouldn't silently re-order the UI, and the
  // merge can interleave seed+live arbitrarily.
  return [...merged.values()].sort((a, b) => a.ordinal - b.ordinal);
}

// Phase labels the runtime emits as the final block of a task; a
// non-terminal latest phase means a task is still in flight.
export const TERMINAL_PHASE_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

// The task id of the latest in-flight turn in `blocks`, or null when the
// transcript is quiescent. Scan from the end: the first `phase` block
// decides it (null when terminal, else its taskId); a `tool_call` still
// `running` also marks an in-flight turn. Shared by the chat page's
// in-flight detection and the poll-while-active gate in useChatBlocks.
export function latestInFlightTaskId(blocks: ChatBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "phase") {
      if (TERMINAL_PHASE_LABELS.has(b.label)) return null;
      return b.taskId ?? null;
    }
    if (b.kind === "tool_call" && b.status === "running") return b.taskId ?? null;
  }
  return null;
}

// The SSE stream auto-attaches Last-Event-ID on browser-driven reconnects.
// On open we still issue a fresh GET /blocks so a tab waking from sleep or
// a fresh navigation gets the durable list before any live frames land.
//
// `initialPending` seeds the message queue (ADR chat-message-queue.md) from
// the session record the page already holds, so the "N Queued" pill paints
// without an extra request. Live queue changes (enqueue / drain / remove)
// then ride the existing per-session `chat_session` SSE frame, which carries
// the full session record including `pendingMessages`.
export function useChatBlocks(
  sessionId: string | null,
  initialPending: PendingChatMessage[] = []
) {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(sessionId));
  const [error, setError] = useState<Error | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingChatMessage[]>(initialPending);

  // Stash sessionId in a ref so the effect cleanup observes the exact
  // sessionId it opened against rather than whatever the latest render
  // captured. Without this, a quick session switch could leak an
  // EventSource because the closed-over id no longer matches.
  const activeSessionRef = useRef<string | null>(sessionId);
  activeSessionRef.current = sessionId;

  // Latest seed for the queue, read by the session-reset effect below. Held in
  // a ref so re-seeding doesn't have to put `initialPending` in the SSE
  // effect's dep array (which would tear down + rebuild the stream on every
  // render as the page passes a fresh array reference).
  const initialPendingRef = useRef<PendingChatMessage[]>(initialPending);
  initialPendingRef.current = initialPending;

  // Guards a late refetch resolve from setting state after unmount. The
  // sessionId match below already drops cross-session writes; this drops
  // the post-unmount case too.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Silent reconciliation against durable state. GETs the current block
  // list and merges it into state via mergeSeedWithLive, so a refetch can
  // replace a stranded `streaming:true` block with the finalized copy
  // (freshest-wins) without disturbing live frames. Deliberately does NOT
  // touch isLoading, and swallows errors: a transient poll failure must
  // never surface an error or blow away the loaded transcript. The
  // session match (and mountedRef) drop a resolve that lands after the
  // user switched chats or the component unmounted.
  const refetch = useCallback(() => {
    const sid = activeSessionRef.current;
    if (!sid) return;
    api<ChatBlock[]>(`/chat/${sid}/blocks`)
      .then((list) => {
        if (!mountedRef.current || activeSessionRef.current !== sid) return;
        setBlocks((prev) => mergeSeedWithLive(list, prev));
      })
      .catch(() => {});
  }, []);

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
    // Re-seed the queue from the session the page holds for the new id. The
    // initial `chat_session` frame on connect (and every mutation after) then
    // keeps it live.
    setPendingMessages(initialPendingRef.current);

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

    // Resilient transport: a bare EventSource is permanently CLOSED when a
    // reconnect attempt hits the BFF's gateway-down 503; the
    // wrapper reopens with backoff. A reopen replays the session's block log
    // (no Last-Event-ID on a fresh source) and merge() upserts by id, so
    // blocks missed during a gateway restart backfill on their own.
    const stream = openResilientEventSource(`/api/runtime/chat/${sessionId}/stream`, {
      attach: (source) => {
        source.addEventListener("chat_block", (event) => {
          const messageEvent = event as MessageEvent;
          try {
            const block = JSON.parse(messageEvent.data) as ChatBlock;
            merge(block);
          } catch {
            // A malformed frame shouldn't kill the stream — ignore and
            // wait for the next one.
          }
        });
        // The session record (full ChatSessionRecord) is sent on connect and
        // re-sent after every mutation, including queue changes. Track its
        // `pendingMessages` so the "N Queued" pill stays live as messages are
        // enqueued, drained one-per-turn, or removed — no client dispatch
        // logic, the server is the source of truth (ADR chat-message-queue.md).
        source.addEventListener("chat_session", (event) => {
          const messageEvent = event as MessageEvent;
          if (cancelled || activeSessionRef.current !== sessionId) return;
          try {
            const session = JSON.parse(messageEvent.data) as { pendingMessages?: PendingChatMessage[] };
            setPendingMessages(session.pendingMessages ?? []);
          } catch {
            // Ignore a malformed frame; the next one will land.
          }
        });
      }
    });
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [sessionId]);

  // Poll while a task is in flight. The EventSource auto-reconnect is the
  // primary path; this is the safety net for a half-open/zombie stream
  // (readyState stays OPEN so onerror never fires) that drops the
  // terminal frame and strands the UI on "Thinking". 3s matches the
  // session-list / agent-chat cadence; clears once terminal or the
  // session changes.
  const active = useMemo(() => anyConversationInFlight(blocks), [blocks]);
  useEffect(() => {
    if (!sessionId || !active) return;
    const id = setInterval(refetch, 3000);
    return () => clearInterval(id);
  }, [sessionId, active, refetch]);

  // Recover on tab focus / visibility regained. A backgrounded tab (e.g.
  // during screensharing) is exactly where the SSE goes zombie; refetch
  // on return reconciles immediately rather than waiting for the next
  // poll tick.
  useEffect(() => {
    if (!sessionId) return;
    const onVis = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", refetch);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", refetch);
    };
  }, [sessionId, refetch]);

  return { blocks, isLoading, error, refetch, pendingMessages };
}

// True when the main chat OR any thread has a non-terminal tail. The flat
// block list interleaves thread blocks in the same ordinal stream, so a
// single tail-scan would conflate conversations — a thread's terminal
// phase landing last would mask a still-running main turn (and vice
// versa). Evaluate each conversation slice independently and OR them.
export function anyConversationInFlight(blocks: ChatBlock[]): boolean {
  const { main, byThread } = splitBlocks(blocks);
  if (latestInFlightTaskId(main) !== null) return true;
  for (const threadBlocks of byThread.values()) {
    if (latestInFlightTaskId(threadBlocks) !== null) return true;
  }
  return false;
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

    // Same resilient transport as useChatBlocks — survives the gateway-down
    // 503 that permanently closes a bare EventSource.
    const stream = openResilientEventSource(`/api/runtime/chat/${sessionId}/stream`, {
      attach: (source) => {
        source.addEventListener("chat_block", (event) => {
          const messageEvent = event as MessageEvent;
          try {
            merge(JSON.parse(messageEvent.data) as ChatBlock);
          } catch {
            // Ignore a malformed frame; the next one will land.
          }
        });
      }
    });
    return () => {
      cancelled = true;
      stream.close();
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
        body: JSON.stringify({ ...input, client: "web" })
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

// Remove a single queued (pending) chat message (ADR chat-message-queue.md).
// The DELETE publishes a fresh `chat_session` frame, so the pill updates live
// through useChatBlocks; this mutation only fires the request and surfaces a
// toast on failure.
export function useRemovePendingChatMessage(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ removed: boolean }, Error, string>({
    mutationFn: (pendingId: string) =>
      api<{ removed: boolean }>(`/chat/${sessionId}/pending/${pendingId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
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
