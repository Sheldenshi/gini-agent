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
      credentials: []
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
- `requires.credentials: [<credential-name>]` — the credential names the
  skill needs, referenced by name (e.g. `[LINEAR_API_KEY]` for an
  api-key credential, `[google-workspace-oauth]` for the Google oauth2
  credential). This is the current, preferred form.
- `requires.connectors: [{ provider, scopes? }]` — still accepted for
  backward compatibility during the migration window; prefer
  `requires.credentials`.

## Procedure

1. Confirm the user's intent. If the request is "create a skill that
   posts to Slack", clarify whether the skill should also read messages,
   list channels, etc. — surface the cardinality so the design is right.

2. Decide whether the skill needs a credential. Use
   `requires.credentials` only when the skill needs a configured account,
   credential, remote API, or connector-backed local integration. Each
   entry is a credential NAME — `LINEAR_API_KEY` for an api-key
   credential, `google-workspace-oauth` for the Google oauth2 credential.
   Check the configured credentials in `GET /api/connectors` to find the
   right name. If the skill only needs local commands such as `git`,
   `gh`, `jq`, or `curl`, record those under `prerequisites.commands` and
   set `requires.credentials: []`. If the skill truly needs a credential
   that hasn't been configured yet, name it the way the credential will
   be stored (the env-var name for an api-key) and tell the user to add
   it. Do not ask the user to pick between install/skip on unknown
   credentials — default to forward motion.
   (`requires.connectors: [{ provider }]` is still accepted for backward
   compatibility, but `requires.credentials` is preferred.)

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
         # Leave empty for local-command-only skills. If a credential is
         # needed, list it by name, e.g. [LINEAR_API_KEY] or
         # [google-workspace-oauth].
         credentials: []
   ---
   ```

4. Write the body. The body is the model's manual for this skill at
   runtime — concrete examples, when-to-use / when-not-to-use sections,
   exact commands. Imitate the body shape of
   `skills/apple/apple-notes/SKILL.md` for a working reference.

5. Validate before writing to disk. Run:

   ```bash
   bun run gini skill validate /tmp/draft-skill.md
   ```

   Fix every issue the validator reports. Common failures:
   - `name` is uppercase or contains underscores → switch to kebab-case.
   - `description` exceeds 1024 chars → tighten it.
   - parent dir name doesn't match `name` → adjust whichever is wrong.
   - required credential name is malformed → an api-key name must be an
     env token (`[A-Z][A-Z0-9_]*`, e.g. `LINEAR_API_KEY`); if the skill
     only needs local commands, remove the credential requirement.

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

7. Walk the credential dependency:

   - List the credential names the skill declares in
     `requires.credentials`.
   - For each, check `GET /api/connectors`. If a healthy credential with
     that name already exists, you are done.
   - If not, prompt the user in chat with `request_connector` (passing the
     new skill's id as `skillId`) so they can enter it securely — the card
     stores the credential and grants it to the skill in one step. For a
     credential with no registered provider, use the templateless
     `{name, type, skillId}` shape. The `/skills` page (find the new skill,
     click the inline `[Set up <Credential>]` button) is a fallback when the
     secure card cannot render. There is no standalone Connectors page.

## Migration Mode

When converting a legacy SKILL.md, the recipe is:

1. Move `version`, `author`, `platforms`, `prerequisites`, and the
   credential requirement under `metadata.gini.*`, landing on the current
   `requires.credentials: [<name>]` form. Convert legacy connector
   declarations to credential names:
   - `requires.identities[].kind` and `requires.connectors[].provider` →
     `requires.credentials[]` names (e.g. `linear` → `LINEAR_API_KEY`,
     `google-oauth-desktop` → `google-workspace-oauth`).
   The legacy `requires.identities` / `kind:` and `requires.connectors` /
   `provider:` shapes are what older SKILL.md files used;
   `requires.connectors` is still accepted for backward compatibility, but
   migrate to `requires.credentials` when rewriting.

2. Move `compatibility` to the top level if you can describe the host
   contract in ≤ 500 chars.

3. Add `allowed-tools` at the top level when the skill is meant to run
   under an agent harness that respects it.

4. Re-validate with `gini skill validate` before installing.

## Rules

- Never write a skill without validating first.
- Always check `GET /api/connectors` for the credentials the new skill
  will depend on, and reference them by name in `requires.credentials`.
  Do not add a credential requirement for local-command-only skills.
- Bundled skills are immutable from the agent's perspective — if the
  user asks to edit a bundled skill, instead create a user-source copy
  with the same name. The runtime keeps both as separate rows.
- Do not embed plaintext API tokens or secrets in SKILL.md body.
