# ADR: Per-skill connector consent grant

## Decision

A skill receives a credential's env only after a
per-`(skill, credential)` **user grant**, keyed on the credential name.
Declaring the credential is no longer sufficient.

- `resolveSkillEnv(config, skill, taskId?)` in
  `src/integrations/connectors/index.ts` injects a credential's secret into a
  skill's spawn env only when **either** the skill is first-party
  (`source === "bundled"`, auto-granted) **or** the skill's
  `grantedConnectors` array includes that credential **name**
  (`bundled || grantedConnectors.includes(credentialName)`). An ungranted
  non-bundled skill resolves to `{}` even if it requires the credential and a
  healthy credential exists.

- The grant is requested at **enable time** for the model-driven path. When
  the `enable_skill` tool is called on a non-bundled skill whose required
  credentials carry a secret, the dispatcher mints a
  `skill.grant_connector` SetupRequest (one per ungranted credential) and
  returns `{ kind: "pending" }` instead of enabling. The user grants via the
  inline chat card; `/api/setup-requests/<id>/complete` appends the credential
  name to `grantedConnectors`. The skill is enabled **only when every
  credentialed requirement is granted** — the `/complete` handler re-evaluates
  the remaining ungranted credentials server-side: if any remain it mints the
  next `skill.grant_connector` card (attached to the same task) and keeps the
  task pending without enabling; only when none remain does it set the skill
  `enabled` and resume the chat-task loop. A grant is recorded only through
  this consent flow — no other path writes `grantedConnectors`.

- **Bundled skills are auto-granted** by short-circuit in `resolveSkillEnv`
  (`(skill.source ?? "user") === "bundled"`). No grant is ever written onto
  a bundled record, so first-party skills (linear, attachments, google-*)
  keep a clean UX with no consent prompt.

- **Revoked on disable.** Both disable paths — `setSkillStatus` and the
  status-only `updateSkill` PATCH (`PATCH /api/skills/<id>`) — clear
  `grantedConnectors` on the transition to `disabled` and emit one
  `skill.connector.revoked` audit row per cleared credential, so re-enabling
  re-prompts for consent and never reuses a stale grant.

- A credential "carries a secret" — and therefore needs consent — when its
  connector record has a `type` (`api-key` or `oauth2`). Presence-only
  connectors (no `type`, no env) leak nothing and need no grant.

## Context

Credentials bind to skills through SKILL.md frontmatter:
`metadata.gini.requires.credentials` declares the credential **names** a
skill needs (ADR typed-named-credentials.md), and
`metadata.gini.prerequisites.env` lists the env var names its scripts read.
ADR skill-env-containment.md scopes credential injection to one skill at a
time through `skill_run` / `resolveSkillEnv`.

A presence-only existence check leaves a gap: a skill that merely
**declares** a credential and runs while a healthy credential exists would
receive that secret. The trust decision would collapse into the skill's own
manifest — exactly the surface a model-authored or model-installed skill (or
a prompt injection that installs one) controls. A freshly authored skill
could silently acquire a credential the user connected for a different
purpose.

The credential model is only safe when the human, not the manifest, decides
which skill may use which credential. This ADR adds that decision as an
explicit per-`(skill, credential)` consent gate, checked at the single
injection point.

## Considered alternatives

- **Trust the declaration (status quo).** Rejected: the manifest is
  attacker-controllable for non-bundled skills; declaration is not consent.

- **A new approval mechanism / dedicated consent store.** Rejected for
  Simplicity First. The SetupRequest substrate (ADR
  authorization-vs-setup-request.md) already models "user performs a setup
  step, the side effect runs in `/complete`, the chat-task loop resumes." A
  `skill.grant_connector` action reuses it verbatim — no new UI framework, no
  new state collection. The grant itself lives as a `grantedConnectors`
  string array on the existing `SkillRecord`.

- **Per-grant revocation UI.** Not built here. Disable clears all grants for
  the skill, which is the coarse-but-correct revocation primitive; finer
  per-connector revocation can layer on later via `revokeConnectorGrant`.

- **Auto-grant credentialed connectors on the settings-page enable.**
  Rejected. `POST /api/skills/<id>/enable` is just an HTTP route — the model
  can reach it (e.g. via the web BFF surface), so auto-granting there would
  let a model-installed skill silently acquire a credential and bypass the
  gate entirely. Enabling a skill therefore **never** grants a connector;
  grants flow only through the `skill.grant_connector` consent flow. Enabling
  a non-bundled credentialed skill via `/enable` is safe and stays env-denied:
  `resolveSkillEnv` returns `{}` for any credential that is neither bundled nor
  in `grantedConnectors`, so the skill remains inert until the user grants it
  through the consent card.

## Consequences

### Required

- Non-bundled skills that ship `prerequisites.env` + `requires.connectors`
  prompt for a one-time consent grant the first time they're enabled by the
  model. The `enable_skill` tool description documents this so the model
  expects a pending result and surfaces the card rather than retrying.

- The consent card renders only in an interactive web chat session. Enabling
  a credentialed non-bundled skill from a surface that can't render it — a
  messaging bridge (Telegram/Discord), a headless subagent with no chat
  session, or a scheduled/headless job session (`origin: "job"`) — fails
  synchronously with an "open the web chat to grant" message, mirroring the
  `browser_fill_secret` surface guard, so the task never parks unresolvably on
  a card no one can see.

- Any future code that spawns a process with connector env must go through
  `resolveSkillEnv`, which enforces the gate. Re-implementing the binding
  resolution elsewhere would bypass consent.

### Audited surfaces

- `skill.connector.granted` / `skill.connector.revoked` audit rows record
  every grant change (`evidence.provider` holds the credential name), so
  operators can answer "which skill was granted which credential, and when."
- `setup.requested` / `setup.completed` rows from the SetupRequest substrate
  bracket the consent flow.

### Trust boundary

The grant is the trust boundary. A skill's manifest declares *intent* to use
a connector; the `grantedConnectors` grant (or bundled-auto-grant) is the
*authorization*. `resolveSkillEnv` enforces authorization, not intent, at the
single point where a credential would enter a process.

## Implementation surface

- `src/types.ts`: `SkillRecord.grantedConnectors?: string[]`; new
  `"skill.grant_connector"` member of `SetupRequestAction`.
- `src/integrations/connectors/index.ts`: `resolveSkillEnv` resolves env
  through a single name-based path. It maps each required credential name to
  its usable connector record, resolves env vars via `bindingsForCredentials`,
  and injects a value only when `bundled || grantedConnectors.includes(credentialName)`
  holds for the credential that owns the env var. There is no provider-keyed
  or generic-fallback branch.
- `src/capabilities/skills.ts`: `grantConnectorToSkill` /
  `revokeConnectorGrant` mutate `grantedConnectors` and write the audit
  rows; a shared `clearConnectorGrantsOnDisable` helper clears grants and
  emits one `skill.connector.revoked` row per cleared credential from both the
  `setSkillStatus` and `updateSkill` PATCH disable paths.
- `src/execution/tool-dispatch.ts`: `setSkillStatusTool` returns a
  `DispatchResult`; on enable of a non-bundled credentialed skill it mints a
  `skill.grant_connector` SetupRequest (surface-guarded) and returns
  `{ kind: "pending" }`. The dispatcher's `enable_skill` / `disable_skill`
  cases return the dispatch result directly.
- `src/http.ts`: the `/complete` `skill.grant_connector` branch appends the
  grant, then enables the skill only when no credentialed requirements remain
  ungranted — otherwise it mints the next grant card and leaves the task
  pending. The settings-page `/enable` endpoint never grants connectors.
- `src/execution/tool-catalog.ts`: `enable_skill` description notes the
  one-time consent prompt.
- `web/src/components/chat/BlockSetupRequested.tsx`: Grant / Cancel card for
  the `skill.grant_connector` action.
- `web/src/app/permissions/page.tsx`: "Grant skill access" label for the new
  action in the setup-request list.

## Acceptance checks

- `bun test src/integrations/connectors/index.test.ts` — ungranted
  non-bundled skill resolves to `{}`; granted non-bundled and bundled skills
  inject.
- `bun test src/capabilities/skills.test.ts` — grant / revoke audit rows;
  both the `setSkillStatus` and `updateSkill` PATCH disable paths clear grants
  and emit one `skill.connector.revoked` row per cleared credential.
- `bun test src/execution/skill-dispatch.test.ts` — non-bundled credentialed
  enable mints the SetupRequest (pending); bundled and already-granted enable
  immediately; the messaging-bridge and `origin: "job"` surfaces return a sync
  error with no setup row; re-entering enable while a grant is pending
  references the existing request instead of minting a duplicate.
- `bun test src/http.test.ts` — the `skill.grant_connector` `/complete`
  branch grants the credential and enables a single-credential skill; for a
  multi-credential skill it grants one credential, stays disabled, and mints
  the next grant card.

## Related

- ADR `skill-env-containment.md` — the single-surface containment this gate
  sits on top of; `resolveSkillEnv` is the enforcement point.
- ADR `connector-secret-storage.md` — how the connector secret is encrypted
  at rest before `resolveSkillEnv` resolves it at spawn.
- ADR `authorization-vs-setup-request.md` — the SetupRequest substrate the
  `skill.grant_connector` action reuses.
- ADR `typed-named-credentials.md` — the name-based credential binding model;
  the consent gate keys on the credential name defined there, and a credential
  "carries a secret" when its connector record has a `type`.
