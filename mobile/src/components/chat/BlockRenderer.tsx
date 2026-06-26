import { View } from "react-native";
import type { ChatBlock, ToolResultBlock } from "@/src/types";
import { BlockAuthorizationRequested } from "./BlockAuthorizationRequested";
import { BlockSetupRequested } from "./BlockSetupRequested";
import { BlockAssistantText } from "./BlockAssistantText";
import { BlockPhase } from "./BlockPhase";
import { BlockSystemNote } from "./BlockSystemNote";
import { BlockToolCall } from "./BlockToolCall";
import { BlockUserText } from "./BlockUserText";
import { TopicForwardChip } from "./TopicForwardChip";

// Dispatcher for the typed ChatBlock union. The switch is exhaustive on
// `block.kind` — adding a new block kind to src/types.ts (via the
// runtime's ChatBlock union) requires a new case here, and the `never`
// guard in the default branch makes the compiler enforce it.
//
// tool_result blocks render inline only when their parent tool_call is
// tapped. The chat screen builds the callId → result map and passes it
// here so each row can find its own result without scanning the list.
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
      // A forwarded Topic answer carries its source Topic; render a deep-link
      // chip below the answer text so the user can open the Topic conversation.
      return block.forwardedFromTopicId ? (
        <View style={{ gap: 8 }}>
          <BlockAssistantText block={block} />
          <TopicForwardChip
            topicId={block.forwardedFromTopicId}
            topicTitle={block.forwardedFromTopicTitle}
          />
        </View>
      ) : (
        <BlockAssistantText block={block} />
      );
    case "tool_call":
      return <BlockToolCall block={block} result={toolResult} />;
    case "tool_result":
      return null;
    case "phase":
      return <BlockPhase block={block} />;
    case "authorization_requested":
      return <BlockAuthorizationRequested block={block} />;
    case "setup_requested":
      return <BlockSetupRequested block={block} />;
    case "system_note":
      return <BlockSystemNote block={block} />;
    default: {
      const exhaustive: never = block;
      throw new Error(`Unknown chat block kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
