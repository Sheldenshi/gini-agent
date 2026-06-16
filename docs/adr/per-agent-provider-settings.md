# ADR: Per-Agent Provider Settings (Editable Override + In-Chat Settings Tab)

- **Status:** Accepted
- **Date:** 2026-06-09
- **See also:** [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Make provider/model selection a per-agent operation. Each agent already
carries an optional `providerName` + `model` override that
`resolveEffectiveContext` resolves into the effective provider for inference
and memory LLM calls (see ADR agents-replace-profiles.md). That override could
only be set at agent creation. This ADR adds:

1. A mutation to **edit an existing agent's** provider/model — capability
   `setAgentProvider(config, idOrName, { providerName, model })` exposed at
   `POST /api/agents/:id/provider`.
2. A **Settings tab** in the per-agent chat view, sitting next to the Jobs
   tab, where the user selects the provider/model for the active agent.

The instance-level provider remains the bootstrap seed and the fallback an
agent inherits when it carries no override (`providerSource: "instance"`).

## Context

Provider selection lived only on the global Settings page, which writes the
instance-level `RuntimeConfig.provider`. The agent record was the documented
control surface for per-agent provider (ADR agents-replace-profiles.md), but
the only way to populate it was the create-agent path — there was no edit
surface, and no UI affordance on the agent view itself. The product direction
is per-agent personas with real provider preferences (a "coding" agent on one
provider, a "research" agent on another), so the agent view needed a first-class
place to pick a provider/model.

## Credentials Stay Instance-Level

Provider **credentials** are machine-global: API keys and the AWS access key +
secret live in `~/.gini/secrets.env` and `process.env`, and Codex OAuth in
`~/.codex/auth.json`. They are not per-agent, and the instance-level
`POST /api/setup/provider` flow that writes them (plus the launchd plist
refresh it triggers) is unchanged. The per-agent Settings tab therefore only
**selects among already-configured providers** — it never accepts or stores a
key. This keeps a single source of truth for secrets and avoids duplicating the
heavy secret-write/plist-refresh machinery per agent.

Consequences of this split:

- The Settings tab offers only providers reported `configured` by
  `providerCatalogWithStatus` — an override to an unconfigured provider would
  fail at the next turn, so it is not offered.
- Because `resolveEffectiveContext` inherits the instance's transport config
  (baseUrl, apiKeyEnv, Azure routing, extraBody) only when the agent routes to
  the **same** provider name as the instance, a cross-provider agent takes
  `normalizeProvider`'s per-provider defaults. Azure is configured-gated to the
  active instance provider (it has no default endpoint), so the Settings tab
  naturally won't offer a broken cross-provider Azure override.

## Contract

`POST /api/agents/:id/provider`

- Body `{ providerName, model }` — **both** required to set an override. The
  provider name is validated against `providerCatalog()`; an unknown name is
  rejected. A lone `providerName` or lone `model` is rejected. These map to
  `400` via the `Invalid input:` prefix in `statusFromErrorMessage`.
- Body with both blank/omitted — **clears** the override; the agent reverts to
  the instance default (`providerSource` flips back to `"instance"`).
- Unknown agent id/name → `404` via the `Agent not found:` prefix.
- A no-op (the agent already carries the requested selection) skips the state
  write, the audit row, and the `updatedAt` bump — same hygiene as
  `renameAgent`.
- Success returns the updated `AgentRecord` and writes an `agent.provider_set`
  audit event with `{ from, to, agentId }`.

The "both required for an override" rule is the same invariant
`resolveEffectiveContext` enforces (a half-configured agent falls through to
the instance config), surfaced at the write boundary so the stored record is
always either a complete override or none.

The API validates the provider **name** only; it does not require the provider
to be `configured`. The configured-only restriction is a UI affordance (the
Settings tab filters to configured rows), not an API contract — the endpoint
intentionally allows setting a known-but-unconfigured provider (e.g. to
pre-select one before its credential is added). An override to an unconfigured
provider simply surfaces the normal provider-auth error on the next turn.

## UI

`web/src/components/chat/SettingsTab.tsx` renders next to the Jobs tab on the
agent surface (`ChatTabBar` gains a `settings` tab). Like the Jobs tab, both
are per-agent surfaces and are hidden on the recurring-job channel view, which
is not scoped to the active agent.

The tab reads the active agent's current effective provider from
`/api/status.activeAgent` (`resolvedProvider` + `providerSource`). Selection is
model-first (see ADR model-first-selection.md): the shared `ModelPicker` lists
canonical models with the configured routes that serve them, picking a model
saves the route pair through the contract above immediately, and a "Use default
model" action clears the override. The picker surfaces the agent's
currently-saved pair even when it is off-catalog (e.g. a custom Bedrock
inference-profile id); entering a brand-new custom model id is not done here —
that lives in the global Settings provider editor (which the tab links to),
keeping this tab a focused per-agent selector rather than a second
provider-configuration surface.

The tab is rendered only on the active agent's own canonical chat. It is hidden
on channels and on any pinned session (`?session=` deep links), because those
surfaces can display a session owned by a different agent while the mutation
target and the displayed current provider are the active agent — so restricting
the tab to the canonical chat keeps the read and write referring to the same
agent.

## Consequences

- Switching an agent's provider from the chat view is now a first-class action,
  not a create-time-only setting.
- Clearing the override on the **default** agent (`agent_default`) is transient:
  `seedDefaultAgentFromConfig` reseeds its `providerName`/`model` from
  `RuntimeConfig.provider` whenever they are missing, so a cleared default agent
  reverts to an explicit override that equals the instance provider. This is by
  design — the default agent mirrors the instance config — and the **effective**
  provider/model is identical either way (only `providerSource` flips from
  "instance" back to "agent"). Clearing a non-default agent's override persists.
- The global Settings page is still the place to add/edit/remove provider
  credentials and pick the instance default; the per-agent tab links to it.
- `AgentRecord` and `resolveEffectiveContext` are unchanged — this ADR adds an
  edit surface over the existing model, so no migration is required.

## Acceptance Checks

- `POST /api/agents/:id/provider` with `{ providerName: "openai", model:
  "gpt-4o" }` on the active agent → `/api/status.activeAgent.resolvedProvider`
  reflects openai/gpt-4o and `providerSource === "agent"`.
- The same route with blank fields clears the override →
  `providerSource === "instance"`.
- A lone field or unknown provider → `400`; an unknown agent → `404`.
- The Settings tab appears next to Jobs on the agent view, hidden on channels,
  and selecting a configured provider + model persists and drives the next
  chat turn.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` are green.

## Critical Files

- `src/capabilities/agents.ts` — `setAgentProvider` (validation, no-op,
  audit).
- `src/http.ts` — `POST /api/agents/:id/provider` route.
- `src/execution/effective-context.ts` — unchanged resolution chokepoint the
  override feeds.
- `web/src/components/chat/SettingsTab.tsx` — the per-agent provider/model
  picker.
- `web/src/components/chat/ChatTabBar.tsx`, `web/src/app/chat/page.tsx` — the
  Settings tab wiring.

## Amendment 2026-06-09: Model-First Picker

The Settings tab's provider radio rows + per-provider model dropdown were
replaced by the shared model-first `ModelPicker` (the UI section above
describes the current shape). The `POST /api/agents/:id/provider` contract,
the credentials-stay-instance-level split, and the resolution semantics are
unchanged. The global Settings page's per-provider "active" radio was
likewise replaced by a "Default model" control whose write path updates the
instance provider and the default agent's override together — see ADR
model-first-selection.md.
