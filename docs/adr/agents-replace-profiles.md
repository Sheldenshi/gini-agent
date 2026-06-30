# ADR: Agents Replace Profiles And Drive Runtime Behavior

- **Status:** Accepted
- **Date:** 2026-05-13
- **See also:** [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Agent Attribution Invariant](./agent-attribution-invariant.md)

## Decision

Rename `Profile` to `Agent` across the runtime — types, state, HTTP API,
CLI, and web — and wire the agent record into the chat-task path so that
activating an agent now actually changes inference, tool dispatch, and
messaging.

A single resolution chokepoint, `resolveEffectiveContext(state, config)`
in `src/execution/effective-context.ts`, returns the effective provider,
toolset filter, messaging target filter, memory namespace, and a list of
warnings for unknown or disabled references. Every runtime path that
needs agent-aware behavior reads from this helper instead of consulting
`state` or `config` directly.

The rename is hard: there is no `/api/profiles` alias and no
`gini profiles` CLI alias.

## Context

`ProfileRecord` shipped with no consumer. Activating a profile had no
observable effect on inference, tools, memory, or messaging. The web
Settings page exposed a knob that did nothing.

At the same time, provider configuration lived in two places. The
instance-level `RuntimeConfig.provider` drove inference, while related
capability fields (toolsets, messaging targets, provider name/model
hints) lived on the profile. The two-layer model was confusing, and the
profile-layer values were ignored.

The product direction (see context in change requests) is per-agent
personas with real overrides — a "coding" agent that prefers one
provider and one toolset, a "research" agent that prefers another. That
requires the agent record to be a real control surface, not a cosmetic
label.

## Required Now

- `ProfileRecord` → `AgentRecord`; `state.profiles` → `state.agents`;
  `state.activeProfileId` → `state.activeAgentId`. `normalizeState`
  migrates legacy state files in place.
- `/api/profiles*` → `/api/agents*`. `gini profiles ...` → `gini agents
  ...`. Web `ProfileCard` → `AgentCard`, query key `["profiles"]` →
  `["agents"]`.
- `src/execution/effective-context.ts` exposes `EffectiveContext` and
  `resolveEffectiveContext(state, config)`. Fields:
  - `provider: ProviderConfig` — agent override when both
    `providerName` and `model` are set, else fall through to
    `config.provider`.
  - `providerSource: "agent" | "instance"` — used by `chat-task` to
    decide whether to pass `providerOverride` to
    `generateToolCallingResponse`.
  - `toolsetFilter?: Set<string>` — agent's toolset names. Intersected
    with the globally-enabled set; always-on tools (`web_fetch`,
    `read_skill`, `spawn_subagent`, `create_job`, `list_jobs`,
    `update_job`, `delete_job`) bypass. The four job tools are always
    on as a set so the agent can compose them (e.g. list-then-update,
    delete-then-create) without modal approval friction.
  - `messagingTargetFilter?: Set<string>` — caller-supplied targets are
    intersected; explicit out-of-set targets are rejected with a typed
    error.
  - `memoryNamespace: string` — the agent id; see ADR agent-memory-isolation.md.
  - `warnings: string[]` — unknown or disabled references; surfaced in
    `/api/status.activeAgent.warnings` but do not block activation.
- Provider override applies to **all LLM generation** on the active task:
  `generateToolCallingResponse` (chat-task inference), `generateStructured`
  (Hindsight extraction in retain/reflect/reinforce — fact extraction,
  observation regeneration, opinion formation, opinion assessment), and
  `generateTaskSummary` (used by reflect for response generation, and by
  legacy task summarization). Embeddings and the reranker continue to read
  `config.provider` so semantic recall stays stable across agent switches.
  See **Amendment 2026-05-13** below.
- `RuntimeConfig.provider` is retained as a bootstrap seed.
  `seedDefaultAgentFromRuntimeConfig` copies `config.provider` onto the
  default agent on first run. `normalizeState` overwrites the default
  agent's provider when its values match the legacy
  `echo / gini-echo-v0` defaults and `config.provider` differs, so
  pre-rename instances pick up their real provider on next boot.
- Subagent inheritance: subagents intersect tools with the parent
  agent's toolsets (not the global enabled set), then narrow further
  via their own `toolsetIds`. Provider and memory namespace inherit
  from the parent.
- `/api/status` includes an additive `activeAgent` block computed from
  `resolveEffectiveContext`. The block is omitted when no agent is
  active.

## Resolution Semantics Per Field

| Field | Semantics |
| --- | --- |
| `providerName + model` | Override when *both* set, else fall through to `config.provider`. Source recorded in `EffectiveContext.providerSource`. |
| `toolsets` | Names intersected with `state.toolsets` enabled set. Subagent narrowing composes on top. Always-on tools bypass. |
| `messagingTargets` | Intersected with caller-supplied targets. Explicit out-of-set targets rejected. When the bridge has no permitted target, fall back to the bridge's first delivery target so scheduled messaging does not silently break. |
| `memoryNamespace` | Agent id. See ADR agent-memory-isolation.md. |

The "both required for an override" rule on provider is deliberate. A
half-configured agent (e.g. `providerName: "openai"` but no `model`)
falls through to the instance config rather than producing a confusing
partial override.

## Bootstrap And Migration

- `defaultAgent` no longer hardcodes `echo / gini-echo-v0`. The seed
  comes from `seedDefaultAgentFromRuntimeConfig`, which fires from
  `install()` and so covers `gini run`, `gini start`, and every CLI
  install path.
- `normalizeState` runs idempotent migrations:
  - Rename `state.profiles` → `state.agents` and
    `state.activeProfileId` → `state.activeAgentId`.
  - Backfill `agentId` on legacy `MemoryRecord` rows so they belong to
    the active agent's pool (Phase C concern, but the rename migration
    runs first so the agent id is available).
  - `normalizeState` does not consult `config` — the provider seed lives
    entirely in `seedDefaultAgentFromRuntimeConfig` above.
- Tests that construct a config without calling `install()` retain
  `providerName: undefined` on the default agent, which is the
  "fall through to `config.provider`" case — the agent is not
  overriding anything.

## Subagent Inheritance

Subagents go through the same `runChatTask` loop as their parents.
The parent task has already set `state.activeAgentId`, so the
subagent's `resolveEffectiveContext` call sees the parent agent.
Toolsets and messaging targets are intersected against the parent
agent's filter, then narrowed further by the subagent's own
`toolsetIds`. Provider and memory namespace inherit transparently. No
extra plumbing was needed.

## Warnings

`resolveEffectiveContext` records warnings when an agent references a
toolset that is unknown or disabled, or a messaging bridge that does
not exist. Warnings are informational — they propagate to
`/api/status.activeAgent.warnings` for client display. Activation does
not reject on warnings; the agent runs with the narrower (possibly
empty) filter so a misconfigured agent fails visibly rather than
silently bypassing the filter.

## Consequences

- **Behavior change:** switching the active agent now changes
  inference, tools, and messaging. Document this for users — switching
  is no longer a cosmetic UI flip.
- **State rename:** `state.activeProfileId` → `state.activeAgentId`.
  Legacy state files are migrated in place.
- **Breaking client change:** `/api/profiles*` is gone. There is no
  alias. No external clients in this repo consume the old endpoint,
  but any downstream client must update its path.
- **Code review rule:** any new code that reads `config.provider`
  directly during a task must justify why the agent override should
  not apply. The default expectation is that chat-task inference goes
  through `EffectiveContext`.

## Alternatives Considered

- **Keep "profile" as a cosmetic UI knob and remove the field from
  `ProfileRecord`.** Rejected — the user wants real per-agent
  overrides for provider, tools, and messaging.
- **Per-field merge semantics for provider (fall through for
  individual subfields like `providerName` independently of
  `model`).** Rejected — clearer to require both `providerName` and
  `model` together for an override. Half-configured agents fall
  through to instance config.
- **Allow provider override on embeddings/reranker paths.**
  Rejected — switching agents would invalidate semantic recall against
  the current memory bank. Embeddings and the reranker stay on
  `config.provider` so recall continues to work across agent switches.
  The summarizer (`generateTaskSummary`) and structured-generation
  (`generateStructured`) calls *are* part of the override scope as of
  the 2026-05-13 amendment — see below.

## Acceptance Checks

- Agent with `providerName: "openai"` and `model: "..."` activates →
  next chat task routes through openai. Verifiable via
  `/api/status.activeAgent.resolvedProvider.name === "openai"`.
- Agent with `toolsets: ["file"]` → tool catalog limited to `file.*`
  plus always-on tools. Covered by `tool-catalog.test.ts`.
- Agent with `messagingTargets: ["local"]` →
  `send(target: "slack")` rejected with a typed error. Covered by
  `http.test.ts`.
- `/api/status` includes the `activeAgent` block when an agent is
  active and omits it otherwise.
- Default agent on a fresh instance with `gini run --provider codex`
  → `providerName: "codex"` after install.
- Agents can be deleted via `DELETE /api/agents/:id`; cascade removes
  legacy `MemoryRecord` rows owned by the agent and the per-agent
  Hindsight bank plus all of its units. The default agent
  (`agent_default`) and the currently active agent are protected and
  return 400 with a typed error.
- Agents can be archived via `POST /api/agents/:id/archive` and restored
  via `POST /api/agents/:id/unarchive` (also `gini agent archive` /
  `gini agent unarchive`). Archive sets `AgentRecord.archivedAt`; the
  agent is retained (memory and history preserved) but suppressed.
  Restore clears `archivedAt` and leaves the agent inactive. Only the
  default agent (`agent_default`) cannot be archived; archiving the active
  agent is allowed and hands "active" back to the default. An archived
  agent cannot be activated — both guards return 400 with a typed error. A
  due, active scheduled job whose owning agent is archived is skipped by
  `runDueJobs`.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are
  green.

## Critical Files

- `src/execution/effective-context.ts` — resolution chokepoint.
- `src/execution/chat-task.ts` — calls `resolveEffectiveContext` once
  on loop entry and threads `effective.toolsetFilter` and
  `effective.provider` into the tool catalog and provider call.
- `src/execution/tool-catalog.ts` — agent + subagent filter
  composition, always-on bypass.
- `src/integrations/messaging.ts` — messaging target intersection and
  rejection.
- `src/state/store.ts` — `normalizeState` migration and
  `seedDefaultAgentFromRuntimeConfig`.
- `src/state/defaults.ts` — `defaultAgent` (provider seeded from
  config, not hardcoded).
- `src/runtime/index.ts` — `install()` seeding and `status()`
  `activeAgent` block.
- `src/types.ts` — `AgentRecord`, `ActiveAgentSnapshot`,
  `RuntimeStatus.activeAgent`.

## Amendment 2026-05-13: Provider override extends to memory LLM calls

Phase B scoped the provider override to `generateToolCallingResponse`
only. Live testing on the davao instance found that Hindsight memory
extraction (`retain`, `reflect`, `reinforce`) went through
`generateStructured` and `generateTaskSummary`, both of which still
read `config.provider` directly. The result: an agent configured with
`codex / gpt-5.5` on an instance whose `config.provider` was
`echo / gini-echo-v0` silently routed extraction through the echo
provider, which returned `units: []` for every retain call.

Resolution semantics are now:

- `generateToolCallingResponse` — accepts `providerOverride` (Phase B).
- `generateStructured` — accepts `providerOverride` (2026-05-13).
  Callers: `retain` (fact extraction, observation regeneration),
  `reflect` (opinion formation), `reinforce` (opinion assessment).
- `generateTaskSummary` — accepts `providerOverride` (2026-05-13).
  Callers: `reflect` (response generation), legacy task summary paths.
- `getEmbeddingProvider` and the reranker — **unchanged.** They keep
  reading `config.provider`. Switching the embedding model would
  invalidate semantic recall against the current memory bank.

The plumbing helper is
`providerOverrideForRuntime(config)` in
`src/execution/effective-context.ts`, which reads state, resolves the
effective context, and returns the agent's provider when
`providerSource === "agent"` (else `undefined`). Each memory pipeline
resolves the override once at function entry and threads it through.

## Amendment 2026-06-15: Archive / unarchive agent lifecycle

Agents support a soft-delete lifecycle alongside the hard `deleteAgent`
cascade. `AgentRecord.archivedAt` is an optional ISO timestamp,
orthogonal to `status`: archiving an agent stamps `archivedAt` and leaves
the agent in `state.agents` with its memory pool and history intact;
restoring clears the field. `archivedAt` lives in its own field rather
than as an `AgentStatus` value because `activateAgent` rewrites every
agent's `status` on each switch and would clobber an "archived" status.

`archiveAgent` and `unarchiveAgent` in `src/capabilities/agents.ts`
mirror `deleteAgent`'s structure (load state, mutate, persist, audit,
return the updated record) and emit `agent.archived` / `agent.unarchived`
audit events attributed to the subject agent (see ADR
agent-attribution-invariant.md). Only the default agent (`agent_default`)
is non-archivable — it's the always-present fallback selection. The active
agent can be archived: archiving the current selection hands "active" back
to the default via `activateAgent`, so the active pointer, per-agent
statuses, and the `agent.activated` audit stay consistent. A restored
agent stays inactive — restoration never auto-activates. `activateAgent`
(and the `/use` path) refuse an archived agent so reactivation is an
explicit restore. `listAgents` returns `defaultAgentId` alongside
`activeAgentId` so the web can tell which agent is non-archivable.

Two consequences:

- **Job suppression.** Scheduled jobs are the only per-agent background
  execution. `runDueJobs` skips a due, active job whose owning agent has
  `archivedAt` set (the job stays `active`, so restoring the agent
  resumes it). This is the "stop running" half of archiving.
- **Client surface.** `POST /api/agents/:id/archive` and `/unarchive`,
  the `gini agent archive` / `unarchive` CLI subcommands, and the web
  agent switcher (the sidebar-header dropdown) — which carries the
  per-agent Archive control and an "Archived" group alongside agent
  selection — all drive the archive/unarchive capability functions. The
  "Archived" group exposes two controls per agent: Restore (`/unarchive`)
  and a permanent-Delete control wired to the existing
  `DELETE /api/agents/:id` cascade, so the irreversible hard delete sits
  behind the reversible archive (active → archive → delete permanently)
  and never collides with the active-agent / default-agent delete guards.
  The trimmed `AgentRow` view-type carries `archivedAt` so the web can
  split active from archived agents.
