import type { ChatBlock, ToolResultBlock } from "@runtime/types";
import { BlockApprovalRequested } from "./BlockApprovalRequested";
import { BlockAssistantText } from "./BlockAssistantText";
import { BlockPhase } from "./BlockPhase";
import { BlockSystemNote } from "./BlockSystemNote";
import { BlockToolCall } from "./BlockToolCall";
import { BlockUserText } from "./BlockUserText";

// Dispatcher for the typed ChatBlock union. The switch is exhaustive on
// `block.kind` — adding a new block kind requires a new case here, and
// the `never` guard in the default branch makes the compiler enforce it.
//
// Tool results don't render as standalone rows — they're shown inline
// when the user expands their parent tool_call. The page resolves the
// callId → tool_result mapping and passes the matching result here.
export function BlockRenderer({
  block,
  toolResult
}: {
  block: ChatBlock;
  toolResult?: ToolResultBlock;
}) {
  switch (block.kind) {
    case "user_text":
      return <BlockUserText block={block} />;
    case "assistant_text":
      return <BlockAssistantText block={block} />;
    case "tool_call":
      return <BlockToolCall block={block} result={toolResult} />;
    case "tool_result":
      return null;
    case "phase":
      return <BlockPhase block={block} />;
    case "approval_requested":
      return <BlockApprovalRequested block={block} />;
    case "system_note":
      return <BlockSystemNote block={block} />;
    default: {
      const exhaustive: never = block;
      throw new Error(`Unknown chat block kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
