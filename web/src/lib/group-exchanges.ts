import type { ChatBlock, ToolCallBlock } from "@runtime/types";

// Render-time view of the chat block stream. Tool calls inside a
// completed exchange (user_text → final non-streaming assistant_text)
// collapse to a single "tool_group" item; everything else passes
// through as the raw block. In-flight exchanges keep their tool calls
// inline so the user sees progress as it streams.
export type ChatRenderItem =
  | { kind: "block"; block: ChatBlock }
  | { kind: "tool_group"; id: string; calls: ToolCallBlock[] };

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
