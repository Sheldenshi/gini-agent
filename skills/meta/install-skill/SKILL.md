---
name: install-skill
description: "Install a pasted SKILL.md (or one fetched from a URL or file path) into the user-skill directory, reviewing risk and walking trust."
license: MIT
compatibility: "Requires the gini gateway and curl. Skills that need extra binaries will fail health checks after install — surface that clearly."
allowed-tools: "Bash file_write"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: meta
    requires:
      connectors: []
---

# Install Skill

You install a SKILL.md the user supplied — pasted text, a URL, or a
file path — into the runtime's user-skills directory. You also walk the
user through the trust decision and surface the providers the new skill
will need.

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
     provider that doesn't exist), see step 4.

3. Review the scripts and the body for risk. Read every sidecar file
   the user provided. Summarize for the user:

   - Which commands the skill runs (`bash`, `curl`, `psql`, …).
   - Which env vars / secrets it reads.
   - Whether it can write outside its workspace.
   - Whether it makes outbound network calls and to which hosts.

4. Resolve the connector requirements declared under
   `metadata.gini.requires.connectors`:

   - For each entry, check `GET /api/connectors/providers`.
   - If the provider exists, note whether the user already has a healthy
     connector for it (via `GET /api/connectors`).
   - If the provider does NOT exist in the registry:
     **Default to forward motion.** Rewrite the requirement as
     `provider: generic` and explain the tradeoff to the user:
     "Gini doesn't yet have a `<id>` provider module. I'll install with
     `generic` instead; you'll provide the credentials manually in the
     Connections dialog. Probes are presence-only — Gini won't verify
     the remote system is actually reachable." Do not present an
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
   new SkillRecord. New user skills land at `status: draft` so they
   never auto-run.

7. Walk the trust decision. Explain:

   "User-installed skills land as draft. Trust gives them access to
   your tools through the agent loop. Bundled skills are auto-trusted;
   user-installed skills need an explicit decision because the SKILL.md
   was written by someone outside Gini's vendored set."

   Then ask the user if they want to trust now. If yes, flip the status:

   ```bash
   curl -sS -X PATCH \
     http://localhost:<runtime-port>/api/skills/<skill-id> \
     -H "authorization: Bearer $GINI_TOKEN" \
     -H "content-type: application/json" \
     -d '{"status":"trusted"}'
   ```

   The PATCH emits an audit event `skill.trust` so the trail records
   when trust was granted.

8. If any required connector is missing or unhealthy, tell the user to
   open the Skills page (`/skills`), find the row for the skill they
   just installed, and click the inline `[Set up <Provider>]` button
   next to the missing connector. There is no longer a standalone
   Connectors page — connector setup happens inline. Alternatively,
   collect the credential in chat and POST it directly to
   `/api/connectors`.

## Rules

- Always validate before writing. Never install an invalid SKILL.md.
- Always review the scripts for risk before flipping trust. If you
  can't read the scripts (binary blobs, opaque URLs), refuse the trust
  flip and tell the user why.
- Default to `provider: generic` for unknown providers; do not stop the
  install flow to ask permission.
- Never embed the user's secret values in the SKILL.md you write.
- Bundled vendored skills are off-limits to this skill — install only
  user-source records.
