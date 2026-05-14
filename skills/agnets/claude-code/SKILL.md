---
name: claude-code
description: "Delegate coding work to Claude Code CLI for repository edits, reviews, and multi-turn implementation sessions."
version: 1.0.0
author: Gini
license: MIT
prerequisites:
  commands: [claude, git]
---

# Claude Code CLI

Use Claude Code when the user wants another coding agent to edit a repository,
review a diff, run tests, or carry an implementation through multiple turns.
Gini should still own the visible approval, audit, and trace boundary around
the shell commands it runs.

## Prerequisites

- Install: `npm install -g @anthropic-ai/claude-code`
- Authenticate with `claude` or `claude auth login`.
- Check health with `claude doctor`.
- Check auth with `claude auth status --text`.

## When to Use

- User asks to delegate to Claude Code or wants an independent coding pass.
- The task is large enough to benefit from a separate agent loop.
- The work can be done inside a repo, branch, or isolated worktree.
- A multi-turn session is useful for iterative implementation, review, and
  follow-up fixes.

## When NOT to Use

- Gini can safely make the edit directly in one short pass.
- The task requires private credentials or destructive commands without clear
  user approval.
- The repo already has a running agent editing the same files.

## Print Mode

Use print mode for non-interactive automation. It runs once and exits, which
makes it the default choice for Gini-triggered delegation.

```bash
claude -p "Find the failing route test, patch the smallest fix, and run that test." --allowedTools "Read,Edit,Bash" --max-turns 10
```

Review a diff:

```bash
git diff origin/main...HEAD | claude -p "Review this diff for correctness bugs and missing tests. Return findings only." --max-turns 1
```

Produce structured output:

```bash
claude -p "List risky files in this change" --output-format json --max-turns 3
```

Use `--max-turns` for bounded automation and `--allowedTools` when the task
should only read, edit, or run selected command classes.

## Interactive Tmux Mode

Use tmux when the user wants a live multi-turn Claude Code session.

```bash
tmux new-session -d -s claude-gini -x 140 -y 40
tmux send-keys -t claude-gini 'cd /path/to/repo && claude' Enter
sleep 5
tmux capture-pane -t claude-gini -p -S -80
tmux send-keys -t claude-gini 'Implement the settings cleanup, then stop for review.' Enter
```

Read progress with:

```bash
tmux capture-pane -t claude-gini -p -S -120
```

Exit cleanly with:

```bash
tmux send-keys -t claude-gini '/exit' Enter
```

## Dialog Handling

Claude Code can show first-run trust and permission dialogs in interactive
mode. Inspect the pane before sending keys.

Workspace trust usually defaults to the safe accept option:

```bash
tmux send-keys -t claude-gini Enter
```

If the session was launched with `--dangerously-skip-permissions`, the bypass
warning usually requires moving to the accept option first:

```bash
tmux send-keys -t claude-gini Down
sleep 0.3
tmux send-keys -t claude-gini Enter
```

Avoid `--dangerously-skip-permissions` unless the user explicitly wants that
risk.

## Useful Commands

```bash
claude --version
claude doctor
claude auth status --text
claude -p "Summarize this repository's test layout" --max-turns 2
claude -c -p "Continue the previous fix and report what changed" --max-turns 5
claude -r <session-id> -p "Add tests for the change you just made" --max-turns 5
claude mcp list
```

## Worktree Pattern

For parallel work, create one worktree per Claude Code instance.

```bash
git worktree add -b fix/provider-status /tmp/gini-provider-status main
cd /tmp/gini-provider-status
claude -p "Fix provider status reporting and run the focused tests." --allowedTools "Read,Edit,Bash" --max-turns 15
```

Inspect the diff and test results before merging the worktree changes back.

## Rules

1. Prefer `claude -p` for one-shot Gini automation.
2. Use tmux only for live multi-turn sessions.
3. Bound automation with `--max-turns`.
4. Use `--allowedTools` for least-privilege delegated work.
5. Keep each Claude Code instance on its own branch or worktree for parallel
   changes.
6. Inspect Claude Code edits before committing them.
