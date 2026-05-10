# Operations

This document covers local install, runtime lifecycle, parallel smoke testing, and diagnostics.

## Install

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

## Cleanup

Remove one instance:

```sh
bun run gini uninstall --instance <instance>
```

Remove all instances while keeping model cache:

```sh
rm -rf ~/.gini/instances
```

Remove all local Gini data, including downloaded models:

```sh
rm -rf ~/.gini
```

For disposable development and tests, override roots:

```sh
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```
