import type { ToolCallingMessage, MessageContentPart } from "../provider";

export const DEFAULT_PRIOR_CONTEXT_TOKEN_BUDGET = 24_000;

export const PRIOR_HISTORY_ELISION_NOTE =
  "Earlier chat history is outside the current model context. The full chat history is still stored. If an older detail matters, use recall_memory for durable facts or search_history for exact past chat, task, or tool snippets before answering.";

export interface ContextReplayMessage {
  message: ToolCallingMessage;
  threadId?: string;
}

export interface PriorContextPackOptions {
  tokenBudget: number;
  activeThreadId?: string;
}

export interface PriorContextPackResult {
  messages: ToolCallingMessage[];
  omittedMessages: number;
  omittedTokens: number;
  retainedTokens: number;
  elisionInserted: boolean;
}

interface MessageGroup {
  index: number;
  messages: ContextReplayMessage[];
  tokenCost: number;
  priority: 0 | 1;
}

export function packPriorContext(
  entries: ContextReplayMessage[],
  options: PriorContextPackOptions
): PriorContextPackResult {
  if (entries.length === 0) {
    return {
      messages: [],
      omittedMessages: 0,
      omittedTokens: 0,
      retainedTokens: 0,
      elisionInserted: false
    };
  }

  const budget = Math.max(0, Math.trunc(options.tokenBudget));
  const groups = buildReplayGroups(entries).map((group) => ({
    ...group,
    priority: groupPriority(group, options.activeThreadId)
  }));
  const selected = new Set<number>();
  let retainedTokens = 0;

  for (const priority of [0, 1] as const) {
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      if (group.priority !== priority) continue;
      if (group.tokenCost > budget) continue;
      if (retainedTokens + group.tokenCost > budget) continue;
      selected.add(group.index);
      retainedTokens += group.tokenCost;
    }
  }

  let omittedMessages = 0;
  let omittedTokens = 0;
  const retainedGroups = groups.filter((group) => {
    if (selected.has(group.index)) return true;
    omittedMessages += group.messages.length;
    omittedTokens += group.tokenCost;
    return false;
  });
  const messages = retainedGroups.flatMap((group) => group.messages.map((entry) => entry.message));
  const elisionInserted = omittedMessages > 0;
  if (elisionInserted) {
    messages.unshift({ role: "user", content: PRIOR_HISTORY_ELISION_NOTE });
  }

  return {
    messages,
    omittedMessages,
    omittedTokens,
    retainedTokens,
    elisionInserted
  };
}

function buildReplayGroups(entries: ContextReplayMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const toolCallIds = entry.message.role === "assistant"
      ? toolCallIdsFor(entry.message)
      : [];
    if (toolCallIds.length > 0) {
      const groupEntries = [entry];
      const remaining = new Set(toolCallIds);
      let j = i + 1;
      for (; j < entries.length && remaining.size > 0; j++) {
        const candidate = entries[j]!;
        if (candidate.message.role !== "tool") break;
        if (!candidate.message.tool_call_id || !remaining.has(candidate.message.tool_call_id)) break;
        groupEntries.push(candidate);
        remaining.delete(candidate.message.tool_call_id);
      }
      if (remaining.size === 0) {
        groups.push(toGroup(groups.length, groupEntries));
        i = j - 1;
      }
      continue;
    }
    if (entry.message.role === "tool") {
      continue;
    }
    groups.push(toGroup(groups.length, [entry]));
  }
  return groups;
}

function toGroup(index: number, messages: ContextReplayMessage[]): MessageGroup {
  return {
    index,
    messages,
    tokenCost: messages.reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0),
    priority: 0
  };
}

function groupPriority(group: MessageGroup, activeThreadId: string | undefined): 0 | 1 {
  const threadIds = new Set(group.messages.map((entry) => entry.threadId).filter((id): id is string => Boolean(id)));
  if (activeThreadId) {
    return threadIds.size === 0 || threadIds.has(activeThreadId) ? 0 : 1;
  }
  return threadIds.size === 0 ? 0 : 1;
}

function toolCallIdsFor(message: ToolCallingMessage): string[] {
  return (message.tool_calls ?? []).map((call) => call.id).filter(Boolean);
}

function estimateMessageTokens(message: ToolCallingMessage): number {
  let tokens = 4; // role + envelope overhead
  tokens += estimateContentTokens(message.content);
  if (message.name) tokens += approxTokens(message.name);
  if (message.tool_call_id) tokens += approxTokens(message.tool_call_id);
  if (message.tool_calls && message.tool_calls.length > 0) {
    tokens += approxTokens(JSON.stringify(message.tool_calls));
  }
  return Math.max(1, tokens);
}

function estimateContentTokens(content: ToolCallingMessage["content"]): number {
  if (content == null) return 1;
  if (typeof content === "string") return approxTokens(content);
  return content.reduce((sum, part) => sum + estimatePartTokens(part), 0);
}

function estimatePartTokens(part: MessageContentPart): number {
  if (part.type === "text") return approxTokens(part.text);
  if (part.type === "image_url") return approxTokens(part.image_url.url) + 32;
  return approxTokens(part.document.data) + approxTokens(part.document.filename ?? "") + 32;
}

function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
