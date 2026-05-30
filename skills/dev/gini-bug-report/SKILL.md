---
name: gini-bug-report
description: "File a locally-captured, already-redacted Gini crash report as a GitHub issue, with the user's consent. Reads the pending crash queue and delegates the actual filing to the github-issues skill."
license: MIT
compatibility: "Runs on the default, launchd-supervised Gini instance. Needs `gh` (via the github-issues skill) to actually file. Reads the local crash queue under ${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports."
allowed-tools: "terminal_exec"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: dev
    platforms: [macos, linux]
    prerequisites:
      commands: [gh, git, jq]
---

# Gini Bug Report

File a Gini crash that was captured locally — and redacted at capture time —
as a GitHub issue, but only after the user says yes. This skill is the
consent-aware orchestration layer on top of the `github-issues` skill: it
reads the pending crash queue, summarizes it for the user, and on a "yes"
delegates the actual `gh` filing to `github-issues`. It never invents crash
data and never re-reads raw logs.

## When To Use

- The crash-report consent flow invoked you: on restart of the `default`
  instance, Gini posted a chat message asking whether to file captured
  crash(es). The user replied in that thread — act on their answer here.
- The user explicitly asks to report a captured crash ("file that crash",
  "report the crash you found").

## When NOT to Use

- General GitHub issue work (create/search/triage/label/close) → use the
  `github-issues` skill directly; this skill only files queued crashes.
- A non-crash bug report, feature request, or any issue not already sitting
  in the crash queue → use `github-issues` and write the body yourself.
- Anything that would need un-redacted data (raw `runtime.jsonl`, secrets,
  full logs) → out of scope. The queued report is the trust boundary; never
  go around it.
- Proactively scanning the queue or nagging the user → don't. Only act when
  invoked by the consent flow or an explicit request.

## The crash queue

Approved `terminal_exec` runs with the working directory set to the
workspace root — **not** this skill's directory and **not** the crash
directory. Address the queue by ABSOLUTE path. Define it once and reuse it:

```bash
QUEUE="${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports"
```

Layout:

- `$QUEUE/pending/*.json` — captured crashes awaiting a consent decision.
- `$QUEUE/filed/` — reports the user agreed to file (moved here after a
  successful `gh` filing).
- `$QUEUE/dismissed/` — reports the user declined.

Each pending file is one JSON crash report with this shape (field names are
exact):

```
{ instance, source, supervisor, fingerprint, at,
  error: { name, message, stack },
  sysInfo: { platform, arch, nodeVersion, giniCommit },
  logTail: [ { at, message }, ... ] }
```

**The report is ALREADY redacted at capture time.** Secrets, tokens, bearer
headers, and the `data` payload of every log line were stripped before the
file was written. Pass these fields through to the issue **as-is**. Do NOT
re-fetch raw logs, `runtime.jsonl`, secrets, or anything outside `$QUEUE` —
this report is published to GitHub, so the queued JSON is the only data you
are allowed to use.

## 1. List pending crashes

Read the queue and summarize each distinct crash for the user. Always quote
the file path so step 5 can resolve it later.

```bash
QUEUE="${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports"
shopt -s nullglob
pending=("$QUEUE/pending"/*.json)
if [ ${#pending[@]} -eq 0 ]; then
  echo "No pending crash reports."
else
  for f in "${pending[@]}"; do
    jq -r '"\(input_filename)
  source:      \(.source)
  error:       \(.error.name): \(.error.message)
  at:          \(.at)
  fingerprint: \(.fingerprint)
"' "$f"
  done
fi
```

If the queue is empty, tell the user there's nothing to report and stop —
do not file anything.

Multiple pending files can share one `fingerprint` (the same crash
recurring). Group by `fingerprint` — you file **one** issue per distinct
fingerprint (see step 3), not one per file.

## 2. Confirm intent

The restart consent flow already asked the user the "want me to file this?"
question, so on this turn you are acting on their reply:

- **The user said yes** (or "report it", "go ahead") → proceed to step 3.
- **The user said no** (or "don't", "skip it") → file nothing; mark the
  report(s) dismissed (step 5).

If you were invoked **manually** (the user asked directly, without the
consent message having been posted), ask first: summarize the pending
crash(es) from step 1 and ask whether to file them. Wait for the answer
before doing anything in step 3. Either way, confirm before filing.

## 3. On "yes" — file via github-issues

Do not duplicate `gh` mechanics here. Load the `github-issues` skill and
follow its `gh` path — it handles installing `gh`, the interactive
`gh auth login` degrade, idempotent label creation, and create/search:

```
read_skill name='github-issues'
```

Then, **once per distinct fingerprint**:

1. **Dedup first.** Search for an existing open crash issue with the same
   fingerprint (per `github-issues` Listing and Searching). The fingerprint
   is embedded in the body, so search for it:

   ```bash
   gh issue list --state open --label "gini-crash" \
     --search "<fingerprint> in:body" --json number,title
   ```

   If an open issue already carries this fingerprint, **comment** on it
   instead of opening a duplicate (per `github-issues` Comments) — note the
   recurrence and its `at` timestamp — then go to step 5 for the matching
   file(s). Quote the issue number verbatim (`#N`) when you tell the user.

2. **Ensure the label exists** (idempotently, per `github-issues` Labels —
   GitHub returns a generic 422 for an unknown label rather than creating
   it):

   ```bash
   gh label list --search "gini-crash" | grep -q gini-crash \
     || gh label create "gini-crash" \
         --description "Automatically captured Gini crash" --color B60205
   ```

3. **Create the issue.** Title is `[gini-crash] <source>: <error.name>`.
   Assemble the body **only** from the redacted report JSON — the summary,
   `source`, `fingerprint`, the stack, `sysInfo`, and the redacted log tail.
   Build it with `jq` straight from the queued file so nothing un-redacted
   can sneak in:

   ```bash
   QUEUE="${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports"
   f="$QUEUE/pending/<the-report>.json"

   title=$(jq -r '"[gini-crash] \(.source): \(.error.name)"' "$f")
   body=$(jq -r '
     "## Summary\n" +
     "\(.error.name): \(.error.message)\n\n" +
     "- **source:** \(.source)\n" +
     "- **instance:** \(.instance)\n" +
     "- **when:** \(.at)\n" +
     "- **fingerprint:** `\(.fingerprint)`\n\n" +
     "## Stack\n```\n\(.error.stack)\n```\n\n" +
     "## System\n" +
     "- platform: \(.sysInfo.platform) (\(.sysInfo.arch))\n" +
     "- node: \(.sysInfo.nodeVersion)\n" +
     "- gini commit: \(.sysInfo.giniCommit // "unknown")\n\n" +
     "## Recent log tail (redacted)\n```\n" +
     ((.logTail // []) | map("\(.at // "") \(.message // "")") | join("\n")) +
     "\n```\n"
   ' "$f")

   gh issue create --label "gini-crash" --title "$title" --body "$body"
   ```

   Then resolve the file(s) for this fingerprint (step 5). Quote the new
   issue number (`#N`) when you confirm to the user.

The `fingerprint` carried in the body is what makes the dedup search in
step 1 work for the next recurrence — always include it.

## 4. If gh is not authenticated

Filing needs `gh` signed in. Defer to `github-issues`' Setup for the
mechanics — it installs `gh` itself if missing, but **the sign-in is
interactive**. If `gh auth status` is not authenticated, tell the user in
one line and stop; pick up once they confirm:

> Run `gh auth login` in your terminal to sign in, then I can file the crash.

Re-run `gh auth status` to verify before continuing to step 3.

If the user **declines to authenticate**, STOP and **leave the report in
`$QUEUE/pending/`** — do NOT dismiss it. Leaving it pending lets the consent
flow offer it again on a later restart. Dismissing is only for an explicit
"no, don't report this".

## 5. Mark resolved

Resolve each report file only after its decision is final. These moves
mirror the runtime's `resolvePendingReport`; create the sibling dir first so
the move never fails.

After a successful file (or a dedup comment) for a fingerprint, move every
pending file with that fingerprint into `filed/`:

```bash
QUEUE="${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports"
mkdir -p "$QUEUE/filed"
mv "$QUEUE/pending/<the-report>.json" "$QUEUE/filed/"
```

On an explicit "no", move the report(s) into `dismissed/`:

```bash
QUEUE="${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports"
mkdir -p "$QUEUE/dismissed"
mv "$QUEUE/pending/<the-report>.json" "$QUEUE/dismissed/"
```

Never delete a pending report any other way: filed → `filed/`,
declined → `dismissed/`, and gh-not-authed / user-defers → leave it in
`pending/`.

## Rules

1. The queued report is **already redacted**. Never attach, re-derive, or
   re-fetch un-redacted data — no raw `runtime.jsonl`, no secrets, no logs
   outside `$QUEUE`. The issue body comes only from the queued JSON.
2. Always address the queue by ABSOLUTE path
   (`${GINI_STATE_ROOT:-$HOME/.gini}/crash-reports`). `terminal_exec` runs
   from the workspace root, so relative paths will miss the queue.
3. Never put a token on a command line or in an issue/comment body. Let
   `gh` use its stored credential (per `github-issues`).
4. **One issue per distinct fingerprint.** Search the existing open
   `gini-crash` issues for the fingerprint first; comment on a match rather
   than opening a duplicate.
5. **Confirm before filing.** Act on the user's consent-flow reply, or — if
   invoked manually — ask first and wait.
6. Quote issue numbers verbatim (`#N`) in replies so GitHub deeplinks
   resolve them.
