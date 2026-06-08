"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCallBlock, ToolResultBlock } from "@runtime/types";
import { BlockToolCall } from "./BlockToolCall";
import { iconForTool } from "./tool-icons";

// Collapsed summary of every tool_call the assistant made during one
// exchange (user_text → final assistant_text). The trailing icon strip
// shows one glyph per *unique* tool category invoked, so a user can
// glance at the row and know whether the assistant touched files, ran
// shell commands, hit the browser, etc., without expanding.

export function BlockToolCallsCollapsed({
  calls,
  resultsByCallId
}: {
  calls: ToolCallBlock[];
  resultsByCallId: Map<string, ToolResultBlock>;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentCount = calls.filter((c) => c.toolName === "spawn_subagent").length;
  const toolCount = calls.length;

  const uniqueIcons = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const Icon = iconForTool(call.toolName);
    const key = Icon.displayName ?? Icon.name ?? String(Icon);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueIcons.push({ key, Icon });
  }

  const summary =
    agentCount > 0
      ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}, ${agentCount} agent${agentCount === 1 ? "" : "s"}`
      : `${toolCount} tool call${toolCount === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-[13px] self-start py-0.5 text-left"
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="text-[14px] font-medium text-muted-foreground">{summary}</span>
        {uniqueIcons.length > 0 ? (
          <span className="flex items-center gap-[9px]">
            {uniqueIcons.map(({ key, Icon }) => (
              <Icon key={key} className="size-4 text-muted-foreground" aria-hidden="true" />
            ))}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-1.5 pl-[27px]">
          {calls.map((call) => (
            <li key={call.id}>
              <BlockToolCall block={call} result={resultsByCallId.get(call.callId)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
