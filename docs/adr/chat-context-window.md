# ADR: Bounded Chat Context Window

- **Status:** Accepted
- **Date:** 2026-06-05
- **See also:** [Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md), [One Chat Per Agent, Threads, And Job Channels](./agent-chat-threads-and-channels.md), [Stable System Prefix For Chat Prompt Caching](./stable-system-prefix.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

> **Per-topic isolation replaced thread-priority packing.** [Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md)
> made each Topic its own session, so bounded replay now scopes naturally to the Topic's own
> transcript — a turn replays only the rows of the session it runs in. The thread-priority packing
> described below (preferring the active thread's rows, the `groupPriority`/`activeThreadId`
> heuristic, and the `threadId` / `parentBlockId` replay fields on `ChatMessageRecord`) was removed;
> those mentions are legacy. The bounded-replay tail, in-turn tool-result elision, the per-turn
> compaction backstop, and the overflow compact-and-retry are all unchanged and still accurate.

## Decision

Gini keeps complete chat history durable, but the model prompt receives a bounded replay tail:

- The JSON `chatMessages` list, SQLite `chat_blocks`, traces, audits, runs, and Hindsight memory remain append-only durable history. Context packing never deletes or rewrites them.
- `runChatTask` rebuilds prior transcript rows, then packs them under `config.agent.priorContextTokens` before the ephemeral identity/memory tail and current user message. When unset, the default prior-history budget is 65% of the effective provider/model context window; unknown routed or local models fall back to a conservative 32K window. The effective replay budget is then capped to the room left after the live system prompt, current turn, tool schemas, and a response reserve.
- Packing walks from newest to oldest and preserves chronological order among retained rows. Assistant `tool_calls` rows are atomic with their paired `role:"tool"` results so provider replay never sees orphan tool messages or unanswered calls.
- A turn replays the transcript of the session it runs in: each Topic is its own session, so packing scopes to that Topic's own rows. (The earlier thread-priority preference — favoring an active thread's rows over unrelated thread rows within one shared session — was removed when Topics replaced threads.)
- When any prior rows are omitted, the prompt gets a fixed `role:"user"` elision note telling the model that older history is still stored, that tool-call/result pairs are omitted together, and that it should use `recall_memory`, `search_history`, or `read_skill` again when needed.
- ChatBlock remains the UI source of truth. (`ChatMessageRecord` retains legacy optional `threadId` / `parentBlockId` fields that once let the packer prioritize the active thread; with per-topic scoping the packer no longer consults them.)
- Turn-start packing bounds *prior* history, but a single long turn (e.g. a browser tool loop) keeps appending tool results within the turn. Before each provider call the loop also elides the *content* of older tool results down to the live budget (provider window minus the response reserve and tool schemas), replacing them with a short marker while keeping the message and its `tool_call_id` so call/result pairing stays valid. The most-recent results are protected so the model keeps fresh state to act on.
- Every individual tool result is capped at dispatch (`MAX_TOOL_RESULT_CHARS`, truncated middle-out — head + marker + tail) so no single oversized result (a large file read, schema dump, or search) can dominate the window or evade the recent-result protection. Tools that already self-cap below the ceiling are unaffected.
- The live budget is calibrated to the provider's reported prompt-token count from the previous call when present (falling back to the chars/4 estimate), so in-turn trimming and the compaction trigger track the model's real accounting rather than drifting from an approximation.
- When cheap elision cannot keep a single runaway turn under the live budget, the loop escalates *within* the turn: it first prunes harder toward a high-water line, and only if still over does it summarize the *middle* of the in-turn transcript with an auxiliary model call, splicing in one synthetic `[Context compacted]` message while protecting the turn's head (its entry messages and first exchange) and recent tail. The synthetic summary is an ephemeral per-turn artifact — the durable tool-transcript rows keep the originals, so the next turn still rebuilds its bounded projection from exact history. Anti-thrash guards cap compactions per turn and bail to a graceful partial result when a compaction saves too little or the window refills immediately.
- A provider context-overflow error is recoverable, not fatal: the loop compacts and retries a bounded number of times (progressively dropping recent-result protection), and if the window still cannot be satisfied it completes the turn with a graceful partial result rather than failing the task.

Across turns this remains bounded replay plus retrieval, not summarizing compaction: every turn rebuilds a bounded projection from durable storage and keeps the full history searchable, so a span dropped from one turn's prompt stays retrievable — through automatic Hindsight retain, automatic per-turn recall, explicit `recall_memory`, and exact substring `search_history` — rather than gone. Cross-turn context is never bridged by an LLM summary; that would make a lossy, sometimes-stale artifact the only source of truth. Summarize-and-continue compaction (standard in single-session agents like Codex CLI and Claude Code, which must summarize because evicted context is otherwise lost) is used here only *inside* a single turn, as a last-resort backstop after bounded elision is exhausted, so a runaway tool loop degrades to a graceful partial answer instead of overflowing — it never replaces the durable, exact history the next turn replays from.

## Context

The one-chat-per-agent model intentionally accumulates a long-lived transcript. Replaying the entire transcript into every model call works for short chats and is cache-friendly for a while, but it eventually has three failure modes:

- it can exceed the provider context window;
- unrelated side threads can crowd out the current thread;
- old tool transcripts and attachments can make every turn expensive even when they are irrelevant.

Deleting or rewriting old chat would violate the product promise that the agent remembers and that the user can inspect what happened. LLM-generated summaries are useful as a future optimization, but making them the only bridge to old context would create a lossy, sometimes stale source of truth. The safer first step is to keep exact history durable and bound only the provider-bound working set.

## Consequences

- Long agent chats can continue without provider context overflow from unbounded prior replay.
- A single long turn that outgrows the window no longer fails outright: it elides, then summarizes its own middle as a bounded in-turn backstop, and retries on a provider overflow error before falling back to a graceful partial result.
- Exact old history remains available through stored chat rows and `search_history`; salient long-term facts remain available through Hindsight auto-retain and recall.
- The model may not automatically see an old exact quote unless automatic recall surfaces it or it follows the elision note and searches. This is intentional: retrieval is the path for old exact context.
- Prefix caching still gets the stable system prefix. Once a chat is long enough to roll its tail, the retained prior-history window may shift between turns, so cache reuse after the system prefix is best-effort rather than guaranteed.

## Acceptance Checks

- Full stored chat history remains in `RuntimeState.chatMessages` after older rows are omitted from provider messages.
- The first provider call for a long chat includes the fixed elision note, recent prior messages, and the current user message, but not oversized older rows beyond the budget.
- Packing never emits a `role:"tool"` result without its preceding assistant `tool_calls` row.
- A turn packs only its own session's rows; an unrelated session's history never enters the budget (per-topic scoping; the former thread-priority preference was removed).
- A turn that crosses the in-turn high-water line compacts once (head and recent tail preserved) and continues; anti-thrash bails to a partial result rather than compacting repeatedly. A provider context-overflow error triggers bounded compact-and-retry, then a graceful partial result.
- `bun test packages/runtime/src/execution/context-window.test.ts`
- `bun test packages/runtime/src/execution/chat-task.test.ts`

## Critical Files

- `packages/runtime/src/execution/context-window.ts` — prior-history packing, approximate token accounting, tool-call grouping, elision note. (Replay now scopes to the running session's own rows; the former thread-priority pass was removed with the Topics migration.)
- `packages/runtime/src/execution/chat-task.ts` — rebuilds durable prior rows, applies the packer, records retained/omitted context metrics in task trace, and within the loop: calibrates the live budget to the provider's reported prompt tokens, elides older tool-result content (`elideOldToolResultsToBudget`) before each provider call, runs the in-turn high-water compaction (prune-then-summarize, splicing the synthetic `[Context compacted]` message with head/tail protection and per-turn anti-thrash), and on a provider overflow error compacts-and-retries before completing with a graceful partial result.
- `packages/runtime/src/provider.ts` — `generateAuxText` (the auxiliary-model call that summarizes the in-turn middle) and `isContextOverflowError` (the predicate that classifies a provider error as a recoverable context overflow).
- `packages/runtime/src/execution/tool-dispatch.ts` — caps each tool result at dispatch (`capToolResultText`, `MAX_TOOL_RESULT_CHARS`). (`packages/runtime/src/execution/chat.ts` previously stamped thread metadata onto provider-replay rows; that thread-tagging path is legacy under the Topics model.)
- `packages/runtime/src/provider-capabilities.ts` — per-provider/model context-window sizes that set the budget (the codex backend is capped at its real effective window via `CODEX_BACKEND_CONTEXT_WINDOW_TOKENS`).
- `packages/runtime/src/types.ts` — `RuntimeConfig.agent.priorContextTokens`. (`ChatMessageRecord.threadId` / `parentBlockId` survive as legacy provider-replay fields the packer no longer consults under per-topic scoping.)
