# ADR: Browser Fill-Secret Tool

## Decision

Gini gives the agent an inline-in-chat tool, `browser_fill_secrets`, that asks the user to supply one or more values which the gateway fills directly into named locators on the agent's browser tab via playwright. The tool covers any value only the user may supply: credentials (passwords, OTPs, account ids, MFA codes) AND payment-card or sensitive personal-info fields on a checkout, booking, or registration page — both classes ride the same secrecy plumbing. Values flow `user keyboard → chat UI → BFF → gateway → playwright → DOM` and are never persisted, never written to audit/trace payloads, and never reach the LLM. The tool reuses the existing `connector.request` setup-request substrate — same `POST /api/setup-requests/<id>/complete` endpoint, same `{ secrets: Record<string, string> }` body shape, same inline chat card UX rendered by `BlockSetupRequested.tsx` — distinguished only by the setup request's `action` field.

## Context

The agent's browser tool drives a Chromium instance via playwright. Many real workflows hit a login wall (GitHub, banking, internal SSO) where credentials must be supplied, or a checkout / booking / registration form that needs the user's payment-card details or sensitive personal info. The agent cannot type these values itself — and even if it could, the LLM context, transcripts, traces, and audit rows would all leak the secret. The user needs a way to supply the value directly into the right DOM field, inline in the same chat where the agent is working, so the agent can immediately re-snapshot the page and decide what to do next (including asking for another value if there are more fields to fill). At the payment / PII boundary, this secure fill is one of three completion paths the agent offers instead of refusing — alongside the visible-browser handoff ([browser-connect-handoff.md](browser-connect-handoff.md)) and step-by-step instructions; the surface-appropriate subset is chosen per [client-surface-context.md](client-surface-context.md).

Two earlier explorations were abandoned:

1. A full co-browsing handoff (live CDP screencast + WebSocket input relay) — overbuilt for a workflow that only needs typed-text delivery into one DOM field at a time.
2. A parallel `POST /api/setup-requests/<id>/value` endpoint with its own in-process value queue — duplicated infrastructure that the existing `/complete` substrate already provides. Same multi-input pattern, same bearer-injection BFF, same inline chat card — just with a slight payload variant.

The right substrate is the one already built for `connector.request`. The card lives in chat (`BlockSetupRequested.tsx`), Submit POSTs `{ secrets: Record<string, string> }` to `POST /api/setup-requests/<id>/complete`, the gateway's bearer is injected server-side by the BFF, and the runtime has full control over what the secrets are used for. For `connector.request`, the secrets are encrypted to a connector record. For our use case, they are passed straight to `page.locator(...).fill(...)` and discarded the moment the request returns.

## Required Now

- `SetupRequest.action` gains `"browser.fill_secret"`.
- The `POST /api/setup-requests/<id>/complete` handler is a thin routing seam that delegates to the bounded module `src/execution/browser-fill-secrets.ts:runFillSecretConnect(config, setupRequest, secrets)`. The module owns:
  - Slot parsing via the shared parser in `src/execution/browser-fill-secrets-types.ts` (same parser the dispatcher and the chat-card UI use, so the kind-allowlist enforcement can't drift between layers).
  - Full-submission contract: every declared slot must carry a non-empty string. Partial bodies return 400 with the list of missing slot names — the runtime is the gate, not the web client's UX-only `fillReady`.
  - Origin equality check against the structured `setupRequest.payload.approvedUrl`. The URL is NOT encoded into `setupRequest.target` as a parseable substring (peer setup-request actions also carry their contract fields under payload).
  - Atomic `resolveSetupRequest(..., { resumeChatTask: false })` BEFORE the per-slot fill loop. The atomic check-and-flip closes the cancel-mid-fill race window. `resumeChatTask: false` keeps the resolver from resuming the chat-task loop prematurely.
  - Per-slot fill loop with TWO guards. (a) URL re-check: lives INSIDE `browserFillByLocator`'s `withSession` callback (`src/tools/browser.ts`) so the comparison against `approvedUrl` runs immediately before the `locator.fill()` call — TOCTOU close at the depth of one playwright API hop. (b) Task-status re-check: lives in the bounded module's loop in `src/execution/browser-fill-secrets.ts` (one `readState` per iteration, BEFORE the per-slot `browserFillByLocator` call) — a `cancelTask` after the atomic resolve makes the next iteration observe terminal status and bail, recorded as `aborted: "task-cancelled-mid-fill"` in the audit evidence. The two guards live at different layers because the task-status check needs no playwright session (a `readState` call), while the URL check must observe the live `page.url()` and thus runs inside the session.
  - One redacted audit row with `redacted: true`. The audit writer-boundary in `src/state/audit.ts` drops `evidence` entirely on `redacted: true` as defense-in-depth — even though the bounded module passes `{ filledSlots, errors, ...aborted }` (operational metadata only, never values), that whole object is stripped before persistence. Operators looking for per-slot fill outcomes read the runtime trace (`appendTrace` writes from the bounded module) and the agent's resume tool result, both of which carry slot names and error strings. The audit row itself records only `action: "browser.fill_secret"`, `target: <approved-URL>`, `risk`, `taskId`, `approvalId`, and `actor: "user"`. Slot VALUES never appear in any artifact.
  - `resumeChatTask` wrapped in try/catch so a terminal-task throw inside the chat-task loop doesn't make the handler claim a 500; the audit row already records the truth about what filled vs. what didn't.
- A new agent tool `browser_fill_secrets` (always-on, same gating tier as `request_connector`):
  - Tool catalog descriptor: parameters `{ slots: Array<{ name, locator, label, kind? }>, reason: string }`.
  - Tool function rejects duplicate slot names up-front, then mints a setup request with `action: "browser.fill_secret"`, payload `{ slots, reason, toolCallId, approvedUrl }`. Returns `{ kind: "pending", setupRequestId }`. The dispatch creates the setup request directly via `createSetupRequest` — it does NOT route through `pendingOrAuto`, see "Approval-substrate carve-outs" below.
  - The chat-task loop emits a `setup_requested` block for any pending setup request (`chat-task.ts`); no new emission seam needed.
- A new branch in `BlockSetupRequested.tsx` for `action === "browser.fill_secret"`:
  - Renders one HTML input per slot from `payload.slots`, with `type` set from `slot.kind` (`text` | `password` | `email` | `tel` | `number` | `url`, defaulting to `text`).
  - Password-manager attributes (`autoComplete="off"`, `data-1p-ignore`, `data-lpignore`, `data-form-type="other"`) to suppress autofill.
  - Submit POSTs `{ secrets: Record<slot.name, value> }` to `/setup-requests/<id>/complete` via the existing `complete` mutation path.
  - Clears local state on EVERY settled outcome (success, partial-fail, network error, abort) and always invalidates the setup-requests query cache, since the gateway resolves the setup request atomically before running fills — a partial-fail still moves the request out of pending, so the card must re-render with Submit disabled.
- All audit rows for the fill action use `redacted: true` so the writer drops the evidence column at the boundary.
- Browser-side defense in depth: the snapshot walker masks the value of any input with `type="password"`, autocomplete in `current-password`/`new-password`/`one-time-code`, or a `data-gini-secret` attribute (stamped by `browserFillByLocator` post-fill). `browser_console` and `browser_vision` both post-process their tool results through `redactSecretValuesFromString` against the live `data-gini-secret` values, and `browser_vision` additionally blurs `[data-gini-secret]` elements via inline CSS immediately before the screenshot (restored in a finally block).

## Approval-substrate carve-outs

`browser.fill_secret` is intentionally outside two contracts that the
peer authorization ADRs assume hold universally. Both carve-outs are
made necessary by the fact that the side effect's INPUTS (the secret
values) live in the request body of `/complete` and must never become
arguments to `runApprovedAction` (which would require persisting
them).

- **Does not route through `pendingOrAuto`**: the dispatcher
  (`browserFillSecretsTool` in `src/execution/tool-dispatch.ts`) calls
  `createSetupRequest` directly. To keep the mode-uniformity claim in
  [approval-mode.md](approval-mode.md) end-to-end honest,
  `resolveApprovalPolicy` returns `{ mode: "gate", reason: "fill-secret-always-gate" }`
  for `browser.fill_secret` regardless of `approvalMode` — yolo
  cannot auto-approve credential entry because the credentials come
  from the user, not the agent. Any future refactor that wires
  fill_secret through `pendingOrAuto` still produces the same gate.
- **Side effect runs outside `executeApprovedAction`**: the per-slot
  playwright fills happen inside `/complete`'s request handler (via
  `runFillSecretConnect`), not inside `runApprovedAction`. Decision:
  [approval-execution-abort.md](approval-execution-abort.md) is updated
  to acknowledge the carve-out. In place of the `claimApproval` /
  `releaseApproval` / `raceWithAbort` infrastructure other approved
  actions get, the module re-reads task status via `readState` before
  each slot's fill and bails on terminal status. Granularity is
  "between slot N and slot N+1" instead of per-await.
- **`browser.fill_secret` is not routable via `/api/authorizations`**:
  the only resolution path is `/api/setup-requests/<id>/complete` with
  values. SetupRequest and Authorization are disjoint collections, so a
  fill_secret id never appears in `/api/authorizations`. `runApprovedAction`
  for `browser.fill_secret` is consequently unreachable by design —
  the side effect lives in `runFillSecretConnect`.

## Surface Restriction

The amber approval card is an interactive chat card rendered in the Gini web client (React on the Next.js BFF) and the mobile client (React Native in `mobile/src/components/chat/BlockSetupRequested.tsx`) — the value flows through the request body, so any interactive chat surface can collect it. The restriction below is therefore about the messaging bridges, which have no card at all, not about web vs. mobile. The messaging bridge mirrors in `src/integrations/telegram-poller.ts` and `src/integrations/discord-poller.ts` gate their reply dispatch on `isTerminalTaskStatus(...)` and log `messaging.{telegram,discord}.reply_skip_non_terminal` when the task is parked in `awaiting_approval`. If the tool were allowed to mint an approval while the conversation was originating from Telegram or Discord, the task would park, the mirror would skip, and the messaging-surface user would see a typing indicator that eventually stops — no card, no error, no path to submit.

The dispatch surface guard (`browserFillSecretsTool` in `src/execution/tool-dispatch.ts`) refuses the tool synchronously when the owning chat session has `source.kind === "telegram"` or `"discord"`, returning a structured `{ ok: false, error }` envelope. The agent receives a normal `tool_result` block, the chat-task loop continues to completion, and the agent's assistant text reply ("open the Gini web or mobile chat to enter credentials") IS something the messaging mirrors relay back once the task settles. The tool stays visible in the catalog (it isn't hidden per surface) so the agent's reasoning surface is unchanged; only the side-effecting path errors.

## Deferred

- A separate dialog (modal) variant — the inline card is enough for the foreseeable workflow.
- File-upload variants — `browser.upload_file` already handles that surface.
- Multi-page workflows where the agent needs to chain several fills — already covered because the agent can call the tool repeatedly, each call gets its own approval card in chat, and the agent re-snapshots between calls to learn the post-fill DOM state.
- Rendering the credential request *into* Telegram or Discord directly. The blocker is format compatibility — neither bridge has a structured-input affordance equivalent to the amber card, and posting raw credentials through a messaging channel would route them through the bridge provider and the LLM. A future deep-link-back-to-web flow ("open https://gini/chat/<session-id> to enter credentials") could close the UX gap without changing the trust boundary.

## Consequences For Coding Agents

- Sensitive values flow through this tool — they never appear in the agent's tool arguments or tool results. The tool DESCRIBES which fields need filling (locator + label per slot), not what to fill them with.
- The `/complete` handler enforces the redactor's minimum-length floor (`FILLED_SECRET_MIN_REDACTION_LENGTH`) as a submission gate ONLY on `kind: "password"` slots. fill_secret also collects identity/PII fields (the tool advertises account ids; a real call asks for a date of birth + last name), and those are legitimately short — last names like "Shi", "Ng", "Li". A non-password slot therefore accepts any non-empty value. A sub-floor value fills but is not entered into the substring-redaction registry (`recordFilledSecret` skips it so a short string can't shred structural snapshot tokens); the filled field is still masked in snapshots by its `data-gini-secret` stamp, so the only residual exposure is the secondary substring channel (page-echoed copies, `browser_console` eval, outbound URLs), acceptable for a non-credential. To protect a short numeric secret (a PIN), declare `kind: "password"`, which also masks the input.
- The `redacted: true` flag on audit rows is non-negotiable for `browser.fill_secret` — tests must assert that submitted values do not appear in `state.json`, `runtime.jsonl`, or the task's trace JSONL.
- The gateway's `/api/setup-requests/<id>/complete` handler is the seam for all SetupRequest actions: `connector.request`, `browser.fill_secret`, `browser.connect`, and the three `messaging.*` actions (`messaging.add_bridge`, `messaging.approve_pairing`, `messaging.remove_bridge`). See [chat-block-protocol.md](chat-block-protocol.md) for the per-action wire contract and [telegram-bridge.md](telegram-bridge.md) for the full messaging lifecycle (the `messaging.*` actions cover bridge create, pairing approve/reject, and bridge teardown from chat). New fill-style actions added later (e.g. `browser.fill_otp` with a TTL-bound code) follow the same pattern: extend `SetupRequestAction`, add a branch — ideally as a thin delegate to a bounded module under `src/execution/` like `runFillSecretConnect` / `runMessagingBridgeConnect` / `runMessagingPairingConnect` / `runMessagingRemoveConnect` — share the same body shape and BFF route. The shared `safeResume` helper in `src/execution/safe-resume.ts` handles the trace + `failTask` recovery on `resumeChatTask` throws so each new branch only owns its action-specific side effect.
- BFF code never sees the bearer token; the existing `/complete` BFF proxy already injects it server-side.

## Acceptance Checks

- Calling `browser_fill_secrets({ slots: [{ name: "username", locator: "input[name=\"username\"]", label: "Username" }, { name: "password", locator: "input[name=\"password\"]", label: "Password", kind: "password" }], reason: "Sign in to the test site" })` creates one pending setup request with `action: "browser.fill_secret"` and the agent loop pauses on `waiting_approval`.
- The chat UI renders one card with two input fields. The password field is `type="password"`.
- `POST /api/setup-requests/<id>/complete` with `{ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } }` fills both DOM fields via `browserFillByLocator`, writes one redacted audit row with `action: "browser.fill_secret"`, and resolves the setup request.
- A `browser.fill_secret` id never appears under `/api/authorizations`, so the `/approve` route can never resolve it; the only resolution path is `/complete` with the per-slot values.
- Posting `/complete` with a body that misses any declared slot returns 400 with the list of missing names; no DOM fill runs and the setup request stays pending.
- Posting `/complete` with a `kind: "password"` slot value below `FILLED_SECRET_MIN_REDACTION_LENGTH` returns 400 ("Secret value too short") and leaves the request pending. The same sub-floor value in a non-password slot (e.g. last name "Shi" in a `kind: "text"` slot) fills and resolves the request — the floor is redactor-safety scoped to secrets, not a general input-length rule.
- Posting `/complete` when the live page URL no longer matches `setupRequest.payload.approvedUrl` returns 409; no DOM fill runs and the setup request stays pending.
- Calling `browser_console` on a page with a `data-gini-secret`-stamped element redacts the value from `evalResult`, `evalError`, and console-message text.
- Calling `browser_vision` on a page with a `data-gini-secret`-stamped element blurs the element in the screenshot before sending to the vision model and additionally redacts any literal occurrence of the secret value from the model's answer.
- The on-disk `state.json` and the task's trace JSONL never contain `"tomsmith"` or `"SuperSecretPassword!"` byte sequences.
- Submitting the same setup request twice returns `410 Gone`.
- Cancelling the setup request via `POST /api/setup-requests/<id>/cancel` resolves the setup row without touching the browser; the current runtime treats `browser.fill_secret` cancellation as terminal until this action gains its own continuation contract.
- Calling `browser_fill_secrets` from a task whose chat session originates from Telegram or Discord (`session.source.kind === "telegram" | "discord"`) returns a synchronous `{ ok: false, error }` envelope from `dispatchToolCall` without creating any setup-request row, so the messaging mirror reaches `terminal` and relays the agent's plain-text fallback reply.
