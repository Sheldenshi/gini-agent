# ADR: User Choice Prompt (ask_user / chat.choice)

## Decision

Give the agent a general "ask the user to pick" primitive: an always-on
`ask_user` tool that pauses the chat turn on a `chat.choice` SetupRequest and
resumes the loop with the user's answer.

- **Tool contract**: `ask_user(question, options)` where `options` is 2–6
  entries of `{ label, description? }`. Single-select only — no multi-select,
  no extra flags. The tool validates synchronously (non-empty question,
  2–6 options, non-empty distinct trimmed labels) and returns a recoverable
  error result on bad input; a valid call mints the SetupRequest and returns
  `{ kind: "pending" }` so the task parks in `waiting_approval`.
- **Always-on Other / Skip**: the web chat card ALWAYS renders an
  "Other (type your answer)" freeform input and a Skip affordance. These are
  card-owned, not tool params — the model must not include "Other"/"skip"
  entries in `options`.
- **Rides the SetupRequest rails** (see ADR
  [authorization-vs-setup-request.md](authorization-vs-setup-request.md)):
  the user is the actor, there is no risk pill, and the row resolves through
  the `/api/setup-requests/:id/{complete,cancel}` family. The payload carries
  `{ question, options, toolCallId }`; `reason` and `target` are the question
  so the `setup_requested` block summary (and transcripts) read as the
  question itself. Unlike `connector.request`, no `approval_reason` assistant
  bubble is persisted — the question lives in the card.

## Resolution contract

`POST /api/setup-requests/:id/complete` body, validated against the options
stored in the trusted setup payload BEFORE the claim (a bad body 400s and the
row stays pending):

- `{ choice: { label } }` — must match a stored option label. Resumes the
  loop with `User selected: "<label>"` (` — <description>` appended when the
  option carries one).
- `{ choice: { other } }` — non-empty freeform text. Resumes with
  `User answered: "<text>"`.

On the winning claim the handler persists a human-readable `connectOutcome`
(`You selected: X` / `You answered: ...`) so the resolved card reads
truthfully after reload, then resumes the chat task detached (safeResume).

`POST /api/setup-requests/:id/cancel` is the Skip affordance. Skipping a
question must never kill the turn: like the `connector.request` cancel
contract, the cancel resumes the loop with
`User skipped the question. Continue with your best judgment, or explain what
you need if you cannot proceed without an answer.` rather than failing the
task.

## When the model should reach for it

The tool description steers the model to call `ask_user` when multiple viable
paths exist and the user's preference matters — especially BEFORE requesting
connector setup, offering setup-vs-alternative choices (e.g. "Set up Brave +
Exa" / "Set up Brave only" / "Neither — use web_fetch"), and for general
mid-task preference or clarification questions. It is NOT for permission
confirmations: risk-gated actions stay on the authorization flow.

## Surfaces

The choice card is React UI in the web chat only. The dispatcher carries the
same surface guard as the sibling `request_*` tools: a task with no web chat
session (subagent child, scheduled job, Telegram/Discord bridge) gets a
synchronous error telling the agent to ask the question as a regular message
instead of stranding in `waiting_approval`. Other clients (/permissions,
mobile) render the generic setup-request fallback ("resolve in chat").

## Consequences

- `SetupRequestAction` gains `"chat.choice"` (user-actor, no risk pill).
- `ask_user` is always-on in the tool catalog (like `request_connector`):
  the setup-vs-alternative steer must work on a fresh instance with no
  toolsets toggled.
- Future multi-select or richer answer shapes would extend the payload and
  the `/complete` body — not add tool flags — so the single-select contract
  stays the default.
