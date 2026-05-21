---
name: google-calendar
description: "Google Calendar via gws: list events, create, accept, find free time."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Calendar scopes."
metadata:
  gini:
    version: 1.1.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
      env:
        - GOOGLE_WORKSPACE_CLI_CLIENT_ID
        - GOOGLE_WORKSPACE_CLI_CLIENT_SECRET
    requires:
      connectors:
        - provider: google-oauth-desktop
---

# Google Calendar

Use `gws calendar` to list events, create and update events, look up free/busy windows, and manage calendar ACLs. The CLI wraps the Calendar v3 API and produces structured JSON.

## Prerequisites

- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws calendar ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read-only agenda / free-busy: `calendar.readonly`
  - Create, update, delete events: `calendar.events` (or full `calendar`)
  - Manage calendar lists, ACLs, and secondary calendars: full `calendar`

## When to Use

- The user asks Gini to look at, summarize, or modify their calendar.
- Scheduling a one-off meeting or a recurring event.
- Finding a free slot across the user's own calendars or comparing free/busy with another attendee.
- Adding a Google Meet link to an invite.
- Pulling today's, tomorrow's, or this-week's agenda.

## When NOT to Use

- Personal to-dos the user wants to see on their iPhone — use `apple-reminders` for time-bound to-dos, not Calendar events.
- One-off agent alerts ("ping me in an hour") — use the cronjob tool, not a self-invite.
- Cross-device personal note-taking — use `apple-notes` or `obsidian`.
- Meeting *content* (agenda doc, shared notes) — use `google-docs` for the doc and attach it to the event with a Drive link.
- Project task tracking — use the project's issue tracker; Calendar is for time-bound events, not durable to-dos.

## Quick Reference

The Calendar surface is the auto-generated v3 API (`gws calendar events list`, `gws calendar events insert`, `gws calendar freebusy query`, …) plus two curated helpers: `+agenda` for digests and `+insert` for creating events without hand-rolling the JSON body.

### Agenda

```bash
gws calendar +agenda                              # next ~7 days, all calendars
gws calendar +agenda --today
gws calendar +agenda --tomorrow
gws calendar +agenda --week --format table
gws calendar +agenda --days 14
gws calendar +agenda --today --calendar 'Work'
gws calendar +agenda --today --timezone America/New_York
```

`+agenda` is read-only and uses the user's Google account timezone by default. Override with `--timezone <IANA>` when the user is travelling.

### Create an event

```bash
gws calendar +insert \
  --summary 'Standup' \
  --start '2026-06-17T09:00:00-07:00' \
  --end   '2026-06-17T09:30:00-07:00'

# With attendees + Meet link
gws calendar +insert \
  --summary 'Design review' \
  --start '2026-06-17T14:00:00-07:00' \
  --end   '2026-06-17T15:00:00-07:00' \
  --attendee alice@example.com \
  --attendee bob@example.com \
  --meet \
  --location 'Room 4' \
  --description 'Walk through the v2 mocks.'
```

Times are RFC 3339 / ISO 8601. Always include the offset (`-07:00`, `+02:00`, `Z`) — naked local times round-trip incorrectly across DST.

For natural-language event creation, the API surface also offers `events.quickAdd`:

```bash
gws calendar events quickAdd \
  --params '{"calendarId":"primary","text":"Coffee with Pat tomorrow 3pm-3:30pm"}'
```

### List, get, update, delete events

```bash
gws calendar events list \
  --params '{"calendarId":"primary","timeMin":"2026-06-17T00:00:00Z","timeMax":"2026-06-18T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'

gws calendar events get \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'

gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}' \
  --json '{"location":"Room 5"}'

gws calendar events delete \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'
```

### Respond to an invite (RSVP)

Google does not expose a dedicated RSVP method — you respond by patching the event and updating the current user's entry in the `attendees` array. That means the agent needs three things first: the `eventId`, the user's own email address (so it can find its attendee entry), and the full existing `attendees` array (so the patch can preserve everyone else).

```bash
# 1. Look up the signed-in user's email — `gws auth status` returns
#    structured JSON; the email lives at the top-level `.user` key.
gws auth status | jq -r '.user'

# 2. Fetch the event to read the existing attendees array.
gws calendar events get \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'

# 3. Patch the event with the full attendees array, flipping just the
#    current user's responseStatus to accepted | declined | tentative.
gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>","sendUpdates":"all"}' \
  --json '{
    "attendees": [
      {"email":"alice@example.com"},
      {"email":"bob@example.com"},
      {"email":"me@example.com","responseStatus":"accepted"}
    ]
  }'
```

Set `sendUpdates` to `"all"` (notify everyone), `"externalOnly"`, or `"none"` based on what the user wants. RSVP changes always notify the organizer when `sendUpdates` is `"all"`.

### Find free time

```bash
gws calendar freebusy query --json '{
  "timeMin": "2026-06-17T09:00:00-07:00",
  "timeMax": "2026-06-17T18:00:00-07:00",
  "items": [{"id":"primary"},{"id":"alice@example.com"}]
}'
```

The response lists busy windows per calendar; free time is the complement within `[timeMin, timeMax]`.

### Calendar list and ACLs

```bash
gws calendar calendarList list
gws calendar calendars insert --json '{"summary":"Side project"}'
gws calendar acl list --params '{"calendarId":"primary"}'
gws calendar acl insert --params '{"calendarId":"primary"}' \
  --json '{"role":"reader","scope":{"type":"user","value":"alice@example.com"}}'
```

## Rules

1. Calendar events are **time-bound things on a schedule** — meetings, appointments, focus blocks. For personal to-dos that should appear on the user's iPhone, prefer `apple-reminders`. For agent-internal alerts ("remind me in 2 hours"), use the cronjob tool. Confirm intent before deciding which.
2. Don't add a redundant text confirmation before `events.insert`, `events.patch`, `events.delete`, or `+insert`. The runtime's `terminal_exec` approval gate is the user's safety net — if `gws *` isn't auto-approved they'll see the gate per-command; if it is, they've opted in to "just do it." When the user's command is clear ("remove dinner," "decline the 2pm"), execute. Do ask one clarifying question when the command is ambiguous — multiple events match the description, the user didn't specify which calendar, or `sendUpdates` would email attendees the user might not want notified.
3. When the user says "accept" / "decline" / "tentative" on a meeting, confirm **which event** and **which response status** before patching. Resolve the user's own email via `gws auth status | jq -r '.user'` (or read it from the event's `attendees` array) so the patch updates the right attendee, and re-send the full `attendees` array so other invitees aren't dropped. RSVP changes email-notify the organizer when `sendUpdates` is `"all"`.
4. Use RFC 3339 times with an explicit offset on `+insert` and `events.insert`. Naked local times silently drift across DST boundaries.
5. Prefer `+insert` over hand-rolling `events.insert --json` when the user just wants a normal event. The helper sets sane defaults (visibility, reminders) without forcing the agent to learn the full body schema.
6. Adding `--meet` to `+insert` creates a Google Meet space attached to the event — this is the simplest way to give the user a join link. Do not separately call `google-meet` to create a standalone space when an event will exist anyway.
7. When listing events, set `singleEvents:true` and `orderBy:"startTime"` so recurring events expand into individual instances and arrive in chronological order. Without those, the response is grouped by recurrence master and confusing to summarize.
8. Free/busy queries are read-only and cheap — prefer them over scraping multiple `events.list` calls when the user only needs availability, not event content.
9. Respect the calendar's timezone, not just the host's. `+agenda` defaults to the Google account timezone; only override with `--timezone` when the user is travelling.

For flags not shown here, run `gws calendar --help` or `gws calendar <verb> --help` (e.g. `gws calendar +insert --help`).
