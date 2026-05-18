---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Node.js 18+ (or a prebuilt `gws` binary) and a Google Cloud project for OAuth credentials."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-meet`, `google-forms`). All of them invoke the upstream `gws` CLI from `github.com/googleworkspace/cli`, which speaks every Workspace API. This skill walks the user through installing the binary, completing OAuth once, picking scopes per product, and adding `gws` to the per-instance auto-approve list so subsequent calls don't pop an approval prompt every time.

Run this skill the first time any Workspace skill is invoked. It is idempotent — re-running it just re-verifies the install and lets the user widen scopes.

## Prerequisites

- A Google account (personal `@gmail.com` or a Workspace tenant).
- A Google Cloud project for OAuth credentials. `gws auth setup` can create one if `gcloud` is installed; otherwise see the manual flow below.
- Node.js 18+ on `$PATH` if installing via npm. Homebrew and prebuilt-binary installs do not need Node.

## When to Use

- A user asks Gini to read mail, send a calendar invite, share a Drive file, etc., and `gws` is not installed or not authenticated.
- The user wants to widen scopes (e.g. moved from read-only Gmail to send).
- The user wants to stop seeing approval prompts on every `gws` invocation.

## When NOT to Use

- The user already ran setup and the smoke check passes — go straight to the product skill.
- The user wants to manage non-Google services (Slack, Notion, etc.) — those have their own skills.
- The agent only needs ephemeral, agent-internal state — use the `memory` tool instead of any Google product.

## Quick Reference

### 1. Install the `gws` binary

Pick one of these in order of preference:

```bash
# Homebrew (macOS/Linux)
brew install googleworkspace-cli

# npm (cross-platform, needs Node.js 18+)
npm install -g @googleworkspace/cli

# Prebuilt binary
# Download from https://github.com/googleworkspace/cli/releases
# and place the extracted `gws` binary on $PATH

# Build from source
cargo install --git https://github.com/googleworkspace/cli --locked
```

Verify with:

```bash
gws --version
```

### 2. Run OAuth

The fast path requires the `gcloud` CLI; it provisions the Cloud project, enables APIs, and walks the consent screen:

```bash
gws auth setup          # one-time bootstrap (needs gcloud)
gws auth login          # interactive scope pick + browser consent
```

If `gcloud` is not available, fall back to the manual flow:

1. Open the Google Cloud Console for the target project, configure the OAuth consent screen as **External** (testing mode is fine), and add the user as a **Test user**.
2. Create an OAuth client of type **Desktop app**, download the client JSON, and save it to `~/.config/gws/client_secret.json`.
3. Run `gws auth login` and complete the browser flow.

### 3. Pick the right scopes per product

Unverified OAuth apps in testing mode are capped at roughly 25 scopes by Google, and the default "recommended" preset is 85+ scopes — it will fail for `@gmail.com` accounts. Pass `-s` to narrow the list at login time:

```bash
# Just the products the user actually needs
gws auth login -s drive,gmail,calendar,docs,meet,forms

# Read-only Gmail, full Drive
gws auth login -s "gmail.readonly,drive"
```

Recommended starting scopes per product:

- **Gmail**: `gmail.readonly` for triage-only, `gmail.send` for send/reply, `gmail` for full read+write+labels.
- **Drive**: `drive.file` if the agent should only see files it creates, `drive.readonly` for browsing, `drive` for full access.
- **Calendar**: `calendar.readonly` for agenda, `calendar.events` for create/update events, `calendar` for full access.
- **Docs**: `docs` (Docs has no read-only split — pair with `drive.readonly` if the user wants the agent to find docs by title before reading them).
- **Meet**: `meetings.space.created` for space create/lookup, `meetings.space.readonly` for conference record lookup.
- **Forms**: `forms.body` to create/edit forms, `forms.responses.readonly` to read responses.

### 4. Add `gws` to autoApproveCommands

Every `gws` call goes through Gini's approval-gated `terminal_exec` tool. To stop the prompt firing on every invocation, add a glob to the per-instance config at `~/.gini/instances/<instance>/config.json`:

```json
{
  "autoApproveCommands": ["gws *"]
}
```

For finer-grained gating, list each product the user has agreed to auto-approve:

```json
{
  "autoApproveCommands": [
    "gws gmail *",
    "gws calendar *",
    "gws drive *",
    "gws docs *"
  ]
}
```

You can also patch this at runtime without restarting:

```bash
curl -X PATCH http://localhost:<port>/api/settings/auto-approve \
  -H 'content-type: application/json' \
  -d '{"patterns":["gws *"]}'
```

Auto-approved commands still leave a `terminal.exec` audit row with `evidence.autoApproved=true`, so the activity trail stays intact.

### 5. Smoke-test

A read-only call that returns quickly and exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete and the per-product skills are ready to use.

## Rules

1. Walk this skill end-to-end before invoking any other `google-*` skill the first time. Subsequent runs of those skills assume `gws` is installed, authenticated, and auto-approved.
2. Narrow OAuth scopes to what the user actually asked for. Do not silently expand from read-only to write.
3. When the user is on a personal `@gmail.com` account, never request the full `recommended` scope preset — it will fail because the app is unverified. Use a comma-separated `-s` list.
4. Encourage `gws *` in `autoApproveCommands` only after the user understands every `gws` call still produces an audit row.
5. Credentials are encrypted at rest under `~/.config/gws/` — never `cat` or copy that directory's contents into chat or logs.
6. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

For flags not shown here, run `gws auth --help` and `gws --help`.
