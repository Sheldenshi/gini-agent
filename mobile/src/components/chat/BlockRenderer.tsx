import type { ChatBlock } from "@/src/types";
import { BlockApprovalRequested } from "./BlockApprovalRequested";
import { BlockAssistantText } from "./BlockAssistantText";
import { BlockPhase } from "./BlockPhase";
import { BlockSystemNote } from "./BlockSystemNote";
import { BlockToolCall } from "./BlockToolCall";
import { BlockUserText } from "./BlockUserText";

// Dispatcher for the typed ChatBlock union. The switch is exhaustive on
// `block.kind` — adding a new block kind to src/types.ts (via the
// runtime's ChatBlock union) requires a new case here, and the `never`
// guard in the default branch makes the compiler enforce it.
export function BlockRenderer({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case "user_text":
      return <BlockUserText block={block} />;
    case "assistant_text":
      return <BlockAssistantText block={block} />;
    case "tool_call":
      return <BlockToolCall block={block} />;
    case "tool_result":
      // Tool results are noise in the transcript — the assistant's reply
      // already summarizes the meaningful output. The block is still
      // emitted and persisted so future "expand details" UI can reach it.
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
