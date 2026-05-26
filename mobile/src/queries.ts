import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import EventSource from "react-native-sse";
import { api, ApiError, resolveStreamEndpoint } from "./api";
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
// chat detail screen drives its composer busy state off this — block
// deltas now arrive over SSE, so the signal updates as soon as the
// gateway emits, without any polling cadence in the loop.
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
//     means we're paused on the user — the composer stays busy until
//     the eventual approve/deny flip arrives on the stream.
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

// ChatBlock consumer for the detail screen. Combines a one-shot /blocks
// fetch (seeds the initial render and gives us a Last-Event-ID cursor)
// with an SSE subscription to /stream for live updates.
//
// Trust + lifecycle model (4-6 lines per CLAUDE.md):
//   - Bearer token is read from the in-memory credential cache on every
//     EventSource open via resolveStreamEndpoint; a 401 from the initial
//     /blocks fetch surfaces as ApiError so the screen's redirect-to-setup
//     effect still fires.
//   - react-native-sse retransmits Last-Event-ID on its own polling-based
//     reconnect, and the gateway honors it via listChatBlocksAfter — the
//     client never has to track a cursor manually.
//   - AppState 'background' tears the connection down so an idle device
//     doesn't hold an open XHR; 'active' rebuilds it and the same
//     Last-Event-ID path replays only what was missed.
//
// Returns the typed block list directly — no derivation, no normalization;
// the renderer is exhaustive over the discriminated union. The return
// shape matches the previous React Query result the screen relied on
// ({ data, isPending, error }) so the consumer doesn't change.
export function useChatBlocks(sessionId: string | null): {
  data: ChatBlock[] | undefined;
  isPending: boolean;
  error: Error | null;
} {
  const [data, setData] = useState<ChatBlock[] | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState<boolean>(Boolean(sessionId));

  // Latest setters live in refs so the long-lived effect closures (SSE
  // listeners, AppState subscription) don't get torn down on every state
  // update. Without this, every block delta would unsubscribe and
  // reopen the EventSource, defeating the point of streaming.
  const dataRef = useRef<ChatBlock[] | undefined>(undefined);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Tracks the id of the most recent block observed so we can carry
  // Last-Event-ID across every EventSource reconstruction — react-native-sse
  // tracks its own lastEventId per instance, but a fresh `new EventSource()`
  // after AppState transitions, error-driven reopen, or initial connect
  // starts blank. Passing the header explicitly lets the gateway's
  // listChatBlocksAfter replay only what was missed. The SSE wire id is
  // the same string the server assigns as the block id, so we update this
  // wherever we mutate dataRef.
  const lastSeenIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset unconditionally before branching so a sessionId change
    // (chat A → chat B) doesn't leave chat A's blocks rendered until
    // chat B's seed resolves. The previous effect's cleanup tears down
    // the old subscription; this clears the view so the next paint
    // doesn't briefly mix the two chats' contents.
    setData(undefined);
    setError(null);
    setIsPending(Boolean(sessionId));
    dataRef.current = undefined;
    lastSeenIdRef.current = null;

    if (!sessionId) return;

    let cancelled = false;
    let seeded = false;
    let es: EventSource<"chat_block"> | null = null;
    let appStateSub: { remove(): void } | null = null;

    // Merge a single block into the list. assistant_text streams in as
    // repeated frames with the same id and a growing `text` payload; we
    // upsert by id so the final list contains one entry per block, with
    // the latest payload. Other kinds also upsert (tool_call status
    // flips reuse the call's block id, etc.) — see chat-block-protocol.md.
    const upsert = (block: ChatBlock): void => {
      const current = dataRef.current ?? [];
      const idx = current.findIndex((b) => b.id === block.id);
      const next =
        idx >= 0
          ? current.map((b, i) => (i === idx ? block : b))
          : [...current, block];
      dataRef.current = next;
      // The SSE wire id matches the block id, so updating the resume
      // cursor on every event keeps the cursor pinned to the latest
      // delivered frame — even for upsert-style mutations.
      lastSeenIdRef.current = block.id;
      setData(next);
    };

    const openStream = (): void => {
      if (cancelled || es) return;
      let endpoint: { url: string; headers: Record<string, string> };
      try {
        endpoint = resolveStreamEndpoint(`/chat/${sessionId}/stream`);
      } catch (err) {
        if (!cancelled) setError(err as Error);
        return;
      }
      // Build a fresh header set per open so a Last-Event-ID accumulated
      // by upsert() or the seed handler rides along on every new XHR.
      // react-native-sse keeps the header for as long as the instance
      // lives; reconstruction (AppState toggle, error reopen, sessionId
      // change) is exactly when the cursor would otherwise reset.
      const headers: Record<string, string> = { ...endpoint.headers };
      if (lastSeenIdRef.current) {
        headers["Last-Event-ID"] = lastSeenIdRef.current;
      }
      const source = new EventSource<"chat_block">(endpoint.url, {
        headers,
        // 0 disables auto-reconnect; we want it on. The library default
        // (5000ms) is fine — a longer gap means slower recovery from a
        // tunnel restart but doesn't lose data thanks to Last-Event-ID.
        pollingInterval: 5000
      });
      source.addEventListener("chat_block", (ev) => {
        if (cancelled) return;
        if (!ev.data) return;
        try {
          const block = JSON.parse(ev.data) as ChatBlock;
          upsert(block);
        } catch {
          // Drop malformed frames; the server controls this format and a
          // parse failure here is a wire-protocol bug, not a user one.
        }
      });
      source.addEventListener("error", (ev) => {
        if (cancelled) return;
        // 401 means our bearer token was rejected — the library will
        // happily keep retrying with the same dead token, so we surface
        // it to the screen (which already routes 401s to the setup flow)
        // and tear the connection down. Other errors are transient
        // network blips; let the library reconnect on its polling
        // interval, where Last-Event-ID will resume the stream.
        if (ev.type === "error" && "xhrStatus" in ev && ev.xhrStatus === 401) {
          setError(new ApiError(401, "Unauthorized"));
          closeStream();
        }
      });
      es = source;
    };

    const closeStream = (): void => {
      if (es) {
        es.removeAllEventListeners();
        es.close();
        es = null;
      }
    };

    // Gated open: we must never spin up an EventSource before the seed
    // has resolved (so the seed merge sees an authoritative baseline) or
    // while the app is backgrounded (iOS will tear the XHR down anyway).
    // The AppState callback and the seed completion both route through
    // here so neither path can race past the other.
    const maybeOpenStream = (): void => {
      if (!seeded) return;
      if (cancelled) return;
      if (es) return;
      if (AppState.currentState !== "active") return;
      openStream();
    };

    // Seed the list before opening the stream so the chat renders with
    // its persisted history immediately. After seeding, the EventSource
    // sends Last-Event-ID = <most-recent-block-id> on its first connect
    // (by way of the message replay path the library already implements)
    // — but on the very first open the library has no cursor, so the
    // gateway will replay backfill via listChatBlocksAfter(null) which
    // resolves to the full list. The seen-id dedup in upsert() collapses
    // those into the same row.
    (async () => {
      try {
        const blocks = await api<ChatBlock[]>(`/chat/${sessionId}/blocks`);
        if (cancelled) return;
        // Merge by id rather than overwrite. If the AppState handler or
        // any other path opened a stream while the seed was in flight,
        // dataRef may already hold deltas that arrived ahead of the
        // /blocks response; overwriting would drop them. Seeded rows
        // win for their own ids; any extra ids already in dataRef are
        // preserved at the tail.
        const existing = dataRef.current ?? [];
        const seededIds = new Set(blocks.map((b) => b.id));
        const merged: ChatBlock[] = [
          ...blocks,
          ...existing.filter((b) => !seededIds.has(b.id))
        ];
        dataRef.current = merged;
        // Seed the resume cursor so the very first SSE open skips
        // the redundant full replay listChatBlocksAfter(null) emits.
        lastSeenIdRef.current = merged[merged.length - 1]?.id ?? null;
        setData(merged);
        setError(null);
        setIsPending(false);
        seeded = true;
        maybeOpenStream();
      } catch (err) {
        if (cancelled) return;
        setError(err as Error);
        setIsPending(false);
        // Don't open the stream on a 401 — the screen redirects to setup.
        if (!(err instanceof ApiError && err.status === 401)) {
          // Mark as seeded even on transport failure so a foregrounding
          // user can retry via the AppState handler; the gateway will
          // backfill via listChatBlocksAfter(null) on first connect.
          seeded = true;
          maybeOpenStream();
        }
      }
    })();

    // AppState: drop the connection in background, reopen on foreground.
    // iOS may keep the XHR alive briefly after backgrounding, but the OS
    // can suspend it at any time without notifying the JS layer; tearing
    // down explicitly avoids holding a half-dead socket that doesn't
    // resume cleanly on return.
    const onAppState = (state: AppStateStatus): void => {
      if (cancelled) return;
      if (state === "active") {
        maybeOpenStream();
      } else if (state === "background" || state === "inactive") {
        closeStream();
      }
    };
    appStateSub = AppState.addEventListener("change", onAppState);

    return () => {
      cancelled = true;
      closeStream();
      if (appStateSub) appStateSub.remove();
    };
  }, [sessionId]);

  return { data, isPending, error };
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
      // useChatBlocks is now SSE-driven, so the new user_text + assistant
      // blocks arrive without an explicit invalidation. We still bump the
      // legacy session query (used by older list affordances) and the
      // sidebar chat list so titles + previews refresh promptly.
      qc.invalidateQueries({ queryKey: ["chat", sessionId] });
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
