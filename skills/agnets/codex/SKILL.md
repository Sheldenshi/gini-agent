---
name: codex
description: "Delegate coding work to the OpenAI Codex CLI for repository changes, reviews, and focused fixes."
version: 1.0.0
author: Gini
license: MIT
prerequisites:
  commands: [codex, git]
---

# Codex CLI

Use the OpenAI Codex CLI when the user wants an autonomous coding pass in a
git repository: feature work, bug fixes, refactors, review passes, or isolated
experiments.

## Prerequisites

- Install: `npm install -g @openai/codex`
- Authenticate with the Codex CLI login flow, or provide a valid OpenAI API key.
- Run inside a git repository. For scratch work, create a temporary repo first.
- Use `pty=true` for interactive Codex commands.

Codex CLI OAuth usually lives under `~/.codex/auth.json`. Do not assume Codex
is unauthenticated only because `OPENAI_API_KEY` is missing.

## When to Use

- User asks for a second coding agent to implement, review, or investigate.
- Work can be scoped to a repository, branch, or worktree.
- A task benefits from a separate autonomous pass while Gini keeps the main
  approval, audit, and trace path.

## When NOT to Use

- User only needs a small direct edit that Gini can do faster.
- The working directory is not a git repo and the user did not ask for scratch
  prototyping.
- The request involves secrets, credential files, or destructive commands
  without explicit approval boundaries.

## Quick Tasks

Run a focused one-shot from the target repo:

```bash
codex exec "Find why the dashboard test is flaky, patch the smallest fix, and run the targeted test."
```

Review local changes:

```bash
codex exec "Review git diff --stat and git diff for bugs, regressions, and missing tests. Return findings only."
```

Scratch prototype in a disposable repo:

```bash
tmp=$(mktemp -d)
cd "$tmp"
git init
codex exec "Create a tiny Bun CLI that parses a JSON file and prints a summary."
```

## Long-Running Work

For long tasks, launch in the background with a PTY, then poll the process
rather than starting duplicate Codex runs.

```bash
codex exec --full-auto "Refactor the settings loader. Keep the diff narrow and commit when tests pass."
```

Use `--full-auto` only when repository writes are expected and the user has
accepted the risk. Avoid `--yolo` unless the user explicitly asks for it.

## Worktree Pattern

Use worktrees for parallel issue fixes so each Codex instance has its own
branch and filesystem.

```bash
git worktree add -b fix/runtime-health /tmp/gini-runtime-health main
git worktree add -b fix/skills-copy /tmp/gini-skills-copy main

cd /tmp/gini-runtime-health
codex exec --full-auto "Fix the runtime health regression and run the related tests."

cd /tmp/gini-skills-copy
codex exec --full-auto "Add coverage for bundled skill loading changes."
```

After each run, inspect the diff, run the expected checks, and remove completed
worktrees with `git worktree remove <path>`.

## PR Review Pattern

```bash
git fetch origin main
codex exec "Review the current branch against origin/main. Prioritize correctness, security, and missing tests."
```

For a GitHub PR:

```bash
gh pr checkout 42
codex exec "Review this PR against origin/main. Return only actionable findings with file and line notes."
```

## Rules

1. Keep Codex scoped to a git repo or throwaway initialized repo.
2. Prefer `codex exec "prompt"` for one-shot tasks.
3. Use `pty=true` for interactive Codex sessions.
4. Prefer `--full-auto` over `--yolo` for write-heavy work.
5. Monitor long runs before launching another agent on the same branch.
6. Inspect Codex changes before trusting or committing them.
