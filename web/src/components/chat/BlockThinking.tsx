"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import type { AssistantTextBlock } from "@runtime/types";
import { MarkdownContent } from "./MarkdownContent";

// A single pre-tool narration step, rendered as a row that mirrors
// BlockToolCall's layout: [icon 15px] [bold "Thinking"] [one-line preview].
// Clicking the row reveals the full settled message below (indented to align
// with the label, like the tool-call detail). Narration is always settled —
// the streaming path never collapses — so there is no cursor.

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
        {!expanded && preview ? (
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {preview}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="ml-[23px] text-[13px] text-muted-foreground">
          <MarkdownContent text={text} dropForeignImages />
        </div>
      ) : null}
    </div>
  );
}
