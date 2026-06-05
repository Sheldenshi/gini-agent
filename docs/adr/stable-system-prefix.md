# ADR: Stable System Prefix For Chat Prompt Caching

- **Status:** Accepted
- **Date:** 2026-05-29
- **See also:** [Runtime Identity Injection](./runtime-identity-injection.md), [Runtime Identity Files](./runtime-identity-files.md), [Cache Warmer And The in_memory Prompt Cache Default](./cache-warmer.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Each chat turn the agent loop sends to the provider is shaped as:

```
[ system: instructions + soul + user-profile + skills + inactive-skills + mcp + bound-jobs + current-date ]   ← byte-stable WITHIN A LOCAL DAY, cacheable
[ ...full prior transcript (append-only) ]
[ user: «emitted identity (if any)» + «Long-term memory… block (if any)» ]                     ← ephemeral tail
[ user: the actual user message ]
```

Four decisions hold this shape:

1. **Message 0 (the system message) is a byte-stable prefix.** It contains only content that is stable across turns for a fixed instance configuration: the instructions preamble, `SOUL.md`, `USER.md`, the enabled-skills index, the inactive-skills block, the configured-MCP block, the bound-jobs block, and today's date (the only intra-day-stable element — see decision 4). Those change only when the underlying entity set changes (a real configuration event, where a cache break is correct), never per turn, and the date line rolls at most once per local calendar day. The append-only prior transcript that follows message 0 is likewise deterministic. On a turn with no ephemeral tail the cacheable prefix reaches `[system, ...prior transcript, user]`; on a tail-bearing turn the tail sits between the prior transcript and the user message, so caching stops just short of it and the prefix is `[system, ...prior transcript through the second-to-last turn]` (see Consequences for the exact reach).

2. **Per-turn-varying content rides in an ephemeral `role:"user"` tail.** The two blocks that used to be baked into message 0 — recalled Hindsight memory (keyed on the turn's user input, so different every turn) and the emitted runtime-identity block (present on emit turns, absent on quiet turns) — now render through `renderEphemeralContext(emittedIdentity, recalledContext)` into a single `role:"user"` message placed after the full prior transcript and immediately before the real user message. The two pieces are joined by a blank line in the order identity-then-memory (mirroring their old system-prompt order); each is elided when empty, and when both are empty no tail message is injected at all. The tail is built live every turn and is never written to durable `chatMessages`, so the next turn's prior transcript never replays a stale tail (see Boundary for its in-memory lifecycle across an approval pause).

3. **Automatic provider prefix caching only — no `cache_control` markers.** All non-codex providers Gini targets (openai, openrouter, deepseek, local) use OpenAI-style automatic `in_memory` prefix caching, pinned in `src/provider.ts` (see ADR cache-warmer.md). Codex uses its own server-side prefix caching of `instructions` + `input`. Prefix byte-stability alone is what makes both warm; explicit Anthropic-shaped `cache_control` breakpoints would be dead payload because no provider in the catalog speaks the Anthropic Messages API.

4. **Today's date is stamped into the system prefix at day granularity; precise time is a tool.** `chat-task.ts` appends a `Current date: <weekday>, <date> (<IANA tz>)` line to message 0 (`buildCurrentDateBlock`). Date — not a timestamp — is deliberate: the line is byte-identical for every turn within a local calendar day, so message 0 stays a warm cache prefix and re-prefills at most once per day (at the first turn after local midnight — negligible, and the in_memory cache has usually gone cold across that gap anyway). An ambient date is required, not optional: without it the model silently hallucinates the year from its training cutoff (the failure mode issue #241 reported and that timezone-only designs in comparable agents are bug-reported for). Precise wall-clock time deliberately does NOT go in the prefix — it changes every minute and would bust the day-stable cache — so a live, always-on, read-only `get_current_time` tool (`core` toolset, `buildCurrentTimeResult`) supplies it on demand. The tool is preferred over telling the model to shell out to `date` because `terminal_exec` is high-risk (approval-gated + audited) and toolset-gated, whereas the clock read is side-effect-free and must always be reachable. Subagents share the same `sections` array, so they get the date line too.

## Context

Automatic prefix caching hashes the leading bytes of each request against recent requests; the longest matching prefix is served cheaply and everything after the first divergence is re-prefilled at full rate. The divergence point therefore caps how much of the prompt can be cached.

Before this change, message 0 was rebuilt every turn with two per-turn-varying blocks inlined: recalled memory (keyed on `task.input`) and the emitted identity block (present only on emit turns). Either one made message 0 differ turn-to-turn, so the cache prefix went cold at message 0 and nothing downstream — including the entire append-only transcript — could be reused. The transcript section was already cache-friendly; message 0 was the sole prefix-breaker.

Moving the per-turn content out of message 0 and into a tail placed *after* the transcript restores a long stable prefix and confines the uncached region to the small ephemeral tail plus the user message. On a quiet turn (no tail) the cache reaches the whole `system + prior transcript + user`. On a tail-bearing turn the tail divergence lands just before the user message, so the previous turn's user message falls just outside the cached region and the cache reaches `system + prior transcript through the second-to-last turn`; the re-prefill is then roughly one prior user message plus the tail and current user message, all of which are inherently uncached anyway.

### Why `role:"user"` and not `role:"system"`

The tail must be `role:"user"`. The codex provider path hoists every `role:"system"` message into the top-level `instructions` parameter — `translateMessagesToResponsesInput`, and the codex text fallback `stitchSystemFromMessages` (`src/provider.ts`). A `role:"system"` tail would be re-merged into the stable instructions block, reintroducing the exact per-turn variance this change removes. A `role:"user"` tail stays in position: a discrete `input` item for codex, and sent verbatim for openai/openrouter/deepseek/local. Two consecutive `role:"user"` messages (tail, then the real user message) are valid across every targeted provider.

### Why the tell-once identity mechanism is preserved

The change is placement-only for identity. `decideIdentityEmission`, the per-conversation snapshot read, the deferred snapshot commit in `runLoop`, `RuntimeState.identitySnapshots`, and the `deleteChatSession` cleanup are all unchanged (see ADR runtime-identity-injection.md). The snapshot decision keys on the would-be-emitted content and the turn index, not on where the emitted string is placed, so relocating the string to the tail leaves the tell-once / delta / periodic-refresh behavior intact. The benefit compounds: because emission no longer touches message 0, even a reconfiguration delta (toolset/provider switch) stops breaking the cache prefix.

### Legacy single-shot path

The legacy `generateTaskSummary` path in `src/provider.ts` is one system + one user message with no prior transcript and no cross-turn cache prefix to preserve, so it keeps recalled memory appended to its system context. It calls `renderEphemeralContext(undefined, recalledContext)` to single-source the `Long-term memory…` header rather than duplicating it.

## Boundary

- **Subagents are excluded.** The tail builder is gated behind the same `if (!subagent)` guard as the identity and identity-file logic. Subagents keep their single override-prompt shape with no ephemeral tail.
- **No new caching configuration.** This is a stability-only change. It adds no config fields, no `cache_control` markers, and does not alter `prompt_cache_retention` (still `in_memory`, owned by ADR cache-warmer.md).
- **The tail is never persisted to durable state.** `priorChatMessages` reads only durable `chatMessages` rows, and the tail is never written there — so it is never replayed as prior transcript. It is constructed in `runChatTask` and dropped after a turn completes. It does, however, live in the in-memory `Task.toolCallState.messages` snapshot when a turn pauses for approval; `resumeChatTask` replays that snapshot verbatim (it never re-derives the tail), so there is no double-injection and no stale-tail replay.

## Consequences

- **Cache behavior:** for a session with no configuration change, message 0 is byte-identical turn-to-turn within a local calendar day, so the automatic prefix cache stays warm across the system message and the append-only transcript. On a turn with no tail (no identity emit and no recalled memory) the cache reaches the full `[system, ...prior transcript, user]`. On a tail-bearing turn the ephemeral tail displaces the previous turn's user message from the cached region — the tail diverges before the user message, so the prefix caches only `[system, ...prior transcript through the second-to-last turn]` and re-prefills approximately one prior user message in addition to the tail and current user message (the latter two are inherently uncached). Either way this is a large improvement over the prior behavior, where per-turn-dynamic content in message 0 broke the prefix at message 0 and re-prefilled the entire history every turn. The date line rolls once per local day, re-prefilling message 0 on the first turn after midnight — negligible, and the in_memory cache has usually gone cold across that gap anyway.
- **Salience:** recalled memory and emitted identity move from the system channel to a `role:"user"` message placed immediately before the user turn. Recency placement keeps them prominent; no provider behavior keys off these blocks being in the system channel.
- **Cache-warmer alignment:** the warmer probe (`generateTaskSummary(config, " ")`) shares the same byte-stable instructions + identity-file prefix as real chat turns, so the warmer keeps the pinned `in_memory` tier hot for the prefix this ADR stabilizes. See ADR cache-warmer.md.

## Acceptance Checks

- Two consecutive turns in the same session (within the same local day) with no identity/skill/job/connector change produce a byte-identical message-0 `content`, and `messages[0].role === "system"`.
- The emitted identity block and the recalled-memory block both appear in a single `role:"user"` message located immediately before the real user message, identity before memory.
- A turn that injected a tail does not cause the next turn's prior transcript (or `chatMessages`) to contain that tail's identity/memory text.
- Subagent turns inject no tail; their system prompt is the subagent override.
- `renderEphemeralContext` returns `""` when both pieces are empty and the caller injects no tail message in that case.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.

## Critical Files

- `src/system-prompt.ts` — `buildAgentSystemContext` (byte-stable prefix only), `renderEphemeralContext` (the identity + recalled-memory tail body, single-sourcing the `Long-term memory…` header), `buildCurrentDateBlock` (the day-granularity date line stamped into message 0), and `buildCurrentTimeResult` (the precise wall-clock string returned by the clock tool).
- `src/execution/chat-task.ts` — `runChatTask` builds the stable prefix (appending `buildCurrentDateBlock(new Date(), …)` to message 0), then injects the `renderEphemeralContext` tail as a `role:"user"` message between the prior transcript and the real user message, gated to the non-subagent path.
- `src/execution/tool-catalog.ts` — the always-on `get_current_time` `core` catalog entry and its `buildToolCatalog` bypass.
- `src/execution/tool-dispatch.ts` — the `get_current_time` dispatch case (pure clock read via `buildCurrentTimeResult`).
- `src/provider.ts` — `generateTaskSummary` (legacy single-shot path) keeps recalled memory in its system context via `renderEphemeralContext`.
- `src/system-prompt.test.ts`, `src/execution/chat-task.test.ts` — prefix-stability, tail-delivery, and no-double-injection coverage.
