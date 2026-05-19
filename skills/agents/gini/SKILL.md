---
name: gini
description: "Configure and extend Gini — set up Telegram and other messaging bridges, MCP servers, connectors, scheduled jobs, browser sessions, skills, and memory. Use when the user asks Gini to set up an integration or operate on its own state."
license: MIT
metadata:
  gini:
    version: 1.0.0
    author: Gini
---

# Gini Agent

Gini is a local-first personal agent. The gateway owns durable state and
tool execution; the CLI, Next.js BFF, mobile clients, and other front-ends
are clients of the same `/api/*` contract. Anything Gini does at runtime is
already reachable via API or CLI — this skill is a recipe book for the most
common configuration tasks.

Load this skill before claiming "I cannot do that" about an integration.

## API vs CLI

Both flow through the same gateway. The CLI is a thin wrapper that POSTs
to `/api/*` — the API is the source of runtime truth. Prefer the API when
you need a structured response to act on; the CLI is for human-facing
operations. Do not read `~/.gini/instances/<inst>/*.json` directly — hit
`/api/status` and friends.

## Browser

The runtime drives Playwright Chromium against a per-instance profile at
`~/.gini/instances/<inst>/chrome-profile/`. Sign-ins land on disk and
survive Connect/Disconnect cycles and runtime restarts. The same profile
backs both modes:

- Default: headless Chromium, invisible to the user.
- `managed`: same profile, `headless: false` — a visible window so the
  user can sign in once. The next tool call after disconnect goes back to
  headless against the now-authenticated profile.

Tool surface: `browser.navigate`, `browser.snapshot`, `browser.click`,
`browser.type`, `browser.press`, `browser.hover`, `browser.drag`,
`browser.select_option`, `browser.scroll`, `browser.back`,
`browser.console`, `browser.wait_for`, `browser.tabs.{list,new,switch,close}`,
`browser.vision`, `browser.close`, and the approval-gated
`browser.upload_file`. Side-effecting actions skip the approval gate
because the snapshot itself is the trace evidence; uploads are gated
because they egress local bytes.

### Recipe — authenticated workflow on a new site

When a site needs a sign-in the user hasn't completed:

1. Try `browser.navigate` headlessly. If the page requires sign-in,
   propose opening the visible window.
2. `POST /api/browser/connect` with an empty body — managed mode opens a
   visible Chrome window against the same profile dir.
3. Ask the user to sign in once. The cookies persist on disk.
4. `POST /api/browser/disconnect` — the next tool call goes back to
   headless against the now-signed-in profile.

CLI: `gini browser {status|connect|disconnect|wipe-profile --yes}`.
For CDP attach (rare; flaky under Playwright + Bun), pass
`{ "cdpUrl": "ws://..." }` to `/api/browser/connect`. Prefer managed mode.

## Scheduled Jobs

Jobs run on an interval or a cron expression. When created from inside a
chat, the runtime auto-binds `chatSessionId` so the run output lands back
in the current conversation.

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

CLI mirror: `gini jobs {add|list|run|pause|resume|remove|runs|replay}`.

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

   ```bash
   gini messaging add my-bot telegram --bot-token <BOT_TOKEN>
   ```

   API equivalent:

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

   The response carries a `metadata.pairingCode` and the bot's username.
   The CLI prints a follow-up line: "DM @<bot> on Telegram with that
   message to enroll your chat."

3. **Pair the user's chat.** The user DMs the bot the pairing code from
   their personal Telegram account. The bridge records the chat ID. To
   request a fresh code:

   ```bash
   gini messaging pair my-bot
   ```

   ```http
   POST /api/messaging/my-bot/pair
   ```

4. **Allow-list the chat ID** so the bridge will deliver messages there:

   ```bash
   gini messaging allow my-bot <chatId>
   ```

   ```http
   POST /api/messaging/my-bot/allow

   { "chatId": 123456789 }
   ```

   Group chat IDs are negative integers — that is correct, not an error.

5. **Send a message** to confirm round-trip:

   ```bash
   gini messaging send my-bot "Hello from Gini."
   ```

   ```http
   POST /api/messaging/my-bot/send

   { "text": "Hello from Gini.", "target": "local" }
   ```

### Inspecting state

CLI: `gini messaging {list|chats|messages|health|disable|deny}`.
API: `GET /api/messaging`, `GET /api/messaging/<id>/{chats,messages}`,
`POST /api/messaging/<id>/{health,disable}`.

### Other kinds

The `kind` argument supports `telegram` and `demo` today. Telegram is the
production-ready path. Future messengers slot into the same
`/api/messaging` shape — check `gini messaging add --help`.

## MCP Servers

Register a local MCP server by command:

```bash
gini mcp add fs-mcp node /path/to/server.js
gini mcp health fs-mcp
gini mcp invoke fs-mcp read_file '{"path":"/tmp/x"}'
gini mcp list
```

API: `POST /api/mcp { name, command, args, exposedTools }`,
`POST /api/mcp/<id>/{health,invoke}`, `GET /api/mcp`.

`exposedTools` defaults to `[]`, which exposes everything the server
advertises.

## Connectors

Connectors register external coding/issue services so subagents and
related skills can call them. Built-in providers: `claude-code`, `codex`,
`linear`, `demo`, `generic`.

```bash
gini connectors providers                       # discover what's installable
gini connectors add --provider claude-code --name claude-main --token <T>
gini connectors list
gini connectors health <id>
gini connectors remove <id>
gini connectors rotate <id> --token <T>
gini connectors detect                          # auto-detect locally installed CLIs
```

API: `GET /api/connectors[/providers]`, `POST /api/connectors`,
`POST /api/connectors/<id>/health`, `PATCH /api/connectors/<id>`,
`DELETE /api/connectors/<id>`, `POST /api/connectors/detect`.

## Subagents (Delegated Coding)

Spawn a registered coder (Claude Code, Codex) to execute a delegated
prompt:

```bash
gini subagents spawn <connector-name> "Implement and commit the fix."
gini subagents list
```

API: `POST /api/subagents { name, prompt }`, `GET /api/subagents`.

For depth on prompting and tmux/PTY patterns, load `skills/agents/claude-code/SKILL.md`
or `skills/agents/codex/SKILL.md` — those skills cover `--allowedTools`,
`--max-turns`, `--full-auto`, worktree layout, and dialog handling.

## Memory

Pinned memories ride the system prompt every turn. Long-term memory is
pulled by embedding recall on each task.

CLI: `gini memory {add|list|edit|delete|recall|reflect}`.
API: `POST /api/memory { content, status }`, `GET /api/memory`,
`PATCH /api/memory/<id>`, `DELETE /api/memory/<id>`,
`POST /api/memory/<id>/approve`, `POST /api/memory/recall { query, tokenBudget, bankId }`.

Keep pinned memories short — every active row costs context every turn.

## Skills

Built-in skills live under the repo at `skills/<category>/<name>/SKILL.md`.
User-installed skills land at
`~/.gini/instances/<inst>/skills/<category>/<name>/SKILL.md`. The runtime
loads both on boot.

CLI: `gini skills {list|show|enable|disable|test|rollback|validate|search}`.
API: `GET /api/skills[/<id>]`, `POST /api/skills`,
`POST /api/skills/<id>/{enable,disable,test,rollback}`,
`PATCH /api/skills/<id>`, `GET /api/skills/validate`.

To install a SKILL.md the user pasted or linked, use the `meta/install-skill`
skill. To draft a new one, use `meta/create-skill`.

## Approvals

Risky side-effecting tools (`file.write`, `terminal.exec`,
`browser.upload_file`, etc.) route through the approval queue when
`approvalMode` is `strict` or `auto` and the action exceeds the auto
threshold. **The agent should propose these actions and surface them to
the queue — not refuse them.**

```bash
gini approval list
gini approval approve <id>
gini approval deny <id>
```

```http
GET  /api/approvals
POST /api/approvals/<id>/approve
POST /api/approvals/<id>/deny
```

`approvalMode` lives on the runtime config: `strict | auto | yolo`. Set
via `PATCH /api/settings/auto-approve`. `yolo` skips the queue entirely —
only use it when the user has explicitly asked for that risk profile.

## Logs and Tmux

Per-instance log files (read with `tail`, not the API):

```bash
INSTANCE=$(basename "$(pwd)")
tail -n 200 ~/.gini/instances/$INSTANCE/logs/web.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime-stdout.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime.jsonl
```

The runtime lives in a tmux session named `gini-<instance>`:

```bash
SESSION=gini-$(basename "$(pwd)")
tmux capture-pane -t $SESSION -p -S -2000
tmux send-keys -t $SESSION C-c
tmux send-keys -t $SESSION "bun run gini run --instance $(basename "$(pwd)")" Enter
```

If the session is missing, start it: `tmux new-session -A -d -s "gini-$INSTANCE" "bun run gini run --instance $INSTANCE"`.

## Rules

1. Do not refuse a capability without first checking this skill and the
   approval queue. Propose the action; let the user approve.
2. Prefer the API for state queries; the CLI is a wrapper.
3. Never read `~/.gini/instances/<inst>/*.json` directly — call `/api/*`.
4. Persistent browser cookies are a feature. For sign-in, open managed
   mode once; do not ask the user to re-authenticate on every run.
5. Bind scheduled jobs to the current chat when the user asks Gini to
   remember to do something later — the runtime handles delivery.
6. Keep pinned memories short; offload depth to recall.
