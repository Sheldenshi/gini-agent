"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { ChatBlock } from "@runtime/types";
import type { UploadRef } from "@/lib/api";
import { useReplyToThread, useThread } from "@/lib/queries";
import { groupExchanges, type ChatRenderItem } from "@/lib/group-exchanges";
import type { ThreadSummary } from "@/lib/view-types";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  const reply = useReplyToThread(sessionId, thread.threadId);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [blocks.length, thread.threadId]);

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

  const inflight = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "phase") return !TERMINAL_PHASE_LABELS.has(b.label);
      if (b.kind === "tool_call" && b.status === "running") return true;
    }
    return false;
  }, [blocks]);

  const submit = (images: UploadRef[]) => {
    const trimmed = text.trim();
    if (reply.isPending) return;
    if (!trimmed && images.length === 0) return;
    reply.mutate(
      { content: trimmed, ...(images.length > 0 ? { images } : {}) },
      {
        onSuccess: () => setText(""),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l border-[#1C1C1E] bg-[#0E0E11] md:w-[440px]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1C1C1E] px-[18px] py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-bold text-foreground">Thread</span>
          <span className="truncate text-[12px] font-medium text-[#7A7A80]">
            {agentName}
            {thread.rootPreview ? ` · ${thread.rootPreview}` : ""}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close thread"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded text-[#8A8A90] hover:bg-white/5 hover:text-foreground"
        >
          <X className="size-[18px]" />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-[18px]">
          {isLoading && blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : renderItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No replies yet — start the thread.</p>
          ) : (
            <ul className="space-y-4">
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

      <div className="shrink-0 border-t border-[#1C1C1E] px-4 py-3.5">
        <Composer
          value={text}
          onChange={setText}
          onSubmit={submit}
          busy={inflight || reply.isPending}
          placeholder="Reply in thread…"
        />
      </div>
    </aside>
  );
}
