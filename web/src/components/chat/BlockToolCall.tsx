"use client";

import { useState } from "react";
import type { ToolCallBlock, ToolResultBlock } from "@runtime/types";
import { iconForTool } from "./tool-icons";

// Pencil "Gini Webapp" tool call row:
//   [icon 15px #9A9AA0] [label HankenGrotesk 13/600 #D6D6DC] [chip flex-1 #2B2B31 monospace 12 #C8C8D2]
// All three sit on a single horizontal row, vertically centered, gap 9.
// Icon is contextual (terminal/file/globe/...) so the user can scan
// the kind of tool at a glance. The whole row is the click target —
// tapping toggles the matching tool_result preview below.
//
// Error/denied calls surface the error string below the row — red by
// default, muted gray when errorSeverity is "info" (a calm needs-setup
// notice); happy path stays quiet (no status badge, no chevron).

export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = block.status === "error" || block.status === "denied";
  const canExpand = Boolean(result);
  const Icon = iconForTool(block.toolName);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 py-0.5 text-left disabled:cursor-default"
        disabled={!canExpand}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      >
        <Icon className="size-[15px] shrink-0 text-[#9A9AA0]" aria-hidden="true" />
        <span className="shrink-0 text-[13px] font-semibold text-[#D6D6DC]">
          {block.displayLabel}
        </span>
        {block.argsPreview ? (
          <span className="min-w-0 flex-1 truncate rounded-md bg-[#2B2B31] px-2 py-[3px] font-mono text-[12px] text-[#C8C8D2]">
            {block.argsPreview}
          </span>
        ) : null}
      </button>
      {failed && block.errorMessage ? (
        <span
          className={`pl-[23px] text-[12px] ${
            block.errorSeverity === "info" ? "text-[#9A9AA0]" : "text-red-400/90"
          }`}
        >
          {block.errorMessage}
        </span>
      ) : null}
      {expanded && result ? (
        <pre className="ml-[23px] max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#2B2B31] p-2.5 font-mono text-[12px] text-[#C8C8D2]">
          {result.preview}
          {result.truncated ? "\n\n[truncated]" : ""}
        </pre>
      ) : null}
    </div>
  );
}
