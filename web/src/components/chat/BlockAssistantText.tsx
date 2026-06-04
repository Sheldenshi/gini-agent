import type { AssistantTextBlock } from "@runtime/types";
import { AgentAvatar } from "./AgentAvatar";
import { MarkdownContent } from "./MarkdownContent";
import { formatMessageTimestamp } from "./relative-time";

export function BlockAssistantText({
  block,
  agent
}: {
  block: AssistantTextBlock;
  agent?: { id: string; name: string };
}) {
  // Streaming blocks carry the FULL accreted text on every wire delta, so
  // the markdown component sees a continuously growing string without
  // splicing client-side. The blinking cursor renders only while
  // streaming is true; the terminal flip clears it.
  const timestamp = formatMessageTimestamp(block.createdAt);
  // Colored-initial avatar matching the redesign (header/sidebar/threads). The
  // active agent is threaded down from the chat page; fall back to "Gini" so
  // other callers render sensibly.
  const name = agent?.name ?? "Gini";
  const seed = agent?.id ?? name;
  return (
    <div className="flex items-start gap-2.5">
      <AgentAvatar name={name} seed={seed} size={24} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 pl-1 pb-1 text-xs">
          <span className="font-semibold text-foreground">{name}</span>
          {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
        </div>
        <div className="max-w-[90%] rounded-xl border bg-card px-3 py-2.5 text-card-foreground">
          <MarkdownContent text={block.text} streaming={block.streaming} />
        </div>
      </div>
    </div>
  );
}
