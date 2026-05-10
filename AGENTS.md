# Gini Agent Instructions

These instructions apply to the whole repository unless a nested `AGENTS.md` overrides them for a subtree.

## Shape

Gini is a local-first Bun TypeScript agent runtime. The gateway owns durable state and execution; CLI, Next.js, future mobile, MCP, messaging, and scripts are clients of the same `/api/*` contract.

Start with `README.md` for the docs index. Keep `docs/master-plan.md`, `docs/architecture-overview.md`, focused docs, and `docs/adr/` in sync with architecture changes.

## ADRs

Keep ADRs current when architecture changes.

- Update an existing ADR when the original decision still stands but implementation details, consequences, or acceptance checks changed.
- Add a new ADR for a significant architecture decision, trust boundary, persistence model, process shape, provider strategy, client contract, or operational workflow.
- If a change makes an ADR obsolete, mark the old decision as superseded and link to the replacement ADR.

## Boundaries

- Prefer existing module patterns over new abstractions.
- API handlers should delegate behavior to bounded runtime modules (`src/execution`, `src/memory`, `src/jobs`, `src/governance`, `src/capabilities`, `src/integrations`, `src/runtime`).
- Storage and low-level persistence belong in `src/state/*`.
- CLI commands should prefer the public runtime API for product behavior.
- Browser code must not receive gateway bearer tokens; token injection stays server-side in the Next.js BFF.
- Side-effecting tools must preserve approval, audit, and trace behavior.
- Instance-aware paths, ports, logs, and state must remain isolated.

## Verification

For code changes, run relevant tests plus broader checks when practical:

```bash
bun run typecheck
bun test
bun run gini smoke
```

For docs-only changes, at minimum sweep for stale links and terminology:

```bash
rg -n "v0|v1|v2|v3|lane|v1-readiness|single HTML|src/state\\.ts|src/api" README.md docs
```

The compatibility command/API name `readiness v1` and `/api/readiness/v1` may still appear, but they should not drive product planning language.

## Logs

Spawned child stdio is appended under:

```text
~/.gini/instances/<instance>/logs/
```

- `web.log`: Next.js dev server stdout/stderr
- `runtime-stdout.log`: Bun runtime stdout/stderr
- `runtime.jsonl`: structured runtime events

Read recent logs:

```bash
INSTANCE=$(basename "$(pwd)")
tail -n 200 ~/.gini/instances/$INSTANCE/logs/web.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime-stdout.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime.jsonl
```

## Tmux session

`bun run gini run` is launched inside a tmux session named `gini-<instance>`
(e.g. `gini-rabat`) so the user can watch the live process and the agent
can restart it without disturbing what the user sees in their terminal.

```bash
SESSION=gini-$(basename "$(pwd)")
tmux capture-pane -t $SESSION -p -S -2000   # read what's currently in the pane
tmux send-keys -t $SESSION C-c              # stop the running app (gini run will exit)
tmux send-keys -t $SESSION "bun run gini run --instance $(basename "$(pwd)")" Enter   # restart
```

If `tmux has-session -t gini-<instance>` returns non-zero, the run script
hasn't been started yet — ask the user to start it from Conductor rather
than starting it yourself. Prefer reading the log files above for
historical output; use `capture-pane` only when you need exactly what's
on screen right now.
