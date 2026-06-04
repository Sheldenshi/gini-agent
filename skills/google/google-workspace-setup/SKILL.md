---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Homebrew (or another package manager) and a Google account."
metadata:
  gini:
    version: 3.7.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`, `google-meet`, `google-forms`). Installs `gws` and `gcloud`, signs the user into their own Google Cloud project, enables the Workspace APIs, captures an OAuth Desktop client through the inline Connect form, and completes `gws auth login`.

The OAuth client lives in the user's own GCP project. The Client ID and Client Secret are captured through the inline Connect form (`request_connector` tool) and stored in Gini's encrypted secret store — never write them to chat or logs, and never write `client_secret.json` to disk.

This skill is idempotent — re-running it re-verifies the install and lets the user widen scopes.

**Provisioning vs signing in.** The work splits in two: **provisioning** (install, `gcloud auth login`, project, APIs, `request_connector`) runs **once**, ever; **signing in** (`gws auth login`) runs again whenever the user's `gws` session expires. `gcloud` is *only* ever needed for provisioning — never for a re-auth. Step 0 decides which case you're in.

## The Flow

This is the **exact first-time sequence** (Step 0 short-circuits the re-auth case before you reach it). Within the first-time flow do not branch into shortcuts, do not pre-ask whether they have an existing OAuth client, do not list completed actions retrospectively. Status messages are action-oriented: what the user must do *next*.

1. The user asks Gini to do a Workspace thing (read mail, check calendar, share a Drive file, etc.).
2. Confirm setup with the user.
3. Install `gws` and `gcloud` silently in the background.
4. Run `gcloud auth login`, which pops up the user's default browser for sign-in.
5. After they sign in, create the Cloud project and enable the seven Workspace APIs in the background.
6. Send a single chat bubble with the last-step instructions (two Cloud Console URLs) and call `request_connector` — the inline form renders below the bubble.
7. After the user pastes the credentials and clicks **Save**, run `gws auth login`, which pops up the user's default browser for OAuth consent.
8. After they sign in, the original ask resumes.

## Step 0 — First-time or re-auth?

Before anything else, call `list_connectors` and look for a connector named `google-workspace-oauth`.

- **It exists** → the OAuth client is already provisioned and only the user's `gws` session expired. This is a **re-auth**, not setup. Ask once ("Your Google sign-in expired — want me to sign you back in?") and on yes go **straight to Step 6** (`gws auth login`), then Step 8 (smoke test). Do **not** run `gcloud`, create a project, or call `request_connector` — provisioning already happened and none of it is needed again. (Edge case: if `gws` is not on `$PATH`, run Step 2's install first, then Step 6. If `gws auth login` fails with `invalid_client`, the stored client is broken — fall through to the full first-time flow to re-provision it.)
- **It does not exist** → true first-time setup. Continue to Step 1.

## Step 1 — Confirm setup

Tell the user, in one short sentence, that Google Workspace isn't set up yet, and ask whether to set it up now. Wait for confirmation before doing anything.

If they say yes, proceed silently — do not narrate each substep. The user sees a chat bubble per **milestone** (sign in, last step), not per command.

## Step 2 — Install `gws` and `gcloud`

Both installs are silent and run through `terminal_exec`. If a binary is already on `$PATH`, skip its install.

Detect first:

```bash
command -v gws
command -v gcloud
```

Install whichever is missing:

```bash
# gws (macOS / Linux)
brew install googleworkspace-cli

# gcloud (macOS)
brew install --cask google-cloud-sdk

# gcloud (Linux) — see https://docs.cloud.google.com/sdk/docs/install for the
# tarball install. Use the platform-appropriate command via terminal_exec.
```

Verify both are on `$PATH` afterwards:

```bash
gws --version
gcloud --version
```

If either install fails (network, sudo, broken Homebrew), STOP and tell the user verbatim what failed and the one-line command to try manually. Do not loop.

## Step 3 — Sign in with `gcloud`

```bash
gcloud auth login
```

This opens the user's **default browser** to Google's OAuth consent page. They sign in there. The command returns when the user completes consent.

If `gcloud auth list` already shows an active account, ask once: "gcloud is signed in as `<email>`. Use this account?" — proceed on confirmation. Otherwise run `gcloud auth login` straight through.

## Step 4 — Reach a Cloud project with the seven APIs enabled

The goal of this step is a single value, `<PROJECT_ID>`, that names a Cloud project the active gcloud account owns AND in which the seven Workspace APIs are enabled. Every later step substitutes that string into URLs and `gcloud --project=` flags.

**Invariants for this step and every later `gcloud` call:**

- Pass `--project=<PROJECT_ID>` explicitly on every `gcloud` command that accepts it. Don't rely on `gcloud config get-value project`; its value can carry over from an unrelated shell or a prior failed run, which is exactly how the wrong-project `PERMISSION_DENIED` failure happens.
- Treat `<PROJECT_ID>` as a value you discover, not a value you write. Read it from the output of `projects list` or `projects create`, then thread it through.
- If the user named a specific project earlier in this chat ("use my work project `acme-data-1234`"), use that as `<PROJECT_ID>` and skip straight to 4c. Don't second-guess by listing or creating.

### 4a. Look for an ACTIVE Gini-managed project first

```bash
gcloud projects list --filter="projectId:gini-workspace-* lifecycleState:ACTIVE" --format="value(projectId)"
```

The filter is on **project ID prefix**, which we control — not display name, which collides freely. Every project this skill creates has an ID starting with `gini-workspace-`. If the command returns one or more IDs, pick the first as `<PROJECT_ID>` and skip ahead to 4d. A prior setup run already provisioned it; making another would just leave orphans.

### 4b. Otherwise, undelete a recently-deleted one

Google retains deleted project IDs in `DELETE_REQUESTED` state for ~30 days. During that window the name is reserved (so creating with the same ID fails with `ALREADY_EXISTS`) but the project can be restored with one call. Check before creating:

```bash
gcloud projects list --filter="projectId:gini-workspace-* lifecycleState:DELETE_REQUESTED" --format="value(projectId)"
```

If this returns one or more IDs, pick the most recent and undelete it:

```bash
gcloud projects undelete <PROJECT_ID>
```

Undelete is a single API call — it does NOT count against the per-minute project-create write quota the way `gcloud projects create` does, so this also avoids `RATE_LIMIT_EXCEEDED` during heavy testing. Most enabled APIs survive the undelete, but treat that as best-effort — 4d will re-enable any that didn't.

Skip ahead to 4d once undelete succeeds. (Service Usage takes 30-90 s to re-recognize the project after undelete; 4d's `services enable` retries internally so it tolerates the gap.)

### 4c. Otherwise, create a fresh one

The bare ID `gini-workspace` is almost always globally claimed — don't waste an attempt on it. Derive a deterministic, account-scoped suffix from the gcloud account so re-runs converge instead of accumulating projects:

```bash
gcloud config get-value account
# → something like "shelden@lilaclabs.ai"
```

Take the part before `@`, lowercase, and strip to `[a-z0-9-]`. The project-ID cap is 30 chars; `gini-workspace-` is 15, so truncate the suffix to 15 chars if needed.

```bash
gcloud projects create gini-workspace-<suffix> --name="Gini Workspace"
```

If even that ID is taken AND no DELETE_REQUESTED match was found in 4b (rare — only when a different user with the same email local-part already claimed it globally), append a 4-char random tiebreaker. `<PROJECT_ID>` is whichever ID succeeded.

If `gcloud projects create` errors with `RATE_LIMIT_EXCEEDED` for `cloudresourcemanager.googleapis.com.write_requests`, the user has burned through Google's per-account project-create quota (usually from repeated testing). Surface the error verbatim and ask: "Google is rate-limiting project creates; the quota typically clears in ~10 minutes. Want to wait and retry, or do you have an existing Cloud project I can use? Reply with a project ID or 'wait'." Do not loop the create call.

**Organization-restricted accounts.** If create instead errors with `PERMISSION_DENIED` and a message like `You do not have permission to create projects`, the account belongs to an organization (common on managed `@company` Google Workspace accounts) whose policy reserves project creation for admins. Accepting the Terms of Service will not change this. Surface the error verbatim and ask: "Your Google account can't create Cloud projects — your Workspace admin restricts that. Reply with an existing Cloud project ID I should use, or set Gini up with a personal @gmail.com account instead." Take a project ID as the new `<PROJECT_ID>` and resume from `projects describe` in 4d.

### 4d. Verify access, then enable the APIs

`projects describe` is the cheapest probe that fails fast if the active account doesn't own `<PROJECT_ID>` — much better than learning it from `services enable`'s permission error after the model has already committed to a flow.

```bash
gcloud projects describe <PROJECT_ID> --format="value(projectId)"
```

On success, enable the seven APIs (already-enabled ones are no-ops, which is fine when 4a reused an existing project):

```bash
gcloud services enable \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  docs.googleapis.com \
  sheets.googleapis.com \
  forms.googleapis.com \
  meet.googleapis.com \
  --project=<PROJECT_ID>
```

Calendar's service ID is `calendar-json.googleapis.com` (not `calendar.googleapis.com`).

If either 4d command errors with `PERMISSION_DENIED`, the active account doesn't own `<PROJECT_ID>`. Surface the error verbatim and ask the user briefly: "I don't have access to `<PROJECT_ID>`. Which project should I use?" Take their answer as the new `<PROJECT_ID>` and re-run from `projects describe`. Do not fall back to `gcloud config get-value project` to recover — that's the same stale value that produced the original failure.

## Step 5 — Last step: capture OAuth Desktop credentials

This is the only step that requires the user to click in a browser. Send **one** chat bubble with the two Cloud Console URLs and call `request_connector` immediately after. The inline form renders below the bubble; the user pastes the Client ID and Client Secret and clicks **Save**.

Construct the `reason` string as multi-line markdown with the URLs and click instructions. **Substitute `<PROJECT_ID>` with the actual project id from Step 4** — there is no runtime substitution.

Use this exact format:

```text
**Last step.** Complete the two Cloud Console pages below, then paste the credentials.

**Step 1 — OAuth consent screen** (skip if already configured)

https://console.cloud.google.com/apis/credentials/consent?project=<PROJECT_ID>

- User Type: **External**
- App name: **Gini Workspace**
- Your email for support contact and developer contact
- Save through Scopes (no scopes to add)
- Add yourself as a **Test user**

**Step 2 — Create an OAuth client**

https://console.cloud.google.com/apis/credentials?project=<PROJECT_ID>

- Click **Create Credentials → OAuth client ID**
- Application type: **Desktop app**
- Name it whatever (e.g. "Gini")
- Click **Create**

Then paste the **Client ID** and **Client Secret** below.
```

Then call:

```text
request_connector {
  provider: "google-oauth-desktop",
  reason: "<the constructed markdown string above, with <PROJECT_ID> filled in>"
}
```

Do NOT post a separate chat message before the tool call. Do NOT `open <url>` for either Console URL — let the user click from the bubble. Don't gate on "reply done" between the two pages — the form submission is what advances the flow.

On Save, the connector is created with env bindings (`GOOGLE_WORKSPACE_CLI_CLIENT_ID`, `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`), and the chat-task resumes at Step 6.

## Step 6 — Run `gws auth login`

`gws` reads the Client ID and Client Secret from the env vars Gini binds (`GOOGLE_WORKSPACE_CLI_CLIENT_ID`, `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`) and starts a local HTTP server on a random port to receive the OAuth callback. It then prints a URL like:

```text
Open this URL in your browser to authenticate:

  https://accounts.google.com/o/oauth2/auth?...&redirect_uri=http://localhost:NNNN&...
```

and blocks waiting for the user to complete consent. **It does NOT spawn the browser itself** — despite what `gws auth login --help` claims. If you just run `gws auth login` from `terminal_exec`, the URL goes into Gini's captured stdout and the user never sees it.

**Always pass every service we enabled APIs for to `-s`, regardless of what the user originally asked.** The user enabled APIs for all seven Workspace products in Step 4, and Google's consent screen renders each scope as its own row with per-scope checkboxes (for unverified apps in testing mode) — the user picks which to grant *there*, not by us pre-filtering the `-s` list. Narrowing `-s` to just "calendar" because the user's first ask was a calendar question silently locks them out of Drive / Gmail / Docs / etc. for the rest of the session.

To actually pop the browser, run gws in the background, scrape the URL out of its log, hand it to `open`, then wait for gws to finish. One `terminal_exec` call, single shell pipeline:

```bash
LOG=$(mktemp -t gws-auth.XXXXXX.log)
gws auth login -s drive,gmail,calendar,docs,sheets,meet,forms > "$LOG" 2>&1 &
GWS_PID=$!
# Poll for the URL (gws prints it within a second of starting).
URL=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  URL=$(grep -o 'https://accounts.google.com[^[:space:]]*' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -n "$URL" ]; then
  open "$URL"
else
  echo "gws never printed the consent URL — aborting."
  kill $GWS_PID 2>/dev/null
  exit 1
fi
# Wait for the user to complete OAuth consent in the browser; gws exits when
# its local callback server receives the code.
wait $GWS_PID
GWS_EXIT=$?
cat "$LOG"
rm -f "$LOG"
exit $GWS_EXIT
```

The user's default browser pops to Google's consent page listing every requested scope with its own checkbox; they tick the ones they want, click Continue, gws receives the callback, the command exits. `terminal_exec`'s timeout should be generous (≥ 3 min) — most users take 20-60 s, but a forgotten 2FA prompt can stretch it.

If `wait $GWS_PID` returns non-zero, gws's exit reason is in `$LOG` (printed before exit). Common cases:

- "Token exchange failed: invalid_client" → Client ID or Client Secret entered in Step 5 was wrong; re-run `request_connector` for `google-oauth-desktop`.
- "redirect_uri mismatch" → the Cloud Console OAuth client was created as Web type, not Desktop. Re-create as Desktop and re-paste.
- The user closed the browser without approving → just re-run the same block. Idempotent.

### When the user wants different scopes than the default

Two cases warrant deviating from the all-seven-services default:

- **The user explicitly asks for a narrower or read-only grant** ("I only use Gmail, skip the rest" / "give Gini read-only access"). Trust them, and run with their narrower picks.
- **The user is on a personal `@gmail.com` account AND wants the "full" Gmail scope** (`https://mail.google.com/`, which includes permanent delete). The default `recommended` preset will fail on unverified personal apps; you have to pass the full scope URL via `--scopes`.

```bash
# Read-only across the user's chosen services
gws auth login --readonly -s gmail,drive

# Exact per-scope picks (full URLs) — for the rare case the user names a
# specific scope shape `-s` can't express
gws auth login --scopes "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive"
```

`-s` takes **service names**, not scope strings — `-s gmail.readonly` is silently dropped.

Reference table of `-s` shorthand ↔ full scope URL (only useful when the user names a specific scope shape; the default is the full seven-service `-s` list, not anything from this table):

- **Gmail** — `-s gmail` ↔ `https://www.googleapis.com/auth/gmail.modify` (read + send + reply + label + draft; NOT permanent delete). Narrower: `.readonly` / `.send` / `.compose`.
- **Gmail (full, incl. permanent delete)** — `--scopes "https://mail.google.com/"`. No `-s` shorthand.
- **Drive** — `-s drive` ↔ `https://www.googleapis.com/auth/drive` (`.file`, `.readonly`, `.metadata.readonly` available as full URLs).
- **Calendar** — `-s calendar` ↔ `https://www.googleapis.com/auth/calendar` (`.events`, `.readonly`, `.freebusy` available as full URLs).
- **Docs** — `-s docs` ↔ `https://www.googleapis.com/auth/documents` (`.readonly` available).
- **Sheets** — `-s sheets` ↔ `https://www.googleapis.com/auth/spreadsheets` (`.readonly` available as a full URL).
- **Meet** — `-s meet` ↔ `https://www.googleapis.com/auth/meetings.space.created` (`.readonly` available).
- **Forms** — `-s forms` ↔ `https://www.googleapis.com/auth/forms.body` (`.body.readonly`, `.responses.readonly` available).

Never pass `--full` or the default `recommended` preset on a personal `@gmail.com` account — those expand to 80+ scopes including pubsub and cloud-platform, which an unverified app cannot grant. The seven-service `-s` list stays under the ~25-scope cap.

## Step 7 — Stop the per-call approval prompt (optional)

Every `gws` call goes through Gini's approval-gated `terminal_exec` tool. To stop the prompt firing on every invocation, patch the per-instance auto-approve list:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"patterns": ["gws *"]}' \
  http://127.0.0.1:<port>/api/settings/auto-approve
```

Set `$TOKEN` from `~/.gini/instances/<instance>/config.json` (the `apiToken` field).

For finer-grained gating, list each product:

```json
{ "patterns": ["gws gmail *", "gws calendar *", "gws drive *", "gws docs *"] }
```

## Step 8 — Smoke test

A read-only call that exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete. Resume the user's original ask (read mail, list calendar events, etc.).

## Rules

1. Walk this skill end-to-end on **first-time** setup. Do not skip to `request_connector` or `gws auth login` without the install + project + APIs in place. The one exception is the **re-auth** path (Step 0): when the `google-workspace-oauth` connector already exists, `gws auth login` alone is the whole job — `gcloud`, project creation, and `request_connector` are provisioning-only and must not re-run.
2. **Sign-in is a human-in-the-loop step.** Never attempt to type the user's email or password. `gcloud auth login` and `gws auth login` both open the default browser — wait for the command to return.
3. **Capture credentials through the inline form, not files.** Always use `request_connector { provider: "google-oauth-desktop" }`. Never ask the user for a path to `client_secret.json`, never write a JSON file under `~/.config/gws/`, and never `cat` or echo the credentials back into chat.
4. **Enable all seven Workspace APIs in Step 4 regardless of which product triggered setup.** One `gcloud services enable` call covers them all; this lets the user pivot to another product later without re-running setup.
5. **Status messages are action-oriented and ungrouped.** Do not list "Installed gws, installed gcloud, signed in, created project, enabled APIs." The user sees a chat bubble per milestone (confirm setup, last-step form, done) — not a retrospective changelog.
6. **Fail gracefully.** If `gcloud` errors with `PERMISSION_DENIED` or `ALREADY_EXISTS`, surface the error verbatim and ask the user. If an install fails, STOP — do not retry in a loop, hand off to the user with the one-line manual command.
7. **`gws auth login -s` includes every service we enabled APIs for in Step 4, not just the one the user happened to ask about.** Google's consent screen renders each scope as its own checkbox row in testing mode — the user picks there. Narrowing `-s` based on the current request silently locks the user out of the other six surfaces; they'd have to re-run setup the next time they want anything else. The only time you narrow is when the user explicitly says so ("read-only," "Gmail only," etc.).
8. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

## Manual Fallback

If `gcloud` cannot be installed at all (uncommon — Homebrew is the standard path on macOS, and Linux has a documented tarball install), hand off the Cloud Console flow to the user manually:

1. Tell them to open https://console.cloud.google.com/ and create a project named `gini-workspace`.
2. Enable the seven APIs at https://console.cloud.google.com/apis/library — Gmail, Calendar, Drive, Docs, Sheets, Forms, Meet.
3. Then resume from Step 5 (configure OAuth consent, create Desktop OAuth client, paste credentials into the inline form).

For flags not shown here, run `gws auth --help` and `gws --help`.
