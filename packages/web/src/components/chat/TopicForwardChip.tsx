"use client";

import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { useTopicPanel } from "./TopicPanelContext";

// A forwarded copy of a Topic's final answer lands in the parent Chat tagged
// with the Topic's id + title (ADR chat-topics-tasks-subagents.md). This chip
// renders below that answer text as a subtle sky-accented pill — matching the
// "from <job name>" container in the chat transcript. "View topic →" opens the
// Topic's own conversation in a right-side panel alongside the chat (via the
// TopicPanel context). Outside the chat surface (no provider) it falls back to
// the `?session=` deep link the sidebar uses.
export function TopicForwardChip({
  topicId,
  topicTitle
}: {
  topicId: string;
  topicTitle?: string;
}) {
  const title = topicTitle?.trim() || "topic";
  const panel = useTopicPanel();
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/5 px-3 py-1 text-xs text-muted-foreground">
      <MessagesSquare className="size-3.5 text-sky-500/70" />
      <span>
        from <span className="font-medium text-foreground">#{title}</span>
      </span>
      {panel ? (
        <button
          type="button"
          onClick={() => panel.openTopic(topicId)}
          className="font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          View topic →
        </button>
      ) : (
        <Link
          href={`/chat?session=${topicId}`}
          className="font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          View topic →
        </Link>
      )}
    </div>
  );
}
