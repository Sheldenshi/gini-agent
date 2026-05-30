# ADR: Crash reporting and external GitHub issue filing

## Decision

A launchd-supervised Gini instance captures unhandled crashes to disk and
files a deduped, rate-limited GitHub issue for each distinct failure. The
issue body is published to an external service, so redaction before publish
is a hard trust boundary, not a nicety.

### Capture

The gateway installs process-level `uncaughtException` and
`unhandledRejection` handlers (`src/runtime/crash-handlers.ts`, wired in
`src/server.ts`). On a crash the *dying* process, in order:

1. appends a structured event (`runtime.<event>`) to `runtime.jsonl` so the
   crash is in the log stream even if the steps below fail,
2. builds a structured crash report — error name/message/stack, system
   context (platform, arch, node version), and a bounded tail of
   `runtime.jsonl` — and writes it **synchronously** to
   `<stateRoot>/crash-reports/<ts>-<fingerprint>.json`,
3. when under launchd, spawns a **detached, unref'd** `gini report-crash
   --report <path>` so the filing survives the process's imminent death,
4. always `exit(1)` (in a `finally`, so a failure in any earlier step still
   exits) — KeepAlive then respawns the gateway. See
   [Always-Up Supervision](always-up-supervision.md).

Filing is a separate detached process rather than inline because doing `gh`
I/O inside a dying process is unreliable, and decoupling lets the capture
path stay dumb (write + spawn + exit) while the filing path owns all
policy.

### Web crashes are detected by the watchdog, not in-process

The web (Next.js) child has no in-process crash handler. Patching Next.js
internals to install one in v1 was rejected as invasive and fragile — it
would couple Gini to Next.js's process model. Instead the watchdog
(`gini watchdog`, see [Always-Up Supervision](always-up-supervision.md))
detects a dead-or-hung web child by its health probe and, before
kickstarting it, captures the web log tails (`web-launchd.err.log`,
`web.log`), synthesizes an `Error` (so a web outage with no JS exception
still fingerprints and dedupes), writes a `source: "web"` report, and fires
the same detached `gini report-crash`. An in-process web handler remains a
possible follow-up.

### External publishing trust boundary: redaction before publish

Filing to GitHub *publishes* the report content. Crash reports can contain
provider API keys, bearer tokens, the tunnel secret, and user/task content.
So every text field that reaches an issue body is run through
`redactReportText` (`src/runtime/crash-report.ts`) first, which scrubs:

- the repo's existing browser secret patterns (`sk-…`, `ghp_…`,
  `github_pat_…`, etc.),
- GitHub token shapes (`gho_`/`ghu_`/`ghs_`/`ghr_…`) and
  `Bearer …` / `Authorization: …` header values,
- every literal value parsed out of `~/.gini/secrets.env`, scrubbed
  verbatim so a hand-edited or odd-format key is caught even when it
  doesn't match a pattern,
- the per-instance tunnel secret.

Independently, the `runtime.jsonl` tail carried into a report keeps only
each line's event name + timestamp; the `data` payload is **dropped at
build time** because it can contain user message and task content. Pattern
redaction runs first so a token is removed even when its literal value
isn't in the provided lists — the design defaults to dropping rather than
including.

### Scope, dedup, rate-limit, and auth

- **Gated to launchd/autostart instances only.** `gini report-crash` exits
  0 as a no-op unless `supervisor()` is `"launchd"`. The 40+ throwaway
  conductor/test/foreground instances never file, so they can't spam the
  tracker.

- **Dedup by fingerprint.** The fingerprint is a sha256 over the normalized
  `name: message` plus the top-5 normalized stack frames; normalization
  strips absolute paths to basenames, line/column numbers, hex addresses,
  PIDs, UUIDs, and timestamps, so two instances of the same crash collapse
  to one hash. Each issue body carries a hidden marker
  (`<!-- gini-crash-fingerprint: <hash> -->`) and the `gini-crash` label.
  A recurrence searches open `gini-crash` issues for the marker; a match
  reuses that issue, a miss opens a new one.

- **Rate-limited recurrences.** Recurrences become comments on the existing
  open issue, at least 1h apart, with a hard cap of 20 comments per
  fingerprint after which recurrences are silently dropped. The
  per-fingerprint rate-limit state (`<fingerprint>.state.json` under the
  crash-reports dir) is persisted to disk so it survives the respawns a
  crash loop produces.

- **Auth via the `gh` CLI only.** Filing shells out to `gh` (the operator's
  existing authenticated CLI, repo scope). If `gh` is unauthenticated or
  unreachable, `report-crash` leaves a local breadcrumb in `runtime.jsonl`
  and exits 0 — it never blocks a respawn or a watchdog tick.

## Context

When the incident that motivated this work happened, there was no crash
capture at all: no `uncaughtException`/`unhandledRejection` handlers, so a
runtime crash left no stack trace, no non-zero exit, and no report
anywhere. Diagnosing required reconstructing the timeline from launchd exit
codes and log timestamps.

The operator wanted two things on a crash: enough logs to diagnose it, and
an automatically filed GitHub issue so failures surface without manual
triage. The risk in auto-filing is twofold — publishing secret/user content
to a public tracker, and a crash *loop* (which the incident actually
exhibited) spamming the tracker with duplicate issues. The redaction
boundary addresses the first; fingerprint dedup + rate-limiting + the
launchd-only gate address the second.

## Consequences

- A launchd instance that crashes leaves a structured, redacted report on
  disk and (when `gh` is authed) one open GitHub issue per distinct
  failure, with recurrences as rate-limited comments.
- No crash report or issue body carries a provider key, bearer/tunnel
  secret, gh token, or user/task content — the redaction pass and the
  dropped `data` payload are the enforced boundary.
- Foreground, conductor, tmux, and throwaway instances never file. A crash
  on one of those is captured to its own log stream but produces no GitHub
  issue.
- A crash loop produces at most one issue plus a bounded number of
  rate-limited comments per fingerprint, even though KeepAlive respawns the
  process each time — the rate-limit state survives respawns because it's
  on disk.
- Web outages are reported through the watchdog's ~30s tick rather than
  instantly, and a web report is a synthesized error rather than a real JS
  stack. An in-process web crash handler is a possible follow-up.
- Filing depends on a working, authenticated `gh`. An unauthed or offline
  `gh` degrades to a local log breadcrumb; it never wedges a respawn.

## Acceptance Checks

- The fingerprint is stable across PID/line/timestamp/path noise for the
  same error and differs for a different message or call site.
- `redactReportText` removes `sk-…`, `ghp_…`, `github_pat_…`, `gho_…`,
  `Bearer …`, a literal secrets-env value, and the tunnel secret; the
  serialized `runtime.jsonl` tail carries no `data` payload.
- With no matching open issue, `report-crash` creates one carrying the
  hidden marker and the `gini-crash` label; with one open, it comments
  (when within the rate-limit budget); rate-limited or capped recurrences
  do neither.
- When `supervisor()` is not `"launchd"`, `report-crash` never calls `gh`
  and exits 0; when `gh` is unauthed, it exits 0 with a local breadcrumb.
- A crash emitted to the runtime handlers writes a report, spawns a
  detached `gini report-crash`, and exits 1 even if the report write
  throws.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass.
