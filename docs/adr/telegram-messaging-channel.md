# ADR: Telegram Messaging Channel

## Decision

Gini supports Telegram as a first-class messaging bridge. The runtime drives a bot via long polling (`getUpdates?timeout=30`), authorizes each inbound message by Telegram `user_id` against a per-bridge allowlist, routes each allowlisted user to their own Gini chat session and pinned agent, and delivers replies through `sendMessage` / `editMessageText`. Approvals raised by the agent become inline-keyboard prompts on the originating chat, with callback routing protected against cross-user approval.

The bot token is stored as a connector secret per ADR connector-secret-storage.md. Environment-variable tokens and any plaintext on the bridge record are rejected — explicitly, not deferred.

## Context

Telegram is the lowest-friction remote messenger for a local-first agent runtime: bot accounts are free, the Bot API has no business-verification gate, and the long-poll transport works behind any NAT or firewall the user's Mac happens to be sitting on. The product expectation in ADR local-runtime-architecture.md is that the user can drive the agent from a phone while the Mac runs headless — the same constraint that drove the rejection of macOS Keychain in ADR connector-secret-storage.md.

Telegram offers webhook delivery as an alternative to long polling, but webhooks require a publicly reachable HTTPS endpoint. The local-first runtime has no public ingress (and the runtime token in ADR local-runtime-architecture.md is explicitly bound to localhost). Long polling is the only transport that fits today's deployment shape; webhooks become viable later if the relay surface in ADR local-runtime-architecture.md materializes.

A bot's auth key is `from.id`, not `chat.id`. A group `chat.id` is shared across every member of the group; if the same bot were added to a group, the only way to keep non-allowlisted members from driving the agent is to filter at `from.id`. The runtime never authorizes by `chat.id`, even in private (1:1) chats where they happen to correlate.

## Required Now

- Connector secret. A `telegram` connector module (parallel to `linear`) accepts a single `token` secret, persists it via the connector secrets pipeline (encrypted file under `~/.gini/instances/<instance>/secrets/`), and probes `getMe` to confirm the token + extract the bot username for display.
- Bridge record. `MessagingBridgeRecord` gains `connectorId` (reference to the telegram connector) and `telegram` (config). `MessagingMessageRecord` gains `chatSessionId`, `externalId` (Telegram `message_id`), and `approvalId`. All new fields are optional so existing demo bridges keep working.
- Per-user allowlist. `bridge.telegram.allowlist` is an array of `{ telegramUserId, telegramUsername?, agentId, chatSessionId? }`. The allowlist is the only source of truth for "this Telegram user may drive this bridge"; non-allowlisted senders are silently dropped with a `messaging.telegram.dropped` audit row.
- Per-user chat session. The first inbound message from an allowlisted user creates a fresh chat session (titled "Telegram @handle" or "Telegram <user_id>" when the handle is missing), and the session id is cached on the allowlist entry. Subsequent messages from the same user keep landing in the same session so multi-turn context is preserved.
- Active-agent activation. Each inbound message activates the allowlist entry's `agentId` inside the same `mutateState` write that records the inbound message, so the subsequent chat-task resolves the intended agent's provider / toolset / memory namespace per ADR agent-memory-isolation.md.
- Long-poll worker. One worker per configured telegram bridge. Each worker owns an `AbortController`; the server shutdown drain aborts every worker so the in-flight `getUpdates` returns within one event-loop tick. The poller persists `bridge.telegram.updateOffset = max(processedUpdateId) + 1` after each batch so a runtime restart resumes after the last dispatched update without re-delivery.
- Backoff and lifecycle. Network / 5xx errors trigger exponential backoff (1, 2, 4, 8, capped 30s). HTTP 401 from `getUpdates` flips the bridge to `status: "error"` with a clear message ("Bot token rejected; rotate via connectors.") and stops the worker; the connector probe is the path to revive.
- Reply via terminal-state hook. `replyToMessagingFromTask` is a sibling of `finalizeJobRunFromTask` and is wired into every terminal-state site (chat-task completion, exhaustion, imperative completion, failTask, completeLowRiskToolTask, cancelTask, decideApproval-deny). It looks up the inbound row for the task, builds the reply from the synced assistant chat message (falling back to `task.summary` / `task.error`), and posts via `dispatchOutboundMessage`. Idempotent — skips when a non-approval outbound row already exists for the task.
- Inline-keyboard approvals. When the chat-task loop pauses with pending approvals, `emitTelegramApprovalPromptsForTask` checks whether the task was driven by an inbound Telegram message and posts an `[Approve] [Deny]` inline keyboard message for each approval. The outbound `MessagingMessageRecord` carries `approvalId` so the `callback_query` handler can route the button press back to `decideApproval`.
- Cross-user approval prevention. A `callback_query` for `appr:<id>` / `deny:<id>` is rejected if the `from.id` of the callback differs from the allowlist entry that owns the chat session the prompt was emitted into. Otherwise allowlisted-user-A could resolve allowlisted-user-B's pending action just by tapping the button in their own chat.
- Audit hygiene. Every messaging.telegram.* audit row records `bridgeId`, `telegramUserId`, `chatId`, `approvalId`, and / or the update kind. The bot token is NEVER included, even on probe failure or error paths.
- HTTP / CLI. `POST /api/messaging/:id/telegram/allow` and `DELETE /api/messaging/:id/telegram/allow/:userId` manage the allowlist. The CLI exposes `gini messaging add <name> telegram --connector <id>`, `gini messaging telegram allow <bridge> <user-id> --agent <agent-id> [--username <handle>]`, and `gini messaging telegram revoke <bridge> <user-id>`.

## Rejected

- Env-var bot tokens (`process.env.TELEGRAM_BOT_TOKEN`). Rejected by the parent decision in ADR connector-secret-storage.md; reintroduction would require a superseding ADR. The pre-ADR placeholder check in `src/integrations/messaging.ts` was removed in this change.
- Plaintext bot token on `MessagingBridgeRecord` or any audit row. The bridge holds `connectorId` only; the token is resolved per-call via `resolveConnectorSecret(config, connectorId, "token")`.
- Authorization by `chat.id`. A group `chat.id` is shared across members; only `from.id` (numeric, stable, per-user) is acceptable as the auth key.
- Authorization by `username`. Telegram lets users change their handle. The allowlist stores `telegramUsername` for display only.
- Webhook transport. Requires public HTTPS ingress; ADR local-runtime-architecture.md binds the runtime to localhost.

## Deferred

- Webhook delivery (revisit alongside the relay surface in ADR local-runtime-architecture.md).
- File / voice / sticker / photo handling. Text only for v1; non-text updates land a `messaging.telegram.unsupported_update` audit row and drop.
- Inline mode, payments, deep links.
- Multi-bot per instance. Today we run one bridge per bot; multiple telegram bridges per instance work but each must point at its own connector.
- MTProto / user accounts (Bot API only).
- Fancier streaming debounce. The current implementation throttles edits to ≤ 1/sec via a per-task last-edit timestamp; a smarter coalescer is a future change.
- Concurrent multi-user activation. The current implementation activates the per-message agent inside `mutateState` before submitting the task; in a multi-user burst where two inbound messages from different allowlist entries land in the same event-loop tick, the agent active at submitTask time depends on the per-instance lock ordering. v1 is typically single-user; documented here so a future per-task agent override can supersede this without rediscovery.

## Consequences For Coding Agents

- Do not read `process.env.TELEGRAM_BOT_TOKEN` or any other env-var holding bot credentials. Resolve via `resolveConnectorSecret(config, connectorId, "token")`. The pre-existing placeholder was the only consumer; do not reintroduce it.
- Do not store the bot token on `MessagingBridgeRecord`, audit `evidence`, log lines, or trace data. The token never leaves the connector secrets pipeline.
- Do not authorize by `chat.id` or `username`. Match against `bridge.telegram.allowlist[i].telegramUserId`.
- New terminal-state code paths on `Task` must call `replyToMessagingFromTask` alongside `finalizeJobRunFromTask`, wrapped in try/catch. The hook is idempotent (skips when a non-approval outbound row already exists for the task).
- Callback-query handlers must enforce cross-user approval routing: the allowlist entry that owns the chat session of the approval prompt MUST equal the entry the callback came from.

## Acceptance Checks

- A telegram connector probe with a valid token returns `{ ok: true, message: "Authenticated as @<username>" }`; with an invalid token returns `{ ok: false, message: "Telegram rejected the bot token (HTTP 401). Rotate it via connectors." }`.
- Adding a telegram bridge without `--connector` (or without `connectorId` on `POST /api/messaging`) throws "Telegram bridges require connectorId pointing to a telegram connector."
- A configured telegram bridge starts a poller at boot (`startConfiguredTelegramPollers`) and again whenever `POST /api/messaging/:id/health` flips its status to `configured`. The poller stops when the bridge is disabled or the bot token is rejected (HTTP 401).
- An inbound message from an allowlisted `from.id` lands in a fresh chat session (or the cached one), activates the entry's agent, submits a chat-mode task, and stamps `target = String(chatId)`, `externalId = String(message_id)`, and `chatSessionId` onto the inbound message row.
- An inbound from a non-allowlisted `from.id` records a `messaging.telegram.dropped` audit row with `reason: "unauthorized"` and does NOT submit a task.
- A `callback_query` whose `from.id` matches a different allowlist entry than the one that owns the approval's chat session records a `messaging.telegram.dropped` audit row with `reason: "cross_user_approval"` and does NOT call `decideApproval`.
- The bridge's `updateOffset` advances correctly across batches and survives a simulated restart (round-trip write + read of the state file).
- `sendMessagingOutput` for a telegram bridge resolves the connector secret, calls `sendMessage`, captures the returned `message_id` into `MessagingMessageRecord.externalId`, and flips status to `"sent"`. On Telegram HTTP failure the row flips to `"failed"` with the API description captured.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.
