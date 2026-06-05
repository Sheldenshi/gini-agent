# Email Watch

## Decision

An email watcher is an `EmailWatcherRecord` (per `(account, sender-query)`) on
`RuntimeState`. A periodic gateway-owned worker (`src/integrations/gmail-poll-worker.ts`)
polls the user's Gmail through the existing `gws` CLI for new matching message
ids, dedups them, applies a deterministic safety floor, and on each new match
wakes a single agent turn in the watcher's dedicated chat session. The woken
agent reads the full message and composes/sends a reply via the EXISTING
`google-gmail` skill — the worker reads ONLY metadata (From/Subject/Date/snippet)
and never message bodies.

The architecture is deliberately a **thin deterministic detection floor + skill-driven action**:

- **Trigger floor (runtime code):** poll `gws` → dedup → safety-filter → wake a turn. Zero model turns when there's no new matching mail.
- **Action (reuse the skill):** the woken turn reads the body and drafts/sends via `google-gmail`, gated by `terminal_exec`'s existing approval.

No native Gmail REST client, no new OAuth flow, no new token store, and no new
`gmail_send`/`gmail_draft` tools are introduced. The watcher only writes a
config record; everything side-effecting flows through the already-approval-gated
skill.

## Context

This follows the messaging-bridge ADRs ([telegram-bridge.md](telegram-bridge.md),
[discord-bridge.md](discord-bridge.md)) and the connector-reprobe maintenance
loop. The user asked for an email-watching feature with multi-account support,
sender filtering, and drafted responses, and chose to reuse the already-set-up
`gws` (`google-gmail`) skill rather than build a native Gmail client.

`gws` holds ONE signed-in Google identity per machine, so v1 watches that single
account. The data model is multi-account-SHAPED (`provider` + `accountEmail` +
`credentialName` per record) so a later phase can fan out to per-account
credentials (gws multi-profile or native tokens) without a schema migration.

Reference systems shaped the design: OpenClaw's untrusted-content wrapping (borrowed),
Hermes's layered inbound-safety + startup watermark seeding (borrowed), and the
"separate email-as-connector from watching-as-scheduler" lesson from Claude Code.
OpenClaw's Pub/Sub-push infrastructure and Hermes's auto-send + plaintext creds
were rejected as the wrong shape for a local-first, consent-gated runtime.

## Required Now

- `EmailWatcherRecord` carries `{ id, instance, agentId?, provider:"gmail", accountEmail?, credentialName?, query, labelIds?, lastSeenInternalDate?, chatSessionId?, enabled, status:"ok"|"error"|"needs_auth", lastError?, lastPolledAt?, createdAt, updatedAt }`. State CRUD lives in `src/state/email-watchers.ts`; all writes go through `mutateState`, never the JSON file directly.
- Dedup is an `email_seen (instance, watcher_id, message_id, seen_at)` SQLite table in `memory.db` (schema version 10) with `markEmailSeen` / `isEmailSeen`. `markSeen` is per item so a crash mid-batch never replays an already-handled email.
- The worker loop runs in `server.ts` alongside the other self-rescheduling loops. Cadence defaults to 60s; `GINI_GMAIL_POLL_MS` overrides it. A stop flag + drained done-promise unwind the in-flight tick on SIGTERM (a tick can be mid-`submitTask`).
- Before polling, the worker checks `gws auth status` (via `gwsSessionStatus`). When signed out, enabled watchers flip to `needs_auth` and the tick skips them (no spam); the next tick retries once the user re-auths.
- The worker spawns `gws` exactly as `gws-session.ts` does for `gws auth status`: `zsh -lc`, `stdin: "ignore"`, kill-on-timeout, inheriting `process.env`. The subprocess boundary is injectable so unit tests stub it. `gws` prints a `Using keyring backend:` preamble to stdout before its JSON, so the parser skips to the first `{`.
- Detection uses `gws gmail users messages list --params '{"userId":"me","q":"<query>","maxResults":N}' --format json`. Once a watcher has a watermark the query is bounded with `after:<epochSec>` derived from `lastSeenInternalDate`, so steady-state polling lists almost nothing. A per-tick cap (`MAX_MESSAGES_PER_TICK = 25`) bounds the cold-start / catch-up burst.
- Metadata for the safety floor + prompt comes from `gws gmail users messages get --params '{"userId":"me","id":"<id>","format":"metadata","metadataHeaders":["From","Subject","Date"]}'`. Bodies are NEVER fetched here.
- Safety floor (deterministic, drop-at-trigger): drop automated senders (From matches `no-reply` / `noreply` / `mailer-daemon` / `postmaster` / `bounce` / `notifications@`) and drop self (From contains the signed-in address from `gws gmail users getProfile`). Dropped messages are still `markSeen` so they're never reconsidered.
- On a surviving match the worker calls `submitTask(config, prompt, { mode: "chat", agentId, chatSessionId })` — the same path scheduled jobs use. The prompt instructs the agent to `read_skill google-gmail`, read the full message, post a PROPOSED reply in this chat for review, and NOT send unless the user says so; it must emit exactly `[SILENT]` when nothing is actionable (the existing chat-task suppression sentinel).
- The matched email metadata in the prompt is wrapped in an `UNTRUSTED_EMAIL_METADATA` fence (the prompt-injection boundary): everything inside is quoted data the agent must not treat as instructions; the trusted instructions live outside the fence.
- Startup seeding: on a watcher with no `lastSeenInternalDate`, the first tick lists current matches, marks them all seen, and sets the cursor to the newest `internalDate` seen (or now, if the inbox had no matches) WITHOUT waking any turn — no replay storm on first run.
- Cursor advance + `markSeen` happen per surviving item via `mutateState` so the work is crash-safe; the tick also advances the watermark + stamps `lastPolledAt` at the end.
- Per-watcher errors mark THAT watcher `status: "error"` with a scrubbed `lastError` (absolute `.json`/`.enc` paths redacted) and the tick continues, so one bad query can't starve the rest. A deliberate disable that races the tick is never overwritten with `error`.
- The `email_watch` agent tool (toolset `email`, action enum `add | list | remove`) is always-on and low-risk — it only writes a watcher record (and, on `add`, a dedicated chat session). One tool with an action enum keeps the catalog surface minimal, mirroring the `create_job` / `list_jobs` / `delete_job` precedent collapsed into one.
- `add` builds the query: a raw `query` wins; else `from:<sender> is:unread`; else `is:unread`. The watcher + its dedicated chat session are created in ONE `mutateState` write (no orphan session on failure). The tool, `POST /api/email/watchers`, and `gini email add` all route through the shared `addEmailWatcher` helper so they produce identical records.
- HTTP: `GET /api/email/watchers` (list), `POST /api/email/watchers` (add), `DELETE /api/email/watchers/:id` (remove) — thin handlers over the state module. CLI: `gini email list | add --from <sender> [--query <q>] | remove <id>`.

## Trust Boundary

- Inbound email is untrusted external content. The worker fences matched metadata in the woken-turn prompt so a hostile subject/snippet cannot smuggle instructions to the agent. Bodies are read only inside the agent turn, through the consent-gated `google-gmail` skill — the deterministic floor never touches them.
- Drafting a reply is surfaced as a CHAT MESSAGE in the watcher's session for the user to review; the agent does not auto-send. Sending requires an explicit user instruction, which then runs `gws gmail +reply` through `terminal_exec`'s approval gate — no new send tool or risk plumbing is added.
- The worker shells `gws` with fixed query strings and integer `after:` values it builds itself; raw email bytes never reach the shell. `gws` reads its own client config + token from `~/.config/gws/`, so no credentials are injected into the spawn env and none land on the watcher record.

## Limitations / Open Questions

- **Single account (v1).** `gws` holds one signed-in identity, so v1 watches that account. The data model is multi-account-shaped; true multi-account needs gws multi-profile or native per-account tokens (a future phase).
- **`after:`-second cursor precision.** Gmail's `after:` is second-granular while the watermark is millisecond `internalDate`. The `email_seen` dedup makes the second-rounding harmless (a re-listed boundary message is skipped), but it does mean the bounded query can re-surface same-second messages, which dedup then drops.
- **History robustness.** v1 uses `messages.list` + a per-watcher watermark rather than `history.list`, so there's no `historyId`-404 full-resync path to maintain. If a future phase moves to `history.list` for lower latency/cost, it must add the bounded full-resync on a 404 history id.
- **Drafts in Gmail.** v1 posts the proposed reply as a chat message, not a Gmail draft. Landing drafts in the user's real Gmail Drafts (threaded) is a future option.
- **Pub/Sub-pull low-latency.** Polling at ~60s is the v1 cadence. A future opt-in could use Pub/Sub-pull (outbound only, no public webhook) for lower latency without changing the trust model.

## Verification

- `bun test src/integrations/gmail-poll-worker.test.ts` exercises the message-list JSON parse (incl. the `gws` preamble), metadata parse, the safety floor (automated + self dropped), startup seeding (no turn on first run), dedup + cursor advance, one tick that triggers exactly one turn for a new match and zero when there's no match / all seen, and the signed-out → `needs_auth` path — all with an injected `gwsSpawn` + ephemeral instance dir + ephemeral `memory.db`.
- `bun test src/state` covers the `EmailWatcherRecord` CRUD + `email_seen` helpers.
