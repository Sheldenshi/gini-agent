# Migrating from openclaw to gini

This guide moves an existing [openclaw](https://github.com/openclaw/openclaw) install onto gini. Read [Per-Agent Memory Isolation](adr/agent-memory-isolation.md), [Connector Secret Storage](adr/connector-secret-storage.md), and [Openclaw Migration](adr/openclaw-migration.md) for the architectural reasoning.

## Prerequisites

- A working openclaw install you no longer want as your primary agent. The state must live on the same machine you are running gini on; the migrator does not transfer state across hosts.
- A gini install (`bun run gini install`). The migrator does not bootstrap gini; it only adds to an existing instance.
- Stop openclaw's gateway before migrating so the migrator reads a consistent snapshot. `openclaw stop` (or its daemon equivalent) is enough — the migrator never writes back into openclaw's state root.
- Stop the gini gateway for the target instance before running `apply`. `gini import apply openclaw` refuses to run while a gateway is alive for the same instance because the in-process `mutateState` lock cannot serialize writes across separate OS processes. Run `gini stop --instance <name>` first, apply, then `gini start --instance <name>`.

## Resolving the openclaw state root

The migrator looks for openclaw's state root in this order, matching openclaw's own resolution:

1. An explicit path argument to `gini import`.
2. `OPENCLAW_STATE_DIR` environment variable.
3. `~/.openclaw/`.
4. The legacy `~/.clawdbot/`.

If none of those exist, you'll see "no openclaw.json found" in the planner output and the apply step is a no-op.

## Two-step flow

The migrator separates inspection from mutation. Always run `plan` first so you can read the summary before any state changes.

```bash
# Dry-run: print a redacted summary of what would happen.
bun run gini import plan openclaw

# Apply: actually mutate gini state.
bun run gini import apply openclaw
```

Both commands accept an optional path argument when your openclaw state lives somewhere other than the default. The CLI prints JSON; pipe it to `jq` for readable filtering.

```bash
bun run gini import plan openclaw /Volumes/backup/old-openclaw | jq
```

## What gets migrated

The migrator walks the openclaw state and synthesizes equivalent gini records for the subsystems gini implements today:

| Openclaw artifact | Gini destination | Notes |
| --- | --- | --- |
| `cfg.agents.list[]` | New `AgentRecord` per agent | Agent name carries the openclaw id. The default openclaw agent maps to a new gini agent — the seeded `agent_default` is left alone so your existing defaults aren't disturbed. |
| `agents/<id>/agent/auth-profiles.json` (api_key / token) | `~/.gini/secrets.env` line `<PROVIDER>_API_KEY=…` | Only providers gini supports natively (`openai`, `codex`, `openrouter`, `local`). Anthropic, Google, and similar are listed in `unsupported` so you can wire them manually. |
| `channels.telegram` + state-dir `.env` `TELEGRAM_BOT_TOKEN` + `credentials/telegram-allowFrom.json` | `MessagingBridgeRecord` (kind `telegram`) with encrypted bot token and per-chat allowlist | Allowlist string ids are coerced to numbers. See [Telegram Messaging Bridge](adr/telegram-bridge.md). |
| `channels.discord` + `DISCORD_BOT_TOKEN` | `MessagingBridgeRecord` (kind `discord`) with encrypted bot token | See [Discord Messaging Bridge](adr/discord-bridge.md). **The supervisor won't poll the bridge until you add at least one delivery channel.** Openclaw stores a per-sender allowlist while gini stores per-channel snowflakes, so the migrator cannot derive the channel list. The migration warning instructs the operator to disable the migrated bridge with `gini messaging disable <id>` and re-create it via `gini messaging add <name> discord <channel-id>... --bot-token <token>` (re-supplying the original openclaw bot token). An in-place edit verb is a known follow-up. |
| `<state>/skills/<name>/SKILL.md` | `<instance>/skills/<name>/SKILL.md` | Top-level `openclaw:` frontmatter block is rewritten to `metadata:\n  gini:`. Sibling files in the skill dir (scripts, references) are copied verbatim. |
| `<state>/workspace/{AGENTS,SOUL,TOOLS,IDENTITY,USER,HEARTBEAT,BOOTSTRAP,MEMORY}.md` | `<instance>/workspace/<file>` | Same-named files are skipped unless `--force` is passed. The migrator looks for the workspace dir at `<state>/workspace/` first, then `<openclaw-home>/.openclaw/workspace/` as a fallback. |

Provider keys land in `~/.gini/secrets.env` because the installed `gini` wrapper sources that file with `set -a` on every invocation. Connector tokens go through the per-instance encrypted secret store described in [Connector Secret Storage](adr/connector-secret-storage.md) — they are never logged or echoed.

## What is NOT migrated

The migrator surfaces every unmigrated subsystem in the `unsupported` field so you know what is left on the openclaw side:

- **Hindsight memory** (`<state>/memory/<id>.sqlite`). The openclaw and gini memory schemas don't align; rebuilding memory from scratch is safer than a lossy translation.
- **Session transcripts** (`<state>/agents/<id>/sessions/`). Openclaw's Claude-CLI handoff doesn't have a gini equivalent.
- **Tasks and cron registries**, **plugin installs**, **device-pair tokens**. Either the feature doesn't exist on the gini side yet or the state is safer to re-establish (devices in particular — openclaw device tokens cannot be reused under gini; re-pair via `gini pair` once you're on gini).
- **Non-Telegram, non-Discord channels** (WhatsApp, Signal, Slack, etc.). Gini has no bridge implementation for those yet; the migrator lists each unsupported channel by name.

## Idempotency and re-runs

`gini import apply openclaw` is safe to re-run. The default behavior skips anything that already exists by name:

- Agents with a matching `name` are left alone.
- Workspace files that already exist on disk are skipped.
- Skills with the same directory name are skipped.
- One messaging bridge per kind is kept; a second apply does not fork the bridge.

Use `--force` to rotate values: a fresh openclaw config with a new `TELEGRAM_BOT_TOKEN` re-applied with `--force` rewrites the encrypted secret file and updates `metadata.allowedChatIds`. Workspace files and skills also overwrite under `--force`.

## Audit trail

Every applied migration writes:

- An `ImportReport` row with `source: "openclaw"`, `mode: "applied"`, and a `counts` map summarizing each subsystem.
- Per-creation audit rows in `state.audit` (agent created, messaging configured, etc.) emitted by the same `addAudit` path the live CRUD endpoints use.

You can read the report via `gini import` (the default subcommand lists reports) and the audit rows via `gini audit`.

## Verifying after migration

```bash
# Inspect agent state.
bun run gini agents list

# Confirm the bridge is configured and healthy.
bun run gini messaging list

# Smoke test the runtime end-to-end.
bun run gini smoke
```

After the smoke passes, start gini:

```bash
bun run gini start
```

The newly-imported provider keys are picked up automatically because the installed `gini` wrapper sources `~/.gini/secrets.env` on every invocation.

## Common questions

**Can I run this without stopping openclaw?**
The migrator only reads from the openclaw state, never writes. But openclaw's gateway can rewrite files mid-read (a `sessions.json` flush, an offset bump). Stopping openclaw first guarantees a consistent snapshot.

**Where do I find my openclaw state if I customized it?**
Run `openclaw doctor` — it prints the active state root. Or check `OPENCLAW_STATE_DIR` in your shell environment.

**My openclaw agents use Anthropic. What happens?**
The migrator creates the agent record but skips the API key (Anthropic isn't in gini's native provider list yet). The `unsupported` array in the report lists `provider:anthropic`. Add the key manually via `gini provider set` once gini supports Anthropic, or point the agent at OpenRouter as an interim alternative.

**Will my chat history come over?**
No. Sessions live in JSONL transcripts under `<state>/agents/<id>/sessions/`, written for Claude-CLI's handoff model. Gini's `ChatSessionRecord` model is structurally different. History migration is a follow-up question and is intentionally out of scope for v1.
