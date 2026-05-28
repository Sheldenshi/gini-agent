# Gini Agent Instructions

These instructions apply to the whole repository unless a nested `AGENTS.md` overrides them for a subtree.

## Shape

Gini is a Bun TypeScript personal agent runtime. The gateway owns durable state and execution; CLI, Next.js, future mobile, MCP, messaging, and scripts are clients of the same `/api/*` contract.

Start with `README.md` for the docs index. Keep `docs/whitepaper.md`, `docs/architecture-overview.md`, focused docs, and `docs/adr/` in sync with architecture changes.

## ADRs

Keep ADRs current when architecture changes.

- Update an existing ADR when the original decision still stands but implementation details, consequences, or acceptance checks changed.
- Add a new ADR for a significant architecture decision, trust boundary, persistence model, process shape, provider strategy, client contract, or operational workflow.
- If a change makes an ADR obsolete, mark the old decision as superseded and link to the replacement ADR.
- ADRs should be forward-looking. Don't write removal logs — context for what was deleted belongs in git history and PR descriptions, not in an ADR. If two ADRs overlap because of a consolidation, merge the canonical forward-looking content into one and delete the redundant ADR (instead of leaving both).
- ADRs are named by slug (`docs/adr/<slug>.md`), no number prefix. Pick the slug carefully and never rename it once merged — the filename is the citation key.
- Always cite an ADR by its full filename including `.md` so the reference is unambiguously a file: `see ADR agent-memory-isolation.md` in prose and code comments, and `[Per-Agent Memory Isolation](docs/adr/agent-memory-isolation.md)` for markdown links.

## Boundaries

- Prefer existing module patterns over new abstractions.
- API handlers should delegate behavior to bounded runtime modules (`src/execution`, `src/memory`, `src/jobs`, `src/governance`, `src/capabilities`, `src/integrations`, `src/runtime`).
- Storage and low-level persistence belong in `src/state/*`.
- CLI commands should prefer the public runtime API for product behavior.
- Browser code must not receive gateway bearer tokens; token injection stays server-side in the Next.js BFF.
- Side-effecting tools must preserve approval, audit, and trace behavior.
- Instance-aware paths, ports, logs, and state must remain isolated.

## Branches

Use `<type>/<kebab-case-topic>`, where `<type>` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, or `test`. Examples: `feat/profile-switcher`, `fix/chat-title-overflow`, `docs/release-process`.

## Commits and PR titles

Commit messages and PR titles describe the technical change, not the process that produced it. Public history is what reviewers and future readers see; the back-and-forth that shaped the diff is internal.

Don't write:

- `Address codex review round 3: ...`
- `Round-2 fix: ...`
- `Apply review feedback`
- `Fix bugs from <reviewer name>`
- `Sanitize PR-review meta-narration` — even meta-cleanup messages can leak the meta

Do write:

- `Sanitize extraBody and tighten provider parsers`
- `Per-provider baseUrl defaults; tighten CLI flag accuracy`
- `Tighten provider and provider-test comments`

The same rule applies to **comments inside source and tests**: describe the hazard generically (what the test pins, why a guard exists) rather than its history (`Round-3 caught that…`). Grep your diff for `[Rr]ound[- ]?[0-9]` and `review` in comments before pushing.

If iterating with multiple review-fix commits before the PR lands, squash to a clean narrative first (`git rebase -i`, or use squash-merge). Once the PR is merged, the messages are permanent.

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

After a UI-related change or new feature, exercise it in a real browser before declaring the task done. Drive the affected screen end-to-end and confirm the change actually renders and behaves as intended — typecheck and unit tests don't catch broken layouts, missing handlers, or regressed flows.

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
so the user can watch the live process and the agent
can restart it without disturbing what the user sees in their terminal.

```bash
SESSION=gini-$(basename "$(pwd)")
tmux capture-pane -t $SESSION -p -S -2000   # read what's currently in the pane
tmux send-keys -t $SESSION C-c              # stop the running app (gini run will exit)
tmux send-keys -t $SESSION "bun run gini run --instance $(basename "$(pwd)")" Enter   # restart
```

If `tmux has-session -t gini-<instance>` returns non-zero, the run script
isn't up yet. Start it yourself with the same pattern Conductor uses —
`tmux new-session -A` attaches to an existing session or creates a new one,
so it's safe to call unconditionally:

```bash
instance=$(basename "$(pwd)")
tmux new-session -d -A -s "gini-$instance" "bun run gini run --instance $instance"
```

(Conductor's workspace `conductor.json` run script uses the same flag, so
this matches what the user sees when they click Run.)

Prefer reading the log files above for historical output; use
`capture-pane` only when you need exactly what's on screen right now.
