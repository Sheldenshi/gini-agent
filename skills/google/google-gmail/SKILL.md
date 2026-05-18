---
name: google-gmail
description: "Gmail via gws: send, read, search, label, draft, reply, forward."
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

# Google Gmail

Use `gws gmail` to read, search, send, reply, forward, draft, label, and triage Gmail directly from the terminal. The CLI wraps the Gmail v1 API and produces structured JSON, so it composes cleanly with `jq` and other shell tooling.

## Prerequisites

- `gws` installed and authenticated. If `gws auth login` has never been run on this instance, invoke the `google-workspace-setup` skill first to walk the user through install, OAuth, scope selection, and `autoApproveCommands`.
- The OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read-only triage: `gmail.readonly`
  - Send a new message: `gmail.send`
  - Reply, reply-all, forward: `gmail.modify` — upstream helpers fetch the original message to thread `In-Reply-To` / `References` headers, which `gmail.send` alone cannot do
  - Drafts and labels: `gmail.modify` (or full `gmail`)

## When to Use

- The user asks Gini to send, draft, read, search, label, reply to, or forward email.
- Summarizing or triaging the inbox (latest unread, by-sender, by-label digests).
- Saving an attachment from a thread, or pulling a message body into another workflow.
- Watching for new messages and streaming them as NDJSON (`gws gmail +watch`).

## When NOT to Use

- Agent-internal scratch notes or transient state — use the `memory` tool, not email-to-self.
- Personal to-dos that should appear on the user's iPhone — use `apple-reminders`.
- Cross-device personal note-taking — use `apple-notes` or `obsidian`.
- Calendar invites and meeting scheduling — use `google-calendar` (a Gmail invite is still a Calendar event).
- Bulk outbound mail (newsletters, marketing) — personal Gmail has aggressive sending limits and Google will throttle or suspend the account. Tell the user to use a transactional provider.

## Quick Reference

The Gmail surface in `gws` is split into auto-generated API methods (`gws gmail users messages list`, `gws gmail users labels create`, …) plus a small set of curated helpers (`+send`, `+reply`, `+read`, `+triage`, …) that handle MIME encoding, threading, and base64 for you. Prefer the helpers for everyday tasks. The raw API is rooted at the `users` resource — every `--params` JSON must include `"userId": "me"` (or another delegated address).

### Send

```bash
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'

# CC, BCC, alias send-from
gws gmail +send --to alice@example.com --cc bob@example.com \
  --subject 'Status' --body 'See below.' --from alias@example.com

# Attachments (repeatable, 25 MB total)
gws gmail +send --to alice@example.com --subject 'Report' \
  --body 'See attached.' -a report.pdf -a notes.txt

# HTML body
gws gmail +send --to alice@example.com --subject 'Update' \
  --body '<b>Bold</b> text' --html

# Save as draft instead of sending
gws gmail +send --to alice@example.com --subject 'Draft' --body 'WIP' --draft
```

### Read

```bash
gws gmail +read --id <MESSAGE_ID>                # plain-text body
gws gmail +read --id <MESSAGE_ID> --headers      # include From/To/Subject/Date
gws gmail +read --id <MESSAGE_ID> --format json | jq '.body'
gws gmail +read --id <MESSAGE_ID> --html         # HTML body instead of text
```

### Search and list

`gws gmail users messages list` accepts standard Gmail search operators via the `q` param (`from:`, `to:`, `subject:`, `label:`, `is:unread`, `has:attachment`, `newer_than:7d`, etc.).

```bash
gws gmail users messages list --params '{"userId":"me","q":"from:alice@example.com is:unread","maxResults":20}'
gws gmail users messages list --params '{"userId":"me","q":"label:invoices newer_than:30d"}' --page-all
gws gmail +triage                                 # curated unread inbox digest
```

### Reply and forward

```bash
gws gmail +reply --message-id <MESSAGE_ID> --body 'Thanks — will follow up.'
gws gmail +reply-all --message-id <MESSAGE_ID> --body 'Looping in the team.'
gws gmail +forward --message-id <MESSAGE_ID> --to charlie@example.com \
  --body 'FYI from the thread below.'
```

The helpers preserve `In-Reply-To` and `References` headers so the reply lands inside the original thread.

### Labels and drafts

```bash
gws gmail users labels list --params '{"userId":"me"}'
gws gmail users labels create --params '{"userId":"me"}' \
  --json '{"name":"Receipts","labelListVisibility":"labelShow"}'
gws gmail users messages modify --params '{"userId":"me","id":"<MESSAGE_ID>"}' \
  --json '{"addLabelIds":["Label_123"],"removeLabelIds":["INBOX"]}'

gws gmail users drafts list --params '{"userId":"me"}'
gws gmail users drafts get --params '{"userId":"me","id":"<DRAFT_ID>"}'
```

### Watch for new mail

```bash
gws gmail +watch        # streams new messages as NDJSON (one JSON object per line)
```

## Rules

1. Every send is a side-effecting action. Confirm recipient list, subject, and body with the user before invoking `gws gmail +send` (or any `messages.send` / `drafts.send` call), even when `gws *` is auto-approved.
2. Prefer the curated helpers (`+send`, `+reply`, `+read`, `+triage`) over the raw `gws gmail <resource> <method>` surface — they handle MIME, base64, threading, and HTML-to-text conversion automatically.
3. When replying, use `+reply` / `+reply-all` so the thread stays intact. Building a new message with `+send` and pasting in the prior subject does not thread correctly.
4. Treat the Gmail scopes as three separate trust boundaries: `gmail.readonly` covers `+read` / `+triage` and any `messages.list`/`get` call; `gmail.send` covers a brand-new `+send` only; `gmail.modify` is required for `+reply`, `+reply-all`, `+forward`, labels, and drafts because those helpers must fetch the original message or mutate its state. If the user only granted a narrower scope at setup, never silently call a verb that needs a wider one — direct them back to `google-workspace-setup` to widen scopes.
5. Do not bulk-send from a personal `@gmail.com` account. Google throttles or suspends accounts that look like bulk senders. Use a transactional provider for newsletters or anything addressed to more than a handful of recipients.
6. Attachment cap is 25 MB total. For larger files, upload via `google-drive` and send the share link instead.
7. Never paste raw message bodies that contain secrets (API keys, passwords, MFA codes) back into the chat transcript. Summarize, redact, or write to a file the user controls.

For flags not shown here, run `gws gmail --help` or `gws gmail <verb> --help` (e.g. `gws gmail +send --help`).
