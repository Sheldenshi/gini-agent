# Operations

This document covers local install, runtime lifecycle, parallel smoke testing, and diagnostics.

## Install

One-line install:

```sh
curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash
```

The installer detects OS and arch, installs Bun if missing, clones the runtime into `~/.gini/runtime`, installs dependencies, drops a `gini` wrapper at `~/.local/bin/gini`, ensures `~/.local/bin` is on `PATH`, and initializes the `main` instance under `~/.gini/instances/main/`. The wrapper defaults `GINI_INSTANCE=main` (override via `--instance` or the `GINI_INSTANCE` env var) so installed users land on `main` while repo-clone developers stay on `dev`.

From source (for developers):

```sh
bun install
bun run gini install
```

Use Codex OAuth as the preferred interactive provider:

```sh
codex --login
bun run gini provider set codex gpt-5.4
bun run gini doctor
```

Gini reads Codex credentials from `CODEX_AUTH_JSON` or `~/.codex/auth.json` and does not write token values into Gini config.

OpenAI API keys are supported as a fallback:

```sh
export OPENAI_API_KEY=...
bun run gini provider set openai gpt-5.4-mini
bun run gini doctor
```

## Start And Stop

Persistent runtime:

```sh
bun run gini start
bun run gini status
bun run gini stop
```

Foreground runtime for development:

```sh
bun run gini run --instance feature-x
```

`start` and `run` print the runtime gateway URL and the Next.js web URL.

For `dev`, defaults are:

- runtime: `http://127.0.0.1:7337`
- web: `http://127.0.0.1:3000`

Other instances get deterministic ports and isolated state.

## Parallel Smoke Tests

Smoke tests are isolated by default:

```sh
bun run gini smoke
```

Each smoke run creates an ephemeral instance under `/tmp`, chooses available localhost ports, uses deterministic echo model providers, exercises the real runtime/API, writes evidence, and stops the runtime afterward. Multiple coding agents can run smoke tests at the same time without sharing the `dev` instance.

For a named persistent test instance:

```sh
bun run gini smoke --instance codex-a --state-root /tmp/gini-codex-a --log-root /tmp/gini-codex-a-logs --port 7601
```

## Verification

```sh
bun run typecheck
bun test
bun run gini smoke
```

Common runtime checks:

```sh
bun run gini doctor
bun run gini parity hermes
bun run gini readiness v1
bun run gini evidence
```

## Update

To update an existing install, re-run the install one-liner. The script is idempotent — it pulls the latest source into `~/.gini/runtime`, reinstalls dependencies, and leaves your state under `~/.gini/instances/` and the model cache at `~/.gini/models/` untouched.

```sh
curl -fsSL https://raw.githubusercontent.com/Lilac-Labs/gini-agent/main/scripts/install.sh | bash
```

## Cleanup

Remove a single instance:

```sh
gini uninstall --instance <instance>
```

Full uninstall (interactive, two prompts):

```sh
gini uninstall
```

The first prompt asks "are you sure" (default no). The second asks whether to keep instance state at `~/.gini/instances/` (default yes). The full uninstall stops every running instance, removes the installer-managed wrapper at `~/.local/bin/gini`, removes the runtime checkout at `~/.gini/runtime/`, and strips the PATH block (marker `# Added by gini-agent installer`) from your shell rc. The model cache at `~/.gini/models/` is never auto-removed — the summary prints its size and the `rm -rf` command to remove it manually.

Non-interactive variants:

```sh
gini uninstall --yes      # full uninstall, no prompts, keep instances
gini uninstall --purge    # full uninstall + delete instances (implies --yes)
```

For disposable development and tests, override roots:

```sh
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```
