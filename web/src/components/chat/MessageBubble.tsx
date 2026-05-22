import type { ChatMessage } from "@/lib/view-types";
import type { ToolCallSummary } from "@runtime/types";
import { Avatar } from "./Avatar";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallRow } from "./ToolCallRow";
import { formatMessageTimestamp } from "./relative-time";

export function MessageBubble({
  message,
  isStreaming,
  toolCalls
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  // Tool-call breadcrumbs from this message's task. Rendered above the
  // bubble so the user can see what the agent did to arrive at the
  // answer, even after newer turns push this one up. Empty / undefined
  // hides the section.
  toolCalls?: ToolCallSummary[];
}) {
  const timestamp = formatMessageTimestamp(message.createdAt);
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2 pr-1 text-xs">
          <span className="font-semibold text-foreground">You</span>
          {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
        </div>
        <div className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-xl bg-primary px-3 py-2.5 text-sm leading-snug text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <Avatar />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 pl-1 pb-1 text-xs">
          <span className="font-semibold text-foreground">Gini</span>
          {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
        </div>
        {toolCalls && toolCalls.length > 0 ? (
          <div className="mb-1 flex flex-col gap-0.5">
            {toolCalls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        ) : null}
        <div className="max-w-[90%] rounded-xl border bg-card px-3 py-2.5 text-card-foreground">
          <MarkdownContent text={message.content} streaming={isStreaming} />
        </div>
      </div>
    </div>
  );
}
