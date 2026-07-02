# ADR: Runtime Identity Injection With Tell-Once + Delta + Periodic Refresh

- **Status:** Accepted
- **Date:** 2026-05-19
- **See also:** [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Stable System Prefix](./stable-system-prefix.md)

## Decision

The chat-task agent loop injects a per-conversation runtime identity block into each turn. The block names the instance, runtime port, active agent, provider/model, enabled toolsets, and memory namespace — the same fields `gini status` surfaces. The agent can then answer self-introspection questions (`what model are you?`, `what tools do you have?`, `what instance am I talking to?`) without spending a tool call.

The emitted block is delivered in an ephemeral `role:"user"` "context" message placed after the full prior transcript and immediately before the real user message — **not** in the system message (message 0). Message 0 is a byte-stable, cacheable prefix; per-turn identity emission lives in the tail so an emit turn never breaks the cache prefix. The tell-once mechanism below is unchanged — only the placement of the emitted string moved. See ADR stable-system-prefix.md.

The block uses a tell-once + delta + periodic refresh policy keyed on the chat session id:

- **First turn in a conversation:** emit the full block.
- **Subsequent turns:** emit only the changed fields (with `(was X)` annotations) since the last snapshot. Emit nothing when nothing changed.
- **Every `IDENTITY_FULL_REFRESH_INTERVAL = 10` turns:** force a full re-emission, regardless of changes.

The would-be snapshot is persisted to `RuntimeState.identitySnapshots[conversationId]` only after the first successful provider call in `runLoop`, never up-front in `runChatTask`. The subagent path is excluded — subagents already get an overriding system prompt and short-lived context.

## Context

Before this change, the agent had no in-context source for its own runtime identity. Asked "what tools do you have?" or "what's your instance?", it would either guess from prior memory entries or admit it didn't know. Tools that could fetch the info (`gini status` via terminal, the `gini` skill) require explicit tool calls — slow, costly, and the agent doesn't always think to invoke them.

The naive fix — always emit the full identity block — would re-send the same fields on every turn for stable sessions, and (in the original design that placed identity in the system message) would change message 0 on every reconfiguration, breaking the cache prefix. The tell-once policy bounds emitted identity tokens; placing the emitted block in the ephemeral `role:"user"` tail (see ADR stable-system-prefix.md) keeps even an emit turn from disturbing the byte-stable system prefix, so frequent agent reconfiguration no longer defeats the cache for the rest of the prompt.

A pure-delta approach (tell once, then only emit changes forever) would minimize tokens but force the model to reconstruct ground-truth identity from a long chain of accumulated deltas in unbounded-length conversations. The periodic full refresh caps that reconstruction depth at `IDENTITY_FULL_REFRESH_INTERVAL` turns and gives the prompt cache a clean resync point on a predictable cadence.

## Required Now

- `AgentIdentity` (in `packages/runtime/src/types.ts`) carries the seven fields surfaced in the block. It is the snapshot unit and the runtime-time render input.
- `IdentitySnapshotRecord` carries the last-emitted `AgentIdentity` plus `lastFullTurn: number`. The refresh trigger is `currentTurn - lastFullTurn >= IDENTITY_FULL_REFRESH_INTERVAL`.
- `RuntimeState.identitySnapshots?: Record<string, IdentitySnapshotRecord>` keys on `conversationId` (the chat session id). The field is optional so legacy state files do not need a normalizeState migration; readers default to `{}`.
- `decideIdentityEmission(current, snapshot, currentTurn)` (in `packages/runtime/src/system-prompt.ts`) is the pure decision function. Three outcomes: full block + snapshot reset, delta block + snapshot identity advance (keeping `lastFullTurn`), or empty string + no snapshot change.
- `renderFullIdentity` and `renderIdentityDelta` produce the human-readable block content. The toolset list is sorted for stable output, and a missing `toolsetFilter` (no agent-level restriction) renders the actual enabled toolset names from `state.toolsets` — never `(none)` when the agent has unrestricted access.
- `buildAgentIdentity(config, state, effective)` in `packages/runtime/src/execution/chat-task.ts` is the gateway from runtime state into `AgentIdentity`. It resolves the agent name from `state.agents` and follows the existing `effectiveForAgent` pattern for provider/toolsets/memory namespace.
- `runChatTask` computes the would-be snapshot but defers persistence. The deferred snapshot rides into `runLoop` as a parameter; `runLoop` commits it inside the same `mutateState` block that runs after the first successful `generateToolCallingResponse`. Subsequent iterations within the same `runLoop` entry never re-commit (the local variable is cleared after the first write).

## Boundary

- **Subagents are excluded.** Subagents receive their own override prompt in `subagent.systemPrompt`; injecting parent identity into a subagent prompt would mislead the child about its own context. The identity block lives only on the parent chat-task path.
- **Non-chat-session callers get the full block every turn.** When a chat-mode task has no `conversationId` (e.g. CLI/imperative entries that route through `runChatTask` without a chat session), there is no snapshot key to track against. These paths emit the full block unconditionally and skip snapshot persistence.
- **Snapshot lifecycle follows the chat session.** `deleteChatSession` in `packages/runtime/src/state/records.ts` drops `state.identitySnapshots[id]` alongside the session's chat messages, so deleted chats do not leak orphan snapshots.
- **Snapshot persistence is gated on the model call.** Persistence happens only after the prompt actually reaches the provider. A task cancelled between `runChatTask`'s exit and `runLoop`'s first iteration leaves the snapshot untouched — the next turn computes its delta against the prior snapshot, which the model actually saw.

## Read and Write Semantics

- **Read:** `runChatTask` reads the snapshot from `state.identitySnapshots?.[conversationId]` to compute the emission decision. `decideIdentityEmission` is pure and side-effect free.
- **Write:** `runLoop` writes the deferred snapshot inside `mutateState` after `generateToolCallingResponse` returns successfully on the first iteration. There is no other write site. Cancellation, model-call failure, or pre-model bail-out all leave the snapshot untouched.
- **Concurrent same-conversation writes:** the `mutateState` lock serializes writes per instance. Two tasks racing on the same `conversationId` may clobber each other's snapshot, but the only field that can disagree is `lastFullTurn` (the integer counter). The worst case is one extra full-identity emission on a future turn — the safe direction, not data loss.

## Consequences

- **Behavior change:** the agent answers self-introspection questions correctly without a tool call on the first turn of a chat session, and at every `IDENTITY_FULL_REFRESH_INTERVAL`-th turn thereafter. Follow-up turns without identity changes carry no identity tokens.
- **State growth:** one `IdentitySnapshotRecord` per active chat session. Each record is small (seven identity fields plus an integer). Cleanup follows chat-session deletion, so growth tracks active conversations rather than lifetime turn count.
- **Prompt token cost:** flat for stable sessions (zero identity tokens after the first turn except at the K-turn refresh). Bounded for high-churn sessions (delta lines are smaller than the full block; the K-turn refresh caps the worst case).
- **Cache behavior:** the emitted identity block rides in the ephemeral `role:"user"` tail, after the full prior transcript and immediately before the real user message — never in the system message. Message 0 therefore stays byte-stable across turns regardless of whether identity is emitted, so an emit turn (first turn, K-turn refresh, or a reconfiguration delta) never breaks the cache prefix. The tail itself is uncached by construction (it carries the per-turn-varying content), which is the correct place for it. See ADR stable-system-prefix.md.

## Alternatives Considered

- **Always emit the full identity block.** Rejected for the high-churn case: when the user reconfigures toolsets or providers mid-conversation, the block content changes and prompt caching cannot redeem the redundant tokens. The delta approach pays only for what changed; the K-turn refresh handles the long-session reconstruction risk.
- **Pure delta with no periodic refresh.** Rejected for unbounded conversations. The model would have to reconstruct current identity from a chain of deltas stretching back to turn 1, which is fragile when older turns scroll past effective attention. The K-turn refresh resets the baseline at predictable intervals.
- **A `describe_self` runtime tool that returns the same struct `gini status` builds.** Rejected as the primary mechanism: requires a tool call per question, adds schema and permission surface, shows up in every toolset, and only fires when the model decides to invoke it. The static identity block is free at prompt-construction time and always present on turn 1 and refresh turns. (A `describe_self` tool remains a sensible future addition for live-state introspection — current job counts, pending approvals, version metadata — that the static block does not cover.)
- **Wire the identity block into the legacy imperative `provider.ts` single-shot path too.** Deferred. The chat-task path covers all chat-mode entries (web, Discord, Telegram, `gini chat send`). The legacy single-shot path is used only by `gini task submit` without `--mode chat`, which is a CLI-internal entry where introspection demand is low. Extending the policy there is straightforward and can land in a follow-up if a use case emerges.
- **Pin the identity block to the chat session's owner agent (`session.agentId`) rather than `state.activeAgentId`.** Out of scope. The existing chat-task pipeline already uses `resolveEffectiveContext(state, config)` (which reads the global active agent) for memory recall, tool catalog filtering, and provider override. The identity block follows that same pattern. A future change that threads `task.agentId` through `resolveEffectiveContext` would correct identity, memory, tools, and provider in one shot; isolating identity would actively mislead users (the block would report an agent whose provider and tools were not the ones actually in effect this turn).

## Acceptance Checks

- Turn 1 of a fresh chat session: the ephemeral `role:"user"` tail contains `Your runtime identity:`, the system message (message 0) does not, and the agent answers self-introspection without tool calls.
- Turn 2-9 of the same session with no identity changes: neither the system message nor the tail contains `Your runtime identity:` or `Runtime identity changes since last turn:`.
- Turn N where toolsets / provider / agent / memory namespace changed: the tail contains `Runtime identity changes since last turn:` with only the changed fields annotated `(was X)`; message 0 stays byte-stable.
- Turn 11 of a session: the tail re-emits the full block; `state.identitySnapshots[conversationId].lastFullTurn` advances to 11.
- Subagent tasks: the system prompt is the subagent's override, no identity tail is injected.
- Deleted chat session: `state.identitySnapshots[id]` is removed.
- Task cancelled before `runLoop`'s first model call: `state.identitySnapshots[conversationId]` is unchanged from before the task started.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.

## Critical Files

- `packages/runtime/src/types.ts` — `AgentIdentity`, `IdentitySnapshotRecord`, `RuntimeState.identitySnapshots?`.
- `packages/runtime/src/system-prompt.ts` — `IDENTITY_FULL_REFRESH_INTERVAL`, `renderFullIdentity`, `renderIdentityDelta`, `decideIdentityEmission`; `renderEphemeralContext` renders the emitted-identity + recalled-memory tail body (`buildAgentSystemContext` builds only the stable prefix). See ADR stable-system-prefix.md.
- `packages/runtime/src/execution/chat-task.ts` — `buildAgentIdentity`, deferred snapshot persistence in `runChatTask` and `runLoop`, subagent-skip branch.
- `packages/runtime/src/state/records.ts` — `deleteChatSession` clears the matching snapshot.
- `packages/runtime/src/system-prompt.test.ts`, `packages/runtime/src/execution/chat-task.test.ts`, `packages/runtime/src/http.test.ts` — render/decision/lifecycle coverage.
