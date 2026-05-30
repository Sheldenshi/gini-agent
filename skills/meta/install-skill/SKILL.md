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
     **Default to forward motion.** Keep the requirement and explain to
     the user: "This skill needs a `<name>` credential you haven't added
     yet. I'll install it; you'll provide the value manually in the
     credential dialog. Probes are presence-only — Gini won't verify the
     remote system is actually reachable." Do not present an
     install / hold-off binary choice.

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

7. If any required credential is missing or unhealthy, tell the user to
   open the Skills page (`/skills`), find the row for the skill they
   just installed, and click the inline `[Set up <Credential>]` button
   next to the missing credential. There is no longer a standalone
   Connectors page — credential setup happens inline. Alternatively,
   collect the credential in chat and POST it directly to
   `/api/connectors`.

## Rules

- Always validate before writing. Never install an invalid SKILL.md.
- Always review the scripts for risk before installing. If you can't read
  the scripts (binary blobs, opaque URLs), refuse the install and tell the
  user why.
- Keep an unconfigured credential requirement and install anyway; do not
  stop the install flow to ask permission. Do not add a credential
  requirement for skills that only need local commands or an
  already-authenticated CLI.
- Never embed the user's secret values in the SKILL.md you write.
- Bundled vendored skills are off-limits to this skill — install only
  user-source records.
