"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { ChatBlock } from "@runtime/types";
import type { UploadRef } from "@/lib/api";
import {
  latestInFlightTaskId,
  useCancelTask,
  useChatBlocks,
  useReplyToThread,
  useThread
} from "@/lib/queries";
import { groupExchanges, type ChatRenderItem } from "@/lib/group-exchanges";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
import type { ThreadSummary } from "@/lib/view-types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AgentAvatar } from "./AgentAvatar";
import { BlockRenderer } from "./BlockRenderer";
import { BlockToolCallsCollapsed } from "./BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "./GeneratedFilesCard";
import { Composer } from "./Composer";

// Phase labels treated as terminal — a thread reply is still in flight while
// the latest phase block is non-terminal (mirrors the chat page logic).
const TERMINAL_PHASE_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

// Slack-style thread side-panel — design `D7N4b`. 440px right drawer:
//   - header: "Thread" + "<agent> · <root preview>" + close
//   - body: the thread's blocks, grouped through the SAME renderer as the
//     main chat (tool calls collapse, files card, etc. all preserved)
//   - footer: "Reply in thread…" composer posting via useReplyToThread
export function ThreadPanel({
  sessionId,
  thread,
  agentName,
  agent,
  onClose
}: {
  sessionId: string;
  thread: ThreadSummary;
  agentName: string;
  agent?: { id: string; name: string };
  onClose: () => void;
}) {
  const { blocks, isLoading } = useThread(sessionId, thread.threadId);
  // Resolve the full parent block from the session's block stream so the
  // thread's root renders identically to a real chat message. This shares the
  // chat surface's query (react-query dedupes by key); for an inbox-opened
  // panel it loads the parent's session to find the block.
  const { blocks: sessionBlocks } = useChatBlocks(sessionId);
  const parentBlock = sessionBlocks.find((b) => b.id === thread.parentBlockId);
  const reply = useReplyToThread(sessionId, thread.threadId);
  const cancel = useCancelTask();
  const [text, setText] = useState("");
  // Snap to the latest reply instantly when the panel opens (the inbox reuses
  // one panel across threads, so key on threadId to re-arm per thread); follow
  // smoothly as new reply blocks arrive. Gate on having reply blocks: the
  // panel mounts empty while the thread loads, and snapping then would burn the
  // instant-snap latch before the replies are laid out, leaving the real
  // content to animate in.
  const endRef = useStickToBottom(blocks.length, {
    key: thread.threadId,
    enabled: blocks.length > 0
  });

  const visibleBlocks = useMemo(
    () =>
      blocks.filter((b, i) => {
        if (b.kind !== "phase") return true;
        const isLast = i === blocks.length - 1;
        return isLast && !TERMINAL_PHASE_LABELS.has(b.label);
      }),
    [blocks]
  );

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, ChatBlock & { kind: "tool_result" }>();
    for (const b of blocks) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [blocks]);

  const renderItems = useMemo<ChatRenderItem[]>(() => groupExchanges(visibleBlocks), [visibleBlocks]);

  // In-flight detection over the thread's block stream — mirrors the main
  // chat. Yields the running turn's task id so the composer's stop button can
  // cancel it; null when the thread is quiescent.
  const inflightTaskId = useMemo(() => latestInFlightTaskId(blocks), [blocks]);

  const submit = (images: UploadRef[]) => {
    const trimmed = text.trim();
    if (reply.isPending) return;
    if (!trimmed && images.length === 0) return;
    reply.mutate(
      {
        content: trimmed,
        // Carry the thread's parent on every reply. On a brand-new thread (no
        // blocks yet) the backend needs it to root the thread; on an existing
        // thread it's inherited from the blocks and ignored.
        ...(thread.parentBlockId ? { parentBlockId: thread.parentBlockId } : {}),
        ...(images.length > 0 ? { images } : {})
      },
      {
        onSuccess: () => setText(""),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l border-border bg-background md:w-[440px]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-[18px] py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-bold text-foreground">Thread</span>
          <span className="truncate text-[12px] font-medium text-muted-foreground">
            {thread.rootAuthor === "user" ? "You" : agentName}
            {thread.rootPreview ? ` · ${thread.rootPreview}` : ""}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close thread"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[18px]" />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-[18px]">
          {/* Parent message — the thread's root, always shown at the top.
              Rendered through the same BlockRenderer as the main chat so it
              carries the real author (agent message, or the human's "You"
              message for an agent-started thread). Falls back to a minimal
              bubble — author-matched via rootAuthor — while blocks load. */}
          {parentBlock ? (
            <BlockRenderer block={parentBlock} agent={agent} />
          ) : thread.rootPreview ? (
            thread.rootAuthor === "user" ? (
              <div className="flex flex-col items-end gap-1">
                <span className="pr-1 text-xs font-semibold text-foreground">You</span>
                <div className="ml-auto max-w-[80%] rounded-xl bg-secondary px-3 py-2.5 text-[13px] text-secondary-foreground dark:bg-primary dark:text-primary-foreground">
                  {thread.rootPreview}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5">
                <AgentAvatar name={agentName} seed={agent?.id ?? agentName} size={24} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 pl-1 pb-1 text-xs">
                    <span className="font-semibold text-foreground">{agentName}</span>
                  </div>
                  <div className="max-w-[90%] rounded-xl bg-card px-3 py-2.5 text-[13px] text-foreground">
                    {thread.rootPreview}
                  </div>
                </div>
              </div>
            )
          ) : null}

          {/* Replies divider — frames the reply section even with 0 replies. */}
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-muted-foreground">Replies</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {isLoading && blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : renderItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No replies yet.</p>
          ) : (
            <ul className="space-y-4">
              {renderItems.map((item) => {
                if (item.kind === "tool_group") {
                  return (
                    <li key={item.id}>
                      <BlockToolCallsCollapsed calls={item.calls} steps={item.steps} resultsByCallId={toolResultsByCallId} />
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
                return (
                  <li key={item.block.id}>
                    <BlockRenderer
                      block={item.block}
                      toolResult={
                        item.block.kind === "tool_call"
                          ? toolResultsByCallId.get(item.block.callId)
                          : undefined
                      }
                      agent={agent}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-border px-4 py-3.5">
        <Composer
          value={text}
          onChange={setText}
          onSubmit={submit}
          busy={Boolean(inflightTaskId) || reply.isPending}
          onStop={() => {
            if (inflightTaskId) {
              cancel.mutate(inflightTaskId, {
                onError: (error) => toast.error(error.message)
              });
            }
          }}
          placeholder="Reply in thread…"
        />
      </div>
    </aside>
  );
}
