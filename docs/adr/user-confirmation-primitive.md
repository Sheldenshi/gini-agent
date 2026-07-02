# ADR: User Confirmation Primitive (request_confirmation / confirmation.request)

## Status

Accepted.

## Decision

Give the agent a general "ask the user to confirm" primitive: an always-on
`request_confirmation` tool that pauses the chat turn on a
`confirmation.request` SetupRequest and resumes the loop with the user's
decision as an unambiguous boolean.

The agent calls it BEFORE an irreversible action that goes to another person —
sending or replying to a message or email, posting a reply in a web app,
submitting or purchasing on the user's behalf. The user sees an inline
Confirm/Cancel card in the web chat; the task parks in `waiting_approval`
until they decide, then resumes with `{ confirmed: true }` (the agent performs
the action itself) or `{ confirmed: false }` (the agent holds off and asks
what to change).

- **Tool contract**: `request_confirmation(summary, details?, confirmLabel?)`.
  `summary` (required) is the one-line "what will happen" statement shown as
  the card headline. `details` (optional) is the actual content the user is
  consenting to (message body, recipient, order summary), shown in a
  disclosure so they can review exactly what goes out. `confirmLabel`
  (optional, default `"Confirm"`) lets the agent label the button "Send" /
  "Submit" / "Purchase". No other flags — the contract stays minimal. The
  tool validates synchronously (non-empty `summary`) and returns a
  recoverable error result on bad input; a valid call mints the SetupRequest
  and returns `{ kind: "pending" }`.
- **Rides the SetupRequest rails** (see ADR
  [authorization-vs-setup-request.md](authorization-vs-setup-request.md)):
  the user is the actor, there is no risk pill, and the row resolves through
  the `/api/setup-requests/:id/{complete,cancel}` family. The payload carries
  `{ summary, details?, confirmLabel, toolCallId }`; `reason` and `target` are
  the `summary` so the `setup_requested` block summary (and transcripts) read
  as the summary itself. Like `chat.choice`, no `approval_reason` assistant
  bubble is persisted — the summary lives in the card. The
  [chat-block-protocol.md](chat-block-protocol.md) `setup_requested` block
  kind is reused (no new block kind); the new action drives a Confirm/Cancel
  variant of `BlockSetupRequested`. This is the user-actor sibling of
  [user-choice-prompt.md](user-choice-prompt.md): same rails, a yes/no decision
  instead of a single-select pick.

## Trust boundary: yolo is not authority for irreversible third-party actions

The instance default approval mode is `"yolo"` (see
[approval-mode.md](approval-mode.md)), a full bypass for every
*approval-gated* tool. But `approvalMode` only governs **agent-actor**
authorizations: only the `PolicyAction` subset flows through
`resolveApprovalPolicy` (`packages/runtime/src/execution/policy.ts`). SetupRequest actions are
**user-actor** and never call `resolveApprovalPolicy` — there is no auto-resolve
path for them at any approval mode. `request_confirmation` is therefore
yolo-immune by construction: minting a `confirmation.request` SetupRequest
pauses the task regardless of approval mode.

This encodes the trust boundary the primitive exists to enforce: **being
auto-approved authorizes operational, reversible work — not speaking in the
user's voice to others.** Sending a message, posting a reply, or placing an
order on the user's behalf is irreversible and third-party-facing; consent for
those is a separate, user-actor gate from the agent-actor risk gate that yolo
relaxes. The authorization card (an agent-actor risk gate) is deliberately NOT
reused for this — that flow is about *whether the agent may take a risky
action*; this is about *whether the user consents to content going out in their
name*.

## Resolution contract

`POST /api/setup-requests/:id/complete` is the Confirm button. The body
carries no fields — hitting `/complete` IS the confirmation. On the winning
claim the handler persists a human-readable `connectOutcome` (`"Confirmed"`)
so the resolved card reads truthfully after reload, then resumes the chat task
detached (safeResume) with the tool result `{ confirmed: true }`. No side
effect runs in the handler — the agent performs the actual send/submit on
resume.

`POST /api/setup-requests/:id/cancel` is the Cancel button. Like the
`connector.request` / `chat.choice` cancel contract, cancelling must never
kill the turn: it resumes the loop — here with `{ confirmed: false }`, the
SAME unambiguous boolean shape the Confirm path uses, so the model never has
to parse prose to learn the user declined. On a `false` the agent holds the
irreversible action and asks the user what to change.

## When the model should reach for it

The tool description, reinforced by `packages/runtime/src/runtime/defaults/INSTRUCTIONS.md`,
steers the model to call `request_confirmation` before any irreversible action
that goes to another person, EVEN under yolo. Two carve-outs keep it from
nagging or fabricating:

- **Clear prior go-ahead** — if the user already gave a specific go-ahead for
  THIS action in the conversation ("send it", "reply yes", "you can submit"),
  the agent does not ask again; it executes directly.
- **Don't invent the substance** — confirmation is consent to send content the
  user has approved, never a license to fabricate what they would say. When the
  agent lacks the substance, it asks for it as a normal question instead of
  composing a plausible version in the user's voice.

The per-message confirmation is fixed — not a mode the agent may offer to trade
away. It never presents the user a standing "auto-send" / "no approval needed"
arrangement for messages or email, and never asks them to choose between
drafting and sending: replies that speak in the user's voice are always drafted
for review, so the agent surfaces the draft, not a send-mode choice. A reply
proposed by an email watcher, for instance, always lands as a read-only draft
card for review (see [email-watch.md](email-watch.md)), never an auto-send the
watcher cannot perform.

On a confirmation (or that prior go-ahead) the agent performs the action
ITSELF — clicking Send/Submit, running the send command — and never hands it
back ("I don't click Send myself"). This is NOT for risk-gated operational
actions (those stay on the authorization flow) or for picking between options
(use `ask_user`).

## Surfaces

The Confirm/Cancel card renders in both the web chat and the mobile app. The
dispatcher carries the same surface guard as the sibling chat-card tools
(`ask_user`, `browser_fill_secrets`): a task with no interactive user chat
session — subagent child, scheduled job, or Telegram/Discord bridge — gets a
synchronous error telling the agent NOT to proceed with the irreversible action
and to ask for an explicit go-ahead as a regular message instead, so it never
strands in `waiting_approval`. On mobile, `BlockSetupRequested` renders an
actionable Confirm/Cancel card backed by a `useSetupRequests` query for
pending/resolved state (the `chat.choice` choice card and the
`browser.fill_secret` credential-fill card are actionable there too — the
filled value travels through the request body, so it needs no gateway machine).
The setup actions that stay read-only on mobile — `connector.request`,
`browser.connect`, messaging-bridge setup — do so because their flows (OAuth,
the desktop browser handoff, bot-token entry) require the gateway machine, not
because confirmation is web-only.

## Consequences

- `SetupRequestAction` gains `"confirmation.request"` (user-actor, no risk
  pill). The `setup_requested` block kind is reused, not extended.
- `request_confirmation` is always-on in the tool catalog (like `ask_user` /
  `request_connector`): the consent path must work on a fresh instance with no
  toolsets toggled.
- The result is an unambiguous boolean from both Confirm and Cancel, so the
  model's branch (perform vs. hold) is decided by data, not prose.
- Editing the bundled INSTRUCTIONS.md to encode the behavior rotates its hash;
  the prior default joins `HISTORICAL_DEFAULT_INSTRUCTIONS_HASHES` so existing
  instances auto-reseed (see [runtime-identity-files.md](runtime-identity-files.md)).
- Integration skills that send on the user's behalf defer to this primitive for
  a reply the agent composed or an outcome the user only delegated, rather than
  asserting "just execute / the `terminal_exec` gate is the safety net" — that
  gate does not fire under auto-approval, so a skill bypassing confirmation would
  send in the user's name with no consent. Skills keep the direct-execute path
  only for a message the user dictated and explicitly told the agent to send.

## Acceptance checks

- A `request_confirmation` call in a web chat session mints a pending
  `confirmation.request` SetupRequest carrying `{ summary, details?,
  confirmLabel, toolCallId }`; the task parks in `waiting_approval` even when
  `approvalMode` is `"yolo"`.
- `POST /api/setup-requests/:id/complete` resumes the chat task with tool
  result `{ confirmed: true }`; `POST /api/setup-requests/:id/cancel` resumes
  with `{ confirmed: false }`.
- The dispatcher rejects a task with no web chat session (job / messaging
  bridge) with a synchronous error result instead of minting a card.
- The `setup.requested` / `setup.completed` audit rows record the `summary` in
  `target`; the full `details` the user consented to is persisted in the
  SetupRequest payload.
