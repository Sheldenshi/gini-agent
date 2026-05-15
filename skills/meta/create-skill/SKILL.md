---
name: create-skill
description: "Author a new SKILL.md from a user prompt, or migrate an existing non-spec skill to the Anthropic Agent Skills format."
license: MIT
compatibility: "Requires the gini gateway."
allowed-tools: "Bash file_write file_patch"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: meta
    requires:
      connectors: []
---

# Create Skill

You author new skills from a prompt and migrate legacy skills to the
Anthropic Agent Skills specification. The goal is one spec-compliant
SKILL.md plus optional scripts the agent can later run.

## When To Use

- User asks "create a skill for X" or "add a skill that does X".
- User pastes a SKILL.md that is missing required fields or uses the
  legacy top-level fields (`version`, `author`, `platforms`,
  `prerequisites`, `requires.connectors`).
- User asks "make this work" while looking at a non-spec SKILL.md.

## Spec Reference

Required top-level frontmatter keys (Anthropic Agent Skills spec):

- `name` — max 64 chars, lowercase + digits + hyphens, must equal the
  parent directory name.
- `description` — max 1024 chars.

Optional spec keys:

- `license` — free-form string.
- `compatibility` — max 500 chars; human summary of environment needs.
- `metadata` — arbitrary; Gini extensions live under `metadata.gini.*`.
- `allowed-tools` — space-separated list of tool names the skill plans
  to invoke (advisory; recorded in audit trail).

Gini extensions (under `metadata.gini`):

- `version`, `author`, `platforms`, `category`
- `prerequisites: { commands, env }`
- `requires.connectors: [{ provider, scopes? }]`

## Procedure

1. Confirm the user's intent. If the request is "create a skill that
   posts to Slack", clarify whether the skill should also read messages,
   list channels, etc. — surface the cardinality so the design is right.

2. Decide on a provider. If a fitting connector exists in
   `/api/connectors/providers`, use it. If not, declare `provider: generic`
   under `requires.connectors`. Do not ask the user to pick between
   install/skip on unknown providers — default to forward motion.

3. Draft the frontmatter. Use this template:

   ```yaml
   ---
   name: <kebab-case-name>
   description: "<one-liner>"
   license: MIT
   compatibility: "<one sentence describing host requirements>"
   allowed-tools: "<space-separated tool names>"
   metadata:
     gini:
       version: 1.0.0
       author: <user-or-"Gini">
       platforms: [<macos|linux|windows>]
       prerequisites:
         commands: [<cli names>]
         env: [<ENV_VAR_NAMES>]
       requires:
         connectors:
           - provider: <id>
             scopes: [<optional>]
   ---
   ```

4. Write the body. The body is the model's manual for this skill at
   runtime — concrete examples, when-to-use / when-not-to-use sections,
   exact commands. Imitate the body shape of `skills/productivity/linear/
   SKILL.md` or `skills/apple/apple-notes/SKILL.md` for a working
   reference.

5. Validate before writing to disk. Run:

   ```bash
   bun run gini skill validate /tmp/draft-skill.md
   ```

   Fix every issue the validator reports. Common failures:
   - `name` is uppercase or contains underscores → switch to kebab-case.
   - `description` exceeds 1024 chars → tighten it.
   - parent dir name doesn't match `name` → adjust whichever is wrong.
   - required provider doesn't exist → switch to `generic` or add the
     provider module first.

6. Install the skill via the API so the runtime picks it up:

   ```bash
   curl -sS -X POST http://localhost:<runtime-port>/api/skills \
     -H "authorization: Bearer $GINI_TOKEN" \
     -H "content-type: application/json" \
     -d "$(jq -nc \
       --arg body "$(cat /tmp/draft-skill.md)" \
       --arg category "<optional category override>" \
       '{ body: $body, category: $category }')"
   ```

   The endpoint writes the file under
   `~/.gini/instances/<instance>/skills/<category>/<name>/SKILL.md`
   and triggers a loader reload. The response includes the new
   `SkillRecord` with `validation: { ok, issues }`.

7. Walk the connector dependency:

   - List the providers the skill declares in `requires.connectors`.
   - For each, check `GET /api/connectors`. If a healthy connector for
     that provider already exists, you are done.
   - If not, tell the user: "Open `/skills`, find the new skill, and
     click the inline `[Set up <Provider>]` button next to the missing
     connector." There is no standalone Connectors page; setup is
     inline on the Skills page.

## Migration Mode

When converting a legacy SKILL.md, the recipe is:

1. Move `version`, `author`, `platforms`, `prerequisites`, and
   `requires.connectors` (with `provider:` items) under
   `metadata.gini.*` — paying attention to the renames introduced by
   ADR connector-provider-spec-compliance.md:
   - `requires.identities[].kind` → `requires.connectors[].provider`.
   The legacy `requires.identities` / `kind:` shape is what older
   pre-ADR-connector-provider-spec-compliance.md SKILL.md files used; rewrite both keys when migrating.

2. Move `compatibility` to the top level if you can describe the host
   contract in ≤ 500 chars.

3. Add `allowed-tools` at the top level when the skill is meant to run
   under an agent harness that respects it.

4. Re-validate with `gini skill validate` before installing.

## Rules

- Never write a skill without validating first.
- Always check `GET /api/connectors/providers` for the providers the new
  skill will depend on. Prefer existing providers over `generic`.
- Bundled skills are immutable from the agent's perspective — if the
  user asks to edit a bundled skill, instead create a user-source copy
  with the same name. The runtime keeps both as separate rows.
- Do not embed plaintext API tokens or secrets in SKILL.md body.
