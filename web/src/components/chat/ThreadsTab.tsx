"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadSummary } from "@/lib/view-types";
import { useThreadReadState } from "@/lib/use-chat-read-state";
import { ThreadCard } from "./ThreadCard";

// Per-agent Threads tab. Lists this agent's threads (newest activity first)
// as Thread Cards; clicking a card opens the side panel. Read-state drives the
// NEW badge — same per-thread localStorage store as the global inbox.
export function ThreadsTab({
  threads,
  agentName,
  onOpen
}: {
  threads: ThreadSummary[];
  agentName: string;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const { isThreadUnread } = useThreadReadState(threads);
  const ordered = [...threads].sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt));

  if (ordered.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <p className="text-[15px] font-semibold text-foreground">No threads yet</p>
        <p className="text-sm text-muted-foreground">
          Replies to {agentName}&apos;s messages branch into threads here.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul>
        {ordered.map((thread) => (
          <li key={thread.threadId}>
            <ThreadCard
              thread={{ ...thread, agentName: thread.agentName ?? agentName }}
              isUnread={isThreadUnread(thread)}
              onOpen={() => onOpen(thread)}
            />
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
