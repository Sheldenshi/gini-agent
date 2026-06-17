# ADR: Comprehensive Token Usage Accounting

- **Status:** Accepted
- **Date:** 2026-06-17
- **See also:** [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Anthropic Messages Provider](./anthropic-messages-provider.md)

## Decision

Every generative provider call's token usage is recorded into a durable,
per-day **usage ledger** (`RuntimeState.usageLedger`), and the home Token usage
chart reads a server-side rollup of that ledger (`GET /api/usage`) rather than
summing `task.cost`.

- A ledger entry is keyed by `(day, source, agentId, provider, model)` and
  accumulates `inputTokens`, `outputTokens`, `totalTokens`, `estimatedUsd`, and
  `calls`. `day` is a **local** `YYYY-MM-DD` so the chart reads pre-bucketed,
  server-authoritative daily totals.
- `UsageSource` is a small, chart-friendly set: `chat`, `job`, `subagent`,
  `memory`, `chat-title`, `vision`, `aux`, `imperative`, `other`. Finer-grained
  call sites (memory retain vs reflect; `vision_query` vs `browser_vision`)
  collapse into one source.
- `recordUsage(instance, context, cost)` is invoked at each generative **call
  site** — the caller already holds both the result's `CostRecord` and the
  attribution. It is fire-and-forget (`void recordUsage(...).catch(...)`) so it
  never adds latency to, or fails, a provider response. A call with no cost
  record (unpriced or usage-less) is a no-op.
- `estimateCost` now fills `estimatedUsd` from a maintained per-model price
  table (`resolveModelPricing` in `provider-capabilities.ts`). Token counts are
  always recorded; USD is omitted for an unpriced model rather than shown as 0.

`task.cost` is retained as the **live per-turn** cost for the chat UI; it is a
separate consumer and the chart never reads it.

## Context

The home chart previously summed `task.cost` over `/api/tasks`. That missed
every generative call that does not land on a chat task:

- All memory LLM work (`retain` extraction, observation regeneration, `reflect`
  generation + opinion formation, opinion reinforcement) runs fire-and-forget
  **outside** the task lifecycle, so it can never attach to a `task.cost`.
- `generateStructured` (memory + chat titles) produced **no** cost record at all.
- Chat-title generation, `vision_query`, and browser snapshot summarization
  dropped their tokens.
- `task.cost` is a per-task running total bucketed client-side from
  `createdAt`; pruning tasks erased history.

The five generative entry points in `provider.ts`
(`generateToolCallingResponse`, `generateTaskSummary`, `generateStructured`,
`generateVisionAnalysis`, `generateAuxText`) are context-free, so the provider
boundary cannot attribute spend on its own — the caller must.

## Consequences

- **No double counting.** Each generative call is recorded in exactly one
  ledger entry. The chart sums the ledger only; it never also sums `task.cost`.
  `browser_vision` still folds into `task.cost` for the live display *and* is
  recorded once in the ledger — the chart reads only the latter.
- **Attribution.** Most call sites carry `agentId`; `/api/usage?agentId=` scopes
  to one agent but **includes** unattributed shared overhead (some
  title/aux generation), so a per-agent total never silently drops real spend.
- **Pricing is maintained.** `MODEL_PRICING` is list-price data; add a row (with
  a source) when a provider/model is added or a price changes. Anthropic values
  are verified; OpenAI/DeepSeek rows should be re-verified before relying on the
  USD figure for billing.
- **Historical backfill.** On the first boot after the ledger ships,
  `backfillUsageLedgerOnce` seeds the ledger from existing **terminal**
  `task.cost` rows (source derived from task provenance, USD recomputed from the
  now-priced model), guarded by a run-once marker (`usageLedgerBackfilledAt`) so
  it never re-seeds. Only terminal tasks are backfilled — a still-running task
  records forward via `recordUsage`, so backfilling it too would double count.
  Memory / title / vision history is **not** recoverable (it was never stored on
  a task); only the chat/task-attributed portion of history is restored.
- **Not yet covered (intentional):** embeddings/vector-indexing tokens are
  excluded by product decision; failed context-overflow retry attempts are not
  billed into the ledger.

## Acceptance checks

- A real chat turn, a memory-triggering turn, and (where applicable) a job or
  subagent each add ledger entries under their respective `source`.
- `GET /api/usage?days=N` returns `N` day buckets oldest→newest ending today,
  each with input/output/total/USD and a `bySource` breakdown.
- The home Token usage chart's headline equals the rightmost bar and includes
  memory/title/vision spend, not just chat-task `task.cost`.
- `bun run typecheck`, `bun run test`, and the web suite stay green.
