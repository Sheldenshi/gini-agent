import type { UserTextBlock } from "@runtime/types";
import { formatMessageTimestamp } from "./relative-time";

export function BlockUserText({ block }: { block: UserTextBlock }) {
  const timestamp = formatMessageTimestamp(block.createdAt);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 pr-1 text-xs">
        <span className="font-semibold text-foreground">You</span>
        {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
      </div>
      <div className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-xl bg-primary px-3 py-2.5 text-sm leading-snug text-primary-foreground">
        {block.text}
      </div>
    </div>
  );
}
