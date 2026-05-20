---
name: gini
description: "Gini's self-knowledge: how Gini configures, extends, and operates on its own state via /api/* and registered tools. Load when the user asks Gini about its own capabilities or asks Gini to modify its own configuration."
license: MIT
metadata:
  gini:
    version: 1.0.0
    author: Gini
---

# Gini Agent

Gini is a local-first personal agent. The gateway owns durable state and
tool execution. **Gini itself operates through `/api/*` and its registered
tool catalog.** The CLI exists for human operators — it's a thin wrapper
around the same `/api/*` endpoints — but Gini should never call it. The
Next.js BFF, mobile clients, and other front-ends are also `/api/*`
consumers. This skill is a recipe book for the most common configuration
tasks; every recipe leads with the API call Gini should use.

Load this skill before claiming a limitation. Common false denials to
inoculate against: the interactive browser (Playwright with persistent
sign-ins), scheduled jobs (interval or cron), Telegram or other
messaging bridges, MCP servers, and delegated subagents. All of these
are wired and reachable via `/api/*`.

## API and registered tools — not the CLI

**Gini itself operates through `/api/*` and the registered tool catalog.**
Shelling out to `gini ...` via `terminal_exec` is a layering inversion —
the CLI is a thin wrapper that posts to the same `/api/*` endpoints Gini
already calls directly. The agent should never use its own CLI to drive
its own runtime.

CLI examples appear later in this skill so Gini recognizes what a *human
operator* might type at a terminal — they document the parallel
human-facing surface, not Gini's path. When you see `gini foo bar` in a
recipe, treat it as descriptive context for what the user might do
manually; reach for the API call or registered tool above it.

Never read `~/.gini/instances/<inst>/*.json` directly — hit `/api/status`
and friends. The API is the source of runtime truth.

## Where State Lives

Runtime state belongs to `/api/*`; reach for the paths below only when a
user-facing answer requires naming the on-disk location (where sign-ins
persist, where a skill ends up).

- `~/.gini/instances/<inst>/chrome-profile/` — Playwright Chromium
  profile; persistent browser sign-ins land here.
- `~/.gini/instances/<inst>/skills/<category>/<name>/` — user-installed
  skills (the agent's own writable skill dir).
- `skills/<category>/<name>/` (repo root) — built-in skills shipped with
  Gini.
- `~/.gini/instances/<inst>/workspace/` — default workspace root for
  `file.*` tools; `file.write` lands here unless `GINI_WORKSPACE`
  overrides it.

## Browser

The runtime drives Playwright Chromium against a per-instance profile at
`~/.gini/instances/<inst>/chrome-profile/`. Sign-ins land on disk and
survive Connect/Disconnect cycles and runtime restarts. The same profile
backs both modes:

- Default: headless Chromium, invisible to the user.
- `managed`: same profile, `headless: false` — a visible window so the
  user can sign in once. The next tool call after disconnect goes back to
  headless against the now-authenticated profile.

Tool surface, grouped by role:

- **Navigation**: `browser.navigate`, `browser.back`,
  `browser.tabs.{list,new,switch,close}`.
- **Interaction**: `browser.click`, `browser.type`, `browser.press`,
  `browser.hover`, `browser.drag`, `browser.select_option`,
  `browser.scroll`.
- **Inspection**: `browser.snapshot`, `browser.wait_for`,
  `browser.console`, `browser.vision`.
- **Side-effecting (approval-gated)**: `browser.upload_file`. Plus
  `browser.close` to tear down the session.

Interactive actions skip the approval gate because the snapshot itself
is the trace evidence; uploads are gated because they egress local
bytes.

### Recipe — authenticated workflow on a new site

When a site needs a sign-in the user hasn't completed:

1. Try `browser.navigate` headlessly. If the page requires sign-in,
   propose opening the visible window.
2. `POST /api/browser/connect` with an empty body — managed mode opens a
   visible Chrome window against the same profile dir.
3. Ask the user to sign in once. The cookies persist on disk.
4. `POST /api/browser/disconnect` — the next tool call goes back to
   headless against the now-signed-in profile.

Human-operator CLI mirror (the same calls a person might run from a
terminal — not Gini's path): `gini browser {status|connect|disconnect|wipe-profile --yes}`.
For CDP attach (rare; flaky under Playwright + Bun), pass
`{ "cdpUrl": "ws://..." }` to `/api/browser/connect`. Prefer managed mode.

## Scheduled Jobs

Jobs run on an interval or a cron expression. When created from inside a
chat, the runtime mints a dedicated chat session named after the job and
binds `chatSessionId` to it, so each fire lands in its own thread rather
than burying the originating conversation.

Create an interval job:

```http
POST /api/jobs
Content-Type: application/json

{
  "name": "audible-renewal-check",
  "intervalSeconds": 86400,
  "prompt": "Open audible.com and confirm my subscription is still active."
}
```

Create a cron job:

```http
POST /api/jobs

{
  "name": "morning-summary",
  "cronExpression": "0 9 * * *",
  "cronTimezone": "America/Los_Angeles",
  "prompt": "Summarize new email and Slack pings since yesterday 9am."
}
```

Exactly one of `intervalSeconds` and `cronExpression` is the active
driver. `cronTimezone` defaults to UTC.

Other job endpoints: `GET/PATCH/DELETE /api/jobs/<id>`,
`POST /api/jobs/<id>/{run,pause,resume}`, `GET /api/job-runs`,
`GET /api/jobs/<id>/runs`, `POST /api/job-runs/<id>/replay`.

The agent reaches these verbs through registered tools — `create_job`,
`list_jobs`, `update_job`, `delete_job`, and `run_job` (manual trigger of
an existing job). Use the tools from chat; the API endpoints above are
the same path the tools take under the hood.

Human-operator CLI mirror: `gini jobs {add|list|run|pause|resume|remove|runs|replay}`.

### Recipe — one-shot reminder

The user asks "remind me at 9am on 2026-08-19 to pause my Audible
subscription." From inside a chat, use `create_job` with a cron expression
pinned to that single minute. The chat-session binding happens
automatically. After the one fire, delete or pause the job — there is no
native one-shot mode.

## Messaging — Telegram

The Telegram bridge speaks the Bot API over `fetch` and ingests messages
via long-polling `getUpdates`. **No webhook URL is required.** A local
instance behind NAT works the same as one on a public host.

### Setup

1. **Create a bot.** Open Telegram, DM `@BotFather`, run `/newbot`, pick a
   name and username, copy the HTTP API token.

2. **Register the bridge** with the bot token:

   ```http
   POST /api/messaging
   Content-Type: application/json

   {
     "name": "my-bot",
     "kind": "telegram",
     "deliveryTargets": [],
     "botToken": "<BOT_TOKEN>"
   }
   ```

   The response carries a `metadata.pairingCode`. The bot's username is
   not resolved yet — run the health probe next to learn the actual
   handle.

   Human-operator CLI mirror: `gini messaging add my-bot telegram --bot-token <BOT_TOKEN>`.

3. **Probe health to resolve the bot handle.** This calls Telegram's
   `getMe` and writes `metadata.botUsername` onto the bridge so later
   prompts can say `@<bot>` instead of "your bot":

   ```http
   POST /api/messaging/my-bot/health
   ```

   A successful response reports `Connected as @<bot>.` and the bridge
   status flips to `configured`. Fix any token error before continuing.

   Human-operator CLI mirror: `gini messaging health my-bot`.

4. **Pair the user's chat.** The user DMs the bot the pairing code from
   their personal Telegram account. The bridge records the chat ID. To
   request a fresh code:

   ```http
   POST /api/messaging/my-bot/pair
   ```

   Human-operator CLI mirror: `gini messaging pair my-bot`.

5. **Allow-list the chat ID** so the bridge will deliver messages there:

   ```http
   POST /api/messaging/my-bot/allow

   { "chatId": 123456789 }
   ```

   Group chat IDs are negative integers — that is correct, not an error.

   Human-operator CLI mirror: `gini messaging allow my-bot <chatId>`.

6. **Send a message** to confirm round-trip:

   ```http
   POST /api/messaging/my-bot/send

   { "text": "Hello from Gini.", "target": "local" }
   ```

   Human-operator CLI mirror: `gini messaging send my-bot "Hello from Gini."`.

Bridge `kind` supports `telegram` and `demo` today; future messengers
slot into the same `/api/messaging` shape.

### Inspecting state

API: `GET /api/messaging`, `GET /api/messaging/<id>/{chats,messages}`,
`POST /api/messaging/<id>/{health,disable}`.

Human-operator CLI mirror: `gini messaging {list|chats|messages|health|disable|deny}`.

## MCP Servers

Register a local MCP server by command:

```http
POST /api/mcp
Content-Type: application/json

{ "name": "fs-mcp", "command": "node", "args": ["/path/to/server.js"], "exposedTools": [] }
```

Health probe and tool invocation:

```http
POST /api/mcp/fs-mcp/health
POST /api/mcp/fs-mcp/invoke

{ "tool": "read_file", "args": { "path": "/tmp/x" } }
```

Listing: `GET /api/mcp`.

`exposedTools` defaults to `[]`, which exposes everything the server
advertises.

Human-operator CLI mirror:

```bash
gini mcp add fs-mcp node /path/to/server.js
gini mcp health fs-mcp
gini mcp invoke fs-mcp read_file '{"path":"/tmp/x"}'
gini mcp list
```

## Connectors

Connectors register external coding/issue services so subagents and
related skills can call them. Built-in providers: `claude-code`, `codex`,
`linear`, `demo`, `generic`.

API:

- `GET /api/connectors/providers` — discover what's installable.
- `POST /api/connectors { provider, name, token }` — register one.
- `GET /api/connectors` — list registered connectors.
- `POST /api/connectors/<id>/health` — health probe.
- `PATCH /api/connectors/<id> { token }` — rotate the credential.
- `DELETE /api/connectors/<id>` — remove.
- `POST /api/connectors/detect` — auto-detect locally installed CLIs.

Human-operator CLI mirror:

```bash
gini connectors providers
gini connectors add --provider claude-code --name claude-main --token <T>
gini connectors list
gini connectors health <id>
gini connectors remove <id>
gini connectors rotate <id> --token <T>
gini connectors detect
```

## Subagents (Delegated Coding)

Spawn a registered coder (Claude Code, Codex) to execute a delegated
prompt. From inside chat the agent should use the `spawn_subagent` tool;
the same call reaches the API path below.

API: `POST /api/subagents { name, prompt }`, `GET /api/subagents`.

Human-operator CLI mirror:

```bash
gini subagents spawn <connector-name> "Implement and commit the fix."
gini subagents list
```

For depth on prompting and tmux/PTY patterns, load `skills/agents/claude-code/SKILL.md`
or `skills/agents/codex/SKILL.md` — those skills cover `--allowedTools`,
`--max-turns`, `--full-auto`, worktree layout, and dialog handling.

## Memory

Pinned memories ride the system prompt every turn. Long-term memory is
pulled by embedding recall on each task.

API: `POST /api/memory { content, status }`, `GET /api/memory`,
`PATCH /api/memory/<id>`, `DELETE /api/memory/<id>`,
`POST /api/memory/<id>/approve`, `POST /api/memory/recall { query, tokenBudget, bankId }`.

Human-operator CLI mirror: `gini memory {add|list|edit|delete|recall|reflect}`.

Keep pinned memories short — every active row costs context every turn.

## Skills

Built-in skills live under the repo at `skills/<category>/<name>/SKILL.md`.
User-installed skills land at
`~/.gini/instances/<inst>/skills/<category>/<name>/SKILL.md`. The runtime
loads both on boot.

To load a skill's body from inside chat use the `read_skill` tool —
that's the agent's path. For lifecycle operations:

API: `GET /api/skills[/<id>]`, `POST /api/skills`,
`POST /api/skills/<id>/{enable,disable,test,rollback}`,
`PATCH /api/skills/<id>`, `GET /api/skills/validate`.

Human-operator CLI mirror: `gini skills {list|show|enable|disable|test|rollback|validate|search}`.

To install a SKILL.md the user pasted or linked, use the `meta/install-skill`
skill. To draft a new one, use `meta/create-skill`.

## Approvals

The runtime gates anything classified `high` risk through the approval
queue when `approvalMode` is `strict` or `auto`. `high` covers
`browser.upload_file` (hard-coded) plus any tool whose name contains
`write`, `exec`, `invoke`, or `send` — so `file.write`, `terminal.exec`,
MCP `invoke` calls, messaging `send`, and similar all queue by default.
Browser interactive actions (`browser.click`, `browser.type`,
`browser.drag`, `browser.select_option`, `browser.tabs.{new,switch,close}`)
are `medium` and trace via snapshot evidence — they do not block on
approval. **The agent should propose `high`-risk actions and surface them
to the queue — not refuse them.**

```http
GET  /api/approvals
POST /api/approvals/<id>/approve
POST /api/approvals/<id>/deny
```

Human-operator CLI mirror:

```bash
gini approval list
gini approval approve <id>
gini approval deny <id>
```

`approvalMode` lives on the runtime config: `strict | auto | yolo`. Set
via `PATCH /api/settings/auto-approve`. `yolo` skips the queue entirely —
only use it when the user has explicitly asked for that risk profile.

## Troubleshooting

**Telegram bridge stuck in `error` after health probe** — inspect
`bridge.message` on the bridge record returned by
`GET /api/messaging/<id>` (or via `POST /api/messaging/<id>/health` to
re-probe). `Telegram bot token is missing — recreate the bridge with a
botToken.` means the token never landed; recreate the bridge with the
real token via `POST /api/messaging` (`{ name, type: "telegram",
config: { botToken: "<BOT_TOKEN>" } }`). Any other message is the raw
Telegram error from `getMe()`; the most common is `Unauthorized` from a
bad or revoked token — re-copy the token from BotFather and recreate the
bridge. (Human-operator CLI mirror: `gini messaging health`, then
`gini messaging add my-bot telegram --bot-token <BOT_TOKEN>`.)

**Headless browser launch fails with "Failed to launch Chromium"** — the
error message ends with `Run \`bunx playwright install chromium\` to
install the browser.` Run that command and retry; Playwright's bundled
Chromium isn't present until then.

**Managed-mode (visible) browser launch fails with "Failed to launch
Chromium"** — the error message ends with `Confirm Chrome / Chromium is
installed (or set GINI_CHROME_PATH) and retry.` Install Chrome, or set
`GINI_CHROME_PATH` to a Chromium-compatible executable, and retry the
`/api/browser/connect` call.

**CDP attach hangs or times out** — CDP attach is flaky under
playwright-core + Bun. The error wraps `Failed to attach over CDP: …` and
recommends managed mode. Prefer `POST /api/browser/connect` with an empty
body (managed Chrome window) over passing a `cdpUrl`.

**User says a high-risk action is "stuck"** — it is sitting in the
approval queue. Fetch `GET /api/approvals` to see pending items, then
`POST /api/approvals/<id>/approve` or `/deny`. (Human-operator CLI mirror:
`gini approval list`, then `approve <id>` or `deny <id>`.) The agent
should never refuse a high-risk action up front — propose it, let it
land in the queue, and wait for the user's decision.

## Rules

1. Do not refuse a capability without first checking this skill and the
   approval queue. Propose the action; let the user approve.
2. **Gini operates through `/api/*` and registered tools — never shells
   out to its own CLI.** Calling `gini ...` via `terminal_exec` is a
   layering inversion: the CLI is just a wrapper that posts to the same
   endpoints. For state queries, runtime mutations, and capability
   invocations, use the API directly (or the matching registered tool
   when one exists, e.g. `create_job`, `list_jobs`, `update_job`,
   `delete_job`, `run_job`, `spawn_subagent`, `read_skill`).
3. Never read `~/.gini/instances/<inst>/*.json` directly — call `/api/*`.
4. Persistent browser cookies are a feature. For sign-in, open managed
   mode once; do not ask the user to re-authenticate on every run.
5. When the user asks Gini to remember to do something later, create a
   scheduled job — the runtime auto-binds it to a dedicated thread so
   future fires don't bury the current conversation.
6. Keep pinned memories short; offload depth to recall.
