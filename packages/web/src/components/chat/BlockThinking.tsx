"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import type { AssistantTextBlock } from "@runtime/types";

// A single per-iteration narration step, rendered to read exactly like a
// BlockToolCall row: [icon 15px] [bold "Thinking" label] [brief content chip],
// click to expand the full text in a content box — the same brief-then-more
// affordance a tool call uses for its args preview + result. The chip and the
// expanded box reuse BlockToolCall's chip / result-box styling so a Thinking
// step is visually a peer of the tool calls in the collapsed group. Narration
// is always settled (the streaming path never collapses to a step), so there
// is no cursor.

export function BlockThinking({ block }: { block: AssistantTextBlock }) {
  const [expanded, setExpanded] = useState(false);
  const text = block.text.trim();
  const preview = text.split("\n", 1)[0] ?? "";
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 py-0.5 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Brain className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-[13px] font-semibold text-foreground">Thinking</span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-[3px] text-[12px] text-foreground">
            {preview}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <pre className="ml-[23px] max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 text-[12px] text-foreground">
          {text}
        </pre>
      ) : null}
    </div>
  );
}
