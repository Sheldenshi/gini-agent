import type { AssistantTextBlock, ChatBlock, ToolCallBlock } from "@runtime/types";

// One entry in a collapsed exchange's "process": either a tool call or a
// piece of pre-tool narration the model emitted between tools. Steps keep
// exchange order so the expanded view replays the turn chronologically.
export type ProcessStep =
  | { kind: "tool_call"; block: ToolCallBlock }
  | { kind: "narration"; block: AssistantTextBlock };

// Render-time view of the chat block stream. In a completed exchange
// (user_text → final non-streaming assistant_text), the tool calls AND
// the per-iteration narration the model emitted between them collapse
// into a single "tool_group" item, leaving only the final answer as a
// standalone bubble; everything else passes through as the raw block.
// In-flight exchanges keep their tool calls and narration inline so the
// user sees progress as it streams.
export type ChatRenderItem =
  | { kind: "block"; block: ChatBlock }
  | { kind: "tool_group"; id: string; calls: ToolCallBlock[]; steps: ProcessStep[] }
  | { kind: "file_artifact"; id: string; files: { path: string; toolName: string }[] };

export function groupExchanges(blocks: ChatBlock[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  // Partition blocks into exchanges, then collapse each. An exchange is the
  // set of blocks sharing one taskId — a single agent turn or job cycle. A
  // turn's user_text, assistant_text, and tool calls all carry that turn's
  // taskId, so grouping by taskId keeps them together. This is what splits a
  // recurring-job channel — which has no user_text — into one group per cron
  // cycle; treating the whole channel as one exchange would collapse every
  // cycle's tool calls into a single group anchored to the first message.
  //
  // Grouping by taskId rather than by contiguous run also survives
  // interleaving: a manual or replay job run may execute alongside an
  // in-flight scheduled run (see src/jobs/index.ts), so two tasks can write
  // blocks into one session's ordinal stream out of order. Keying on taskId
  // reunites each task's blocks regardless of insertion order, and exchange
  // order follows each task's first appearance.
  //
  // A block with no taskId forms its own single-block exchange in place, so
  // it passes through untouched rather than merging into an unrelated turn.
  const exchanges: ChatBlock[][] = [];
  const indexByTask = new Map<string, number>();
  for (const b of blocks) {
    if (b.taskId === undefined) {
      exchanges.push([b]);
      continue;
    }
    const existing = indexByTask.get(b.taskId);
    if (existing === undefined) {
      indexByTask.set(b.taskId, exchanges.length);
      exchanges.push([b]);
    } else {
      exchanges[existing]!.push(b);
    }
  }
  for (const exchange of exchanges) appendExchange(items, exchange);
  return items;
}

function appendExchange(items: ChatRenderItem[], exchange: ChatBlock[]) {
  if (!isExchangeComplete(exchange)) {
    for (const b of exchange) items.push({ kind: "block", block: b });
    return;
  }
  const calls: ToolCallBlock[] = [];
  for (const b of exchange) {
    if (b.kind === "tool_call") calls.push(b);
  }
  if (calls.length === 0) {
    for (const b of exchange) items.push({ kind: "block", block: b });
    return;
  }
  // The final answer is the LAST assistant_text in a completed exchange;
  // every earlier assistant_text is pre-tool narration. Fold that
  // narration into the same collapsed process as the tool calls so the
  // user sees only the final answer plus a collapsed "N tool calls" row,
  // not a stack of "thinking out loud" bubbles.
  let finalAnswerIdx = -1;
  for (let i = exchange.length - 1; i >= 0; i--) {
    if (exchange[i]!.kind === "assistant_text") {
      finalAnswerIdx = i;
      break;
    }
  }
  // Build the ordered process: tool calls and non-final narration in
  // exchange order. The group renders at the first process step's
  // position (groupIdx), so a leading narration line collapses into the
  // group rather than rendering above it.
  const steps: ProcessStep[] = [];
  let groupIdx = -1;
  for (let i = 0; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call") {
      steps.push({ kind: "tool_call", block: b });
    } else if (b.kind === "assistant_text" && i !== finalAnswerIdx) {
      steps.push({ kind: "narration", block: b });
    } else {
      continue;
    }
    if (groupIdx === -1) groupIdx = i;
  }
  for (let i = 0; i < groupIdx; i++) {
    items.push({ kind: "block", block: exchange[i]! });
  }
  items.push({ kind: "tool_group", id: `group-${calls[0]!.id}`, calls, steps });
  for (let i = groupIdx + 1; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call" || b.kind === "tool_result") continue;
    if (b.kind === "assistant_text" && i !== finalAnswerIdx) continue;
    items.push({ kind: "block", block: b });
  }
  // Group every successfully generated file into one always-visible card so
  // the user can open them directly instead of digging through the collapsed
  // tool group. Dedupe by path, keeping the last write's toolName. The card is
  // pushed after the trailing blocks (assistant_text) so it renders below the
  // agent's reply rather than above it.
  const filesByPath = new Map<string, string>();
  for (const call of calls) {
    if (call.toolName !== "file_write" && call.toolName !== "file_patch") continue;
    if (call.status !== "ok") continue;
    const path = String(call.argsFull?.path ?? call.argsPreview ?? "").trim();
    if (!path) continue;
    filesByPath.set(path, call.toolName);
  }
  if (filesByPath.size > 0) {
    const files = Array.from(filesByPath, ([path, toolName]) => ({ path, toolName }));
    items.push({ kind: "file_artifact", id: `files-${calls[0]!.id}`, files });
  }
}

function isExchangeComplete(exchange: ChatBlock[]): boolean {
  for (let i = exchange.length - 1; i >= 0; i--) {
    const b = exchange[i]!;
    if (b.kind === "phase" || b.kind === "tool_result" || b.kind === "system_note") continue;
    if (b.kind === "assistant_text") return !b.streaming;
    return false;
  }
  return false;
}
