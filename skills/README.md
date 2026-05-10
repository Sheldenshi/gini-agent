# Bundled Skills

This directory ships with the runtime. Each subdirectory uses the layout:

```
skills/<category>/<skill-name>/SKILL.md
```

A `SKILL.md` is a markdown file with YAML frontmatter (`name`,
`description`, `version`, `platforms`, `prerequisites`, …) followed by a
markdown body that teaches the LLM when to use the skill, when not to use
it, and which shell commands the skill wraps. The body is loaded on demand
via the `read_skill` tool so the model only pays the token cost when it
actually needs the skill.

## Auto-load

`loadSkillsFromDisk` runs at runtime boot and on `POST /api/skills/reload`.
It walks this directory (each loaded record is tagged `source: "bundled"`)
plus `~/.gini/instances/<instance>/skills/` (tagged `source: "user"`) and
upserts each `SKILL.md` into runtime state. Skills are matched by
`(name, source)` so a user-instance `SKILL.md` named the same as a bundled
skill lands as its own row instead of overwriting the vendored one.
Re-running the loader bumps the numeric `version` when content changes
without resetting user-set fields like `status`.

## Auto-trust allowlist

Vendored bundled skills in this directory are reviewed by maintainers, so
the loader auto-trusts the following on first import (the demo flow can
exercise them without the user clicking through `/api/skills/<id>/trust`):

- `apple-notes`
- `apple-reminders`

A skill the user has explicitly disabled stays disabled across reloads.

## Platform gating

Skills with a `platforms:` frontmatter list that doesn't include the host
platform are skipped at load time. The skipped reason is surfaced in the
LoadReport returned from `loadSkillsFromDisk` and emitted as a `skill`
runtime event.

## Adding a new bundled skill

1. Create `skills/<category>/<your-skill>/SKILL.md` with the frontmatter
   shape used by the existing apple skills.
2. Restart the runtime (or `curl -X POST /api/skills/reload`).
3. The skill appears in the `/skills` page; trust it from the UI or via
   `POST /api/skills/<id>/trust` to expose it to the agent loop.

## Auto-approving the underlying shell commands

Skills like `apple-notes` and `apple-reminders` invoke trusted CLIs
(`memo`, `remindctl`) through `terminal_exec`, which is approval-gated by
default. To skip the approval prompt for those commands, add a glob
pattern to the per-instance `autoApproveCommands` list in
`~/.gini/instances/<instance>/config.json`:

```json
{
  "autoApproveCommands": ["memo *", "remindctl *"]
}
```

Patterns are anchored on both ends (so `memo *` matches `memo notes -a`
but NOT `rm -rf / && memo notes`). `*` and `?` use the standard shell
glob semantics; everything else is a literal match. Auto-approved
commands still write a high-risk `terminal.exec` audit row with
`evidence.autoApproved=true` and `evidence.autoApprovedReason=<pattern>`
so the activity trail stays intact.

The list can also be updated at runtime via `PATCH
/api/settings/auto-approve` with body `{ "patterns": ["memo *", ...] }`;
the change persists to disk and takes effect immediately for new
`terminal_exec` calls.
