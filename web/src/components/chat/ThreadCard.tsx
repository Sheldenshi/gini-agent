"use client";

import { useMemo, useState } from "react";
import type { ChatBlock } from "@runtime/types";
import { useThread } from "@/lib/queries";
import type { ThreadSummary } from "@/lib/view-types";
import { formatRelativeTime, formatMessageTimestamp } from "./relative-time";
import { agentColor } from "@/lib/agent-visuals";
import { MarkdownContent } from "./MarkdownContent";

function previewText(block: ChatBlock): string | null {
  if (block.kind === "user_text") return block.text;
  if (block.kind === "assistant_text") return block.text;
  return null;
}

// One reply row inside an expanded thread card. "You" for user blocks, the
// agent name otherwise — mirroring the design's name + timestamp + text rows.
function ReplyRow({ block, agentName }: { block: ChatBlock; agentName: string }) {
  const text = previewText(block);
  if (text == null) return null;
  const isUser = block.kind === "user_text";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-foreground">{isUser ? "You" : agentName}</span>
        <span className="text-[12px] font-medium text-[#6A6A70]">
          {formatMessageTimestamp(block.createdAt)}
        </span>
      </div>
      {isUser ? (
        <p className="whitespace-pre-wrap text-[13px] font-medium leading-relaxed text-[#C2C2C8]">{text}</p>
      ) : (
        <div className="text-[#C2C2C8]">
          <MarkdownContent text={text} />
        </div>
      )}
    </div>
  );
}

// Cross-agent Thread Card — design `tlViK`. Used in the Threads inbox.
//   - meta: "in <agent chip> · <time> · <N new> badge"
//   - original message: agent name + root preview
//   - expandable: "Show N more replies" loads the thread's blocks
//   - footer: "N replies · Last reply …"
// Clicking the card body opens the full thread panel.
export function ThreadCard({
  thread,
  isUnread,
  onOpen
}: {
  thread: ThreadSummary;
  isUnread: boolean;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentName = thread.agentName ?? "Agent";
  const dotColor = agentColor(thread.agentId ?? agentName);
  const { blocks } = useThread(expanded ? thread.sessionId : null, expanded ? thread.threadId : null);

  // The thread-blocks endpoint returns the thread span (excluding the root
  // main-chat message). Show the most recent two by default once expanded; a
  // future "show all" could lift this, but the design caps the preview.
  const replyBlocks = useMemo(
    () => blocks.filter((b) => previewText(b) != null),
    [blocks]
  );
  const previewReplies = expanded ? replyBlocks.slice(-2) : [];
  const hiddenCount = expanded ? Math.max(0, replyBlocks.length - previewReplies.length) : 0;

  const lastReply = thread.lastReplyAt ? formatRelativeTime(thread.lastReplyAt) : "";

  return (
    <div className="flex flex-col gap-3.5 border-b border-[#1C1C1E] bg-[#0D0E14] px-10 py-5">
      {/* Meta */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-[#6A6A70]">in</span>
        <span className="flex items-center gap-1.5 rounded-md border border-[#1F1F24] bg-[#141418] px-2 py-0.5">
          <span aria-hidden className="size-[7px] rounded-full" style={{ backgroundColor: dotColor }} />
          <span className="font-semibold text-[#C2C2C8]">{agentName}</span>
        </span>
        {thread.lastReplyAt ? (
          <>
            <span className="text-[#3A3A40]">·</span>
            <span className="font-medium text-[#6A6A70]">{formatMessageTimestamp(thread.lastReplyAt)}</span>
          </>
        ) : null}
        {isUnread ? (
          <span className="flex items-center justify-center rounded-lg bg-primary px-1.5 py-px text-[10px] font-bold text-primary-foreground">
            New
          </span>
        ) : null}
      </div>

      {/* Original message (root preview) */}
      <button type="button" onClick={onOpen} className="flex flex-col gap-1.5 text-left">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-foreground">{agentName}</span>
        </div>
        <p className="text-[13px] font-medium leading-relaxed text-[#B6B6BC]">
          {thread.rootPreview || thread.lastReplyPreview || "Thread"}
        </p>
      </button>

      {/* Expand to show replies */}
      {expanded ? (
        <div className="flex flex-col gap-3.5 pl-2">
          {hiddenCount > 0 ? (
            <span className="text-[13px] font-semibold text-[#4277FB]">
              {hiddenCount} more {hiddenCount === 1 ? "reply" : "replies"} above
            </span>
          ) : null}
          {previewReplies.map((b) => (
            <ReplyRow key={b.id} block={b} agentName={agentName} />
          ))}
        </div>
      ) : thread.replyCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-[13px] font-semibold text-[#4277FB] hover:underline"
        >
          Show {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
        </button>
      ) : null}

      {/* Footer */}
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={onOpen}
          className="text-[12px] font-semibold text-[#C2C2C8] hover:underline"
        >
          {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
        </button>
        {lastReply ? (
          <span className="text-[12px] font-medium text-[#6A6A70]">Last reply {lastReply}</span>
        ) : null}
      </div>
    </div>
  );
}
