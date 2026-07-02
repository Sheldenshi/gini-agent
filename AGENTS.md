# Gini Agent Instructions

These instructions apply to the whole repository unless a nested `AGENTS.md` overrides them for a subtree.

## Shape

Gini is a Bun TypeScript personal agent runtime. The gateway owns durable state and execution; CLI, Next.js, future mobile, MCP, messaging, and scripts are clients of the same `/api/*` contract.

The repository is a Bun workspaces monorepo: the root `package.json` is a private workspace root (single `bun.lock`, shared dependency versions via the workspace `catalog`), with `packages/runtime` (`@gini/runtime`, the gateway + CLI), `packages/web` (`@gini/web`, the Next.js control plane), and `packages/mobile` (`@gini/mobile`, the Expo app). Bundled `skills/`, `docs/`, `scripts/`, `vendor/`, and `patches/` live at the repository root, which the runtime discovers by walking up to the workspace marker (`projectRoot()` in `packages/runtime/src/paths.ts`). Run `bun install` once at the root — it covers every package. See ADR bun-workspaces-monorepo.md.

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
- API handlers should delegate behavior to bounded runtime modules (`packages/runtime/src/execution`, `packages/runtime/src/memory`, `packages/runtime/src/jobs`, `packages/runtime/src/hooks`, `packages/runtime/src/governance`, `packages/runtime/src/capabilities`, `packages/runtime/src/integrations`, `packages/runtime/src/runtime`).
- Storage and low-level persistence belong in `packages/runtime/src/state/*`.
- CLI commands should prefer the public runtime API for product behavior.
- Browser code must not receive gateway bearer tokens; token injection stays server-side in the Next.js BFF.
- Side-effecting tools must preserve approval, audit, and trace behavior.
- Instance-aware paths, ports, logs, and state must remain isolated.
- Skill scripts (`skills/**/scripts/*.ts`) are first-class code: typechecked via the root `tsconfig` and run by `bun run test` (which spans `./skills`). Put a script's tests in `<skill>/scripts/__tests__/` — never directly in `scripts/`, which the loader advertises as runnable scripts — and keep scripts self-contained (no `packages/runtime/src/` imports) so the skill stays portable; export a pure function and import it from the test when you need coverage.

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
bun run test
bun run gini smoke
```

`bun run test` runs the suite in parallel across files (`bun test --parallel`); bare `bun test` is serial. Keep the full suite under 6 seconds; profile a slow file with `bun test <file>` or `--reporter=junit`. A 10s per-test cap lives in `bun-test-setup.ts` (via the `bunfig.toml` preload).

Fast-test rules: poll instead of `sleep`; make timeouts/intervals injectable; stub expensive deps (models, network, subprocesses); use unique temp dirs and ephemeral ports.

For docs-only changes, at minimum sweep for stale links and terminology:

```bash
rg -n "v0|v1|v2|v3|lane|v1-readiness|single HTML|src/state\\.ts|src/api" README.md docs
```

After a UI-related change or new feature, verify it end-to-end by driving the real running app the way the user would — through the browser — before declaring the task done. You are the user here: open the app, get to the change, and exercise it in context. Depending on the change, that's a **visual inspection** (does it render correctly — take a `screenshot` and look at it), a **flow** check (does the interaction path actually work — click, type, and navigate through it), or both.

- Web changes (`packages/web/`): run the Next.js dev server and drive it in a browser with `agent-browser` (run `agent-browser skills get dogfood` first for the exploratory-QA workflow, or `skills get core` for the command reference). Walk the flow by `@ref` from `snapshot -i`, wait with `--load networkidle`, `screenshot` to eyeball the result, and check `errors`/`console` per page.
- Mobile changes (`packages/mobile/`): run it on the iOS simulator (`bun run mobile:ios`) AND in the RN Web target (`cd packages/mobile && bun run web`). The web target lets `agent-browser` drive the actual UI (flow and visual check); the iOS simulator is what catches native-only behavior (long-press selection, gesture handling, native text input, etc.).
- Shared changes that affect both: verify on both.

Don't stop at typecheck — "it compiles" and "the screen loaded" are not "it works." Native RN behavior in particular often differs from RN Web (e.g. `selectable` on `<Text>` is a no-op on web because browser text is selectable by default), so a web-only check can pass while the native build is still broken.

**A gateway that isn't running is not a blocker — start it yourself.** Never report "I couldn't test end-to-end because the gateway/dev server was down." Bring it up with the Tmux pattern below (`tmux new-session -d -A -s gini-<instance> "bun run gini run --instance <instance>"`), confirm it's listening with `bun run gini status --instance <instance>`, then drive the change through the real surface. It boots in seconds.

**Always test on the worktree's own instance — the same one the user sees in Conductor.** That instance is the worktree root's basename, which is exactly Conductor's `gini-<instance>` tmux session and the `--instance` value its Run script passes. Use it — never `default`, never an invented throwaway. Always drive the runtime with `bun run gini …` from the worktree root so you exercise *this* checkout's code, and pass `--instance "$instance"` explicitly. Never use the bare `gini` on `PATH`: its installer wrapper does `cd ~/.gini/runtime` and `export GINI_INSTANCE=default`, so it silently runs the *installed* copy against the `default` instance — testing neither your code nor your instance, even when the command looks correct. Resolution precedence is `--instance` flag > `GINI_INSTANCE` env > worktree basename.

For runtime / agent changes (tools, dispatch, providers, memory, skills), "the affected surface" is a **real chat turn**, not a unit test — and you verify it the way the user does: **open the running web app in a browser (`agent-browser`), start a fresh chat, type the bare message into the composer**, wait for the turn to finish (`--load networkidle`), and judge from what actually **renders** that the agent picked the right tool and produced the right result. The CLI path (`bun run gini chat new`/`chat send`, which post to `/api/chat/<id>/messages`) and reading the task's `recentToolCalls` or `/api/chat/<id>/blocks` are only a **fallback for genuinely headless contexts and a supplement for confirming which tool fired — never a substitute for the browser turn**: rendering (chips, narration folding, draft cards, tool-group collapsing) lives client-side and never appears in the API payload, so an API-only check can pass while the user-visible result is broken. Unit tests verify the mechanism; the chat turn verifies the model actually reaches for it. Test against the worktree's own instance, never `default`.

When the change is a **behavioral steer** (you want the agent to *reach for* a tool or path on its own), the chat turn must use a prompt a real user would actually send — and nothing more. Never narrate the intended behavior into the message ("drive the purchase as far as you can before involving me", "use your handoff flow"). That tests instruction-following, not the default — and a coached prompt routinely makes a behavior look more robust than it is, even producing a structured affordance (e.g. an `ask_user` choice card) that the bare prompt never triggers. Send the bare request, then judge whether the agent gets there unprompted. The behavior belongs in `INSTRUCTIONS.md`, never in the user's mouth. (Claude Code: the full dogfooding runbook is the checked-in `dogfood-as-user` skill under `.claude/skills/`.)

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
