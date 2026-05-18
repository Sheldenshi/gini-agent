---
name: google-forms
description: "Google Forms via gws: create forms, add items, read responses."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated with Forms scopes."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Forms

Use `gws forms` to create new forms, add questions to them, change publish settings, and read submitted responses. Wraps the Forms v1 API.

## Prerequisites

- `gws` installed and authenticated. If `gws auth login` has never been run on this instance, invoke the `google-workspace-setup` skill first.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Create / edit forms: `forms.body`
  - Read submitted responses: `forms.responses.readonly`
  - Both: pick both scopes at login time.

## When to Use

- The user asks Gini to create a Google Form (survey, signup, feedback, RSVP).
- Reading responses to an existing form and summarizing them.
- Updating publish settings on an existing form (accepting responses on/off, etc.).
- Watching for new responses on an existing form.

## When NOT to Use

- Structured data the user maintains themselves — use Sheets (`gws sheets ...`), not Forms.
- Free-form notes — use `apple-notes`, `obsidian`, or `google-docs` instead.
- Agent-internal state — use the `memory` tool.
- Long, branching surveys with complex logic — Forms supports basic section navigation but real survey tooling (Typeform, Qualtrics) is more appropriate.

## Quick Reference

The Forms surface is small: `forms.create`, `forms.get`, `forms.batchUpdate`, `forms.setPublishSettings`, and the `forms.responses` subresource for reading submissions.

### Create a form (two-step)

`forms.create` only honors `info.title` and `info.documentTitle`. Body items must be added with a follow-up `batchUpdate`. This is by design — Google rejects body content in the create call.

```bash
# Step 1: create the empty form
gws forms forms create --json '{
  "info": {
    "title": "Team feedback",
    "documentTitle": "Team feedback (internal)"
  }
}'

# Capture the response's "formId" — you'll need it for step 2.

# Step 2: add items (questions) with batchUpdate
gws forms forms batchUpdate \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{
    "requests": [
      {
        "createItem": {
          "item": {
            "title": "How are things going?",
            "questionItem": {
              "question": {
                "required": true,
                "textQuestion": {"paragraph": true}
              }
            }
          },
          "location": {"index": 0}
        }
      },
      {
        "createItem": {
          "item": {
            "title": "How satisfied are you?",
            "questionItem": {
              "question": {
                "required": true,
                "scaleQuestion": {
                  "low": 1, "high": 5,
                  "lowLabel": "Not at all", "highLabel": "Extremely"
                }
              }
            }
          },
          "location": {"index": 1}
        }
      }
    ]
  }'
```

### Read a form's structure

```bash
gws forms forms get --params '{"formId":"<FORM_ID>"}'
```

The response contains the title, items, and the `responderUri` (the public URL to share with respondents).

### Read responses

```bash
# All responses on a form
gws forms forms responses list --params '{"formId":"<FORM_ID>"}' --page-all

# A specific response
gws forms forms responses get \
  --params '{"formId":"<FORM_ID>","responseId":"<RESPONSE_ID>"}'

# Filter by submission time (server-side filter)
gws forms forms responses list \
  --params '{"formId":"<FORM_ID>","filter":"timestamp > 2026-06-01T00:00:00Z"}' \
  --page-all
```

Each response has an `answers` map keyed by `questionId`. Cross-reference against `forms.get` to map question IDs back to titles when summarizing.

### Publish settings

```bash
# Inspect
gws forms forms get --params '{"formId":"<FORM_ID>"}' | jq '.publishSettings'

# Update (legacy forms not supported)
gws forms forms setPublishSettings \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{"publishSettings":{"publishState":{"isPublished":true,"isAcceptingResponses":true}}}'
```

### Watch for new responses

```bash
gws forms forms watches create \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{"watch":{"target":{"topic":{"topicName":"projects/<PROJECT>/topics/<TOPIC>"}},"eventType":"RESPONSES"}}'
```

Watches deliver to Pub/Sub. For most agent workflows, polling `responses.list` on a schedule is simpler.

## Rules

1. `forms.create` is two-step by design: create the empty shell, then `batchUpdate` to add items. Trying to embed `items[]` in the create call is silently dropped.
2. Every `forms.create`, `forms.batchUpdate`, and `forms.setPublishSettings` is a write. Confirm form title, item list, and publish state with the user before invoking, even when `gws *` is auto-approved.
3. `batchUpdate` is atomic across all `requests`. Build the full sequence (createItem, updateItem, deleteItem, …) and send once; do not loop one-request-at-a-time, which doubles round trips and risks half-applied state.
4. The `responderUri` returned by `forms.get` is a public URL. Anyone with the link who is allowed by the form's access settings can submit. Be explicit when sharing it.
5. To map answers back to question text, fetch the form structure once with `forms.get` and keep the `questionId → title` map locally — do not refetch the structure on every response.
6. For structured data the user already owns (existing CSV or sheet), Forms is the wrong tool — keep the data in Sheets and use `gws sheets`. Forms is for **collecting** new input, not storing existing data.
7. Long, branching surveys are better served by dedicated survey tools (Typeform, Qualtrics). Forms supports basic page navigation and required questions but no advanced logic.

For flags not shown here, run `gws forms --help` or `gws schema forms.<resource>.<method>` to inspect a specific API method.
