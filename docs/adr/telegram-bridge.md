# Telegram Messaging Bridge

## Decision

A Telegram bridge is a `MessagingBridgeRecord` with `kind: "telegram"` and a per-bridge encrypted bot token. The runtime talks to `api.telegram.org` directly over `fetch` — no SDK dependency. Outbound (`POST /api/messaging/:id/send`) calls Telegram's `sendMessage`; inbound is a long-poll `getUpdates` loop owned by the gateway. Bot tokens live in the per-instance secret store under the `messaging.<bridgeId>` namespace and never appear on the bridge record.

The macOS Keychain, public webhooks, and a Telegram SDK are all rejected. They each add either a remote-headless dialog (Keychain), a public-internet surface (webhooks), or a runtime dependency tree (SDK) that the local-first Gini shape does not need.

## Context

Gini's messaging surface already modeled `MessagingBridgeRecord`, `MessagingMessageRecord`, and HTTP endpoints (`POST /api/messaging`, `/:id/send`, `/:id/receive`, `/:id/health`, `/:id/disable`). Until this ADR the telegram code path was a stub: `checkMessagingBridge` only verified that `TELEGRAM_BOT_TOKEN` was set in the runtime env, and `sendMessagingOutput` wrote a state record without performing a Bot API call. A real integration needed three things: secret-bound transport, an outbound call site, and an inbound pump.

Webhook delivery requires Telegram to reach the gateway over the public internet. The gateway binds to `127.0.0.1` per ADR `local-runtime-architecture.md`, so webhook mode would force the user to operate a tunnel (ngrok, cloudflared) and pin a public certificate. Long-poll `getUpdates` works from any network position and keeps the gateway entirely on the loopback interface.

A Telegram SDK (e.g. `node-telegram-bot-api`) is rejected on the same grounds the rest of this codebase prefers — the wire format is a small set of POST endpoints with JSON bodies; introducing a runtime dependency only adds upgrade exposure, a handler abstraction the runtime does not need, and (in the python-side reference systems we surveyed) elaborate workarounds for the SDK's own coupling to a process-wide `Application` lifecycle.

The Telegram Bot API caps the long-poll timeout at 50 seconds and uses an offset-based acknowledgment scheme: the next call's `offset` parameter implicitly acknowledges all updates with `update_id < offset`. The runtime therefore has to persist the next offset so a crash mid-batch doesn't replay messages that already produced tasks.

## Required Now

- `MessagingBridgeRecord` carries optional `secretRefs` (per-bridge encrypted secret pointers) and `metadata` (kind-specific free-form state — for Telegram: `botUsername`, `botId`, `lastOffset`).
- `POST /api/messaging` with `kind: "telegram"` requires a `botToken` field. The token is written through `writeSecret(instance, "messaging.<bridgeId>", "bot-token", value)` and immediately discarded from memory.
- `POST /api/messaging/:id/health` performs a real `getMe()` round-trip when the bridge is Telegram-kind. Bot username/id land on `bridge.metadata`; failures mark `bridge.status = "error"` with the API description as `bridge.message`.
- `POST /api/messaging/:id/send` dispatches `sendMessage` for Telegram-kind bridges. The `target` field is the `chat_id`. Send failures mark the resulting `MessagingMessageRecord.status = "failed"` with `error` set to the API description.
- `POST /api/messaging/:id/disable` deletes every encrypted file under `messaging.<bridgeId>` and clears `bridge.secretRefs`. The bridge status flips to `"disabled"` before the file cleanup so a partial failure cannot leave an active token on disk under a configured bridge.
- The gateway runs a Telegram poller supervisor that reconciles per-bridge long-poll loops against state every five seconds (`GINI_TELEGRAM_RECONCILE_MS`). Loops run `getUpdates(offset, 25, signal)` with `allowed_updates: ["message"]`, route each text message through `receiveMessagingInput` (which already calls `submitTask`), and persist `metadata.lastOffset = update.update_id + 1` after each update.
- SIGTERM aborts every active long-poll via `AbortController` so shutdown does not wait out the 25-second timeout.
- The Telegram HTTP client (`src/integrations/telegram.ts`) is mockable via an injected `fetch`; the messaging module exposes `setMessagingDeps` for tests to substitute a stub `TelegramClient`. Production callers leave both unset.

## Trust Boundary

- The bot token is a write-only field on the create payload. It is encrypted at rest and never re-emitted — neither on the bridge record, nor in audit evidence, nor on `MessagingMessageRecord`. A bridge owner has no API to read it back; they re-supply it by recreating the bridge.
- The poller calls `receiveMessagingInput` which submits a task. Task-level approval (per ADR `approval-execution-abort.md`) and the active-agent toolset/messaging-target filters (per `agents-replace-profiles.md`) apply unchanged. The bridge does not bypass them.
- `allowed_updates` is pinned to `["message"]`. Callback queries, inline events, edits, and other update kinds are not surfaced until the runtime grows explicit routing for them. An attacker controlling a Telegram chat cannot reach internal call sites by sending update kinds the runtime ignores.
- The bridge owner controls which chats can speak to the bot. We do not add a per-chat allowlist in this iteration — Telegram bot accounts only see messages addressed to them, and the runtime treats every inbound message as a task input subject to the same governance as any other. A chat-level allowlist is a plausible follow-up if the surface grows.

## Open Questions

- Per-chat allowlist. Today every chat that messages the bot can submit tasks. A chat-id allowlist on the bridge would let a user restrict the bot to their own chats; the data shape (`metadata.allowedChatIds`) already supports it.
- Rich message kinds. Photos, documents, callback buttons, MarkdownV2 escaping, and reply threading are deliberately out of scope. Each is an extension on top of the same client (`sendMessage` → `sendPhoto`, etc.) and a small addition to the poller's update filter.
- Network egress fallbacks. Some networks block the public IP `api.telegram.org` resolves to. A hostname-preserving fallback transport (curl `--resolve` equivalent) is a plausible future addition but is not required by the local-first shape.

## Verification

- `bun test src/integrations/telegram.test.ts` exercises the HTTP client (`getMe`, `sendMessage`, `getUpdates`, error paths) against an injected `fetch`.
- `bun test src/integrations/messaging.test.ts` exercises add/health/send/disable for telegram-kind bridges against an injected `TelegramClient`, including secret-store round-trip and error propagation.
- `bun test src/integrations/telegram-poller.test.ts` exercises the supervisor's start/stop reconciliation, inbound-routing path (incoming text → task submission → offset advance), and disable-cleanup.
