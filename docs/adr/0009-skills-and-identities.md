# ADR 0009: Skills As Packages, Identities As Credentials

## Decision

Gini has two top-level user-facing primitives for integrating with the outside world:

- **Skill** — the package. A folder under `skills/` (bundled) or `~/.gini/instances/<inst>/skills/` (user-installed) containing `SKILL.md` (markdown for the agent), optional helper scripts, and YAML frontmatter declaring requirements. This is the unit a user thinks of as "the Linear thing my agent can do." Already present in Gini.
- **Identity** — the managed credential record. Stores secrets, scopes, and health for an external account (e.g. Linear API key, Google OAuth tokens) or local permission grant (e.g. macOS TCC for Notes). Renamed from the previous "Connector" concept.

A skill is **active** if and only if every identity it declares as required exists and is healthy. Activation is automatic; deactivation is automatic when an identity becomes unhealthy. The agent loop never sees inactive skills.

There is no separate "Integration" or "Connector" concept above either of these. The Skill *is* the package; the Identity *is* the credential plane. This matches the Hermes and OpenClaw conventions for skill-as-package, with Gini's addition being a managed credential plane that those projects punt to environment variables for.

## Context

Earlier framings of this surface used a "Connector" record that conflated three things — auth/identity, tool/execution, and knowledge/instructions — into one undefined record. The actual implementation already separated these concerns: `SkillRecord` is the package (markdown + scripts + declared requirements), `ToolRecord` / `ToolsetRecord` is the execution layer (subprocess, MCP, HTTP), and `ConnectorRecord` was a stub for the auth layer. The conflation lived only in vocabulary.

Two observations forced clarity:

1. **Hermes and OpenClaw both use "skill" as the user-facing package.** A Hermes Linear skill is `skills/productivity/linear/SKILL.md` plus `scripts/linear_api.py` plus frontmatter declaring `LINEAR_API_KEY` as a required env var. OpenClaw's skill format is the same shape. Both explicitly do not bundle credentials; they declare requirements. Gini's `SkillRecord` already has this shape (`body`, `manifestPath`, `prerequisites.env`, `requiredTools`, `requiredPermissions`, `source: bundled | user`). The convention is well-established and Gini already follows it.
2. **The screenless-Mac model breaks the "punt to env vars" approach.** A user interacting with Gini from a phone or remote web client cannot `export LINEAR_API_KEY=...` on the host. Credentials must be managed by the runtime, not the user's shell. This is the gap Hermes and OpenClaw don't fill and Gini must.

The right shape is: skills stay as packages, Identities become a first-class managed credential plane, and skills declare which identities they need. The two records bind by dependency, not by merging.

Cardinality forces this separation. A single Google identity powers Gmail, Calendar, Drive, Docs, and Sheets skills. A single skill ("schedule meeting and send invite") needs multiple identities (Calendar + Mail). Merging skill and identity into one record would either force per-skill credential duplication or per-record multi-credential bundling. Both are worse than a dependency edge.

## Required Now

### Skill record

- `SkillRecord` gains a `requiredIdentities: { kind: string; scopes?: string[] }[]` field, parsed from SKILL.md frontmatter under `requires.identities` (or equivalent).
- Skill loading remains unchanged for bundled and user skills.

### Identity record

- `ConnectorRecord` is renamed to `IdentityRecord`. Field-level shape is preserved where it makes sense; secret storage follows ADR 0008.
- `RuntimeState.connectors` is renamed to `RuntimeState.identities`. No back-compat shim — state files are rewritten on first load if needed.
- HTTP route prefix is `/api/identities`. The old `/api/connectors` prefix is removed.
- CLI command is `gini identity ...`. The old `gini connector ...` command is removed.
- Per-kind health probes live in `src/integrations/identities/<kind>.ts`. The demo kind keeps its no-op behavior; new kinds (e.g. `linear`) make real network calls during health checks.

### Activation by dependency

- When the agent loop lists available skills, it filters out any skill whose `requiredIdentities` are not all satisfied by a healthy identity.
- Skill execution paths (subprocess spawn, tool dispatch) re-check at call time as a defensive guard.
- When a skill spawns a subprocess that declares `prerequisites.env`, the runtime resolves those env vars from matching identities and injects them into the subprocess environment. Plaintext secrets never appear in skill records, state, audit, or trace evidence.
- The Connections / Identities UI surface marks dependent skills as "needs setup: \<identity kind>" when their identities are missing or unhealthy.

### Trust and audit

- All identity mutations (create, update, rotate, delete, health) emit audit events tied to the identity id, per ADR 0002.
- Secret values never appear in audit evidence. Audit may include the identity id, the purpose, and a boolean of whether resolution succeeded.
- Risky tool calls that consume identity secrets continue to route through ADR 0002 approvals.

### UI

- The web "Connections" tab is renamed "Identities" internally; the user-facing label may remain "Connections" if friendlier. The page supports add, rotate, and delete in addition to the existing health probe.
- Skills view (where it exists) surfaces dependency state: each skill shows its required identities and whether they are satisfied.

## Rejected

- Merging Skill and Identity into one record. Breaks N:M cardinality (one identity serves many skills, one skill can need many identities) and conflates curated bundled content with user-specific runtime data on differing lifecycles.
- An "Integration" wrapper above Skill. Hermes and OpenClaw demonstrate that the skill *is* the integration; an additional layer adds vocabulary without changing semantics.
- Punting credentials to environment variables (Hermes/OpenClaw approach). Incompatible with the screenless-Mac model where the user has no shell access to the host.
- Reintroducing macOS Keychain as a secret backend (see ADR 0008).

## Deferred

- OAuth flows for identity kinds that require them (e.g. Google). v1 identity kinds use static credentials (API keys, PATs).
- Identity scope-aware approval policy (today scopes are advisory metadata).
- Per-skill UI editor or marketplace.
- Cross-instance identity sharing.

## Consequences For Coding Agents

- Use `IdentityRecord`, `/api/identities`, and `gini identity` everywhere. Do not introduce or revive `Connector` naming.
- When adding an identity kind, place per-kind code under `src/integrations/identities/<kind>.ts`. Export a health probe and (when applicable) a per-secret resolver. Do not let kind-specific code leak into the generic identity runtime.
- When adding a skill that needs credentials, declare them in the skill's frontmatter under `requires.identities` and reference them in scripts via env vars. Do not read identity records directly from skill code.
- Skill activation filtering is a runtime concern. Do not duplicate the "is this skill active" check at the UI layer; ask the gateway.
- Do not introduce an "Integration" type, table, or route. The skill is the package.

## Acceptance Checks

- `bun run gini identity add --kind demo --name "test"` creates an identity record and emits an audit event.
- `bun run gini identity health <id>` runs the per-kind probe and updates `health`.
- `bun run gini identity remove <id>` deletes the record and any associated encrypted secret files.
- A bundled skill that declares `requires.identities: [{ kind: linear }]` does not appear in the agent loop's available-skill list when no healthy `linear` identity exists.
- Adding a healthy `linear` identity makes the same skill appear; deleting or breaking the identity makes it disappear again.
- A subprocess launched by a skill receives the identity's resolved env vars; the skill record contains no plaintext secret.
- `bun run gini smoke` exercises identity CRUD and the activation gate.
- `rg connector src` returns no production-code matches (test fixtures and migration paths may transiently reference the old name during the rename, but should not in steady state).
