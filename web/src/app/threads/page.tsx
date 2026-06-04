"use client";

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThreadCard } from "@/components/chat/ThreadCard";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { useThreadsInbox } from "@/lib/queries";
import { useThreadReadState } from "@/lib/use-chat-read-state";
import type { ThreadSummary } from "@/lib/view-types";

type Filter = "all" | "unread";

// Cross-agent Threads inbox — design `nhSyP` / `hZ6Q0` / `L6r3M`. A filter
// toolbar (All / Unread segmented control + "Mark all read") over a list of
// Thread Cards aggregated across every agent. Unread is computed client-side
// from per-thread read-state. The "You're all caught up" empty state shows
// when Unread has nothing.
export default function ThreadsInboxPage() {
  const inbox = useThreadsInbox();
  const threads = useMemo(() => inbox.data ?? [], [inbox.data]);
  const { isThreadUnread, markThreadRead, markAllThreadsRead } = useThreadReadState(inbox.data);
  const [filter, setFilter] = useState<Filter>("all");
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null);

  // Mark the open thread read using the live summary, so a reply that lands
  // while the panel is open clears too instead of re-flagging it as unread.
  useEffect(() => {
    if (!openThread) return;
    const live = threads.find((t) => t.threadId === openThread.threadId) ?? openThread;
    markThreadRead(live);
  }, [openThread, threads, markThreadRead]);

  const visible = useMemo(
    () => (filter === "unread" ? threads.filter((t) => isThreadUnread(t)) : threads),
    [threads, filter, isThreadUnread]
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0B0B0E]">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-4 border-b border-[#1C1C1E] px-10 py-5">
          <h1 className="text-[19px] font-bold text-foreground">Threads</h1>
          <span className="text-[13px] font-medium text-muted-foreground">
            Replies across all your agents
          </span>
        </header>

        <div className="flex shrink-0 items-center justify-between border-b border-[#1C1C1E] px-10 py-3">
          <div className="flex items-center gap-0.5 rounded-lg border border-[#1F1F24] bg-[#141418] p-0.5">
            {(["all", "unread"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-md px-3.5 py-1.5 text-[13px] font-semibold capitalize transition-colors",
                  filter === value
                    ? "border border-[#33333B] bg-[#26262C] text-foreground"
                    : "text-[#9A9AA0] hover:text-foreground"
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => markAllThreadsRead(threads)}
            className="flex items-center gap-1.5 text-[13px] font-medium text-[#9A9AA0] hover:text-foreground"
          >
            <Check className="size-3.5" />
            Mark all read
          </button>
        </div>

        {visible.length === 0 ? (
          <EmptyState filter={filter} onBrowseAll={() => setFilter("all")} />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul>
              {visible.map((thread) => (
                <li key={thread.threadId}>
                  <ThreadCard
                    thread={thread}
                    isUnread={isThreadUnread(thread)}
                    onOpen={() => setOpenThread(thread)}
                  />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </section>

      {openThread ? (
        <ThreadPanel
          sessionId={openThread.sessionId}
          thread={openThread}
          agentName={openThread.agentName ?? "Agent"}
          onClose={() => setOpenThread(null)}
        />
      ) : null}
    </div>
  );
}

function EmptyState({ filter, onBrowseAll }: { filter: Filter; onBrowseAll: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-7 p-10 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl border border-[#1F1F24] bg-[#141418]">
        <Check className="size-7 text-[#9A9AA0]" />
      </div>
      <div className="flex flex-col gap-2.5">
        <h2 className="text-[22px] font-semibold text-[#ECECEE]">You&apos;re all caught up</h2>
        <p className="text-sm font-medium text-[#6A6A70]">
          You have no unread thread replies right now.
        </p>
      </div>
      {filter === "unread" ? (
        <button
          type="button"
          onClick={onBrowseAll}
          className="rounded-lg border border-[#1F1F24] px-4 py-2 text-[13px] font-semibold text-[#C2C2C8] hover:bg-white/5"
        >
          Browse all threads
        </button>
      ) : null}
    </div>
  );
}
