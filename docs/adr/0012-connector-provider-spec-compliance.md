# ADR 0012: Connector + Provider Vocabulary, Spec Compliance, and Meta-Skills

## Decision

Gini's external-system integration surface uses the following vocabulary and conventions:

- **Connector** — the managed record for an external system Gini connects to (renamed from `Identity`, reverting to the original term now that the concept is precise). Holds credentials, scopes, secret references, health.
- **Provider** — the discriminator inside a connector (renamed from `kind`). Identifies which integration code handles this connector — `linear`, `demo`, `claude-code`, `codex`, `generic`, etc.
- **Skill** — the package, as defined by the Anthropic Agent Skills specification. A folder containing `SKILL.md` plus optional `scripts/`, `references/`, `assets/`.

A skill is active iff every connector it declares as required exists and is healthy. Activation is automatic, deactivation is automatic.

SKILL.md files conform to the Anthropic spec. Gini-specific extensions (provider requirements, prerequisites, version, author, platforms) live under `metadata.gini.*` so skills are portable to Claude Code, OpenClaw, Hermes, and other spec-conforming agent runtimes.

Skills are discovered by filesystem watch, matching every other agent ecosystem. The HTTP `POST /api/skills` endpoint is a convenience for remote install (phone, install-skill meta-skill from chat) but writes to the same watched directory.

## Context

Three prior ADRs (0006 Identity Secret Storage, 0007 Skills and Identities — now numbered 0008 and 0009 after the merge collision) established the model: separate credential plane (Identity), separate skill plane, activation by dependency. The work shipped. In use, three things became clear:

1. **"Identity" was awkward for the heterogeneous cases.** A Linear identity reads fine ("I am authenticated to Linear"). An Apple Notes identity reads strangely (you don't have a Notes "identity"; you have a *connection* to it via OS permission). A Claude Code CLI identity reads stranger still. "Connector" is industry vocabulary (Zapier, Airbyte, Vercel, n8n) and fits every case: a Linear connector, an Apple Notes connector, a Claude Code connector, a generic connector.
2. **"Kind" was opaque.** It told the reader nothing about what it discriminates. "Provider" matches the OAuth/auth-provider vocabulary every developer already knows and reads correctly across cases: provider=linear, provider=apple-notes, provider=claude-code.
3. **Gini's SKILL.md format diverged from the Anthropic spec at the top level.** `version`, `author`, `platforms`, `prerequisites`, `requires` were all Gini inventions outside the spec's frontmatter schema. The spec explicitly carves out a `metadata` field for client extensions; that's where they belong.

The cost of fixing all three is small (mechanical renames + frontmatter migration), the benefit is real (clearer vocabulary, ecosystem portability, validation tooling, alignment with what users already know from other agent products).

## Required Now

### Vocabulary

- `IdentityRecord` → `ConnectorRecord`. Field `kind` → `provider`.
- `RuntimeState.identities` → `RuntimeState.connectors`.
- `src/integrations/identities/` → `src/integrations/connectors/`.
- `src/cli/commands/identities.ts` → `src/cli/commands/connectors.ts`.
- Routes: `/api/identities*` → `/api/connectors*`.
- CLI: `gini identity ...` → `gini connector ...`.
- Audit event names: `identity.*` → `connector.*`.
- Helpers: `isSkillActive`, `resolveSkillEnv`, `resolveActiveSkillsEnv` keep their names — the verb operates on skills.
- Web: `useIdentities` → `useConnectors`. The route moves from `/connections` to `/connectors`; sidebar label and page title both read "Connectors". Underlying queries and types match the new vocabulary.
- State migration: on load, rename `state.identities` → `state.connectors` and `record.kind` → `record.provider` silently. No back-compat shim is exposed.
- ADR 0008 title becomes "Connector Secret Storage"; ADR 0009 becomes "Skills and Connectors." Body text updated to match.

### SKILL.md spec compliance

- Frontmatter conforms to `agentskills.io/specification`:
  - Top-level: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` only.
  - Gini-specific fields live under `metadata.gini.*`:
    ```yaml
    metadata:
      gini:
        version: 1.0.0
        author: Gini
        platforms: [macos, linux]
        prerequisites:
          commands: [curl, git]
          env: [LINEAR_API_KEY]
        requires:
          connectors:                      # was identities
            - provider: linear             # was kind
              scopes: [issues:read]
    ```
- `compatibility` carries a human-readable summary of environment requirements ("Requires curl and git. Needs a healthy Linear connector.").
- Skill loader reads `metadata.gini.*` paths first. For one release, fall back to legacy top-level fields with a deprecation log. Remove the fallback in the release after.
- Bundled skills migrated to the new shape in this PR: `apple-notes`, `apple-reminders`, `claude-code`, `codex`, `linear`.
- The misspelled directory `skills/agnets/` is renamed to `skills/agents/`.

### Validation

- `bun run gini skill validate <path>` lints a SKILL.md against the spec (name format, description length, frontmatter schema, parent-dir match) and against Gini-specific extension rules (declared provider must exist in the registry; unknown providers warn with the suggestion to use `generic`).
- The skill loader runs the same validation at load time. Unsupported skills mount with `status: "unsupported"` and a message; they never reach the activation gate.

### `allowed-tools`

- Parsed from SKILL.md frontmatter (top-level per spec) into `SkillRecord.allowedTools: string`.
- Surfaced in the install-skill review step and in the Skills UI ("this skill says it will use: …").
- Stored, not enforced. Enforcement at the tool dispatcher is deferred until the tool catalog grammar is stable (separate ADR or follow-up).

### Generic provider

- Reserved provider id `generic`. Form fields are dynamic: user supplies a label and a list of `{ name, value, secret: boolean }` pairs in the Add Connector dialog. Probe is "all required fields non-empty" (best-effort; no remote check).
- Used as the install-skill fallback when a skill requires a provider Gini does not have natively.
- A connector record with `provider: "generic"` has its fields stored in `secretRefs` (for secret fields) or `metadata` (for non-secret fields like base URLs).

### Probe contract

- The probe function on a `ProviderModule` is **optional**. Providers without a probe (generic, presence-only providers without a remote system to query) keep `health: "unknown"` or `health: "healthy"` based on a configured static default.
- A scheduled background job re-probes every connector whose provider declares a probe, with a configurable per-provider interval (default 30 minutes). Probes that time out (>10s) fail closed. Probes that succeed flip health to `healthy`; failures flip to `unhealthy` with the surfaced message.
- The activation gate treats `health === "unknown"` as active if the provider has no probe (the connector exists, no failing signal). Treats `health === "unknown"` as inactive if the provider *does* have a probe but hasn't run yet — to avoid surfacing skills before their first probe.

### Skill installation flow

- **Primary discovery**: filesystem watch on `skills/` (bundled) and `~/.gini/instances/<inst>/skills/` (user). Matches Claude Code, Anthropic spec, OpenClaw, Hermes conventions.
- **API convenience**: `POST /api/skills` accepts a SKILL.md (with optional script payloads) and writes to the user-skills directory. Triggers loader reload. Returns the new SkillRecord.
- No "registered vs not" duality. The filesystem is the state.

### Meta-skills

Two new bundled skills under `skills/meta/`:

- **`create-skill`** — handles "create a skill that does X." Generates a spec-compliant SKILL.md, a stub script if needed, and `metadata.gini.requires.connectors` declarations. Validates before writing. Can also convert an existing non-spec skill to the new format.
- **`install-skill`** — handles "install this skill" (pasted content, URL, or file path). Reads the SKILL.md, validates frontmatter, reviews scripts for risk (summarizes what they access), explains required connectors and `allowed-tools` to the user, installs via the API, walks through trust. Defaults to forward motion: when a required provider is not natively supported, installs with `generic` and continues, surfacing the tradeoff but not asking for a yes/no.

Both are bundled, trusted by default, and declare `metadata.gini.requires.connectors: []` (they don't need external systems themselves).

### Web UI

- **Skills page** (new) at `/skills`. Lists every loaded SkillRecord with status: `active`, `needs setup`, `unsupported`, `untrusted`. Per-skill rows show `requires.connectors`, `prerequisites.commands`, `prerequisites.env`, `allowed-tools` with per-entry resolution status. "Connect →" affordance on missing connectors opens the Add Connector dialog with `provider` pre-filled.
- **Trust toggle** on each user-installed skill ("source: user"). Bundled skills are auto-trusted and the toggle is read-only.
- **Connectors page** at `/connectors`. Cards label "Connector" not "Identity"; dependents column reads "Used by: linear skill, custom-jira skill."

## Rejected

- **Two-PR split.** Keeping the rename and the spec compliance in separate PRs would mean a stale-vocabulary window in main. Net churn is the same; bundling reduces total review surface and avoids two sweeping renames.
- **Top-level Gini extension fields.** Mixing `version`, `prerequisites`, `requires` at the top level alongside spec fields confuses spec-conforming runtimes and prevents `skills-ref validate` from passing. The spec's `metadata` field is the intended extension point.
- **Forced probes.** Demanding every provider implement a probe excludes presence-only providers (apple-notes, generic). Best-effort with explicit `unknown` health is more honest.
- **API-primary skill installation.** Breaks the universal filesystem-watch convention. Filesystem stays primary; API is convenience.

## Deferred

- `allowed-tools` enforcement at the tool dispatcher. Parsed and surfaced now; enforced once the tool catalog grammar stabilizes.
- Config-file user-registered providers (`~/.gini/instances/<inst>/connector-providers/<id>.yaml`). Not yet needed; generic provider covers the common BYO case.
- Plugin providers (user-supplied TypeScript). Real security surface; MCP servers already cover the use case.
- Per-provider probe schedules in the registry. v1 uses a single default interval.
- OAuth flows for providers that require them. v1 providers use static credentials.

## Consequences For Coding Agents

- Use `ConnectorRecord`, `/api/connectors`, `gini connector ...`, `metadata.gini.requires.connectors[].provider` everywhere. Do not introduce or revive `Identity` or `kind`.
- When adding a provider, place per-provider code under `src/integrations/connectors/<provider>.ts`. Export a `ProviderModule` conforming to the central contract. Add a registry entry. Do not let provider-specific code leak into the generic connector runtime.
- When authoring or migrating skills, use the spec frontmatter. Gini extensions live under `metadata.gini.*`. Run `gini skill validate` before shipping.
- The skill is the integration package. Do not introduce an "Integration" type, "Provider" record (separate from the connector's provider field), or any other concept above Skill.
- Filesystem-based skill discovery is the contract. `POST /api/skills` writes to the same directory; it is not a separate registration plane.
- The activation gate is the source of truth for "is this skill in the agent's capability set." Do not duplicate it at the UI layer; ask the gateway.

## Acceptance Checks

- `bun run typecheck` clean (root + web).
- `bun test` passes including new tests for connector CRUD, skill loader spec compliance, allowed-tools parsing, validate command, generic provider fields.
- `bun run gini smoke` runs to completion with renamed routes.
- `rg connector` returns expected matches (production code, ADRs, tests). `rg "kind:" src/integrations/` returns no production matches in the new provider registry code.
- `rg identity src web` returns no production-code matches outside migration helpers and ADR history.
- `bun run gini skill validate skills/apple/apple-notes/SKILL.md` passes for every bundled skill.
- `bun run gini connector add --provider demo --name test` works; `bun run gini connector list` shows it; `bun run gini connector remove <id>` removes it.
- HTTP CRUD round-trip on `/api/connectors` confirms plaintext secrets never appear in state.json.
- Add Connector dialog shows correct fields per provider (token for linear, dynamic for generic, none for claude-code/codex).
- Skills page shows every loaded skill with correct activation status, with "Connect →" on missing connectors deeplinking to Add Connector with provider pre-filled.
- Trust toggle on user-installed skills works; activation gate respects it.
- create-skill meta-skill is bundled, trusted, active, and produces a valid SKILL.md when invoked via a real agent task.
- install-skill meta-skill is bundled, trusted, active, and installs a pasted SKILL.md end-to-end (validating, reviewing, walking trust, installing via API, confirming activation).
- Periodic re-probe job runs at the configured interval, updates health, emits audit events on transitions.
- A live browser test of the Connectors page + Skills page confirms the renamed vocabulary, add/delete flows, trust toggle, and deeplink between pages all work.
- A live functional test on the running instance invokes both meta-skills via a task and verifies the outcome on disk.
