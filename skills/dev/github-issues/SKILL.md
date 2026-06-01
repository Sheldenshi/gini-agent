---
name: github-issues
description: "Create, search, triage, label, assign, comment on, and close GitHub issues using the gh CLI, with a curl REST fallback."
license: MIT
compatibility: "Requires the `gh` CLI authenticated (or a GITHUB_TOKEN for the curl fallback) and a repo with a GitHub remote, or an explicit owner/repo."
allowed-tools: "terminal_exec"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: dev
    platforms: [macos, linux, windows]
    prerequisites:
      commands: [gh, git, curl]
      env: [GITHUB_TOKEN]
---

# GitHub Issues

Manage GitHub issues end to end: list, search, view, create, label,
assign, comment, close, reopen, triage, and run bulk operations. Every
section leads with the `gh` CLI (the preferred path) and follows with a
`curl` REST fallback for environments where `gh` is unavailable.

## When To Use

- User asks to file, view, search, or update a GitHub issue.
- User asks to triage a backlog ("label the untriaged issues", "assign
  the open bugs to me").
- User asks for the status of issues on a repo ("what's open on
  owner/repo", "show me the bugs I'm assigned").

## When NOT to Use

- Pull-request review or merge flows → not covered here; use `gh pr …`.
- Linear, Jira, or other trackers → use their dedicated skill.
- Plain local git history questions → answer with `git log` directly.

## Setup

`gh` is the preferred path. It must be installed and authenticated before
the first issue operation. **Installing is non-interactive — do it
yourself** (it's a side-effecting command, so it runs through the approval
seam; you propose it, you don't hand it to the user). Only the interactive
sign-in in step 2 needs the user.

### 1. Install gh if it's missing

Check for it, and if it's absent, detect the platform and run the matching
install command yourself:

```bash
command -v gh >/dev/null 2>&1 && echo "gh present: $(gh --version | head -1)"
```

If that prints nothing, install it:

```bash
brew install gh                       # macOS / Linuxbrew
sudo dnf install -y gh                # Fedora / RHEL
sudo pacman -S --noconfirm github-cli # Arch
winget install --id GitHub.cli        # Windows
```

Debian/Ubuntu need the GitHub CLI apt repo added first — run this chain
(don't ask the user to):

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install -y wget)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
  && sudo apt update && sudo apt install -y gh
```

Only if the host genuinely can't install `gh` (no supported package
manager, no sudo) fall back to the curl/REST path in step 3.

### 2. Authenticate gh if it isn't signed in

```bash
gh auth status >/dev/null 2>&1 && echo "gh authenticated" || echo "gh NOT authenticated"
```

If it's not authenticated, tell the user in one line and stop — sign-in is
interactive, so they run it, not you. Say something like:

> Run `gh auth login` in your terminal to sign in, then I can file the issue.

Pick up where you left off once they confirm; re-run `gh auth status` to
verify before continuing.

### 3. Resolve the auth mode and target repo

```bash
# Prefer the gh CLI when it's present and signed in.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  AUTH="gh"
else
  AUTH="curl"
  : "${GITHUB_TOKEN:?gh is unavailable — set GITHUB_TOKEN, or install and auth gh (steps 1-2)}"
fi

# Derive owner/repo from the origin remote (needed for the curl path).
OWNER_REPO=$(git remote get-url origin 2>/dev/null \
  | sed -E 's|.*github\.com[:/]||; s|\.git$||')
OWNER=${OWNER_REPO%%/*}
REPO=${OWNER_REPO##*/}
```

`gh` reads `$OWNER/$REPO` from the remote automatically; pass
`--repo owner/repo` to any `gh issue` command to target a different repo.
For curl, the REST base is `https://api.github.com/repos/$OWNER/$REPO`.

## 1. Listing and Searching

**gh:**

```bash
gh issue list
gh issue list --state open --label "needs-triage" --limit 30
gh issue list --assignee @me --json number,title,labels
gh issue list --search "in:title timeout sort:created-desc"
gh issue view 128
gh issue view 128 --comments
```

**curl:**

```bash
# Open issues (the REST /issues endpoint also returns PRs — filter them out).
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues?state=open&per_page=30" \
  | jq -r '.[] | select(.pull_request|not)
           | "#\(.number)  \(.state)  \([.labels[].name]|join(","))  \(.title)"'

# A single issue with its metadata.
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128" \
  | jq -r '"#\(.number): \(.title)\nState: \(.state)  Labels: \([.labels[].name]|join(", "))\n\n\(.body)"'

# Full-text search scoped to the repo.
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/search/issues?q=timeout+in:title+repo:$OWNER/$REPO" \
  | jq -r '.items[] | "#\(.number)  \(.state)  \(.title)"'
```

## 2. Creating Issues

**gh:**

```bash
gh issue create \
  --title "Webhook retries drop the Idempotency-Key header" \
  --body "$(cat <<'EOF'
## Summary
Retried webhook deliveries are sent without the Idempotency-Key header,
so the downstream consumer treats each retry as a distinct event.

## Impact
Duplicate charges when a delivery is retried after a transient 5xx.

## Steps to Reproduce
1. Trigger a webhook whose first delivery returns 503.
2. Wait for the automatic retry.
3. Inspect the retried request headers.

## Expected
The retry carries the same Idempotency-Key as the original delivery.
EOF
)" \
  --label "bug,webhooks" \
  --assignee "@me"
```

**curl:**

```bash
curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues" \
  -d "$(jq -nc \
    --arg title "Webhook retries drop the Idempotency-Key header" \
    --arg body $'## Summary\nRetried deliveries omit the Idempotency-Key header.\n\n## Impact\nDuplicate charges on retry.' \
    '{title:$title, body:$body, labels:["bug","webhooks"], assignees:["octocat"]}')"
```

### Body templates

Two fillable templates ship alongside this skill:

- `templates/bug-report.md` — Summary, Impact, Steps to Reproduce,
  Expected vs Actual, Environment, Error Output, Additional Context.
- `templates/feature-request.md` — Problem, Who hits this, Proposed
  direction, Alternatives considered, Out of scope, Additional Context.

Fill one in, then pass it straight to `gh` instead of inlining a heredoc.
The templates sit next to this SKILL.md — under the repo at
`skills/dev/github-issues/templates/` for the bundled skill, or under
`~/.gini/instances/<inst>/skills/dev/github-issues/templates/` for a
user-installed copy.

```bash
gh issue create --title "…" --label "bug" \
  --body-file skills/dev/github-issues/templates/bug-report.md
```

With curl, read the file into the `body` field: `jq -nc --arg b "$(cat
templates/bug-report.md)" '{title:"…", body:$b}'`. Edit the placeholders
before submitting — don't file an issue with the `<!-- … -->` hints intact.

## 3. Managing Issues

### Labels

**gh:**

```bash
gh issue edit 128 --add-label "priority:high" --add-label "webhooks"
gh issue edit 128 --remove-label "needs-triage"
gh label list                       # what labels exist on this repo
```

**curl:**

```bash
# Add labels.
curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128/labels" \
  -d '{"labels":["priority:high","webhooks"]}'

# Remove one label.
curl -s -X DELETE -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128/labels/needs-triage"

# List the labels defined on the repo.
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/labels?per_page=100" \
  | jq -r '.[] | "\(.name)\t\(.description // "")"'
```

Confirm a label exists (`gh label list`) before applying it — GitHub
returns a generic 422 for an unknown label rather than creating it.

### Assignment

**gh:**

```bash
gh issue edit 128 --add-assignee @me
gh issue edit 128 --add-assignee octocat --remove-assignee former-owner
```

**curl:**

```bash
curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128/assignees" \
  -d '{"assignees":["octocat"]}'
```

### Comments

**gh:**

```bash
gh issue comment 128 --body "Root cause is in the retry middleware — it rebuilds the request without copying idempotency headers. Fix in progress."
```

**curl:**

```bash
curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128/comments" \
  -d "$(jq -nc --arg b "Root cause is in the retry middleware. Fix in progress." '{body:$b}')"
```

### Closing and reopening

**gh:**

```bash
gh issue close 128 --reason completed --comment "Fixed in #131."
gh issue close 142 --reason "not planned"
gh issue reopen 128
```

**curl:**

```bash
# state_reason is one of: completed | not_planned | reopened
curl -s -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128" \
  -d '{"state":"closed","state_reason":"completed"}'

curl -s -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/128" \
  -d '{"state":"open"}'
```

### Linking issues to PRs

A PR that includes a closing keyword in its body auto-closes the issue
when it merges: `Closes #128`, `Fixes #128`, or `Resolves #128`.

Start a branch directly from an issue:

```bash
gh issue develop 128 --checkout          # gh creates and checks out the branch
# manual equivalent:
git switch main && git pull && git switch -c fix/issue-128-idempotency-key
```

## 4. Triage Workflow

When asked to triage:

1. **List the untriaged set** — `gh issue list --label "needs-triage" --state open`.
2. **Read each issue** in full (`gh issue view <n>`) to understand whether
   it's a bug, a feature, or a question.
3. **Apply a type + priority label** and remove `needs-triage` (see
   Labels above).
4. **Assign** when the owner is obvious; otherwise leave it for a human.
5. **Leave a short triage note** as a comment when the categorization
   isn't self-explanatory.

## 5. Bulk Operations

There is no batch endpoint — loop over issue numbers client-side.

**gh:**

```bash
# Close every issue carrying the "wontfix" label as not-planned.
gh issue list --label "wontfix" --state open --json number --jq '.[].number' \
  | xargs -I {} gh issue close {} --reason "not planned"
```

**curl:**

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues?labels=wontfix&state=open&per_page=100" \
  | jq -r '.[] | select(.pull_request|not) | .number' \
  | while read -r n; do
      curl -s -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
        "https://api.github.com/repos/$OWNER/$REPO/issues/$n" \
        -d '{"state":"closed","state_reason":"not_planned"}' >/dev/null
      echo "closed #$n"
    done
```

## Quick Reference

| Action       | gh                                   | curl endpoint                                  |
|--------------|--------------------------------------|------------------------------------------------|
| List         | `gh issue list`                      | `GET /repos/{o}/{r}/issues`                    |
| View         | `gh issue view N`                    | `GET /repos/{o}/{r}/issues/N`                  |
| Search       | `gh issue list --search "…"`         | `GET /search/issues?q=…+repo:{o}/{r}`          |
| Create       | `gh issue create …`                  | `POST /repos/{o}/{r}/issues`                   |
| Add labels   | `gh issue edit N --add-label …`      | `POST /repos/{o}/{r}/issues/N/labels`          |
| Assign       | `gh issue edit N --add-assignee …`   | `POST /repos/{o}/{r}/issues/N/assignees`       |
| Comment      | `gh issue comment N --body …`        | `POST /repos/{o}/{r}/issues/N/comments`        |
| Close        | `gh issue close N --reason …`        | `PATCH /repos/{o}/{r}/issues/N`                |
| Reopen       | `gh issue reopen N`                  | `PATCH /repos/{o}/{r}/issues/N`                |

## Limitations

- The REST `/issues` collection also returns pull requests; filter with
  `select(.pull_request|not)` (curl) — `gh issue` already excludes them.
- Search is eventually consistent: a just-created issue may not appear in
  `/search/issues` for a few seconds. List endpoints reflect it immediately.
- No batch mutation endpoint — bulk changes loop one issue at a time and
  are subject to the REST secondary rate limit.

## Rules

1. Prefer `gh` when it is authenticated; only drop to curl when `gh`
   cannot be installed or authenticated. If `gh` is missing, install it
   yourself (Setup step 1) — don't ask the user to. Only the interactive
   `gh auth login` (Setup step 2) goes to the user; don't try to drive
   that sign-in headlessly.
2. Confirm intent before any bulk close/relabel or any single destructive
   change — these are side-effecting and have no undo.
3. Never put a token on a command line or in an issue/comment body; let
   `gh` use its stored credential, or pass `GITHUB_TOKEN` via the
   environment for curl.
4. Use closing keywords (`Closes #N`) in PR bodies rather than manually
   closing an issue that a merge will resolve.
5. Quote issue numbers verbatim in replies (`#128`) so GitHub deeplinks
   resolve them.
