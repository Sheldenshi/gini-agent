import type { ChatBlock, ToolCallBlock } from "@runtime/types";

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
  let i = 0;
  while (i < blocks.length) {
    let end = i + 1;
    while (end < blocks.length && blocks[end]!.kind !== "user_text") end++;
    const exchange = blocks.slice(i, end);
    appendExchange(items, exchange);
    i = end;
  }
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
