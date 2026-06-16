"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BlockRenderer } from "@/components/chat/BlockRenderer";
import { BlockToolCallsCollapsed } from "@/components/chat/BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "@/components/chat/GeneratedFilesCard";
import { Composer } from "@/components/chat/Composer";
import { QueuedMessages } from "@/components/chat/QueuedMessages";
import { AgentChatHeader } from "@/components/chat/AgentChatHeader";
import { ChannelViewJob } from "@/components/chat/ChannelViewJob";
import { ChatSearchBox } from "@/components/chat/ChatSearchBox";
import { ChatTabBar, type ChatTab } from "@/components/chat/ChatTabBar";
import { ThreadChip } from "@/components/chat/ThreadChip";
import { ReplyInThreadButton } from "@/components/chat/ReplyInThreadButton";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { ThreadsTab, aggregateActivity } from "@/components/chat/ThreadsTab";
import { JobsTab } from "@/components/chat/JobsTab";
import { SettingsTab } from "@/components/chat/SettingsTab";
import { api, type UploadRef } from "@/lib/api";
import { useChatReadState, useThreadReadState } from "@/lib/use-chat-read-state";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
import { groupExchanges, type ChatRenderItem } from "@/lib/group-exchanges";
import {
  latestInFlightTaskId,
  splitBlocks,
  TERMINAL_PHASE_LABELS,
  useAgentChat,
  useAllChatSessions,
  useAllJobs,
  useCancelTask,
  useChatBlocks,
  useChatSessions,
  useInvalidate,
  useRemovePendingChatMessage,
  useStatus,
  useThreads
} from "@/lib/queries";
import type { ChatBlock } from "@runtime/types";
import type { ChatSession, ThreadSummary } from "@/lib/view-types";

export default function ChatPage() {
  const params = useSearchParams();
  // ?session= deep-links open a specific session (a recurring-job channel
  // from the sidebar, or an agent-chat link from Home/Tasks). Without it, the
  // surface is the active agent's single canonical chat.
  const pinnedSessionId = params?.get("session") ?? null;

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const activeAgentName = status.data?.activeAgent?.name ?? "Gini";

  const agentChat = useAgentChat(pinnedSessionId ? null : activeAgentId);
  const pinnedSession = useChannelSession(pinnedSessionId);

  const session: ChatSession | undefined = pinnedSessionId ? pinnedSession : agentChat.data;
  const sessionId = session?.id ?? null;
  // A pinned session is a "channel" surface only when it's a recurring-job
  // channel; a pinned agent-chat link still renders as the agent surface.
  const isChannel = Boolean(
    pinnedSessionId && (session?.kind === "channel" || session?.origin === "job")
  );

  const headerName = isChannel ? session?.title?.trim() || "Channel" : activeAgentName;
  const headerSeed = isChannel ? sessionId ?? "channel" : activeAgentId ?? "agent";
  // The agent whose messages render in the transcript. On the agent surface
  // this is the active agent; on a channel the assistant is the session's
  // owning agent (named "Gini" by default since the channel title isn't the
  // agent's name). Keys the colored-initial message-row avatar.
  const messageAgent = isChannel
    ? session?.agentId
      ? { id: session.agentId, name: "Gini" }
      : undefined
    : activeAgentId
      ? { id: activeAgentId, name: activeAgentName }
      : undefined;
  const resolving = !sessionId && (pinnedSessionId ? !pinnedSession : agentChat.isLoading);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      {!sessionId ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AgentChatHeader name={headerName} seed={headerSeed} showAvatar={!isChannel} />
          <ChatTabBar active="messages" onChange={() => {}} hideJobsTab={isChannel} hideSettingsTab={Boolean(pinnedSessionId)} />
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {resolving ? "Loading…" : "No chat yet — say hello below."}
          </div>
        </section>
      ) : (
        // Key on sessionId so all transient view state (active tab, open
        // thread, composer draft) resets cleanly when the user switches agents
        // or opens a channel — no reset effect needed.
        <ChatSurface
          key={sessionId}
          sessionId={sessionId}
          session={session!}
          headerName={headerName}
          headerSeed={headerSeed}
          isChannel={isChannel}
          isPinned={Boolean(pinnedSessionId)}
          messageAgent={messageAgent}
          activeAgentId={activeAgentId}
        />
      )}
    </div>
  );
}

function ChatSurface({
  sessionId,
  session,
  headerName,
  headerSeed,
  isChannel,
  isPinned,
  messageAgent,
  activeAgentId
}: {
  sessionId: string;
  session: ChatSession;
  headerName: string;
  headerSeed: string;
  isChannel: boolean;
  isPinned: boolean;
  messageAgent?: { id: string; name: string };
  activeAgentId?: string;
}) {
  const [tab, setTab] = useState<ChatTab>("messages");
  // Fall back to Messages if the active tab becomes hidden without a remount.
  // ChatSurface is keyed by sessionId, so pinning the *same* session you're
  // viewing (e.g. opening its own ?session= link) flips isPinned true in place —
  // which hides Settings while `tab` could still be "settings". Reset so a
  // hidden tab's body can't linger.
  useEffect(() => {
    if (isPinned && tab === "settings") setTab("messages");
  }, [isPinned, tab]);
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null);
  const [text, setText] = useState("");
  // In-chat search: client-side find over the loaded transcript. `query` is the
  // raw input; `activeMatch` indexes into the matched-block list below.
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const invalidate = useInvalidate();

  // On a channel, resolve the originating job by its linked chat session so the
  // header can offer a "Back to job" link. The session carries no jobId, so we
  // match `job.chatSessionId === sessionId` against the unscoped jobs list.
  const allJobs = useAllJobs();
  const job = useMemo(
    () =>
      isChannel ? (allJobs.data ?? []).find((j) => j.chatSessionId === sessionId) : undefined,
    [allJobs.data, isChannel, sessionId]
  );

  const { blocks, isLoading: blocksLoading, refetch, pendingMessages } = useChatBlocks(
    sessionId,
    session.pendingMessages
  );
  const threadsQuery = useThreads(sessionId);
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);
  const { markThreadRead, isThreadUnread } = useThreadReadState(threads);
  // The Threads tab badge mirrors the sidebar nav badge: it counts UNREAD
  // threads (and the pill hides at 0), not the total thread count.
  const unreadThreadCount = threads.filter((t) => isThreadUnread(t)).length;
  // Dot the Threads tab while any thread's run is in flight so activity is
  // visible from the Messages tab without switching over. aggregateActivity
  // shares the sort's ranking, so a run waiting on the user (the actionable
  // state) outranks a running one here exactly as it does in list order.
  const threadsActivity = aggregateActivity(threads);

  const sessionsQuery = useChatSessions();
  const { markRead, activityAt } = useChatReadState(sessionsQuery.data);
  // Mark read using the LIST session (it carries `runs`) so the stored
  // timestamp matches what the sidebar's isUnread compares against. The prop
  // session (sourced from the unscoped list) covers the gap while the scoped
  // list resolves — and is the steady state for channels owned by a
  // non-active agent, which the scoped list never contains.
  const liveSession =
    (sessionsQuery.data ?? []).find((s) => s.id === sessionId) ?? session;
  const liveActivityAt = activityAt(liveSession);
  useEffect(() => {
    markRead(liveSession);
    // Re-mark when activity advances while the chat is open (a task finishes
    // or a job run lands) so it doesn't flip back to unread under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, liveActivityAt, markRead]);

  // Mark the open thread read using the live summary, so a reply that lands
  // while the panel is open clears too instead of re-flagging it as unread.
  useEffect(() => {
    if (!openThread) return;
    const live = threads.find((t) => t.threadId === openThread.threadId) ?? openThread;
    markThreadRead(live);
  }, [openThread, threads, markThreadRead]);

  // Main chat = blocks with no threadId; thread blocks render in the panel.
  const mainBlocks = useMemo(() => splitBlocks(blocks).main, [blocks]);

  // Map a thread's parent block id → its summary, so the chip renders
  // directly under the message it branched from. When several threads share
  // one parent, keep the one with the newest reply so the freshest
  // conversation is the one surfaced by the single chip.
  const threadByParent = useMemo(() => {
    const map = new Map<string, ThreadSummary>();
    for (const t of threads) {
      if (!t.parentBlockId) continue;
      const existing = map.get(t.parentBlockId);
      if (!existing || t.lastReplyAt > existing.lastReplyAt) map.set(t.parentBlockId, t);
    }
    return map;
  }, [threads]);

  // Run-now responses carry { taskId }; enqueued ones carry { queued, pendingId }.
  // The server decides which based on whether a turn is already in flight; the
  // client treats both as success (the pill / transcript update via SSE).
  const send = useMutation({
    mutationFn: ({ content, images }: { content: string; images: UploadRef[] }) =>
      api<{ taskId?: string; queued?: boolean; pendingId?: string }>(`/chat/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, client: "web", ...(images.length > 0 ? { images } : {}) })
      }),
    onSuccess: () => {
      setText("");
      invalidate(["chat", "tasks", "threads"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cancel = useCancelTask();
  const removePending = useRemovePendingChatMessage(sessionId);

  const submit = (images: UploadRef[]) => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // Don't gate on send.isPending: successive Enters while a turn runs must
    // each POST so they queue in order. The server serializes (run-vs-queue),
    // so concurrent POSTs are safe.
    send.mutate({ content: trimmed, images });
  };

  // In-flight detection over the main-chat block stream.
  const inflightTaskId: string | null = useMemo(
    () => latestInFlightTaskId(mainBlocks),
    [mainBlocks]
  );

  // Phase blocks are transient — render only the latest while non-terminal.
  const visibleBlocks = useMemo(
    () =>
      mainBlocks.filter((b, i) => {
        if (b.kind !== "phase") return true;
        const isLast = i === mainBlocks.length - 1;
        return isLast && !TERMINAL_PHASE_LABELS.has(b.label);
      }),
    [mainBlocks]
  );

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, (typeof mainBlocks)[number] & { kind: "tool_result" }>();
    for (const b of mainBlocks) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [mainBlocks]);

  const renderItems = useMemo<ChatRenderItem[]>(() => groupExchanges(visibleBlocks), [visibleBlocks]);
  const hasBlocks = visibleBlocks.length > 0;

  // Pin the transcript to the newest message. Snap instantly when the chat
  // opens or the user returns to the Messages tab (the viewport mounts at the
  // top, so an animated scroll there would be visible); follow smoothly as new
  // blocks arrive mid-turn. Keyed by sessionId so switching agents re-arms the snap.
  const messagesEndRef = useStickToBottom(mainBlocks.length, {
    key: sessionId,
    enabled: tab === "messages" && hasBlocks
  });

  // Block ids whose message text contains the query, in display order. Only
  // the searchable message kinds count (not tool calls / phases / files).
  const matches = useMemo<string[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const ids: string[] = [];
    for (const item of renderItems) {
      if (item.kind !== "block") continue;
      const block = item.block;
      if (
        block.kind !== "user_text" &&
        block.kind !== "assistant_text" &&
        block.kind !== "system_note"
      ) {
        continue;
      }
      if (block.text.toLowerCase().includes(needle)) ids.push(block.id);
    }
    return ids;
  }, [renderItems, query]);
  const matchCount = matches.length;
  const activeMatchId = matchCount > 0 ? matches[Math.min(activeMatch, matchCount - 1)] : undefined;

  // Keep the active index in range as matches change (query edits reset it to
  // 0 at the call site; this guards stream-driven match-set shrinkage).
  useEffect(() => {
    if (activeMatch > 0 && activeMatch >= matchCount) setActiveMatch(matchCount === 0 ? 0 : matchCount - 1);
  }, [matchCount, activeMatch]);

  // Scroll the active match into view when it (or the query) changes.
  useEffect(() => {
    if (!activeMatchId) return;
    document
      .getElementById(`chat-msg-${activeMatchId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatchId]);

  return (
    <>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentChatHeader
          name={headerName}
          seed={headerSeed}
          lastActiveAt={session.updatedAt}
          subtitle={isChannel ? "recurring job channel" : undefined}
          showAvatar={!isChannel}
          titleAction={
            isChannel && job ? (
              <ChannelViewJob jobId={job.id} agentId={job.agentId} activeAgentId={activeAgentId} />
            ) : undefined
          }
          right={
            <ChatSearchBox
              value={query}
              onChange={(q) => {
                setQuery(q);
                setActiveMatch(0);
                if (q && tab !== "messages") setTab("messages");
              }}
              matchCount={matchCount}
              activeIndex={activeMatch}
              onPrev={() => setActiveMatch((i) => (i - 1 + matchCount) % matchCount)}
              onNext={() => setActiveMatch((i) => (i + 1) % matchCount)}
              onClose={() => {
                setQuery("");
                setActiveMatch(0);
              }}
            />
          }
        />
        <ChatTabBar
          active={tab}
          onChange={setTab}
          threadCount={unreadThreadCount}
          threadsActivity={threadsActivity}
          hideJobsTab={isChannel}
          hideSettingsTab={isPinned}
        />

        {tab === "messages" ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-3xl px-6 py-6">
                {blocksLoading && !hasBlocks ? (
                  <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : !hasBlocks ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  <ul className="space-y-5">
                    {renderItems.map((item) => {
                      if (item.kind === "tool_group") {
                        return (
                          <li key={item.id}>
                            <BlockToolCallsCollapsed calls={item.calls} resultsByCallId={toolResultsByCallId} />
                          </li>
                        );
                      }
                      if (item.kind === "file_artifact") {
                        return (
                          <li key={item.id}>
                            <GeneratedFilesCard files={item.files} />
                          </li>
                        );
                      }
                      const block = item.block;
                      // A thread can branch off either the user's message (an
                      // agent-routed turn) or an assistant reply (the user's
                      // own "Reply in thread"), so look up a chip for both.
                      const thread =
                        block.kind === "assistant_text" || block.kind === "user_text"
                          ? threadByParent.get(block.id)
                          : undefined;
                      // An assistant reply with no thread yet gets the always-
                      // visible "Reply in thread" affordance so the user can
                      // branch a new thread off it (Slack-style).
                      const canStartThread =
                        block.kind === "assistant_text" && !block.streaming && !thread;
                      const isMatch = matches.includes(block.id);
                      const isActiveMatch = block.id === activeMatchId;
                      return (
                        <li
                          key={block.id}
                          id={`chat-msg-${block.id}`}
                          className={`space-y-2 transition-colors ${
                            isActiveMatch
                              ? "rounded-lg bg-[#4277FB]/5 ring-2 ring-[#4277FB]/70"
                              : isMatch
                                ? "rounded-lg bg-[#4277FB]/5"
                                : ""
                          }`}
                        >
                          <BlockRenderer
                            block={block}
                            toolResult={
                              block.kind === "tool_call"
                                ? toolResultsByCallId.get(block.callId)
                                : undefined
                            }
                            agent={messageAgent}
                          />
                          {thread ? (
                            // Assistant replies sit in a 46px avatar gutter;
                            // user messages are right-aligned, so align the
                            // chip to the message it branched from.
                            <div className={block.kind === "user_text" ? "flex justify-end" : "pl-[46px]"}>
                              <ThreadChip thread={thread} onOpen={() => setOpenThread(thread)} />
                            </div>
                          ) : canStartThread ? (
                            <div className="pl-[46px]">
                              <ReplyInThreadButton
                                onClick={() => setOpenThread(newThreadFor(sessionId, block))}
                              />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <div className="px-6 pb-5 pt-2">
              <div className="mx-auto w-full max-w-3xl">
                <QueuedMessages
                  sessionId={sessionId}
                  pending={pendingMessages}
                  onRemove={(pendingId) =>
                    removePending.mutate(pendingId, {
                      onError: (error) => toast.error(error.message)
                    })
                  }
                />
                <Composer
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  busy={Boolean(inflightTaskId) || send.isPending}
                  onStop={() => {
                    if (inflightTaskId) {
                      // Reconcile against durable state right away — if a
                      // terminal frame was missed the block list already
                      // holds the terminal phase, so the indicator clears
                      // without waiting on the cancel. Refetch again after
                      // the cancel writes its own Cancelled phase.
                      refetch();
                      cancel.mutate(inflightTaskId, {
                        onSuccess: () => refetch(),
                        onError: (error) => toast.error(error.message)
                      });
                    }
                  }}
                  placeholder={`Ask ${headerName} anything`}
                />
              </div>
            </div>
          </>
        ) : tab === "threads" ? (
          <ThreadsTab threads={threads} agentName={headerName} onOpen={(t) => setOpenThread(t)} />
        ) : tab === "jobs" ? (
          <JobsTab />
        ) : tab === "settings" && !isPinned ? (
          // Settings only renders on the active agent's canonical chat. The
          // !isPinned guard (plus the reset effect above) keeps its body from
          // showing on a pinned surface even for a frame, and the exhaustive
          // switch keeps a stray tab value from falling through to it.
          <SettingsTab agentId={activeAgentId} />
        ) : null}
      </section>

      {openThread ? (
        // Key on the thread id so the panel's transient state (composer draft,
        // scroll) starts fresh per thread — no draft leaks across switches.
        <ThreadPanel
          key={openThread.threadId}
          sessionId={sessionId}
          thread={openThread}
          agentName={headerName}
          agent={messageAgent}
          onClose={() => setOpenThread(null)}
        />
      ) : null}
    </>
  );
}

// Build the open-thread descriptor for a brand-new thread the user is
// starting off an assistant message. There's no ThreadSummary yet (no blocks),
// so synthesize one with a fresh threadId and replyCount 0; ThreadPanel renders
// the parent echo + empty replies + composer, and the first reply (carrying
// `parentBlockId`) brings the real thread into existence.
function newThreadFor(
  sessionId: string,
  block: Extract<ChatBlock, { kind: "assistant_text" }>
): ThreadSummary {
  return {
    threadId: crypto.randomUUID(),
    sessionId,
    parentBlockId: block.id,
    rootPreview: block.text,
    replyCount: 0,
    lastReplyAt: block.createdAt
  };
}

// Resolve a pinned session from the unscoped chat list the sidebar fetches —
// channels and agent-chat links live there for every agent, so the lookup
// works even before an active agent is known.
function useChannelSession(sessionId: string | null): ChatSession | undefined {
  const sessions = useAllChatSessions();
  return useMemo(
    () => (sessionId ? (sessions.data ?? []).find((s) => s.id === sessionId) : undefined),
    [sessions.data, sessionId]
  );
}
