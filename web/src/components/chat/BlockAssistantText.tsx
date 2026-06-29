import type { AssistantTextBlock } from "@runtime/types";
import { AgentAvatar } from "./AgentAvatar";
import { CalendarView } from "./CalendarView";
import { MarkdownContent } from "./MarkdownContent";
import { formatMessageTimestamp } from "./relative-time";

const BUBBLE = "max-w-[90%] rounded-xl border bg-card px-3 py-2.5 text-card-foreground";

// Pull a COMPLETE ```calendar fence out of the assistant text so the calendar can
// render as its OWN full-width card — like the standalone Question/Setup cards —
// instead of cramped inside the chat bubble. Returns null when there is no
// complete fence (including mid-stream, before the closing ```), so the text just
// renders normally inside the bubble until the block finishes.
const CALENDAR_FENCE = /```calendar[^\n]*\n([\s\S]*?)\n```/;

export function splitCalendar(
  text: string
): { before: string; calendarRaw: string; after: string } | null {
  const match = CALENDAR_FENCE.exec(text);
  if (!match) return null;
  return {
    before: text.slice(0, match.index),
    calendarRaw: match[1]!,
    after: text.slice(match.index + match[0].length)
  };
}

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
  const header = (
    <div className="flex items-center gap-2 pl-1 pb-1 text-xs">
      <span className="font-semibold text-foreground">{name}</span>
      {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
    </div>
  );

  const split = splitCalendar(block.text);
  if (!split) {
    return (
      <div className="flex items-start gap-2.5">
        <AgentAvatar name={name} seed={seed} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {header}
          <div className={BUBBLE}>
            <MarkdownContent text={block.text} streaming={block.streaming} dropForeignImages />
          </div>
        </div>
      </div>
    );
  }

  // Calendar hoisted to its OWN full-width card (no avatar indent), with the prose
  // before/after it kept in Gini's normal avatar-indented bubbles.
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <AgentAvatar name={name} seed={seed} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {header}
          {split.before.trim() ? (
            <div className={BUBBLE}>
              <MarkdownContent text={split.before} dropForeignImages />
            </div>
          ) : null}
        </div>
      </div>
      <CalendarView raw={split.calendarRaw} />
      {split.after.trim() ? (
        <div className="flex items-start gap-2.5">
          {/* avatar-width spacer so the trailing prose stays aligned under Gini */}
          <div className="w-6 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className={BUBBLE}>
              <MarkdownContent text={split.after} streaming={block.streaming} dropForeignImages />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
