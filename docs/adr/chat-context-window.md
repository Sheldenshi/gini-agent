# ADR: Bounded Chat Context Window

- **Status:** Accepted
- **Date:** 2026-06-05
- **See also:** [One Chat Per Agent, Threads, And Job Channels](./agent-chat-threads-and-channels.md), [Stable System Prefix For Chat Prompt Caching](./stable-system-prefix.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Gini keeps complete chat history durable, but the model prompt receives a bounded replay tail:

- The JSON `chatMessages` list, SQLite `chat_blocks`, traces, audits, runs, and Hindsight memory remain append-only durable history. Context packing never deletes or rewrites them.
- `runChatTask` rebuilds prior transcript rows, then packs them under `config.agent.priorContextTokens` before the ephemeral identity/memory tail and current user message. When unset, the default prior-history budget is 65% of the effective provider/model context window; unknown routed or local models fall back to a conservative 32K window. The effective replay budget is then capped to the room left after the live system prompt, current turn, tool schemas, and a response reserve.
- Packing walks from newest to oldest and preserves chronological order among retained rows. Assistant `tool_calls` rows are atomic with their paired `role:"tool"` results so provider replay never sees orphan tool messages or unanswered calls.
- For thread replies, rows from the active thread and main chat are preferred before unrelated thread rows. Main-chat turns prefer main-chat rows before thread rows. Legacy rows without thread metadata are treated as main-chat context.
- When any prior rows are omitted, the prompt gets a fixed `role:"user"` elision note telling the model that older history is still stored, that tool-call/result pairs are omitted together, and that it should use `recall_memory`, `search_history`, or `read_skill` again when needed.
- `ChatMessageRecord` now carries optional `threadId` / `parentBlockId` for provider replay. ChatBlock remains the UI source of truth; the JSON fields exist so the packer can prioritize the active thread.

This is not summarizing compaction. It is bounded replay plus retrieval. Durable recall continues through automatic Hindsight retain, automatic per-turn recall, explicit `recall_memory`, and exact substring `search_history`.

## Context

The one-chat-per-agent model intentionally accumulates a long-lived transcript. Replaying the entire transcript into every model call works for short chats and is cache-friendly for a while, but it eventually has three failure modes:

- it can exceed the provider context window;
- unrelated side threads can crowd out the current thread;
- old tool transcripts and attachments can make every turn expensive even when they are irrelevant.

Deleting or rewriting old chat would violate the product promise that the agent remembers and that the user can inspect what happened. LLM-generated summaries are useful as a future optimization, but making them the only bridge to old context would create a lossy, sometimes stale source of truth. The safer first step is to keep exact history durable and bound only the provider-bound working set.

## Consequences

- Long agent chats can continue without provider context overflow from unbounded prior replay.
- Exact old history remains available through stored chat rows and `search_history`; salient long-term facts remain available through Hindsight auto-retain and recall.
- The model may not automatically see an old exact quote unless automatic recall surfaces it or it follows the elision note and searches. This is intentional: retrieval is the path for old exact context.
- Prefix caching still gets the stable system prefix. Once a chat is long enough to roll its tail, the retained prior-history window may shift between turns, so cache reuse after the system prefix is best-effort rather than guaranteed.

## Acceptance Checks

- Full stored chat history remains in `RuntimeState.chatMessages` after older rows are omitted from provider messages.
- The first provider call for a long chat includes the fixed elision note, recent prior messages, and the current user message, but not oversized older rows beyond the budget.
- Packing never emits a `role:"tool"` result without its preceding assistant `tool_calls` row.
- A thread reply prefers that thread plus main chat over unrelated thread history when the budget cannot fit all rows.
- `bun test src/execution/context-window.test.ts`
- `bun test src/execution/chat-task.test.ts`

## Critical Files

- `src/execution/context-window.ts` — prior-history packing, approximate token accounting, tool-call grouping, thread priority, elision note.
- `src/execution/chat-task.ts` — rebuilds durable prior rows, applies the packer, and records retained/omitted context metrics in task trace.
- `src/execution/chat.ts` and `src/execution/tool-dispatch.ts` — stamp thread metadata onto provider-replay chat rows.
- `src/types.ts` — `RuntimeConfig.agent.priorContextTokens` and provider-replay `ChatMessageRecord.threadId` / `parentBlockId`.
