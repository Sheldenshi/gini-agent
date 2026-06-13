# ADR: Deferred Tools (Load-On-Demand Catalog)

## Decision

A catalog tool may be marked `deferred: true`. A deferred tool's NAME and a
one-line `indexSummary` appear in a system-prompt "Tools available on demand"
index, but its full schema is withheld from the live provider `tools` array
until the model loads it via the core, always-on `load_tools({ names })`
meta-tool. Once loaded, the tool is callable directly by its own name, exactly
like a core tool. Core tools (not marked deferred) always ship their full
schema.

This keeps the count of full-schema tools the model sees each turn low and
roughly constant, independent of how large the catalog grows. The whole
catalog stays reachable — the model discovers a deferred tool by name in the
index and pulls its schema on demand.

## Context

The agent loop (ADR agent-loop-tool-calling.md) sent every enabled tool's full
schema to the provider on every turn, and the only lever to shrink that set
was toolset on/off gating. Model tool-selection accuracy degrades as the live
full-schema tool count grows — earlier and more steeply for the weaker
providers Gini must support (local OpenAI-compatible servers, smaller models),
where the practical ceiling is roughly 30-50 live tools. Large clusters
(browser automation, self-config) pushed the always-on surface past that for
turns that never touch them.

Claude Code's harness solves this by listing tool names cheaply and loading
schemas on demand (its `ToolSearch`); a tool becomes a normal, directly-callable
tool once loaded. We adopt the same shape. The names are load-bearing: the
model selects against them in the index, so deferred tools must be named
self-descriptively.

## Required Now

- **Catalog (`src/execution/tool-catalog.ts`).** A def carries `deferred?: boolean`
  and `indexSummary?: string`. Pure helpers: `applyDeferralFilter(catalog,
  loaded)` drops deferred-and-unloaded tools; `deferredToolIndex(catalog,
  loaded)` returns `{name, summary}` for deferred-and-unloaded tools;
  `resolveLoadableTools` / `handleLoadTools` validate requested names and build
  the load result envelope. `load_tools` is a core tool (toolset `core`, never
  deferred) that bypasses toolset gating.
- **Loop (`src/execution/chat-task.ts`).** `load_tools` is handled INLINE in
  the dispatch loop, not via the dispatch switch: it unions the requested names
  into a per-task loaded set, recomputes the provider `tools` array so the NEXT
  provider call ships the new schemas, and persists the set on
  `Task.loadedTools`. `tools` / `providerTools` / `toolsHash` are per-iteration
  `let`s recomputed only after a load; the hot no-load path is unchanged. The
  system-prompt index is built from the SAME gated + subagent-filtered catalog
  the loop uses, so a toolset-disabled deferred tool never appears in the index.
- **Load takes effect on the NEXT turn.** A deferred tool is callable only on
  the provider call after it was loaded — the provider never had the tool's
  schema when it generated the current turn's calls. The loop snapshots the
  loaded set at the start of each turn (`loadedAtTurnStart`); a deferred tool
  call whose name is not in that snapshot — whether never loaded, or loaded by
  a sibling `load_tools` in the SAME batch — gets a recoverable "load it first"
  result instead of executing, so the model retries next turn rather than
  running with arguments it produced without the schema.
- **Persistence / resume.** `Task.loadedTools` lives at task level, NOT in
  `Task.toolCallState` (which is cleared on every resume), so a tool loaded
  before an approval pause survives it. `runLoop` re-seeds the loaded set from
  the task row on every entry, including `resumeChatTask`. The set is cleared
  only on terminal transitions (completion, exhaustion, failure, cancel, deny,
  setup-cancel) alongside `toolCallState`.
- **Subagents.** A subagent whose whitelisted toolsets own deferred tools gets
  those tool names seeded into its loaded set at `runLoop` entry, so an
  explicitly-scoped subagent has them live without spending a turn on
  `load_tools`.
- **`browser_navigate` seeds the browser cluster.** Dispatching a
  `browser_navigate` call unions every deferred `browser`-toolset tool into the
  loaded set (recompute + `Task.loadedTools` persistence, same as an inline
  `load_tools`). A navigation establishes a browsing session whose snapshot is
  full of actionable `@eN` refs; the interaction tools (snapshot, click, type,
  scroll, …) are that session's action vocabulary, and making each first use
  cost a failed call plus a `load_tools` round-trip biased the loop toward
  reading one page and summarizing instead of acting. Seeding is unconditional
  on the navigate outcome and the next-turn rule still applies: interaction
  calls in the SAME batch as the navigate get the "load it first" nudge.
- **`toolsHash`.** Recorded on the pause snapshot for trace/telemetry only; it
  is not enforced on resume (resume rebuilds the catalog via `runLoop`). A
  loaded set that grows the catalog is therefore safe.

## Currently Deferred

- The browser cluster — 21 of 24 tools. `browser_navigate`,
  `browser_fill_secrets`, and `browser_connect` stay core. `browser_fill_secrets`
  and `browser_connect` are escalation / onboarding meta-tools that must be
  reachable before the cluster is loaded (a sign-in wall mid-task).
  `browser_navigate` is core because `browser_connect`'s navigate-first guard
  refuses a cold connect and steers the agent to navigate first — so navigate
  must be directly callable for that steer to be satisfiable in one step.
  In practice the deferred browser tools rarely need an explicit `load_tools`:
  the first `browser_navigate` seeds the whole cluster (see Required Now).
- The self-config tools (ADR self-config-registry.md).

Messaging-lifecycle, jobs, skill-lifecycle, identity-edit, and `mcp_call` tools
stay core for now; deferring a cluster later is a per-tool flag flip using this
same mechanism.

## Consequences For Coding Agents

- To defer a cluster, set `deferred: true` + a concise `indexSummary` on each
  tool. It then surfaces by name in the on-demand index and loads on first use.
  Reserve core (non-deferred) status for high-frequency tools and for
  escalation/onboarding meta-tools that must be reachable before any load
  (`request_connector`, `request_messaging_bridge`, `browser_connect`,
  `browser_fill_secrets`, `load_tools` itself).
- Never store the loaded set in `Task.toolCallState` — it must outlive a
  pause/resume; keep it on `Task.loadedTools`.
- A newly-loaded tool is not callable in the same turn it was loaded; the model
  must call it on a subsequent turn. Don't design flows that assume same-turn
  availability.
- Deferred tools still pass through normal gating (toolset enable/disable, agent
  and subagent whitelists) BEFORE deferral; deferral only controls whether a
  gated-in tool's schema is live yet.

## Acceptance Checks

- `applyDeferralFilter(catalog, ∅)` excludes every deferred tool; with a name in
  the loaded set it includes that one. `deferredToolIndex` lists
  deferred-and-unloaded tools and drops loaded ones.
- A deferred tool the model never loaded returns the "load it first" nudge and
  does not execute; a `load_tools`+call in the same batch nudges the call and
  succeeds the load; the tool is callable on the next turn.
- A tool loaded before an approval pause is still in the provider `tools` array
  after resume (`Task.loadedTools` persisted and re-seeded), and the resumed
  turn can dispatch it.
- A turn containing a `browser_navigate` call puts every deferred browser tool
  in the provider `tools` array on the next provider call and on
  `Task.loadedTools`, with no `load_tools` call.
- A real chat turn confirms model selection: a core-only ask loads nothing; an
  ask needing a deferred tool drives `load_tools(<name>)` then a direct call.
- `bun run typecheck` and `bun test` are green.
