---
name: gmail-watch
description: "Detection engine for Gmail email watches: polls gws for new matching mail, dedups, drops automated/self, and hands matches to the watcher's drafting turn. Provisioned and run automatically by an email watcher's backing job."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Gmail scopes."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Gmail Watch

This skill ships the **detection engine** behind an email watch. It is not
something you run by hand — when you create an email watch (`email_watch` tool,
`gini email add`, or the settings UI), Gini provisions a background job whose
pre-run hook runs this skill's `detect` script on a schedule. The script decides
whether there is new matching mail to draft a reply to.

## What it does

Each time the watch's job fires, `detect` runs **headless** (no model turn, no
approval) and:

1. Checks the Google sign-in. If signed out, it reports `needs_auth` and does
   nothing — the watch stays active and recovers the moment you re-authenticate.
2. Lists new mail matching the watch's query via `gws`, bounded by a watermark so
   steady-state polling lists almost nothing.
3. Drops automated senders (no-reply, mailer-daemon, notifications, …) and your
   own address — only real, human, new mail survives.
4. Hands each surviving match (its From / Subject / Date / snippet only — never
   the body) to the watch's drafting turn as quoted, untrusted data.

When nothing new matches, the run ends with **no model turn at all** — the watch
is silent until there is something to act on.

## How a match becomes a reply

The detection floor reads only metadata. The drafting turn that follows reads the
full message and composes a reply through the **google-gmail** skill, posts the
proposed reply in the watch's chat for you to review, and sends only when you
explicitly ask (which runs `gws gmail +reply` through the normal approval gate).

## Stateful but pure

`detect` is a pure function of the watch's query and a small cursor it is handed
each run; it never writes to disk itself. Gini stores the cursor on the watch's
backing job and advances it only after a drafting turn is dispatched, so a match
is never silently lost if delivery fails — it re-surfaces on the next run.

## First run baselines

The first time a watch runs it records where your inbox currently is and drafts
nothing for pre-existing mail — only mail that arrives *after* the watch was
created triggers a reply.
