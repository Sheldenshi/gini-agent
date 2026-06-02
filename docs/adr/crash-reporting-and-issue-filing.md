# ADR: Crash reporting and issue filing

## Decision

A launchd-supervised `default` Gini instance captures unhandled crashes to a
local queue, **redacts them at capture**, and **never files anything
autonomously**. On the next gateway restart — and only for the `default`
instance — if the queue holds crashes the user hasn't been asked about, Gini
posts a single normal chat message asking whether to file them as GitHub
issues. Filing happens only on the user's explicit "yes", and runs through the
`gini-bug-report` skill, which delegates the actual `gh` work to the
`github-issues` skill. Nothing leaves the machine without consent.

Crash reports can contain provider API keys, bearer tokens, and user/task
content. Because a GitHub issue *publishes* that content,
redaction before the report is even offered to the agent or the user is a hard
trust boundary, not a nicety.

### Capture

Two producers write redacted reports into a local queue; neither files
anything:

- **Runtime crashes.** The gateway installs process-level `uncaughtException`
  and `unhandledRejection` handlers (`src/runtime/crash-handlers.ts`, wired in
  `src/server.ts`). On a crash the *dying* process, in order: appends a
  structured `runtime.<event>` line to `runtime.jsonl` (so the crash is in the
  log stream even if the next step fails); builds a structured, redacted report
  — error name/message/stack, system context, and a bounded tail of
  `runtime.jsonl` — and writes it **synchronously** to
  `<stateRoot>/crash-reports/pending/`; then always `exit(1)` in a `finally`
  (so a failure in the report write still exits) — KeepAlive respawns the
  gateway. See [Always-Up Supervision](always-up-supervision.md).

- **Web crashes (via the watchdog).** The web (Next.js) child has no
  in-process crash handler; patching Next.js internals to install one was
  rejected as invasive and fragile. Instead the watchdog (`gini watchdog`, see
  [Always-Up Supervision](always-up-supervision.md)) detects a dead-or-hung web
  child by its health probe and, for a *genuine* web failure only — the web
  port was recorded, the probe failed, **and** the runtime is healthy — builds
  a `source: "web"` report from the web log tails (synthesizing an `Error` so a
  web outage with no JS exception still fingerprints and dedupes), writes it
  into the same `pending/` queue, then kickstarts the web service. A missing
  port (boot race) or a web failure while the runtime is also down (the BFF
  can't reach a dead gateway) is not a web crash, so no report is written for
  it.

Both producers are write-only: they capture, queue, and move on. The decision
to publish lives entirely in the consent flow below.

### Trust boundary: redaction happens at capture

The report is **already redacted before it is written to the queue** — before
it can be read by the agent or shown to the user. `buildCrashReport`
(`src/runtime/crash-report.ts`) runs every text field through
`redactReportText`, which scrubs:

- the repo's existing browser secret patterns (`sk-…`, `ghp_…`,
  `github_pat_…`, etc.),
- GitHub token shapes (`gho_`/`ghu_`/`ghs_`/`ghr_…`) and `Bearer …` /
  `Authorization: …` header values (the whole header value to end-of-line, not
  just the first token),
- every literal value parsed out of `~/.gini/secrets.env`, unquoted through the
  repo's `unquoteSecretsValue` and scrubbed verbatim so a hand-edited or
  odd-format key is caught even when it doesn't match a pattern.

Independently, the `runtime.jsonl` tail carried into a report keeps only each
line's event name + timestamp; the `data` payload is **dropped at build time**
because it can contain user message and task content. Pattern redaction runs
first, so a token is removed even when its literal value isn't in the provided
lists — the design defaults to dropping rather than including.

Because redaction is complete at capture, the queued JSON *is* the trust
boundary. The `gini-bug-report` skill files an issue straight from that JSON
and is instructed never to re-fetch raw `runtime.jsonl`, secrets, or any data
outside the queue. There is no un-redacted path from the queue to GitHub.

### Consent flow: ask on restart, file through skills

On gateway boot, `maybeAskAboutCrashes` (`src/runtime/crash-recovery.ts`, called
best-effort from `src/server.ts`) decides whether to ask:

1. **Gate.** It returns immediately unless the instance is on the ask-allowlist
   **and** `supervisor()` is `"launchd"`. The allowlist defaults to the primary
   instance (`default`) and is overridable via `GINI_CRASH_ASK_INSTANCES`
   (comma-separated) so a differently-named primary — or a test instance — can
   ask. Throwaway, conductor, tmux, and foreground instances capture crashes but
   never ask.

2. **Filter + dedupe.** It reads the `pending/` queue, keeps only reports
   belonging to this instance, and collapses them to the set of distinct
   fingerprints that have **not** been asked about within the last 24h
   (`lastAskedAt` in the per-fingerprint state). If that set is empty, it
   returns.

3. **Stamp, then ask once.** It stamps `lastAskedAt` for each fresh
   fingerprint **before** creating the ask — so a crash that respawns the
   gateway mid-ask can't double-ask — then creates one immediate one-shot job
   bound to a dedicated `origin: "job"` chat session ("Crash report"). The job
   prompt instructs the agent to post a **single** friendly chat message saying
   it noticed N crash(es) (already redacted, captured locally) and asking
   whether to file them, and to take no other action this turn. The job's
   terminal task syncs the assistant message into the session, which fires the
   usual "Gini has a new message" push.

When the user replies in that thread, their answer drives a fresh agent turn in
the same session, and the agent loads the `gini-bug-report` skill to act:

- **Yes** → the skill reads the queued redacted report(s), loads the
  `github-issues` skill, and files **one** issue per distinct fingerprint to the
  canonical Gini repo (`Lilac-Labs/gini-agent`) — not whatever git remote the
  agent's sandbox workspace happens to have (`[gini-crash] <source>:
  <error.name>`, body assembled only from the queued JSON, label `gini-crash`).
  An open issue already carrying the fingerprint gets a recurrence comment
  instead of a duplicate. Filed reports move to `filed/`.
- **No** → nothing is filed; the report(s) move to `dismissed/`.
- **gh not authenticated** → `github-issues` asks the user to run
  `gh auth login` (interactive, and the user is present), then resumes. If the
  user declines to authenticate, or defers, the report is **left in
  `pending/`** so the consent flow can offer it again on a later restart.

The crash-loop guard is the combination of **per-fingerprint ask-once**
(`lastAskedAt`, 24h window) and **batching** every fresh fingerprint into a
single ask: even if KeepAlive respawns a crash-looping gateway repeatedly, the
user is asked at most once per fingerprint per day, and never more than one
message per restart. The model-turn cost is bounded by the same gate plus
ask-once — only the supervised primary instance, only when there's something new
to ask about.

## Context

When the incident that motivated this work happened, there was no crash capture
at all: no `uncaughtException`/`unhandledRejection` handlers, so a runtime crash
left no stack trace, no non-zero exit, and no report anywhere. Diagnosing
required reconstructing the timeline from launchd exit codes and log timestamps.

The operator wanted two things on a crash: enough logs to diagnose it, and a way
to surface failures as GitHub issues without manual triage. Autonomous filing
carried two risks — publishing secret/user content to a tracker, and a crash
*loop* (which the incident actually exhibited) spamming the tracker. Capture +
redaction addresses the logging need and the publishing risk; routing the
*decision* to publish through a consent message keeps a human in the loop and
makes per-fingerprint ask-once the crash-loop guard, while still surfacing every
distinct crash for one-click filing.

## Consequences

- A launchd `default` instance that crashes leaves a structured, redacted
  report in `crash-reports/pending/` and nothing else — no process is spawned
  to file it, and nothing is published.
- On the next restart of `default`, the user is asked **once per distinct
  fingerprint** (24h window) whether to file the captured crash(es), in a
  single chat message. A "yes" files one GitHub issue per fingerprint through
  the skills; a "no" dismisses; declining or deferring `gh` auth leaves the
  report pending for a later offer.
- Nothing is published without explicit consent, and `gh` authentication
  happens interactively with the user present — there is no headless `gh` path.
- No report or issue body carries a provider key, bearer secret, gh
  token, or user/task content: redaction at capture and the dropped `data`
  payload are the enforced boundary, and the skill files only from the queued
  JSON.
- Non-`default` and non-launchd instances (foreground, conductor, tmux,
  throwaway) capture crashes to their own queue but **never ask** and never
  file.
- A crash loop produces at most one ask per fingerprint per day even though
  KeepAlive respawns the process each time, because `lastAskedAt` is persisted
  to disk and stamped before the ask.
- Web outages are captured through the watchdog's ~30s tick rather than
  instantly, and a web report is a synthesized error rather than a real JS
  stack. An in-process web crash handler remains a possible follow-up.

## Acceptance Checks

- A runtime crash writes a redacted report into `crash-reports/pending/` and
  exits 1 even if the report write throws; no filer process is spawned.
- A genuine web failure (port recorded, probe failed, runtime healthy) writes a
  `source: "web"` report into `pending/`; a missing port or a web failure while
  the runtime is down writes none.
- `redactReportText` removes `sk-…`, `ghp_…`, `github_pat_…`, `gho_…`,
  `Bearer …`, an `Authorization:` header value, and a literal secrets-env
  value; the serialized `runtime.jsonl` tail carries no `data` payload — all
  before the report reaches the queue.
- On a `default` launchd restart with fresh pending reports, exactly one ask job
  is created, its prompt mentions the count and the `gini-bug-report` skill, and
  `lastAskedAt` is stamped for each fresh fingerprint; a second restart within
  the window creates no job (ask-once).
- A non-`default` instance, or a `default` instance not under launchd, creates
  no ask job; pending reports belonging to a different instance are filtered
  out.
- Nothing is published before the user replies "yes": a decline dismisses, an
  un-authed/deferred `gh` leaves the report pending, and a "yes" files one issue
  per distinct fingerprint through the `gini-bug-report` + `github-issues`
  skills.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass.
</content>
</invoke>
