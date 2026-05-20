---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Node.js 18+ (or a prebuilt `gws` binary) and a Google Cloud project for OAuth credentials."
metadata:
  gini:
    version: 1.4.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-meet`, `google-forms`). All of them invoke the upstream `gws` CLI from `github.com/googleworkspace/cli`, which speaks every Workspace API. This skill walks the user through installing the binary, creating an OAuth Desktop client in **their own** Google Cloud project, completing OAuth once, picking scopes per product, and adding `gws` to the per-instance auto-approve list so subsequent calls don't pop an approval prompt every time.

The OAuth Desktop client is created in a Cloud project **the user owns**. Every Workspace API call goes user → Google over an access token Gini never sees in plaintext; Gini's local `gws` binary is the only client. There is no Gini-operated server in the data path. This is the load-bearing privacy property of the whole skill set, and it depends on the user — not Gini — provisioning the Cloud project.

Run this skill the first time any Workspace skill is invoked. It is idempotent — re-running it just re-verifies the install and lets the user widen scopes.

## Prerequisites

- A Google account (personal `@gmail.com` or a Workspace tenant).
- A Google Cloud project for OAuth credentials. The step-by-step flow below creates one through the browser tools; no `gcloud` CLI required.
- Node.js 18+ on `$PATH` if installing via npm. Homebrew and prebuilt-binary installs do not need Node.
- The `browser` toolset enabled on the active agent. The default agent ships with it on; if `/api/status` shows `toolsetFilter` without `browser`, ask the user to enable the toolset before continuing.
- A **visible, managed browser session** so the user can complete sign-in. Headless mode is the default; without an explicit connect the user has no window to type credentials into. Confirm before the Cloud Console flow — see Step 0 below.

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

Pick one of these in order of preference (use `terminal_exec`):

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

Verify:

```bash
gws --version
```

### 1.5. Existing OAuth client (optional shortcut)

Many users already have a Google OAuth **Desktop** client lying around from another project — there's no reason to drive Cloud Console again if a working `client_secret.json` already exists on disk. Before starting Step 2, ask the user:

> Do you already have a Google OAuth Desktop `client_secret.json` from another project? If yes, paste the path and I'll move it into place — we'll skip the Cloud Console setup. If no, I'll drive Cloud Console for you (~5 minutes).

The OAuth client still lives in **the user's own** Google Cloud project either way; this branch just reuses a project they already have instead of creating a new one. The privacy property (Gini never sees the OAuth credentials in transit; every API call goes user → Google over an access token Gini doesn't issue) is identical.

Branch on the answer:

- **User pastes a path.** Verify the file is a Desktop client, then drop it into `~/.config/gws/`:

  ```bash
  # 1. Confirm the file is readable.
  test -r "<PATH>" || echo "MISSING: <PATH> is not readable"

  # 2. Confirm it's a Desktop client (has the `installed` key, not `web`).
  jq -e '.installed.client_id' "<PATH>" > /dev/null && echo "OK: Desktop client" \
    || (jq -e '.web.client_id' "<PATH>" > /dev/null \
        && echo "WRONG TYPE: this is a Web client, not a Desktop client" \
        || echo "INVALID: not a recognizable OAuth client_secret.json")

  # 3. If OK, move it into place.
  mkdir -p ~/.config/gws && cp "<PATH>" ~/.config/gws/client_secret.json
  ```

  Run all three through `terminal_exec`. Interpret the output:
  - `OK: Desktop client` → copy in place, **skip Step 2 entirely**, jump to Step 3 (`gws auth login`).
  - `WRONG TYPE: ...` → the file is a Web OAuth client, which won't work with the `gws` CLI's localhost-loopback redirect. Tell the user: "That's a Web OAuth client — `gws` needs a Desktop client. Want me to drive Cloud Console for a new Desktop client (~5 minutes)?" If yes, fall through to Step 2.
  - `INVALID: ...` or `MISSING: ...` → tell the user what's wrong and ask whether they want to re-paste a different path or have Gini drive Cloud Console.

- **User says no, doesn't have one, or asks Gini to do it.** Fall through to Step 2.

Skip this branch entirely if the user already invoked this skill before and `~/.config/gws/client_secret.json` exists — they're past first-time setup; just go straight to Step 3.

### 2. Create the OAuth Desktop client (browser-driven)

The Cloud Console is fiddly enough that this skill drives it through the `browser_*` tools instead of asking the user to click through six pages by hand. The flow is broken into named milestones; **pause after each milestone and summarize what just happened** in chat so the user can interrupt if anything looks off.

Two rules apply to **every** browser interaction in this section:

- **Snapshot before you click.** Element refs (`@e3`, etc.) are valid only against the most recent snapshot. After `browser_navigate`, `browser_click`, `browser_type`, or `browser_wait_for`, the returned snapshot is the only thing you can address. Never reuse a ref from a previous turn.
- **Address by accessible label, not by ref.** The Cloud Console UI is rearranged often. When you need to click "Create" or fill the "App name" field, find that label in the latest snapshot and use that snapshot's ref. Do not hardcode refs into the plan.

#### Step 0 — Connect a visible browser (preflight)

`browser_navigate` opens a **headless** Chromium by default — there is no window the user can interact with, so the Cloud Console sign-in step below will fail (Google rejects automated sign-in, and the user can't type into a window they can't see). Before driving any of the milestones below, confirm the agent is attached to a **visible** browser session.

Check the connection state via the runtime API:

```bash
# Read $TOKEN from ~/.gini/instances/<instance>/config.json (the `apiToken`
# field) or `gini status`. <port> defaults to 7373 in dev — read it from
# the same config file.
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:<port>/api/browser
```

Decision rule on the JSON response:

- `{ "connected": true, "record": { "mode": "managed", ... } }` → a visible Chrome that Gini itself spawned. This is the only state that guarantees a window the user can see. Proceed to Milestone A.
- `{ "connected": true, "record": { "mode": "cdp", ... } }` → the agent is attached to a user-supplied Chrome via the Chrome DevTools Protocol. That endpoint *might* be a headed window the user can drive, or it might be a headless Chrome the user happens to have running — `GET /api/browser` only checks that the CDP endpoint exists, not whether it has a visible window. Ask the user explicitly in chat:
  > Looks like you're connected via CDP. Is your Chrome window visible on screen right now? Reply **"yes"** if you can see it — I need to be able to hand sign-in off to you.

  Wait for their answer. If they reply yes, proceed to Milestone A. If they reply no, are unsure, or ask to defer, treat the state as "no visible window" (next bullet) — fall through to the auto-spawn path below.
- `{ "connected": false }` (or `connected: true` with no `record`, or the CDP path above fell through) → no visible window. **Spawn a managed Chrome on the user's behalf via the dedicated `browser_connect` tool — do NOT ask the user to run a CLI command, navigate to a webapp page, or call the connect HTTP endpoint via `terminal_exec`.**

  Call the tool directly:

  ```text
  browser_connect { reason: "Sign in to Google Cloud Console" }
  ```

  The user sees an approval card titled **"Open a browser window"** with the reason as the body. Once they approve, the runtime spawns a visible Chrome with a per-instance profile dir and the tool returns `{ success: true, mode: "managed", ... }`. No further user action is required before Milestone A.

  Pass a short, user-facing `reason` that explains *what* the window is for ("Sign in to Google Cloud Console" — not "spawn managed Chrome" or any other internal phrasing). The reason is the only body text the user sees on the approval card.

  If the tool call itself errors (network failure, runtime error — not the user declining), THEN fall back to the manual path: "Open `/browser` in the Gini webapp and click **Connect**, then reply 'done'." Only surface this fallback after the automated path has failed — do not lead with it. If the user declines the approval, respect that and stop — they may want to handle setup manually.

Do **not** start `browser_navigate` against a headless context — the user has no window to act on and the milestone below will stall.

#### Milestone A — Sign in to Cloud Console (user handover)

```text
browser_navigate { url: "https://console.cloud.google.com/" }
browser_snapshot {}
```

Then tell the user, in chat:

> I've opened Google Cloud Console. Please sign in with the Google account you want Gini to use — I cannot type your credentials. Google blocks automated sign-in with captchas and 2FA prompts. When the project picker is visible at the top of the page, reply **"done"** and I'll continue.

**Do not try to type the password or username yourself.** Wait for the user's reply. When they confirm:

```text
browser_snapshot {}
```

Verify the snapshot shows a signed-in state: the project picker at the top of the page, an account avatar in the top-right, or a "Welcome" landing card naming the user. If none of those are present, ask the user to confirm once more rather than guessing.

#### Milestone B — Create or pick a Cloud project

Ask the user (one sentence) whether they want to use an existing project or create a new one. Default to creating one named `gini-workspace` if they don't care.

To create:

1. Snapshot the page. Click the project picker at the top of the page.
2. Snapshot. Click "New Project" in the dialog that opens.
3. Snapshot. Type the project name (e.g. `gini-workspace`) into the "Project name" input.
4. Snapshot. Click "Create."
5. Wait for the project to provision:
   ```text
   browser_wait_for { text: "Project created", timeoutMs: 60000 }
   ```
   or, if the toast message wording is different, watch for the project picker to update with the new project name.
6. Snapshot. Open the project picker again and select the newly created project. The URL should update to include `?project=<project-id>` once the switch is complete.

Summarize the milestone to the user: "Project `<name>` is selected. Moving on to enable the Workspace APIs."

#### Milestone C — Enable Workspace APIs

For each of the six APIs Gini's product skills depend on, run the same loop. The canonical pattern (the body repeats per API; do **not** unroll it into six separate plans — read the pattern once and apply it to each name):

```text
browser_navigate { url: "https://console.cloud.google.com/apis/library" }
browser_snapshot {}
# Find the API library search box (accessible label is "Search for APIs & Services")
# and type the API name.
browser_type { ref: <search-box-ref>, text: "<API NAME>" }
browser_press { key: "Enter" }
browser_snapshot {}
# Click the result card whose title matches the API.
browser_click { ref: <result-card-ref> }
browser_snapshot {}
# If the API is already enabled, the page shows "Manage" instead of "Enable" —
# skip the click and move on. Otherwise click "Enable" and wait.
browser_click { ref: <enable-button-ref> }
browser_wait_for { text: "API enabled", timeoutMs: 60000 }
```

APIs to enable, in order:

1. Gmail API
2. Google Calendar API
3. Google Drive API
4. Google Docs API
5. Google Forms API
6. Google Meet API

After all six are enabled, summarize: "Enabled Gmail, Calendar, Drive, Docs, Forms, and Meet APIs. Moving on to the OAuth consent screen."

#### Milestone D — Configure the OAuth consent screen

```text
browser_navigate { url: "https://console.cloud.google.com/apis/credentials/consent" }
browser_snapshot {}
```

The page asks for User Type. Choose **External**, click **Create**. Snapshot.

On the App information form:

1. Type "Gini Workspace" (or whatever name the user prefers) into "App name."
2. Pick the user's own email in "User support email" — the dropdown should be pre-populated. If unclear which email the user is signed in as, ask them rather than guessing.
3. Skip the App logo and App domain sections.
4. Type the user's own email into "Developer contact information."
5. Click **Save and continue**.

On the Scopes step, click **Save and continue** with no scopes added. The `gws` OAuth flow requests scopes at login time; pre-adding scopes here would also force the user through verification later.

On the Test users step, click **Add users**, type the user's own email, click **Add**, then **Save and continue**. The OAuth flow only works for emails on this Test users list while the app is in testing mode.

Skip the Verification step (the "Back to Dashboard" button at the bottom).

Summarize: "OAuth consent screen configured with your email as the test user. Moving on to create the Desktop client."

#### Milestone E — Create the OAuth Desktop client

```text
browser_navigate { url: "https://console.cloud.google.com/apis/credentials" }
browser_snapshot {}
```

1. Click **Create Credentials** (top of the page), then **OAuth client ID** in the dropdown.
2. Snapshot. In the "Application type" select, choose **Desktop app**.
3. Snapshot. Type a name into "Name" — `gws CLI` is fine.
4. Click **Create**.
5. Snapshot. The Console shows a dialog with the client ID and offers a JSON download. Click **DOWNLOAD JSON**.
6. Wait briefly for the download to land (~2s).

Tell the user: "The OAuth Desktop client is created and the JSON has been downloaded."

#### Milestone F — Move the JSON into place

Use `terminal_exec`:

```bash
mkdir -p ~/.config/gws
mv "$(ls -t ~/Downloads/client_secret_*.apps.googleusercontent.com.json | head -n 1)" ~/.config/gws/client_secret.json
```

The glob picks up the most recent download in case the user has older credential files in `~/Downloads` from a prior attempt. After moving, verify:

```bash
ls -la ~/.config/gws/client_secret.json
```

Close the browser session:

```text
browser_close {}
```

### 3. Run OAuth

```bash
gws auth login          # interactive scope pick + browser consent
```

`gws` opens its own browser tab; the user picks scopes (see the table below) and approves. The post-OAuth authorized-user credentials land encrypted under `~/.config/gws/`.

### 4. Pick the right scopes per product

Unverified OAuth apps in testing mode are capped at roughly 25 scopes by Google, and the default "recommended" preset is 85+ scopes — it will fail for `@gmail.com` accounts. There are two ways to narrow the list at login time:

```bash
# Pick services by short name. `-s` picks the default scope per service —
# typically read+write but NOT permanent-delete or admin-level operations
# (e.g. `gmail.modify` for Gmail, `drive` for Drive). For broader or
# narrower access, use `--readonly` or `--scopes` (see below).
gws auth login -s drive,gmail,calendar,docs,meet,forms

# Same services, but read-only everywhere — the --readonly flag applies
# uniformly to every service listed in -s
gws auth login --readonly -s gmail,drive

# Exact per-scope picks (full URLs, no shortcuts) — use this when you
# need a mixed shape that -s/--readonly can't express, e.g. read-only
# Gmail + full Drive in the same login
gws auth login --scopes "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive"
```

`-s` takes **service names**, not scope strings — `-s gmail.readonly` is silently dropped because no service named `gmail.readonly` exists. Pair `-s` with `--readonly` for read-only across the listed services, or fall through to `--scopes` with explicit URLs for fine-grained mixes.

Recommended starting scopes per product. The first column is the `-s` shorthand (Service column from `gws auth login --help`); the second column is the full URL to pass to `--scopes` when picking a non-uniform mix:

- **Gmail** — `-s gmail` ↔ `https://www.googleapis.com/auth/gmail.modify` (the default `-s gmail` mapping; covers read + send + reply + label + draft but NOT permanent delete). Narrower picks: `https://www.googleapis.com/auth/gmail.readonly` / `.send` / `.compose`.
- **Gmail (full, incl. permanent delete)** — `--scopes "https://mail.google.com/"` only. No `-s` shorthand resolves to this; it must be requested explicitly via `--scopes`.
- **Drive** — `-s drive` ↔ `https://www.googleapis.com/auth/drive` (`.file`, `.readonly`, `.metadata.readonly` available as full URLs).
- **Calendar** — `-s calendar` ↔ `https://www.googleapis.com/auth/calendar` (`.events`, `.readonly`, `.freebusy` available as full URLs).
- **Docs** — `-s docs` ↔ `https://www.googleapis.com/auth/documents` (`.readonly` available as a full URL when the agent only needs to read).
- **Meet** — `-s meet` ↔ `https://www.googleapis.com/auth/meetings.space.created` (`.readonly` available as a full URL).
- **Forms** — `-s forms` ↔ `https://www.googleapis.com/auth/forms.body` (`.body.readonly`, `.responses.readonly` available as full URLs).

### 5. Add `gws` to autoApproveCommands

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
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"patterns": ["gws *"]}' \
  http://127.0.0.1:<port>/api/settings/auto-approve
```

Set `$TOKEN` from `~/.gini/instances/<instance>/config.json` (the `apiToken` field) or `gini status`. Every `/api/*` route except `POST /api/pairing/claim` is gated on this bearer token. For finer-grained globs, swap `["gws *"]` for per-product entries (e.g. `["gws gmail *", "gws drive *"]`).

Auto-approved commands still leave a `terminal.exec` audit row with `evidence.autoApproved=true`, so the activity trail stays intact.

### 6. Smoke-test

A read-only call that returns quickly and exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete and the per-product skills are ready to use.

## Rules

1. Walk this skill end-to-end before invoking any other `google-*` skill the first time. Subsequent runs of those skills assume `gws` is installed, authenticated, and auto-approved.
2. **Sign-in is a human-in-the-loop step.** Never attempt to type the user's email or password into Google's sign-in form. Google blocks automated sign-in with captchas, 2FA, and "this doesn't look like you" warnings, and any attempt to bypass these is a policy violation. Open the page, hand off to the user, wait for their "done."
3. **Snapshot before every click.** Element refs are only valid against the most recent `browser_snapshot`. After any navigation or interaction, re-snapshot and look up the target by its accessible label in the new tree.
4. **Pause and summarize at each milestone.** After project creation, after each API is enabled, after the OAuth consent screen is configured, after the Desktop client is created — say one sentence in chat about what just happened. This produces a useful chat trail and lets the user interrupt early if something looks wrong.
5. **Fail gracefully.** If `browser_snapshot` doesn't show an expected element after two or three attempts (re-snapshot, try `browser_scroll`, try a label variant like "Create project" vs "New project"), STOP. Tell the user: "I got stuck at <milestone>. Please finish manually from here: <one paragraph with the exact Cloud Console URL and what to click>." Then move on to the next step if possible, or stop entirely if the failure is blocking. Do not loop forever on a UI that has changed.
6. Narrow OAuth scopes to what the user actually asked for. Do not silently expand from read-only to write.
7. When the user is on a personal `@gmail.com` account, never request the full `recommended` scope preset — it will fail because the app is unverified. Use a comma-separated `-s` list.
8. Encourage `gws *` in `autoApproveCommands` only after the user understands every `gws` call still produces an audit row.
9. Treat the entire `~/.config/gws/` directory as sensitive — never `cat` or copy its contents into chat or logs. The post-OAuth authorized-user credentials are AES-256-GCM encrypted at rest, with the symmetric key held in the OS keyring (macOS Keychain / Linux Secret Service) or, as a fallback when no keyring is available, written plaintext to a local `.encryption_key` file in that directory. The OAuth client config (`client_secret.json`) is stored as plaintext alongside it. Both artifacts are sensitive: the client secret identifies the app and the encrypted blob (plus its key file) is enough to act as the user.
10. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

## Manual Fallback

If the browser flow gets stuck at any milestone, fall through to the all-manual Cloud Console path below. The end state is identical to the browser flow's: a Desktop OAuth client JSON at `~/.config/gws/client_secret.json`, plus the consent screen configured with the user as a test user.

1. **Sign in.** Open https://console.cloud.google.com/ in a browser and sign in with the target Google account.
2. **Create or pick a project.** Click the project picker at the top of the page → **New Project** → name it (e.g. `gini-workspace`) → **Create**. Wait ~30s; switch to it.
3. **Enable the six Workspace APIs.** For each of Gmail, Calendar, Drive, Docs, Forms, Meet: navigate to https://console.cloud.google.com/apis/library, search the API name, click the result, click **Enable**, wait for the success banner.
4. **Configure the OAuth consent screen.** Open https://console.cloud.google.com/apis/credentials/consent. Choose **External** → **Create**. Fill App name (e.g. "Gini Workspace"), pick your own email for both support and developer contact, **Save and continue**. On Scopes, **Save and continue** without adding any. On Test users, **Add users**, type your own email, **Add**, **Save and continue**. Skip Verification.
5. **Create the OAuth Desktop client.** Open https://console.cloud.google.com/apis/credentials. Click **Create Credentials** → **OAuth client ID**. Pick **Desktop app**, name it `gws CLI`, **Create**. In the resulting dialog, click **DOWNLOAD JSON**.
6. **Move the JSON.** In a terminal:
   ```bash
   mkdir -p ~/.config/gws
   mv "$(ls -t ~/Downloads/client_secret_*.apps.googleusercontent.com.json | head -n 1)" ~/.config/gws/client_secret.json
   ```
7. **Continue with step 3 above** (`gws auth login`, scopes, smoke-test).

For flags not shown here, run `gws auth --help` and `gws --help`.
