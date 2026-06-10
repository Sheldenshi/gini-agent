---
name: google-meet
description: "Google Meet via gws: create spaces, fetch join links, list recordings."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated with Meet scopes."
metadata:
  gini:
    version: 1.1.2
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
      env:
        - GOOGLE_WORKSPACE_CLI_CLIENT_ID
        - GOOGLE_WORKSPACE_CLI_CLIENT_SECRET
    requires:
      credentials: [google-workspace-oauth]
---

# Google Meet

Use `gws meet` to create Meet spaces (the persistent video rooms with a join link), fetch metadata for a space, and inspect conference records — past calls, participants, recordings, transcripts, and smart notes. Wraps the Meet v2 API.

## Prerequisites

- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws meet ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Create / update / end spaces: `meetings.space.created`
  - Read past conference records, participants, recordings, transcripts: `meetings.space.readonly`
- Recordings, transcripts, and smart notes are Workspace-tier features. They may be absent on personal `@gmail.com` accounts even when the scope is granted.

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws meet spaces create --json '{}'
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`).

## When to Use

- The user wants a Meet join link that isn't tied to a specific Calendar event ("a permanent room for our team").
- Looking up past meetings: who attended, when, recording URLs, transcript text.
- Ending an active conference programmatically (e.g. when a workflow has finished its run).
- Updating a space's access settings (open / trusted / restricted).

## When NOT to Use

- Scheduling a meeting at a specific time with attendees — use `google-calendar` with `+insert --meet`. Calendar events with `--meet` automatically attach a Meet space; you do not need a separate `gws meet spaces create` call.
- Reading meeting *content* like a shared agenda or notes doc — use `google-docs`.
- Personal cross-device reminders or notes — use `apple-reminders` / `apple-notes`.
- Agent-internal ephemeral state — use the `memory` tool.

## Quick Reference

The Meet surface has two resources: `spaces` (the room object) and `conferenceRecords` (a finished call). Most agent workflows live in `spaces.create` and `conferenceRecords.list`.

### Create a Meet space

```bash
# Default settings (open access, auto-generated join link)
gws meet spaces create --json '{}'

# Restricted access — only invited users can join directly
gws meet spaces create --json '{
  "config": {"accessType": "RESTRICTED"}
}'
```

The response includes the `meetingUri` (the `https://meet.google.com/abc-defg-hij` link to share) and the canonical `name` (e.g. `spaces/AAAA...`) used for subsequent updates.

### Look up or update a space

```bash
gws meet spaces get --params '{"name":"spaces/<SPACE_ID>"}'
gws meet spaces patch --params '{"name":"spaces/<SPACE_ID>"}' \
  --json '{"config":{"accessType":"TRUSTED"}}'
gws meet spaces endActiveConference --params '{"name":"spaces/<SPACE_ID>"}'
```

### List past conference records

```bash
# Recent calls across all spaces the user has access to
gws meet conferenceRecords list

# Filter to a specific space
gws meet conferenceRecords list \
  --params '{"filter":"space.name=\"spaces/<SPACE_ID>\""}'
```

### Drill into a single conference

```bash
gws meet conferenceRecords get --params '{"name":"conferenceRecords/<RECORD_ID>"}'

# Who joined
gws meet conferenceRecords participants list \
  --params '{"parent":"conferenceRecords/<RECORD_ID>"}'

# Recordings (if recording was on)
gws meet conferenceRecords recordings list \
  --params '{"parent":"conferenceRecords/<RECORD_ID>"}'

# Transcripts and smart notes (Workspace-tier accounts)
gws meet conferenceRecords transcripts list \
  --params '{"parent":"conferenceRecords/<RECORD_ID>"}'
gws meet conferenceRecords smartNotes list \
  --params '{"parent":"conferenceRecords/<RECORD_ID>"}'

# Actual transcript TEXT — `transcripts list` returns metadata only
# (timing, state, docsDestination); the spoken text lives in
# `transcripts.entries`.
gws meet conferenceRecords transcripts entries list \
  --params '{"parent":"conferenceRecords/<RECORD_ID>/transcripts/<TRANSCRIPT_ID>"}'
```

Each transcript also exposes a `docsDestination` pointing at a Google Doc with the human-readable rendering. Fetching that Doc requires Docs/Drive scope (which this skill does not advertise) — if those scopes were granted at setup, prefer the Doc for a clean readable transcript; otherwise stream `entries.list`.

### Sharing the join link

Don't paste raw `meetingUri` blindly into shared channels. For a meeting that has attendees and a time, use a Calendar event with `--meet` so attendees see it on their calendar:

```bash
gws calendar +insert \
  --summary 'Design sync' \
  --start '2026-06-17T14:00:00-07:00' \
  --end   '2026-06-17T15:00:00-07:00' \
  --attendee alice@example.com \
  --meet
```

Use `gws meet spaces create` only when there is no associated event (a persistent team room, an ad-hoc call, an automation trigger).

## Rules

1. Prefer Calendar `+insert --meet` over a standalone `gws meet spaces create` whenever a meeting has a scheduled time and attendees. The Calendar invite carries the Meet link and notifies attendees automatically; a standalone space does neither.
2. Don't add a redundant text confirmation before `spaces.create` or `endActiveConference`. The runtime's `terminal_exec` approval gate is the user's safety net. When the user's command is clear ("end the call I'm in"), execute. Do ask one clarifying question when the command is ambiguous — the user owns multiple active conferences, or `endActiveConference` would disconnect attendees the user might not realize are in the call (mention that side effect, then proceed unless they redirect).
3. Treat a Meet `meetingUri` like a credential to the room. Anyone with the link (and the configured `accessType`) can join. Confirm access settings before sharing in public channels.
4. Recordings, transcripts, and smart notes are not available on every account. If `conferenceRecords transcripts entries list` returns an empty list or a 403, fall back to asking the user to enable recording in Workspace admin or to summarize the meeting another way. (`transcripts list` only tells you whether a transcript object exists; the entries call tells you whether there is any captured text to read.)
5. For agent automations that need to know "did the meeting happen?" or "who showed up?", poll `conferenceRecords list` filtered by space — do not try to scrape Calendar.
6. Personal `@gmail.com` accounts have feature gaps and stricter limits on Meet. Workspace tenants get the full feature set; tell the user when a feature requires Workspace.

For flags not shown here, run `gws meet --help` or `gws schema meet.<resource>.<method>` to inspect a specific API method.
