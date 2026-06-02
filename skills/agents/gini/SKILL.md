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

Gini is a personal agent. The gateway owns durable state and
tool execution. **Gini itself operates through `/api/*` and its registered
tool catalog.** The CLI exists for human operators — it's a thin wrapper
around the same `/api/*` endpoints — but Gini should never call it. The
Next.js BFF, mobile clients, and other front-ends are also `/api/*`
consumers. This skill is a recipe book for the most common configuration
tasks; every recipe leads with the API call Gini should use.

Load this skill before claiming a limitation. Common false denials to
inoculate against: the interactive browser (Playwright with persistent
sign-ins), scheduled jobs (interval or cron), Telegram or other
messaging bridges, MCP servers, delegated subagents, **and Gini's own
provider / model / agent / skill / MCP / connector inventory** — all
visible and mutable through the self-config tools described below. Do not
claim "I can't see my model" or "I can't change my settings"; you can.

## Self-knowledge — what Gini is and how to change it

When the user asks about Gini itself — "what model are you using",
"what's your config", "what can you do", "what skills do you have",
"switch to deepseek" — the answer comes from the self-config tools,
**not from guessing or from "no visibility" disclaimers.**

These tools are DEFERRED: their names appear in the system prompt's
"Tools available on demand" list, but you must `load_tools` a tool before
calling it. The flow is always two steps — load on one turn, call on the
next:

1. `load_tools({ names: ["get_self"] })` (or several at once, e.g.
   `["list_providers", "set_provider"]`).
2. On the next turn, call the tool directly by name with its args at the
   TOP LEVEL — e.g. `get_self({})`, `set_provider({ provider: "deepseek" })`.
   Do NOT wrap args in a `{ name, args }` envelope and do NOT pass a
   tool's arguments to `load_tools`.

The self-config tools (load the ones you need), grouped by surface:

Snapshot

- `get_self` (query) — one-call snapshot: provider, model, active
  agent, approval mode, instance, version, counts, plus
  `approvalSettings` (`approvalMode`, `autoApproveCommands`,
  `dangerousTerminalPatterns`). Start here for broad
  "what / who are you?" questions and before any approval-list replace.

Toolsets

- `list_toolsets` (query) — instance toolsets with status, description,
  and the tools each gates. Use before enabling/disabling one.
- `enable_toolset` (mutate) — turn a toolset on so its tools become
  available.
- `disable_toolset` (mutate) — turn a toolset off. Self-config tools
  bypass toolset gating, so this never locks you out of your own config;
  reverse with `enable_toolset`.

Agents

- `list_agents` (query) — agents + each agent's provider/model
  override + the active id. Use before `use_agent` / `delete_agent`.
- `use_agent` (mutate) — switch the active agent. Provider/model/
  SOUL.md/toolset filter follow the new active row on the next turn.
- `create_agent` (mutate) — create a new agent row. The new agent is
  NOT activated; follow up with `use_agent`.
- `delete_agent` (mutate) — hard-delete an agent and its memory bank.
  Refuses the default and the active agent — switch away first.

Providers

- `list_providers` (query) — provider catalog with `configured` and
  `isActive` per row. Check a target here before `set_provider`.
- `set_provider` (mutate) — switch provider and/or model. Confirm the
  target is `configured: true` via `list_providers` first. If it isn't
  and the user wants to wire one up, ask for credentials (or run
  `request_connector` for connector-backed providers); do not fabricate
  an `apiKey`.
- `remove_provider` (mutate) — disconnect an env-keyed provider (scrub
  its key). Codex and local can't be removed this way.

Approvals

- `set_approval_mode` (mutate) — set the runtime approval mode (`strict`
  / `auto` / `yolo`). Use when the user says "set permissions to yolo",
  "stop asking me to approve", "gate everything". In `strict` this change
  itself requires approval.
- `set_auto_approve_commands` (mutate) — REPLACE the auto-approve
  command allowlist. Read `get_self.approvalSettings.autoApproveCommands`
  first and include the entries you want to keep.
- `set_dangerous_patterns` (mutate) — REPLACE the dangerous-terminal
  pattern list (always-gate substrings). Same replace semantics — read
  `get_self.approvalSettings.dangerousTerminalPatterns` first.

MCP

- `list_mcp_servers` (query) — registered MCP servers.
- `add_mcp_server` (mutate) — register a stdio (`command`) or http
  (`url`) MCP server.
- `remove_mcp_server` (mutate) — disable a registered MCP server.

Connectors

- `list_connectors` (query) — registered connectors (claude-code,
  codex, linear, …).
- `remove_connector` (mutate) — disconnect a connector (wipe its
  secrets, or tombstone an auto-detected one).
- `rotate_connector` (mutate) — write a new token into a connector's
  secret slot. Pass `purpose` when it has more than one slot.

Runtime

- `update_self` (mutate) — pull the latest commit and RESTART the
  gateway to run the new code. Only works from the installer-managed
  runtime. Warn the user the runtime will restart.

Skills

- `list_skills` (query) — installed skills with status. Distinct from
  `read_skill`, which fetches one skill's body.
- `test_skill` (query) — validate one skill's record and report
  pass/fail. Diagnostic, no approval.
- `rollback_skill` (mutate) — roll a skill back to its previous saved
  version.

Query tools resolve immediately; mutate tools may require user approval.

### Recipe — answering "what model are you using"

1. `load_tools({ names: ["get_self"] })`, then call `get_self({})`.
2. Quote `activeAgent.resolvedProvider.name` + `.model` and
   `approvalMode`. If `activeAgent.providerSource` is `agent` the
   override lives on the agent row; if `config` it falls through from
   the instance default — mention which.

Never invent provider names or version numbers. If `get_self` returns
something you don't recognize, report it verbatim.

### Recipe — answering "what providers do you have"

1. `load_tools({ names: ["list_providers"] })`, then call
   `list_providers({})`.
2. Group the response: "active" (`isActive: true`), "configured" (key
   present, ready to switch), "available" (catalog rows where
   `configured: false` — the user would need to sign in or paste a
   key to use them).

### Recipe — "set provider to deepseek"

1. `load_tools({ names: ["list_providers", "set_provider"] })`, then call
   `list_providers({})`. Find the `deepseek` row.
2. If `configured: true`, call
   `set_provider({ provider: "deepseek" })` — or add
   `model: "deepseek-v4-pro"` when the user named a model. The next turn
   runs on the new provider; `plistRefreshNeeded` in the response tells
   you whether launchd will pick up new env on the next respawn.
3. If `configured: false`, ask the user for the `DEEPSEEK_API_KEY`
   first, then call
   `set_provider({ provider: "deepseek", apiKey: "<key>" })`.

The same shape works for `openai`, `openrouter`, `local`, `codex`,
and `echo` — see `list_providers` for the full catalog.

### Recipe — "switch to agent X" / "be Athena now"

1. `load_tools({ names: ["list_agents", "use_agent"] })`, then call
   `list_agents({})` and find the row matching the name or id.
2. Call `use_agent({ agentId: "<id or name>" })`.
3. The new agent's SOUL.md and provider override take effect on the
   next turn.

### Recipe — "set permissions to yolo" / "stop asking for approval"

1. `load_tools({ names: ["set_approval_mode"] })`, then call
   `set_approval_mode({ mode: "yolo" })` (or `"auto"` / `"strict"`).
2. Never shell out to `curl`/the settings API for this — that bypasses
   the registered tool and fails on auth.

### Recipe — "what skills do you have"

1. `load_tools({ names: ["list_skills"] })`, then call `list_skills({})`
   (default returns all statuses). For "what skills can you use right
   now", pass `{ status: "enabled" }`.
2. Reply with names + brief descriptions. If the user asks for
   detail on one, call `read_skill` with that id.

### Recipe — "disable browser tools"

1. `load_tools({ names: ["list_toolsets", "disable_toolset"] })`, then
   call `list_toolsets({})` to confirm the `browser` toolset name.
2. Call `disable_toolset({ toolset: "browser" })`. The browser tools
   stop being offered next turn; your self-config tools are unaffected.
   Re-enable any time with `enable_toolset({ toolset: "browser" })`.

### Recipe — "always auto-approve git commands"

1. `load_tools({ names: ["get_self", "set_auto_approve_commands"] })`,
   then call `get_self({})` and read
   `approvalSettings.autoApproveCommands` — the current allowlist.
2. `set_auto_approve_commands` REPLACES the list, so pass the existing
   entries plus the new one:
   `set_auto_approve_commands({ patterns: [...existing, "git "] })`.
   Dropping the existing entries here would silently un-approve them.

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
- `~/.gini/instances/<inst>/skills/<name>/` — user-installed skills (the
  agent's own writable skill dir); these land flat, no category subfolder.
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

   The response carries the bridge id and an initial status. The bot's
   username isn't resolved yet — run the health probe next to learn the
   actual handle.

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

4. **Enroll the user's chat.** Have the user DM the bot anything
   (including `/start`). The runtime mints a short verification code
   (`F971-8261` format, 10-minute TTL), records it on
   `bridge.metadata.recentDeniedChats[].verificationCode` for the
   originating chat, and DMs the same code back to the user. Fetch the
   pending list with `GET /api/messaging/my-bot/chats`, confirm the
   `verificationCode` matches what the user reports receiving, then
   allow-list the chat in the next step. A DM after the code expires
   mints a fresh one and replaces the row.

5. **Allow-list the chat ID** so the bridge will deliver messages there:

   ```http
   POST /api/messaging/my-bot/allow

   { "chatId": 123456789, "expectedCode": "F971-8261" }
   ```

   Pass the `expectedCode` you confirmed in step 4. The server re-checks
   that it still matches the live `verificationCode` on the pending row
   and hasn't expired, so a code that rotated (the user re-DM'd and
   minted a new one) or aged past its TTL between fetch and approve
   returns `409 Conflict` instead of silently allow-listing the chat.

   Group chat IDs are negative integers — that is correct, not an
   error. Group chats have no `verificationCode` (no per-user channel
   to deliver one through), so omit `expectedCode` when allow-listing a
   negative chat ID.

   Human-operator CLI mirror: `gini messaging allow my-bot <chatId>`.
   The CLI omits the code because the explicit invocation on the
   operator's machine already proves intent; the API path is the one
   that needs the code-rotation check.

6. **Send a message** to confirm round-trip:

   ```http
   POST /api/messaging/my-bot/send

   { "text": "Hello from Gini.", "target": "local" }
   ```

   Human-operator CLI mirror: `gini messaging send my-bot "Hello from Gini."`.

Bridge `kind` supports `telegram` and `demo` today; future messengers
slot into the same `/api/messaging` shape.

The agent's tool for sending is `send_message`. `messaging.send` is
high-risk by classification, so it flows through the approval seam
exactly like `file.write` and `terminal.exec` — see the Approvals
section below for the three-mode contract (`strict` blocks, `auto`
auto-approves with a full audit trail, `yolo` skips the queue).

### Inspecting state

API: `GET /api/messaging`, `GET /api/messaging/<id>/{chats,messages}`,
`POST /api/messaging` (create), `POST /api/messaging/<id>/{health,disable,remove,allow,deny,reject-pending,send,receive}`.

Human-operator CLI mirror: `gini messaging {list|add|health|disable|remove|receive|send|messages|allow|deny|reject-pending|chats}`. `disable` keeps the bridge row with status `"disabled"`; `remove` drops it. Telegram per-chat enrollment uses `allow`/`deny`/`reject-pending`/`chats`; Discord uses channel-as-auth via `deliveryTargets` (no per-chat allowlist).

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

The agent's tool for calling registered MCP tools is `mcp_call`
(args: `server`, `tool`, `arguments`). It auto-executes — invocations
are NOT gated through the approval queue (the MCP server itself is
operator-registered so the agent can't reach arbitrary code). Each
call writes a `mcp.tool.invoked` audit row.

To enumerate the registered servers from chat, `load_tools({ names:
["list_mcp_servers"] })` then call `list_mcp_servers({})`.

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

From chat, `load_tools({ names: ["list_connectors"] })` then call
`list_connectors({})` for inventory, and `request_connector` to drive a
user-mediated add when one is missing.

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

Three surfaces, no fourth:

- `USER.md` (instance-scoped, always-inject) — user identity, preferences,
  recurring goals. Edits go through `edit_user_profile`, which
  auto-approves: writes land at the approved file and ride the system
  prompt on the next turn. Cross-agent — switching agents preserves
  the user profile.
- `SOUL.md` (per-agent, always-inject) — agent persona and behavior
  rules. `edit_soul` auto-approves a clean body (lands at the approved
  file, rides the prompt next turn); the injection scanner routes a body
  that trips a threat pattern through `SOUL.md.proposed` until approved.
- Hindsight (per-agent SQLite bank, recall-on-demand) — long-term
  memory populated by auto-retain at task end. Recall surfaces relevant
  units automatically; `recall_memory` is the on-demand lookup tool.

The legacy `state.memories` pinned-memory store, `add_memory`,
`update_memory`, the `/api/memory` CRUD routes, and
`gini memory list|add|approve|reject` were removed in the
memory-surface consolidation. The only API surfaces are the Hindsight
endpoints (`/api/memory/retain`, `/api/memory/recall`,
`/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`) plus
the identity-file approve endpoint for SOUL.md
(`POST /api/identity-files/soul/approve`).

Human-operator CLI mirror: `gini memory {retain|recall|reflect|units|banks|migrate}`.

## Skills

Built-in skills live under the repo at `skills/<category>/<name>/SKILL.md`.
User-installed skills land flat at
`~/.gini/instances/<inst>/skills/<name>/SKILL.md` (no category subfolder).
The runtime loads both on boot.

To enumerate skills from chat, `load_tools({ names: ["list_skills"] })`
then call `list_skills({})` (filter via `{ status, nameContains }`). To
load a specific skill's body use `read_skill`.
For lifecycle operations the agent has three tools: `install_skill`
(lands a raw SKILL.md body), `enable_skill`, and `disable_skill`. The
`meta/install-skill` skill still drives the full install UX (parsing
pasted descriptions, drafting frontmatter); these tools are the fast
path when the SKILL.md text is already in hand.

API: `GET /api/skills[/<id>]`, `POST /api/skills`,
`POST /api/skills/<id>/{enable,disable,test,rollback}`,
`PATCH /api/skills/<id>`, `GET /api/skills/validate`.

Human-operator CLI mirror: `gini skills {list|show|enable|disable|test|rollback|validate|search}`.

To draft a new SKILL.md interactively, use `meta/create-skill`.

## Approvals

The runtime classifies `browser.upload_file` (hard-coded) plus any tool
whose name contains `write`, `exec`, or `send` as `high` risk.
`file.write`, `terminal.exec`, `messaging.send`, and similar all run
through the approval seam. Browser interactive actions
(`browser.click`, `browser.type`, `browser.drag`, `browser.select_option`,
`browser.tabs.{new,switch,close}`) are `medium` and trace via snapshot
evidence — they do not block on approval. **The agent should propose
`high`-risk actions and surface them to the queue — not refuse them.**

`approvalMode` lives on the runtime config and decides how the seam
treats each `high`-risk call: `strict | auto | yolo`. Set via
`PATCH /api/settings/auto-approve`.

- **strict** — the side effect blocks until a human approves the row
  via `POST /api/authorizations/<id>/approve` (or denies it).
- **auto** — the approval row is created with `status: "pending"`,
  then the runtime auto-resolves it (`status: "approved"`) and runs
  the side effect without waiting for a human. The audit trail is
  complete: the resolution audit row carries
  `evidence.autoApproved: true` plus `autoApprovedReason:
  "approval-mode-auto"`.
- **yolo** — the approval row is still written and resolved
  through the same auto-approve path, but the policy seam skips its
  per-action gate check entirely. The resolution audit row carries
  `evidence.autoApproved: true` plus `autoApprovedReason:
  "approval-mode-yolo"`, so the audit trail stays complete; only the
  wait disappears. This is the install default; operators can switch
  to `strict` or `auto` via `PATCH /api/settings/auto-approve`.

```http
GET  /api/authorizations
POST /api/authorizations/<id>/approve
POST /api/authorizations/<id>/deny
```

Human-operator CLI mirror:

```bash
gini approval list
gini approval approve <id>
gini approval deny <id>
```

## Troubleshooting

**Telegram bridge stuck in `error` after health probe** — re-probe via
`POST /api/messaging/<id>/health`; the response is the updated bridge
record with its `message` field set. `Telegram bot token is missing —
recreate the bridge with a botToken.` means the token never landed;
recreate the bridge with the real token via `POST /api/messaging`
(`{ name, kind: "telegram", deliveryTargets: [], botToken: "<BOT_TOKEN>" }`).
Any other message is the raw Telegram error from `getMe()`; the most
common is `Unauthorized` from a bad or revoked token — re-copy the token
from BotFather and recreate the bridge. (Human-operator CLI mirror:
`gini messaging health`, then
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
approval queue. Fetch `GET /api/authorizations` to see pending items, then
`POST /api/authorizations/<id>/approve` or `/deny`. (Human-operator CLI mirror:
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
   `delete_job`, `run_job`, `spawn_subagent`, `read_skill`, and the
   self-config tools (`load_tools` them first: `get_self`, `list_providers`,
   `set_provider`, `use_agent`, …)).
3. Never read `~/.gini/instances/<inst>/*.json` directly — call `/api/*`.
4. Persistent browser cookies are a feature. For sign-in, open managed
   mode once; do not ask the user to re-authenticate on every run.
5. When the user asks Gini to remember to do something later, create a
   scheduled job — the runtime auto-binds it to a dedicated thread so
   future fires don't bury the current conversation.
6. For durable identity facts ("my name is X", "I prefer Y") call
   `edit_user_profile` so they ride the prompt every turn across agents.
   For ephemeral facts let auto-retain land them in Hindsight — never
   narrate "I'll remember that" without actually calling a tool.
