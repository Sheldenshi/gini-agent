// Authoritative agent system prompt + memory assembly.
//
// Lives outside provider.ts because the prompt is content (agent identity),
// not transport (LLM I/O). Both the legacy single-shot path in provider.ts
// and the chat-task agent loop in execution/ pull from here so they ship
// the same instructions to the model.

import type { MemoryRecord } from "./types";

const INSTRUCTIONS = [
  "You are Gini, a local-first personal agent.",
  "Reply directly and concisely.",
  "When the user asks for an action you have a tool for, execute it; do not narrate what you would do.",
  "Keep working until the task is done or you are genuinely blocked (waiting on approval, missing input, or a tool failure).",
  "Do not claim to have performed side effects. Risky side effects are handled by tools and approvals."
].join("\n");

// Assemble the system-area context: base instructions + pinned memories +
// long-term recalled memory. Placing memory in the system channel (rather
// than the user message) gives it higher-priority placement without
// talking the model into believing it.
export function buildAgentSystemContext(memories: MemoryRecord[], recalledContext?: string): string {
  const parts = [INSTRUCTIONS];
  if (memories.length > 0) {
    const pinned = memories.map((memory) => `- ${memory.content}`).join("\n");
    parts.push(`Pinned memories about this user (curated, always relevant):\n${pinned}`);
  }
  if (recalledContext && recalledContext.trim().length > 0) {
    parts.push(`Long-term memory of prior conversations with this user (use these facts when answering):\n${recalledContext}`);
  }
  return parts.join("\n\n");
}
