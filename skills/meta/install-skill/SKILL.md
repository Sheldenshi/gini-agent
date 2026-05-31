---
name: install-skill
description: "Install a pasted SKILL.md (or one fetched from a URL or file path) into the user-skill directory, reviewing risk and connector requirements."
license: MIT
compatibility: "Requires the gini gateway and curl. Skills that need extra binaries will fail health checks after install — surface that clearly."
allowed-tools: "Bash file_write"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: meta
    requires:
      credentials: []
---

# Install Skill

You install a SKILL.md the user supplied — pasted text, a URL, or a
file path — into the runtime's user-skills directory. You also review risk
and surface the credentials the new skill will need.

## When To Use

- User says "install this skill" with content attached.
- User says "add this skill from this URL".
- User asks you to import a Hermes / OpenClaw / Claude-Code skill.

## Procedure

1. Acquire the SKILL.md text:
   - If the user pasted it, use the pasted content verbatim.
   - If they supplied a URL, fetch with `curl -fsSL <url>`. Refuse if
     the host is not HTTPS unless it's `localhost`.
   - If they supplied a file path, read the file.

2. Validate the SKILL.md against the spec without writing to disk:

   ```bash
   bun run gini skill validate /tmp/incoming-skill.md
   ```

   - Exit code 0 → spec-compliant; continue.
   - Exit code non-zero → repair the obvious issues (kebab-case the
     name, trim the description, move legacy fields under
     `metadata.gini.*`). If the issues are substantive (referencing a
     credential that isn't configured), see step 4.

3. Review the scripts and the body for risk. Read every sidecar file
   the user provided. Summarize for the user:

   - Which commands the skill runs (`bash`, `curl`, `psql`, …).
   - Which env vars / secrets it reads.
   - Whether it can write outside its workspace.
   - Whether it makes outbound network calls and to which hosts.

4. Resolve the credential requirements declared under
   `metadata.gini.requires.credentials` (a list of credential names). An
   incoming skill may instead carry the legacy
   `metadata.gini.requires.connectors` (with `provider:` items); that form
   is still accepted, but rewrite it to `requires.credentials` names
   (e.g. `linear` → `LINEAR_API_KEY`, `google-oauth-desktop` →
   `google-workspace-oauth`) when you install:

   - For each credential name, check `GET /api/connectors` to see whether
     the user already has a healthy credential with that name.
   - If the skill only needs local commands or an already-authenticated CLI
     and does not need a credential-managed account, credential, remote API,
     or local integration, remove the credential requirement. Record
     command requirements under `metadata.gini.prerequisites.commands`.
   - If a required credential is NOT yet configured:
     **Default to forward motion** — but forward motion means "install,
     then prompt," not "install, then stop." Keep the requirement and
     install the skill (step 6). You MUST then prompt for the missing
     credential(s) in chat at step 7 (which is mandatory); do not present
     an install / hold-off binary choice, and do not treat installation as
     the finish line.

5. Surface the `allowed-tools` declaration to the user. Read the
   skill's frontmatter `allowed-tools` value (space-separated) and
   summarize for the user: "This skill declares it will use:
   `<tool list>`. The audit trail records every invocation."

6. Install via the API:

   ```bash
   curl -sS -X POST http://localhost:<runtime-port>/api/skills \
     -H "authorization: Bearer $GINI_TOKEN" \
     -H "content-type: application/json" \
     -d "$(jq -nc \
       --arg body "$(cat /tmp/incoming-skill.md)" \
       '{ body: $body }')"
   ```

   The endpoint writes the file under
   `~/.gini/instances/<instance>/skills/user/<name>/SKILL.md`
   (or under a category folder when the skill declares
   `metadata.gini.category`), triggers a loader reload, and returns the
   new enabled SkillRecord.

7. **MANDATORY — prompt for every missing credential before you report
   the skill ready. Installing the skill is NOT the end of the task.**
   The install response (step 6) returns the new SkillRecord — use its
   `id` as the `skillId`. Then:

   1. Re-read the installed skill's `metadata.gini.requires.credentials`
      list.
   2. For EACH credential name in that list, check `GET /api/connectors`
      for an existing healthy credential with that name.
   3. For EACH credential that is still missing, you MUST call
      `request_connector` so the user enters it securely. Do this for
      every missing credential — do not skip any, do not batch them into
      prose, do not defer to "the next time the skill runs":
      - Registered provider (the credential name maps to a known module,
        e.g. `LINEAR_API_KEY` → linear): `request_connector` with that
        `provider` id plus `skillId`.
      - No registered provider (a brand-new service): `request_connector`
        with `{name: "<CREDENTIAL_NAME>", type: "<api-key|oauth2>",
        skillId: "<installed skill id>", reason: "<what the credential is
        for and where to get it>"}`. Infer `type` from the name: an
        UPPER_SNAKE env-var token (e.g. `SOME_SERVICE_API_KEY`) is
        `api-key`; a kebab handle is `oauth2`.

   **Do not stop after "installed."** A skill with a missing required
   credential is NOT ready to use — it stays inactive until the credential
   is granted. You may report the skill as ready ONLY when either every
   required credential has been provided (each `request_connector` card
   completed) OR the user has explicitly declined to provide it. If the
   user has not yet responded to a card, the task is still in progress;
   wait for it, do not declare completion.

   Completing the card stores the credential as a typed record AND grants
   it to the installed skill — the skill activates once all its
   credentials are granted, so there is no separate grant step and no
   `/skills` trip. The secure card captures the secret server-side; the
   value never enters the chat transcript.

   The `/skills` page (find the installed skill's row, click the inline
   `[Set up <Credential>]` button) is a fallback only — use it if the
   secure card cannot render (e.g. the conversation is not in the web
   chat).

## Rules

- Always validate before writing. Never install an invalid SKILL.md.
- Always review the scripts for risk before installing. If you can't read
  the scripts (binary blobs, opaque URLs), refuse the install and tell the
  user why.
- Keep an unconfigured credential requirement and install anyway; do not
  stop the install flow to ask permission. Do not add a credential
  requirement for skills that only need local commands or an
  already-authenticated CLI.
- After a successful install, prompting for each missing required
  credential via `request_connector` (step 7) is MANDATORY, not optional.
  Never report the skill as installed/ready and then stop while a required
  credential is still missing — the skill is inactive until it is granted.
  The post-install prompt must happen in the SAME turn as the install, not
  deferred to a later on-demand run.
- Never embed the user's secret values in the SKILL.md you write.
- Never POST a secret to `/api/connectors` (or any endpoint) from a shell
  command. A secret on a command line lands in your context, the audit
  trail, and process listings. Always use `request_connector` so the value
  is captured server-side through the secure card and never enters the
  transcript.
- Bundled vendored skills are off-limits to this skill — install only
  user-source records.
