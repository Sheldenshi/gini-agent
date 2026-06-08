# Gini Agent

Gini Agent is a personal agent that remembers, improves, and runs without forcing you to read a log line.

Gini is not just a chat box, CLI, messaging bot, or pile of tools. Chat is an interaction surface. The runtime is the system of record for conversations, runs, tasks, approvals, memory, skills, jobs, tools, traces, audit events, and runtime health.

## Docs

- [Whitepaper](docs/whitepaper.md): the gaps this project is closing and the bar it's measured against
- [Architecture Overview](docs/architecture-overview.md): gateway/client map
- [Gateway And Control Plane](docs/gateway.md): runtime process, BFF, auth, instances, ports, disk layout
- [Conversation And Runs](docs/conversation-runs.md): chat, runs, tasks, plan steps, traces, and audit handoff
- [Memory](docs/memory.md): retain, recall, embeddings, reranking, review, and storage
- [Runtime Capabilities](docs/runtime-capabilities.md): current CLI/API capability map and verification commands
- [Operations](docs/operations.md): install, start, stop, smoke, diagnostics, and cleanup
- [Releases](docs/releases.md): versioning, CHANGELOG conventions, and the release process
- [Migrating from openclaw](docs/migration-from-openclaw.md): import an existing openclaw install into gini
- [Implementation Notes](docs/implementation-notes.md): source layout and module boundary rules
- [Roadmap](ROADMAP.md): shipped surfaces and what's planned, with design intent

## Architecture decisions

- [Architecture Decision Records](docs/adr/README.md): index of all ADRs and how to add new ones

## Architecture In One Sentence

Gini's **runtime is the gateway**: a single Bun process per instance owns state and performs work. The Next.js web app, CLI, Expo mobile app, MCP surfaces, and messaging bridges are clients of the same authenticated `/api/*` contract. See [Architecture Overview](docs/architecture-overview.md) for the design.

```text
                 GATEWAY (Bun runtime, one per instance)
                 state, agent loop, tools, memory, jobs
                              ^
          --------------------+--------------------
          |                    |                   |
      Next.js BFF          CLI / scripts       other clients
      browser UI           bearer token        mobile, MCP, messaging
      no browser token
```

## What's in the box

- Authenticated localhost gateway and a Next.js + Tailwind + shadcn/ui control plane
- Persistent chat, runs, tasks, approvals, traces, audit events, jobs, memories, and skills
- Approval-gated file, terminal, and code tools
- Provider support: Codex OAuth, OpenAI API key, OpenRouter, and any OpenAI-compatible local server
- Local embeddings, reranking, and voice-message speech-to-text by default
- Parallel instances with isolated state, ports, and logs

See the [Whitepaper](docs/whitepaper.md) and [Architecture Overview](docs/architecture-overview.md) for the design.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash
```

On macOS the installer enables autostart (per-user LaunchAgents for the runtime and webapp), waits for the webapp to come up, and opens the `/setup` page in your browser. Pick a provider in the browser form (OpenAI API key or existing `codex --login` auth) and you land on the running app. The runtime stays alive across reboots and crashes until you explicitly run `gini stop` or `gini autostart disable`.

If the browser doesn't open automatically (or you want to navigate manually), run `gini status` to print the actual web URL. The installed `default` instance always lives at `:7777`; other instances get hash-derived ports, so check `gini status` rather than guessing. The installer also prints the URL right before opening the browser.

Caveat on macOS 26 (Tahoe): after a SIGKILL, launchd sometimes refuses to auto-respawn (`pended nondemand spawn = inefficient`). Run `gini autostart kick` to force a respawn when that happens; RunAtLoad still fires at login.

If you opted out of autostart (`--no-autostart`) or you're on Linux (autostart is currently macOS-only), run `gini setup` then `gini start` to launch the runtime by hand.

After install, the URLs are stable:

- web: `http://127.0.0.1:7777`
- runtime: `http://127.0.0.1:7778`

### Update

```bash
gini update
```

Updates the installer-managed runtime at `~/.gini/runtime` and restarts it. Per-instance state under `~/.gini/instances/` and the model cache at `~/.gini/models/` are preserved.

### From source

```bash
bun install
bun run gini install
bun run gini start
```

From a repo clone, the instance is derived from the directory basename, so each worktree gets isolated state and ports automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup including `./scripts/install.sh --local` for testing the install flow against a local checkout.

## CLI

The CLI covers chat, runs, tasks, approvals, memory, jobs, connectors, providers, snapshots, imports, and more. Discover commands with:

```bash
gini --help
```

Useful starting points:

```bash
gini status        # runtime health and URLs
gini chat new      # start a chat session
gini approvals     # review pending tool approvals
```

(From a repo clone, prefix with `bun run`.)

## Providers

Run `gini setup` for an interactive picker, or configure directly:

```bash
gini provider set codex gpt-5.5            # Codex OAuth (reads ~/.codex/auth.json)
gini provider set openai gpt-5.4-mini      # uses $OPENAI_API_KEY
gini provider set openrouter <model>       # uses $OPENROUTER_API_KEY
gini provider set local <model> --base-url http://127.0.0.1:8000/v1
# Azure OpenAI: point the openai provider at a deployment
gini provider set openai gpt-5.4 \
  --base-url https://<resource>.openai.azure.com \
  --api-version 2024-12-01-preview --deployment <deployment> --auth-scheme api-key
```

The `local` provider works with any OpenAI-compatible server (oMLX, vLLM, LM Studio, llama.cpp). The `openai` provider also targets **Azure OpenAI** when given an `--api-version` and an Azure `--base-url`: requests route to the deployment-scoped Azure endpoint, with `--auth-scheme api-key` for a resource key or `bearer` for an Entra token (the same fields are exposed in Settings → Providers in the web UI). API keys are read from environment variables, and Codex OAuth is read from `~/.codex/auth.json` (or `CODEX_AUTH_JSON`) — nothing is written to Gini config. Run `gini --help` for the full flag set, or see [Azure OpenAI Routing](docs/adr/azure-openai-provider.md) and [provider-extra-body.md](docs/adr/provider-extra-body.md) for the `--extra-body` contract. When a credential fails mid-chat, see [Codex re-authentication](docs/providers/codex.md#re-authentication) and [Provider Re-Authentication Guidance](docs/adr/provider-reauth-guidance.md).

## Parallel Instances

Each instance has isolated state, ports, and logs:

```bash
gini --instance sandbox run
gini smoke                  # ephemeral instance under /tmp
```

Multiple agents can run smoke tests concurrently without colliding.

## Messaging channels

Gini can bridge to messaging channels such as Telegram and Discord. These bridges were added to exercise the gateway's messaging contract and are **not** being actively worked on. We highly recommend interacting with Gini through the native web app and iOS app. Those are the primary, actively developed surfaces. See [telegram-bridge.md](docs/adr/telegram-bridge.md) and [discord-bridge.md](docs/adr/discord-bridge.md) for the bridge contracts.

## Migrating from openclaw

Already running [openclaw](https://github.com/openclaw/openclaw)? Import your agents, chat history, memory, skills, workspace files, and messaging bridges into a gini instance. The import is two steps — `plan` prints a redacted summary, `apply` writes the state:

```bash
gini import plan openclaw    # dry-run: summarize what would be imported
gini import apply openclaw   # import the openclaw state into gini
```

`apply` mutates state in-process, so stop the target instance first (`gini stop --instance <name>`), apply, then start it again. Every applied import first archives your full openclaw state to `<instance>/imports/openclaw-<timestamp>.zip`, so nothing is lost. See [Migrating from openclaw](docs/migration-from-openclaw.md) for the field-by-field mapping, idempotency rules, and verification steps.

## Local State

```text
~/.gini/instances/<instance>/   # config, state.json, memory.db, traces, snapshots, workspace, logs
~/.gini/models/                 # shared embedding/reranker/speech-to-text model cache
```

Use `gini uninstall` to remove an instance or the whole install. See [Operations](docs/operations.md) for diagnostics and cleanup.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for shipped surfaces and what's planned.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, verification commands, and PR conventions. For architecture conventions and module boundaries, see [AGENTS.md](AGENTS.md). Report security issues privately per [SECURITY.md](SECURITY.md).

## Star History

<a href="https://star-history.com/#Lilac-Labs/gini-agent&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Lilac-Labs/gini-agent&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Lilac-Labs/gini-agent&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Lilac-Labs/gini-agent&type=Date" />
 </picture>
</a>

## License

[MIT](LICENSE)
