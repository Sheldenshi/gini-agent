"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BlockRenderer } from "@/components/chat/BlockRenderer";
import { BlockToolCallsCollapsed } from "@/components/chat/BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "@/components/chat/GeneratedFilesCard";
import { Composer } from "@/components/chat/Composer";
import { AgentChatHeader } from "@/components/chat/AgentChatHeader";
import { ChatTabBar, type ChatTab } from "@/components/chat/ChatTabBar";
import { ThreadChip } from "@/components/chat/ThreadChip";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { ThreadsTab } from "@/components/chat/ThreadsTab";
import { JobsTab } from "@/components/chat/JobsTab";
import { api, type UploadRef } from "@/lib/api";
import { groupExchanges, type ChatRenderItem } from "@/lib/group-exchanges";
import {
  splitBlocks,
  useAgentChat,
  useCancelTask,
  useChatBlocks,
  useChatSessions,
  useInvalidate,
  useStatus,
  useThreads
} from "@/lib/queries";
import type { ChatSession, ThreadSummary } from "@/lib/view-types";

// Phase labels the runtime emits as the final block of a task; a non-terminal
// latest phase means a task is still in flight.
const TERMINAL_PHASE_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

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
  const resolving = !sessionId && (pinnedSessionId ? !pinnedSession : agentChat.isLoading);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0B0B0E]">
      {!sessionId ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AgentChatHeader name={headerName} seed={headerSeed} />
          <ChatTabBar active="messages" onChange={() => {}} />
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
  isChannel
}: {
  sessionId: string;
  session: ChatSession;
  headerName: string;
  headerSeed: string;
  isChannel: boolean;
}) {
  const [tab, setTab] = useState<ChatTab>("messages");
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null);
  const [text, setText] = useState("");
  const invalidate = useInvalidate();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const { blocks, isLoading: blocksLoading } = useChatBlocks(sessionId);
  const threadsQuery = useThreads(sessionId);
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);

  // Main chat = blocks with no threadId; thread blocks render in the panel.
  const mainBlocks = useMemo(() => splitBlocks(blocks).main, [blocks]);

  // Map a thread's parent assistant block id → its summary, so the chip
  // renders directly under the message it branched from.
  const threadByParent = useMemo(() => {
    const map = new Map<string, ThreadSummary>();
    for (const t of threads) {
      if (t.parentBlockId) map.set(t.parentBlockId, t);
    }
    return map;
  }, [threads]);

  const send = useMutation({
    mutationFn: ({ content, images }: { content: string; images: UploadRef[] }) =>
      api<{ taskId: string }>(`/chat/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, ...(images.length > 0 ? { images } : {}) })
      }),
    onSuccess: () => {
      setText("");
      invalidate(["chat", "tasks", "threads"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cancel = useCancelTask();

  useEffect(() => {
    if (tab !== "messages") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [mainBlocks.length, tab]);

  const submit = (images: UploadRef[]) => {
    const trimmed = text.trim();
    if (send.isPending) return;
    if (!trimmed && images.length === 0) return;
    send.mutate({ content: trimmed, images });
  };

  // In-flight detection over the main-chat block stream.
  const inflightTaskId: string | null = useMemo(() => {
    for (let i = mainBlocks.length - 1; i >= 0; i--) {
      const b = mainBlocks[i]!;
      if (b.kind === "phase") {
        if (TERMINAL_PHASE_LABELS.has(b.label)) return null;
        return b.taskId ?? null;
      }
      if (b.kind === "tool_call" && b.status === "running") return b.taskId ?? null;
    }
    return null;
  }, [mainBlocks]);

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

  return (
    <>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentChatHeader
          name={headerName}
          seed={headerSeed}
          lastActiveAt={session.updatedAt}
          subtitle={isChannel ? "recurring job channel" : undefined}
        />
        <ChatTabBar active={tab} onChange={setTab} threadCount={threads.length} />

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
                      const thread =
                        block.kind === "assistant_text" ? threadByParent.get(block.id) : undefined;
                      return (
                        <li key={block.id} className="space-y-2">
                          <BlockRenderer
                            block={block}
                            toolResult={
                              block.kind === "tool_call"
                                ? toolResultsByCallId.get(block.callId)
                                : undefined
                            }
                          />
                          {thread ? (
                            <div className="pl-[46px]">
                              <ThreadChip thread={thread} onOpen={() => setOpenThread(thread)} />
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
                <Composer
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  busy={Boolean(inflightTaskId) || send.isPending}
                  onStop={() => {
                    if (inflightTaskId) {
                      cancel.mutate(inflightTaskId, {
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
        ) : (
          <JobsTab />
        )}
      </section>

      {openThread ? (
        <ThreadPanel
          sessionId={sessionId}
          thread={openThread}
          agentName={headerName}
          onClose={() => setOpenThread(null)}
        />
      ) : null}
    </>
  );
}

// Resolve a pinned session from the cached chat list by id. Channels and
// agent-chat links already live in the list the sidebar fetches, so no extra
// request is needed.
function useChannelSession(sessionId: string | null): ChatSession | undefined {
  const sessions = useChatSessions();
  return useMemo(
    () => (sessionId ? (sessions.data ?? []).find((s) => s.id === sessionId) : undefined),
    [sessions.data, sessionId]
  );
}
