import type { ChatBlock, ToolCallBlock } from "@/src/types";

// Render-time view of the chat block stream. Tool calls inside a
// completed exchange (user_text → final non-streaming assistant_text)
// collapse to a single "tool_group" item; everything else passes
// through as the raw block. In-flight exchanges keep their tool calls
// inline so the user sees progress as it streams.
export type ChatRenderItem =
  | { kind: "block"; block: ChatBlock }
  | { kind: "tool_group"; id: string; calls: ToolCallBlock[] }
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
  let firstCallIdx = -1;
  for (let i = 0; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call") {
      if (firstCallIdx === -1) firstCallIdx = i;
      calls.push(b);
    }
  }
  if (calls.length === 0) {
    for (const b of exchange) items.push({ kind: "block", block: b });
    return;
  }
  for (let i = 0; i < firstCallIdx; i++) {
    items.push({ kind: "block", block: exchange[i]! });
  }
  items.push({ kind: "tool_group", id: `group-${calls[0]!.id}`, calls });
  for (let i = firstCallIdx + 1; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call" || b.kind === "tool_result") continue;
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
