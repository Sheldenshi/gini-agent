---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Node.js 18+ (or a prebuilt `gws` binary) and a Google Cloud project for OAuth credentials."
metadata:
  gini:
    version: 3.0.2
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-meet`, `google-forms`). Installs the upstream `gws` CLI, creates an OAuth Desktop client in the user's own Google Cloud project, stores the Client ID and Client Secret in Gini's connector store, completes OAuth, picks scopes per product, and adds `gws` to the per-instance auto-approve list.

The OAuth client lives in the user's own GCP project. The Client ID and Client Secret are captured through the inline Connect form (`request_connector` tool) and stored in Gini's encrypted secret store — never write them to chat or logs, and never write `client_secret.json` to disk.

This skill is idempotent — re-running it re-verifies the install and lets the user widen scopes.

## Prerequisites

- A Google account (personal `@gmail.com` or a Workspace tenant).
- A Google Cloud project for OAuth credentials. Step 2 creates one.
- Node.js 18+ on `$PATH` if installing via npm. Homebrew and prebuilt-binary installs do not need Node.
- A working default browser.

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

### 1.5. Existing OAuth Desktop client (optional shortcut)

Before starting Step 2, ask the user:

> Do you already have a Google OAuth Desktop client from another project? If yes, I'll show you a form where you can paste the Client ID and Client Secret and we'll skip the Cloud Console setup. If no, I'll create one for you.

Branch on the answer:

- **User says yes.** Call `request_connector { provider: "google-oauth-desktop", reason: "Paste the Client ID and Client Secret from your existing OAuth Desktop client." }`. The inline form opens in chat; the user pastes the two values and clicks Save. On success, run the API-verification sub-step below, then jump to Step 3 (`gws auth login`).

  After the connector is created, verify the project has all six Workspace APIs enabled. Read the project id from the user (or ask them) — `gws` itself doesn't need the project id once the OAuth client is wired, but the APIs must be enabled in the project that owns the OAuth client.

  1. Ask: "Which Google Cloud project owns that OAuth client? I'll check the six Workspace APIs are enabled there." Wait for the project id.

  2. If `gcloud` is available, enable all six APIs in one shot:

     ```bash
     gcloud services enable \
       gmail.googleapis.com \
       calendar-json.googleapis.com \
       drive.googleapis.com \
       docs.googleapis.com \
       forms.googleapis.com \
       meet.googleapis.com \
       --project=<project_id>
     ```

     Already-enabled APIs are no-ops. If this succeeds, skip to Step 3.

  3. If `gcloud` is not available, open the API library in the user's default browser:

     ```bash
     open "https://console.cloud.google.com/apis/library?project=<project_id>"
     ```

     Tell the user:

     > I've opened the API library for your project. Please verify these six APIs are **Enabled** (click **Enable** on any that shows it instead of **Manage**):
     >
     > 1. Gmail API
     > 2. Google Calendar API
     > 3. Google Drive API
     > 4. Google Docs API
     > 5. Google Forms API
     > 6. Google Meet API
     >
     > Reply **"done"** when all six show **Manage**.

     Wait for "done," then jump to Step 3.

  If the user objects to verification, proceed to Step 3 — but warn once: "If a future product ask fails with a 403 'API not enabled' error, enable that API at https://console.cloud.google.com/apis/library?project=`<project_id>`."

- **User says no, doesn't have one, or asks Gini to do it.** Fall through to Step 2.

Skip this branch entirely if a `google-oauth-desktop` connector already exists and is healthy — go straight to Step 3.

### 2. Pick a setup path

Detect whether `gcloud` is installed:

```bash
command -v gcloud
```

- **If `gcloud` is on `$PATH`** → run Step 2A.
- **If `gcloud` is NOT installed** → install it silently. Run `brew install --cask google-cloud-sdk` (macOS) or the platform installer at `https://docs.cloud.google.com/sdk/docs/install` (other platforms) via `terminal_exec`. Verify with `gcloud --version`, then continue to Step 2A. Step 2B is reserved for when the install itself fails.

### 2A. gcloud-hybrid setup

Project creation + API enablement run through `terminal_exec`. OAuth consent screen + Desktop client creation happen in the user's default browser. Capturing the Client ID and Client Secret happens through the inline Connect form (`request_connector`). Do NOT spawn managed Chrome for Step 2A.

Don't list completed actions in chat. Status messages should be action-oriented (what the user must do next), not retrospective.

#### Milestone A — Sign in with gcloud

```bash
gcloud auth login
```

If `gcloud auth list` already shows an active account, ask once: "gcloud is signed in as `<email>`. Use this account?" — continue on confirmation.

#### Milestone B — Create or pick a Cloud project

Ask the user (one sentence) whether they want to use an existing project or create a new one. Default to creating one named `gini-workspace` if they don't care.

To create:

```bash
gcloud projects create gini-workspace --name="Gini Workspace"
```

Project IDs are globally unique with a 30-character cap. If `gini-workspace` is taken, the command errors with `ALREADY_EXISTS`; ask the user for a different name or append a suffix (e.g. `gini-workspace-<initials>`).

To pick an existing project, ask for its project ID, or list candidates:

```bash
gcloud projects list --format="table(projectId,name)"
```

Set the active project:

```bash
gcloud config set project <project_id>
```

#### Milestone C — Enable Workspace APIs

**Enable all six APIs even if the user's current ask only needs one.**

```bash
gcloud services enable \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  docs.googleapis.com \
  forms.googleapis.com \
  meet.googleapis.com
```

Calendar's service ID is `calendar-json.googleapis.com` (not `calendar.googleapis.com`). Already-enabled APIs are no-ops.

If it errors with `PERMISSION_DENIED`, the user doesn't own the project — ask them to switch with `gcloud auth login` or pick a project they own with `gcloud config set project <project_id>`.

#### Last step — OAuth client setup

Call `request_connector` with a multi-line `reason` field that embeds both Cloud Console URLs and the click instructions. The inline form renders the reason with line breaks preserved and URLs as clickable links — the user clicks through Cloud Console from the form's body, then pastes the credentials into the form's inputs.

Substitute `<project_id>` with the real project id from Milestone B:

```text
request_connector {
  provider: "google-oauth-desktop",
  reason: "Last step — complete two Cloud Console pages, then paste the credentials below.\n\n1. Consent screen (if not configured):\nhttps://console.cloud.google.com/apis/credentials/consent?project=<project_id>\n→ User Type: External, App name 'Gini Workspace', your email for support + developer contact, save through Scopes, add yourself as a Test user.\n\n2. Create an OAuth client:\nhttps://console.cloud.google.com/apis/credentials?project=<project_id>\n→ Create Credentials → OAuth client ID → Application type: Desktop app.\n\nPaste the Client ID and Client Secret below."
}
```

Do NOT post a separate chat message before the tool call. The reason field IS the message. The user sees one rendered card with the URLs as clickable links above the input fields. Do NOT `open <url>` for either Console URL — let the user click from the form.

Don't gate on "reply done" between the two pages — the form submission is what advances the flow. The user can do them in any order, or come back later. The connector is created with the env bindings `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`, which `gws` picks up automatically. Continue to Step 3 once the connector is healthy.

### 2B. Browser-only setup (emergency fallback)

Run this only when the `gcloud` install in Step 2 itself fails. Everything happens through the `browser_*` tools driving a Gini-managed Chrome.

Two rules apply to every browser interaction:

- **Snapshot before you click.** Element refs (`@e3`, etc.) are valid only against the most recent snapshot. After `browser_navigate`, `browser_click`, `browser_type`, or `browser_wait_for`, the returned snapshot is the only thing you can address. Never reuse a ref from a previous turn.
- **Address by accessible label, not by ref.** Find the label in the latest snapshot and use that snapshot's ref. Do not hardcode refs into the plan.

#### Step 0 — Connect a visible browser (preflight)

Confirm the agent is attached to a visible browser session. Read `$TOKEN` from `~/.gini/instances/<instance>/config.json` (the `apiToken` field) and `<port>` from the same file (default 7373 in dev):

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:<port>/api/browser
```

Decision rule on the JSON response:

- `{ "connected": true, "record": { "mode": "managed", ... } }` → a visible Chrome that Gini itself spawned. Proceed to Milestone A.
- `{ "connected": true, "record": { "mode": "cdp", ... } }` → attached to a user-supplied Chrome via CDP. Ask the user:
  > Looks like you're connected via CDP. Is your Chrome window visible on screen right now? Reply **"yes"** if you can see it — I need to be able to hand sign-in off to you.

  If they reply yes, proceed to Milestone A. If they reply no, are unsure, or ask to defer, fall through to the auto-spawn path below.
- `{ "connected": false }` (or any state with no visible window) → **Spawn a managed Chrome via the dedicated `browser_connect` tool — do NOT ask the user to run a CLI command, navigate to a webapp page, or call the connect HTTP endpoint via `terminal_exec`.**

  Call the tool directly:

  ```text
  browser_connect { reason: "Sign in to Google Cloud Console" }
  ```

  Pass a short, user-facing `reason` that explains *what* the window is for — not internal phrasing like "spawn managed Chrome".

  If the tool call itself errors (network failure, runtime error — not the user declining), fall back to: "Open `/browser` in the Gini webapp and click **Connect**, then reply 'done'." If the user declines the approval, stop.

Do not start `browser_navigate` against a headless context.

#### Milestone A — Sign in to Cloud Console (user handover)

```text
browser_navigate { url: "https://console.cloud.google.com/" }
browser_snapshot {}
```

Tell the user:

> I've opened Google Cloud Console. Please sign in with the Google account you want Gini to use — I cannot type your credentials. When the project picker is visible at the top of the page, reply **"done"**.

**Do not try to type the password or username yourself.** Wait for the user's reply. When they confirm:

```text
browser_snapshot {}
```

Verify the snapshot shows a signed-in state: project picker, account avatar, or a "Welcome" landing card. If none are present, ask the user to confirm once more.

#### Milestone A.5 — Disconnect visible Chrome, reconnect headless

1. `browser_close {}` — closes the visible Chrome. Profile dir and cookies persist.
2. `browser_connect { reason: "Continue Cloud Console setup invisibly", headless: true }` — relaunches headless using the same profile dir.

If after Milestone A.5 a `browser_snapshot` shows a captcha challenge, an "unusual activity" warning, or Console refuses to load, fall back to headed mode: `browser_close`, then `browser_connect { reason: "Re-open Chrome (bot detection tripped headless)" }` (no `headless` flag). Continue Milestones B-E in the visible window. Say once: "Console flagged my headless session — I'll do the rest in the visible window."

#### Milestone B — Create or pick a Cloud project

Ask whether to use an existing project or create a new one. Default to creating `gini-workspace`.

To create:

1. Snapshot. Click the project picker at the top of the page.
2. Snapshot. Click "New Project" in the dialog.
3. Snapshot. Type the project name into "Project name."
4. Snapshot. Click "Create."
5. Wait:
   ```text
   browser_wait_for { text: "Project created", timeoutMs: 60000 }
   ```
6. Snapshot. Open the project picker again and select the new project. The URL should include `?project=<project-id>`.

#### Milestone C — Enable Workspace APIs

**Enable all six APIs even if the user's current ask only needs one.**

For each of the six APIs, run the same loop (do not unroll into six separate plans):

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

#### Milestone D — Configure the OAuth consent screen

```text
browser_navigate { url: "https://console.cloud.google.com/apis/credentials/consent" }
browser_snapshot {}
```

User Type: pick **External**, click **Create**. Snapshot.

On the App information form:

1. Type "Gini Workspace" into "App name."
2. Pick the user's own email in "User support email" — the dropdown is pre-populated. If unclear, ask them.
3. Skip the App logo and App domain sections.
4. Type the user's own email into "Developer contact information."
5. Click **Save and continue**.

On Scopes, click **Save and continue** with no scopes added.

On Test users, click **Add users**, type the user's own email, click **Add**, then **Save and continue**.

Skip Verification ("Back to Dashboard" at the bottom).

#### Milestone E — Capture the OAuth client credentials

```text
browser_navigate { url: "https://console.cloud.google.com/apis/credentials" }
browser_snapshot {}
```

1. Click **Create Credentials**, then **OAuth client ID**.
2. Snapshot. In "Application type," choose **Desktop app**.
3. Snapshot. Type `gws CLI` into "Name."
4. Click **Create**.
5. Snapshot. The dialog shows the **Client ID** and **Client Secret**. Read both values from the snapshot (or ask the user to copy them).

Then call `request_connector` so the inline form opens in chat:

```text
request_connector {
  provider: "google-oauth-desktop",
  reason: "Paste the Client ID and Client Secret from the OAuth Desktop client you just created in Cloud Console."
}
```

The user pastes the two strings into the form and clicks **Save**. The connector is created with the env bindings `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`, which `gws` picks up automatically. The chat-task resumes once the connector is healthy.

#### Cleanup — close the browser

Call `browser_close {}` to tear down the headless Chrome.

### 3. Run OAuth

```bash
gws auth login          # interactive scope pick + browser consent
```

`gws` reads the Client ID and Client Secret from the env vars Gini binds (`GOOGLE_WORKSPACE_CLI_CLIENT_ID`, `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`), opens its own browser tab, lets the user pick scopes (see the table below) and approve. If `gws auth login` exits with an OAuth client error, the Client ID or Client Secret entered in Step 2 was wrong — re-run `request_connector` for `google-oauth-desktop` to capture the correct pair.

### 4. Pick the right scopes per product

Unverified OAuth apps in testing mode are capped at ~25 scopes by Google. The default "recommended" preset is 85+ scopes and will fail for `@gmail.com` accounts. Narrow the list at login time:

```bash
# Pick services by short name. `-s` picks the default scope per service
# (read+write but NOT permanent-delete or admin-level).
gws auth login -s drive,gmail,calendar,docs,meet,forms

# Read-only across all listed services.
gws auth login --readonly -s gmail,drive

# Exact per-scope picks (full URLs) — use for mixed shapes that -s can't express.
gws auth login --scopes "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive"
```

`-s` takes **service names**, not scope strings — `-s gmail.readonly` is silently dropped.

Recommended starting scopes per product (first column = `-s` shorthand; second column = full URL for `--scopes`):

- **Gmail** — `-s gmail` ↔ `https://www.googleapis.com/auth/gmail.modify` (read + send + reply + label + draft; NOT permanent delete). Narrower: `.readonly` / `.send` / `.compose`.
- **Gmail (full, incl. permanent delete)** — `--scopes "https://mail.google.com/"`. No `-s` shorthand.
- **Drive** — `-s drive` ↔ `https://www.googleapis.com/auth/drive` (`.file`, `.readonly`, `.metadata.readonly` available as full URLs).
- **Calendar** — `-s calendar` ↔ `https://www.googleapis.com/auth/calendar` (`.events`, `.readonly`, `.freebusy` available as full URLs).
- **Docs** — `-s docs` ↔ `https://www.googleapis.com/auth/documents` (`.readonly` available).
- **Meet** — `-s meet` ↔ `https://www.googleapis.com/auth/meetings.space.created` (`.readonly` available).
- **Forms** — `-s forms` ↔ `https://www.googleapis.com/auth/forms.body` (`.body.readonly`, `.responses.readonly` available).

### 5. Add `gws` to autoApproveCommands

Every `gws` call goes through Gini's approval-gated `terminal_exec` tool. To stop the prompt firing on every invocation, add a glob to the per-instance config at `~/.gini/instances/<instance>/config.json`:

```json
{
  "autoApproveCommands": ["gws *"]
}
```

For finer-grained gating, list each product:

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

Patch this at runtime without restarting:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"patterns": ["gws *"]}' \
  http://127.0.0.1:<port>/api/settings/auto-approve
```

Set `$TOKEN` from `~/.gini/instances/<instance>/config.json` (the `apiToken` field) or `gini status`.

### 6. Smoke-test

A read-only call that returns quickly and exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete.

## Rules

1. Walk this skill end-to-end before invoking any other `google-*` skill the first time.
2. **Detect `gcloud` before deciding the path.** Run `command -v gcloud` first. Do not silently fall through to browser-only when `gcloud` is available.
3. **Enable all six Workspace APIs regardless of path.** Step 2A's `gcloud services enable` accepts all six in one call; Step 2B's Milestone C loops through all six.
4. **Sign-in is a human-in-the-loop step.** Never attempt to type the user's email or password into Google's sign-in form. Open the page (or run `gcloud auth login`), hand off to the user, wait for their "done."
5. **Capture credentials through the inline form, not files.** Always use `request_connector { provider: "google-oauth-desktop" }` to get the Client ID and Client Secret. Never ask the user for a path to a `client_secret.json`, never write a JSON file under `~/.config/gws/`, and never `cat` or echo the credentials back into chat.
6. **Snapshot before every click.** Element refs are only valid against the most recent `browser_snapshot`. After any navigation or interaction, re-snapshot and look up the target by its accessible label in the new tree.
7. **Fail gracefully.** If a `gcloud` command errors with `PERMISSION_DENIED` or `ALREADY_EXISTS`, surface the error verbatim and ask the user. If `browser_snapshot` doesn't show an expected element after two or three attempts (re-snapshot, try `browser_scroll`, try a label variant like "Create project" vs "New project"), STOP. Tell the user: "I got stuck at <milestone>. Please finish manually from here: <one paragraph with the exact Cloud Console URL and what to click>." Do not loop forever on a UI that has changed.
8. Narrow OAuth scopes to what the user actually asked for. Do not silently expand from read-only to write.
9. When the user is on a personal `@gmail.com` account, never request the full `recommended` scope preset — it will fail because the app is unverified. Use a comma-separated `-s` list.
10. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

## Manual Fallback

If both Step 2A and Step 2B get stuck, hand off the Cloud Console URLs and click sequence from Milestones B-E (in Step 2B) to the user and ask them to do it manually. Once they have a Client ID and Client Secret in hand, call `request_connector { provider: "google-oauth-desktop", ... }` and resume at Step 3.

For flags not shown here, run `gws auth --help` and `gws --help`.
