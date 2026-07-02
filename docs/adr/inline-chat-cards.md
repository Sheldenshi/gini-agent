# ADR: Agent-Authored Inline Cards And The Direct Draft-Send Affordance

- **Status:** Accepted
- **Date:** 2026-06-29
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [User Confirmation Primitive](./user-confirmation-primitive.md), [Outbound Chat Attachments](./outbound-chat-attachments.md), [BFF Trust Boundary](./bff-trust-boundary.md)

## Decision

The agent renders rich, self-contained cards INSIDE its reply by emitting
**fenced code blocks with a reserved language** in its `assistant_text`. The web
markdown renderer (`MarkdownContent`) routes a recognized fence to a React
component instead of a `<pre>`; an unrecognized client degrades it to a readable
code block. Two fences exist today:

- ` ```email-draft ` — an RFC-ish header block (`To`/`Cc`/`Bcc`/`From`/`Subject`)
  plus body, rendered as a draft card.
- ` ```calendar ` — a `view`/`date`/`tz` header plus pipe-delimited event lines,
  rendered as a read-only week/day grid.

The skill that produces the data (e.g. `google-gmail`, `google-calendar`) owns
the fence grammar in its SKILL.md; the renderer is the only consumer. This is a
client-rendering convention layered on the existing markdown answer — NOT a new
`ChatBlock` kind (contrast the typed action cards in
[chat-block-protocol.md](./chat-block-protocol.md), which are structured
`SetupRequestedBlock`s on the wire).

**Layout.** A `calendar` fence is hoisted OUT of the message bubble by
`BlockAssistantText` and rendered as a standalone full-width card placed ABOVE
the reply prose (so a 7-day grid is readable and reads like the standalone
Question/Setup cards), with the surrounding prose collapsed into one bubble. The
week-grid primitives are a single shared component (`packages/web/src/components/calendar/`)
used by BOTH this preview and the Jobs-tab calendar, over a generic
duration-aware `CalendarEvent` (the Jobs view adapts jobs onto it).

**Direct draft-send.** The draft card carries the saved gws draft id and account
as extracted metadata lines (`DraftId` / `Account`, never shown as recipients).
Every emitter — the interactive Gmail flow and the email-watch worker — saves a
real Gmail draft and tags the fence with its `DraftId`, so the card ALWAYS shows a
**Send** button that sends the ALREADY-SAVED draft
**directly, server-side, with no agent turn**: the browser POSTs through the BFF
to `POST /api/email/drafts/send { draftId, account? }`, the gateway resolves the
account to its gws config dir and runs `gws gmail users drafts send`, records the
id in a durable `sentDrafts: string[]` on `RuntimeState`, and stamps an audit row.
A `GET /api/email/drafts/sent` read (all ids, or filtered by `?ids=`) lets the
card render the durable "Sent" state across refreshes; the chat surface fetches it
eagerly so the card paints "Sent" on first render rather than flashing "Send".

The explicit Send click IS the user's consent for this irreversible,
third-party-facing action, so it does not route through the agent's
`request_confirmation` gate (see
[user-confirmation-primitive.md](./user-confirmation-primitive.md)) — that
primitive is for the agent pausing its OWN in-progress send and resuming on
confirm. The draft-send is post-hoc and user-initiated, so a dedicated endpoint
performs it directly. Approval/audit are preserved (audit row + the click as the
authorization); the browser never holds the gateway token (it goes through the
BFF — see [bff-trust-boundary.md](./bff-trust-boundary.md)).

## Context

An `email-draft` card already let the agent show a saved Gmail draft in
chat instead of telling the user to open Gmail. Two needs generalized it:

- A meeting email is more useful with the week it lands in. Rather than a bespoke
  calendar widget, the inline `calendar` fence reuses the Jobs-tab calendar grid,
  generalized to carry real event durations and a `proposed`/`cancel` status.
- "Show me the draft" naturally invites "send it." Re-prompting the agent to send
  is slow, indirect, and leaves no durable record the card can read back. A
  direct endpoint with a persistent marker makes the Send button a one-click,
  refresh-stable action.

## Consequences

Pro:
- One calendar component serves both the Jobs tab and the inline preview; new
  fence cards are a renderer route plus a skill-owned grammar, no wire change.
- The Send affordance is durable and immediate: state survives refresh and a
  click sends without spinning up a model turn.
- Non-rendering clients (mobile, CLI) degrade a fence to a readable code block;
  the calendar/draft cards are a web enhancement, not a wire dependency.

Con:
- The fence grammar is a contract split between a skill's SKILL.md and the web
  renderer/parser; they must move together (each parser is lenient and the skill
  carries a worked example to keep them aligned).
- `sentDrafts` is server state a card reads back; an inline card now has a small
  amount of durable, action-specific persistence beyond the block stream.
- A side-effecting outbound action runs OUTSIDE the agent loop. It is constrained
  to "send a draft the agent already saved, by id" and audited, but it is a
  deliberate exception to "outbound actions flow through the agent."

## Acceptance Checks

- `cd packages/web && bun test src/components/chat/CalendarView.test.tsx` covers the fence
  parser (header/event grammar, statuses, malformed-line skipping) and the
  adapter to the shared grid; `EmailDraftCard.test.tsx` covers metadata
  extraction, the Send POST flow, and the durable/eager "Sent" state.
- `bun test packages/runtime/src/http-email-draft-send.test.ts` covers the send route
  (account→configDir, durable marker + audit on success, no-mark on failure) and
  the `sent` read (all ids vs `?ids=` filter).
- The Jobs-tab calendar renders unchanged after the grid was generalized.
