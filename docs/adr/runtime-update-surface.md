# ADR: Runtime update surface and automatic restart

## Decision

Expose runtime version and update operations through the authenticated
gateway API:

- `GET /api/version` returns the package version and git metadata for the
  running source tree.
- `POST /api/update/check` refreshes git metadata with `git fetch origin`
  and returns the same version shape.
- `POST /api/update` runs the same source update path as `gini update`
  against the installer-managed runtime, reinstalls root and web
  dependencies, builds the sha-keyed production web bundle for the new
  HEAD (see [Web Production Serving](web-production-serving.md)), and
  schedules a restart when the checked-out commit changed. A failed web
  build aborts the update like a failed install: no restart is scheduled
  and the old servers keep running.

The update's long steps (the `git fetch`, both `bun install`s, and the web
build — 40-90s+ together) run as **awaited async spawns**, never
`spawnSync`: the handler must not block the gateway's event loop, or the
gateway stops answering `/api/status` for the whole window and the watchdog
reads a healthy-but-updating gateway as dead. Updates are **single-flight**
— a second `POST /api/update` while one is running gets a structured 409
("gini update already in progress") instead of interleaving git/install
steps. For the duration of `updateRuntime`, an **update-in-progress marker**
(`~/.gini/update-in-progress`, machine-global because the installed runtime
is shared) tells the watchdog to suppress revive actions. Its body records
the updater's pid (`{"pid": <pid>}`) so a marker left behind by a dead
updater reads as stale immediately; the marker is removed when the update
settles and goes stale after 15 minutes regardless (see
[Always-Up Supervision](always-up-supervision.md)).

The CLI `gini update` keeps the same installer-managed target
(`~/.gini/runtime`) but no longer asks the operator to run
`gini stop && gini start`. If the selected instance is running and the
update changed code, the CLI restarts it directly.

When it is running from the installer-managed runtime, the web control
plane surfaces the version in the sidebar and lets the operator trigger
the update from the browser. Repo/worktree runs show version metadata
but do not mutate `~/.gini/runtime`; those still use normal git
workflows. The browser still never receives the gateway bearer token;
the Next.js BFF forwards same-origin requests to the gateway like other
`/api/runtime/*` calls and rejects cross-origin update POSTs.

## Context

Before this decision, update was CLI-only. The command pulled new source
and installed dependencies, then told the user to restart manually. That
was a poor fit for the local control plane: users could see and operate
Gini in the browser, but had to leave the browser for the one maintenance
action most likely to be needed after a release.

The update operation is local and privileged: it mutates
`~/.gini/runtime` and restarts processes. That means it belongs behind
the gateway's authenticated local API and should reuse the existing
installer-origin guardrails rather than adding a browser-only shortcut.

## Consequences

- Version metadata is part of the runtime status surface, so clients can
  display the running package/git version without deriving it themselves.
- `gini update` and the web update button share the same update helper,
  keeping origin validation, fetch/reset behavior, and dependency install
  behavior consistent.
- Web-triggered updates are only enabled when the running source tree is
  the installer-managed runtime. This prevents a repo checkout from
  accidentally mutating a different installed runtime.
- Browser-triggered updates schedule a post-response restart helper so the
  HTTP response can flush before the current gateway exits.
- The web client treats a browser-triggered update as a modal operation:
  it blurs and locks the whole app until the restarted stack is verifiably
  up, then confirms completion and reloads onto the new assets. The new
  revision alone is not completion — version metadata is read from git per
  request, so the still-running old gateway reports the new sha while the
  restart is about to take both servers down. Completion is instead gated
  on process identity: the gateway must answer `/api/status` with a new
  `pid`, and the web server must answer its local `/api/runtime/__healthz`
  with a new `ppid` — the supervising `next` CLI process, i.e. the
  server-tree identity. (The worker `pid` in that response is diagnostic
  only: the `next` CLI respawns its worker in-tree when an update touches
  `next.config.*`, so it proves nothing about a restart.) Both baselines
  are captured when the update starts; a leg whose baseline could not be
  captured falls back to a restart-freshness heuristic. Before reloading,
  the client re-probes `__healthz` once and drops back to waiting if the
  web server is not actually serving, so the reload can never land on a
  dead server. The whole gate is bounded by one shared stall deadline that
  phase transitions cannot extend; past it the blur is released with a
  notice instead of trapping the user. The deadline is **progress-aware**:
  `GET /api/version` carries `updateInProgress` (the gateway's single-flight
  update guard), the blurred client polls it every ~5s, and each `true`
  answer pushes the deadline out to at least now + 90s — so a genuinely
  long update keeps the blur up for as long as the gateway proves it is
  still working, capped by an absolute 30-minute ceiling anchored at the
  moment the gate first engaged. The gate-start timestamp is persisted
  with the in-flight state, so a restart-triggered reload resumes the
  original ceiling (and base deadline) instead of re-arming them.
  `false`, errors, and silence extend nothing, so a hung or dead gateway
  still releases on the base deadline. Because the restart only fires
  after the response flushes (above), a dropped `POST /api/update`
  connection is read as "restarting, not failed" — the blur is held and
  released only on a structured error the gateway itself produced. An HTTP
  status alone is not sufficient: the BFF answers for an unreachable
  gateway with its own status-bearing `gateway_unreachable` 503 envelope,
  which arrives exactly in the restart window, so the client treats that
  tagged shape like a transport failure and holds the blur. The
  in-flight state is persisted to `sessionStorage` so the restart-triggered
  reload resumes the blur instead of briefly exposing a half-updated app.
  The gate is **cross-tab**: the owner tab broadcasts `{type:"start"}` /
  `{type:"done"}` on `BroadcastChannel("gini-update-gate")`, and every other
  open tab engages the same blur in follower mode — no POST of its own, but
  the same baselines (captured at engage time), completion detection,
  deadline rules, and probe-then-reload, persisted to its own
  `sessionStorage` the same way. `done` releases a follower whose update
  ended without a restart; a follower already waiting on the restart
  finishes through its own detection. Platforms without `BroadcastChannel`
  degrade to the single-tab gate.
  The gate's base stall deadline is 240s — the POST now contains a full
  `next build` of the web app on top of git + the installs — and the
  restart's downtime window itself is short (~1-2s gateway drain +
  respawn): the restarted web service answers from the prebuilt bundle
  instead of JIT-compiling routes under `next dev`.
- The scheduled restart is supervisor-aware. On a launchd-supervised
  instance the runtime self-SIGTERMs (drains, exits 0) and `KeepAlive`
  respawns it with the freshly checked-out code — no detached stop+start
  helper that would reparent and orphan the respawn outside supervision —
  plus detached `gini autostart kick` children re-exec the web service (for
  any new `web/` dependencies) and the watchdog — the watchdog is a
  long-lived probe loop, so neither KeepAlive (it never exits) nor the
  plist-stamp reconcile (the template is unchanged by a code-only update)
  would otherwise replace its process with the new code. Foreground /
  `gini run` instances keep the detached stop+start helper because there
  is no KeepAlive to respawn them. The always-respawn KeepAlive model, the watchdog, and the
  bootout-as-stop contract live in
  [Always-Up Supervision](always-up-supervision.md); this ADR cross-links
  rather than duplicating them.
- Update remains scoped to the installer-managed runtime. Repo worktrees
  should still use normal git workflows.

## Acceptance Checks

- The sidebar shows a package/git version and an Update button.
- Clicking Update calls `POST /api/update`; when commits changed, the
  current runtime is restarted without asking for manual stop/start.
- A web-triggered update blurs and locks the app for the duration; the
  completion confirmation and reload come only after the restarted gateway
  (new `/api/status` pid) and the restarted web server (new `__healthz`
  ppid) have both answered, and the blur survives the restart-triggered
  reload rather than briefly exposing the app.
- `gini update` no longer prints a manual restart instruction.
- The gateway answers `/api/status` while a `POST /api/update` is running;
  a concurrent `POST /api/update` returns 409; `GET /api/version` reports
  `updateInProgress: true` exactly while an update is in flight; the
  update-in-progress marker exists exactly for the duration of
  `updateRuntime` (removed on success and on failure).
- After a non-upToDate update, `web/` contains exactly one `.next-prod-*`
  dir keyed to the new HEAD's short sha; a failed web build surfaces a
  structured error and schedules no restart.
- Existing guardrails still reject missing runtimes and unexpected git
  origins.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` pass.
