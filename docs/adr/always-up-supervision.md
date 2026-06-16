# ADR: Always-up supervision for launchd-managed instances

## Decision

A launchd-managed Gini instance is supervised to stay up across crashes,
clean exits, and self-restarts. Three per-instance LaunchAgents under
`~/Library/LaunchAgents/` enforce this:

- `ai.lilaclabs.gini.<instance>.gateway` — the Bun runtime (`src/server.ts`).
- `ai.lilaclabs.gini.<instance>.web` — the Next.js server (the BFF). The
  plist's shim execs `next start` from the sha-keyed production bundle when
  one matches the current checkout, `next dev` otherwise — see
  [Web Production Serving](web-production-serving.md).
- `ai.lilaclabs.gini.<instance>.watchdog` — a long-lived health-probe loop.

The model rests on four pieces:

- **KeepAlive is always-respawn.** The gateway and web plists set
  `KeepAlive` to a plain `<true/>` — launchd respawns the service on *any*
  exit, regardless of exit code. A clean `exit 0` (e.g. an auto-update
  self-SIGTERM) is treated as "respawn with the fresh code", not "the
  operator is done". `ThrottleInterval` (10s) bounds how aggressively a
  crash loop respawns so a tight loop can't melt CPU.

- **`launchctl bootout` is the intentional-stop mechanism.** Because
  KeepAlive always respawns, a plain SIGTERM to the gateway PID would just
  be resurrected. So `gini stop` on a launchd instance runs `launchctl
  bootout` to *unload* the gateway, web, and watchdog services — that is
  the only thing that keeps a supervised instance down. Foreground /
  `gini run` / conductor / tmux instances do not use launchd KeepAlive and
  keep their existing PID-kill stop.

- **`gini start` is launchd-aware, symmetric to `gini stop`.** Both route on
  the same TARGET-instance launchd state — any service loaded OR any plist on
  disk means launchd owns the instance — rather than on the calling process's
  env (a terminal `gini start` has no `GINI_SUPERVISOR`). On a launchd-managed
  instance, `gini start` (and the CLI update path's restart) ensures the
  services *via launchd*: it kickstarts a loaded-but-down kind and bootstraps a
  not-loaded one (`autostart enable`), gateway before web (the web plist shim
  waits on the gateway), then waits for both to report healthy. When everything
  is already healthy — the common case where launchd started the instance at
  login — it is a zero-churn no-op (no bootout/kickstart/enable). It never
  spawns a competing detached daemon. Spawning one created *dual supervision*:
  the launchd web already held the canonical port, so the daemon's web couldn't
  bind it and `availablePort` silently walked it to an offset port, splitting
  the UI onto a port nothing points at — which made an update restart appear to
  hang. Foreground / `gini run` / conductor / tmux instances (no plists, no
  loaded services) are not launchd-managed and keep the existing detached-daemon
  start byte-for-byte.

- **Supervisor detection via a baked-in plist env var.** Each plist's
  `EnvironmentVariables` carries `GINI_SUPERVISOR=launchd`. At runtime
  `supervisor()` (`src/integrations/launchd.ts`) reads that env var and
  returns `"launchd"` only when the marker is present. Foreground paths
  never set it and get `null`. Every launchd-native branch (bootout as
  stop, KeepAlive respawn after self-SIGTERM, the restart-time crash-report
  ask) gates on this value, so the same code runs both supervised and
  foreground without the foreground path ever triggering launchd-only
  behavior.

- **A dedicated watchdog service.** The third LaunchAgent is a *long-lived
  probe loop* — `KeepAlive` + `ThrottleInterval` like the gateway/web, with
  the probe cadence (`WATCHDOG_TICK_INTERVAL_MS`, 10s) driven by an
  in-process timer in `gini watchdog` rather than by launchd respawns
  (`gini watchdog --once` runs a single tick for manual use). It was
  previously a `StartInterval` (30s) one-shot, but that made the safety net
  subject to the exact failure it guards: launchd's spawn deferral on
  macOS 26 defers `StartInterval` spawns just as it defers KeepAlive
  respawns, so during a gateway respawn-deferral window the watchdog's own
  ticks gapped (50-99s observed against the 30s interval) and a
  dead gateway stayed down for the same stretch. A long-lived loop asks
  launchd for one spawn at login; the steady-state cadence is immune to
  spawn deferral. Each tick health-checks
  the gateway (`/api/status`, where any HTTP response — including a 401 —
  proves the process is answering) and the web child
  (`/api/runtime/__healthz`, verified to be *our* `gini-web` on the
  matching instance), and revives whichever has been down for **two
  consecutive ticks** (the loop keeps a per-service failure streak, reset
  by any healthy probe AND after each revive — so a sustained outage
  re-kicks every two ticks, giving the kicked service a boot window,
  instead of re-killing it every tick; `--once` revives on its single
  tick). One failed
  probe is not proof of death: the 2s probe timeout false-negatives a
  healthy service on a CPU-pegged host (observed live during a post-update
  rebuild), and a revive is a `kickstart -k` — a force-kill with no drain —
  so acting on the first miss kills the very service the watchdog protects.
  While a runtime update is rewriting `~/.gini/runtime` (a fresh
  `~/.gini/update-in-progress` marker, written by `updateRuntime` for the
  duration of its git reset + installs + web build — see
  [Runtime Update Surface](runtime-update-surface.md)), revive actions are
  suppressed entirely: probe misses are expected while `node_modules` are
  swapped under the live web server and the build pegs the CPU. The tick
  still probes and logs `suppressed:update:<kind>`. The marker body is JSON
  `{"pid": <updater pid>}`: a marker whose pid is dead means the updater
  crashed before removing it — the watchdog deletes it on sight and stops
  suppressing within one tick. A legacy/unparseable body falls back to
  mtime-only freshness, and a marker older than 15 minutes is stale either
  way (the backstop for a live-but-wedged updater). The revive itself: a service launchd
  still has registered is `launchctl kickstart -k`ed, while a *core*
  service launchd has **deregistered** is re-bootstrapped via `autostart
  enable` (kickstart is a no-op on a label launchd no longer knows, and
  KeepAlive can't respawn a service that isn't registered). This covers the
  three gaps pure KeepAlive cannot: a hung-but-alive process (KeepAlive only
  reacts to exit); a clean exit that launchd defers respawning (observed on
  macOS 26, where auto-respawn after a SIGKILL frequently pends
  indefinitely); and a deregistered service — e.g. a plist reload whose
  `bootout` succeeded but whose `bootstrap` lost the launchd I/O-error race —
  which would otherwise stay down with nothing to revive it. Re-bootstrap
  only fires under launchd supervision, so a manual foreground `gini
  watchdog` never creates plists.

Installed plists are reconciled to the current template on startup, so a
runtime version update propagates supervision-template changes to *existing*
installs, not just fresh ones. Each generated plist carries a
`GINI_PLIST_STAMP` in its `EnvironmentVariables` — a short hash over only the
stable, supervision-critical subset (kind, `Label`, `ProgramArguments`,
`WorkingDirectory`, the scheduling shape, `ProcessType`, and the
`GINI_SUPERVISOR`/`GINI_INSTANCE`/`PORT`/`GINI_DIST_DIR` env values). PATH,
secret values, `HOME`, `SHELL`, the state/log roots, and the stdout/err paths
are deliberately excluded because they vary legitimately between machines and
between the shell-merge/no-merge paths — hashing them would cause a
false-positive reconcile loop. At gateway startup
`reconcileAutostartPlistOnStartup` (`src/runtime/autostart-reconcile.ts`)
compares the stamp the current code would generate against the stamp baked into
each on-disk plist (gateway/web/watchdog). When everything matches it is a
silent no-op; it is also skipped entirely when no managed gateway plist exists
(foreground / `gini run` / conductor). On drift it schedules a detached `gini
autostart enable` — which regenerates the plist files AND reloads them
(bootout+bootstrap) — whose `bootout` terminates this gateway and re-bootstraps
it from the regenerated plist. It never self-SIGTERMs or exits — under
always-respawn KeepAlive a clean exit would be respawned and race the detached
enable, so letting the child's bootout do the killing avoids that race. The
reload is **deferred by a stabilization delay** (`RECONCILE_RELOAD_DELAY_MS`)
rather than dispatched the instant drift is seen, because a startup reconcile
most often runs right after a self-update respawned this gateway while a client
(the web UpdateReminder) polls `/api/status` for the new SHA. Dispatching
immediately would bootout the gateway mid-poll — the client would surface a
"hasn't reported back" prompt — and a bootout+bootstrap against a service
launchd only just respawned can fail with an I/O error and deregister it. The
delay comfortably exceeds the client's poll window, so the gateway stays
reachable to report the new SHA and launchd settles, then the reload runs as a
single race-free operation. The deferral timer is in-process and unref'd: if the
gateway is replaced before it fires, the timer dies with the process and the
next gateway start re-schedules, so the reload only fires once the gateway has
been stable for the full delay. The
reconcile deliberately does NOT pre-write the on-disk plist: writing disk alone
does not reload launchd (it keeps the def it loaded until a bootout+bootstrap),
and stamping the file before that reload actually happened would mask drift — a
matching stamp on the next boot — even if the relaunch had failed. Leaving the
file untouched keeps a failed relaunch's stamp mismatched, so the reconcile
re-fires on the next gateway (re)start until the reload truly succeeds. The
deterministic stamp guarantees convergence (after a successful reconcile the
on-disk plist equals what the code generates, so the next boot no-ops), and a
once-per-process latch backs that up.

The reload itself never double-binds the port. `enable` awaits
`waitForPortFree` (`src/cli/process.ts`) on a port-binding kind's port after a
successful `bootout` and before the `bootstrap` retry — closing the window
where `launchctl bootout` returns (the unload was *accepted*) but the old
process hasn't yet released its socket. This makes every reload caller safe,
including the detached reconcile/refresh relaunch racing KeepAlive's own
respawn. The watchdog binds nothing, so it skips the wait.

Auto-update no longer orphans the runtime. For a launchd instance,
`scheduleRuntimeRestart` (`src/runtime/update.ts`) self-SIGTERMs after the
update has already run `git reset --hard` + `bun install` synchronously;
the server's SIGTERM handler drains and exits 0, and KeepAlive respawns
the gateway with the freshly checked-out code. The drain is bounded so the
restart's downtime window stays short: in-flight responses get a brief grace
(`SERVER_DRAIN_GRACE_MS`) to finish writing, then the server force-closes —
idle keep-alive connections would otherwise never let the graceful
`server.stop(false)` resolve — and every background loop interrupts its
inter-tick sleep on shutdown instead of sleeping out its full interval (up to
60s for the connector re-probe). A detached
`gini autostart kick --kind web` re-execs the web service so any new `web/`
dependencies take effect. Foreground keeps the existing detached
stop+start helper because there is no KeepAlive to respawn it. See
[Runtime Update Surface And Automatic Restart](runtime-update-surface.md)
for the update API surface this restart path serves.

## Context

The supervision model previously had three gaps that let an instance
silently stay down:

1. **KeepAlive ignored clean exits.** The plist used
   `KeepAlive { SuccessfulExit: false }`, so a service that exited 0 was
   never respawned. A web child that exited cleanly (or a gateway that
   drained and exited 0 during an update) stayed dead until the next
   login.

2. **Auto-update reparented the runtime out of supervision.** The update
   restart spawned a *detached* helper that ran `gini stop` + `gini start`.
   The respawned runtime was an unref'd child that reparented to launchd
   (PID 1), so it was no longer the launchd job's tracked process — it ran
   outside KeepAlive entirely. A subsequent crash was never respawned.

3. **No coverage for hung-but-alive or launchd-deferred respawns.** Pure
   KeepAlive only reacts to process *exit*. A wedged process that holds
   the port but never answers, or a clean exit that launchd declines to
   respawn promptly, had nothing watching it.

The fix is to make KeepAlive always-respawn (so clean exits are recovered
and the update path can simply self-SIGTERM rather than orphan a detached
respawn), make bootout the deliberate stop (so the now-aggressive
KeepAlive can't fight `gini stop`), and add a watchdog to cover the
exit-blind gaps. The supervisor env marker keeps all of this scoped to
launchd instances so foreground/conductor/tmux runs are unaffected.

## Consequences

- A launchd-supervised instance stays up across crashes, clean exits, and
  auto-update self-restarts without manual intervention.
- **`launchctl bootout` is the only way to keep a launchd instance
  stopped.** A plain SIGTERM (or a clean exit) is always resurrected by
  KeepAlive — `gini stop` must boot the services out. This is the central
  trade-off of always-respawn: the instance is durably up, so stopping it
  is necessarily an explicit unload rather than "just let it exit".
- The runtime stays under launchd supervision across an auto-update: the
  gateway is never reparented to PID 1, so a crash after an update is still
  respawned.
- The watchdog adds one more launchd job per instance — a single resident
  process probing localhost every 10s. The probe is read-only and
  idempotent — a `kickstart -k` against an already-running healthy job is a
  no-op, so the watchdog overlapping with KeepAlive's own respawn is benign.
  A dead gateway is revived within roughly two ticks plus two 2s probe
  timeouts (~14-24s, depending on where in the interval it died) — the
  two-strike rule trades a one-tick-slower revive of a genuinely dead
  service, still inside the 30s detection target, for never force-killing a
  healthy-but-busy one on a single timed-out probe — even
  while launchd is deferring its own respawns.
- Foreground / `gini run` / conductor / tmux instances keep their existing
  behavior end to end: no KeepAlive, PID-kill stop, and the detached
  stop+start update helper. The `GINI_SUPERVISOR` marker is the single
  switch that keeps the two worlds apart.
- A crash-looping service is bounded by `ThrottleInterval` (10s) rather
  than respawning as fast as it dies. A crash also leaves a redacted report
  in a local queue, which the user is asked to file as a GitHub issue on the
  next restart of the `default` instance;
  see [Crash Reporting And Issue Filing](crash-reporting-and-issue-filing.md).

## Acceptance Checks

- All three generated plists (gateway, web, watchdog) contain `KeepAlive` as
  `<true/>` plus a `ThrottleInterval` and *no* `StartInterval`; the watchdog's
  probe cadence lives in its own loop, and the stamp-driven startup reconcile
  migrates an installed `StartInterval`-shaped watchdog plist to the
  long-lived shape on the next gateway boot.
- Both the gateway and web plist `EnvironmentVariables` carry
  `GINI_SUPERVISOR=launchd`; foreground / `gini run` env never sets it, and
  `supervisor()` returns `null` there.
- `gini stop` on a launchd instance boots out the gateway, web, and
  watchdog targets (a target that isn't loaded counts as a successful
  stop); on a foreground instance it SIGTERMs the PID and does not call
  bootout.
- `gini start` on a launchd-managed instance (a service loaded or a plist on
  disk) ensures the services via launchd and never spawns a detached daemon:
  already-healthy is a no-op with zero kickstart/enable/bootout calls; a
  loaded-but-down kind is kickstarted; a not-loaded kind is bootstrapped via
  `autostart enable`; and a web that never comes healthy within the deadline
  yields a `webError` banner rather than throwing or hanging. On a
  non-launchd instance, start takes the existing detached-daemon path
  unchanged.
- An auto-update on a launchd instance self-SIGTERMs and is respawned by
  KeepAlive with the new code, and dispatches detached
  `gini autostart kick` children for web AND the watchdog — the long-lived
  watchdog loop never exits on its own and a code-only update leaves its
  plist stamp unchanged, so the explicit kick is the only thing that
  replaces its process with the new code. On a foreground instance the
  update uses the detached stop+start helper.
- A `gini watchdog` tick against a healthy instance takes no action; with
  the gateway down for two consecutive ticks it `kickstart -k`s the
  gateway; with web down for two consecutive ticks it `kickstart -k`s web
  (and queues a web crash report for consent-gated filing — see the crash
  ADR). A single failed tick takes no action; a healthy probe resets the
  service's failure streak, and so does each revive (a still-down service
  is re-kicked every two ticks, never on consecutive ticks). With a fresh
  update-in-progress marker on
  disk it takes no revive action regardless of streaks (logging
  `suppressed:update:<kind>` instead); a stale marker (recorded updater pid
  dead, or >15 min old) does not
  suppress. The loop paces itself at
  `WATCHDOG_TICK_INTERVAL_MS` between ticks and never exits on its own;
  `gini watchdog --once` runs exactly one tick and revives on it.
- Every generated plist's `EnvironmentVariables` carries a `GINI_PLIST_STAMP`.
  The stamp is identical for two plists that differ only in PATH, a secret
  value, `HOME`, `SHELL`, the state/log roots, or the stdout/err paths, and it
  changes when a supervision-critical field changes (the `GINI_SUPERVISOR`
  marker, a `ProgramArgument`, the `WorkingDirectory`, or the KeepAlive-vs-
  periodic scheduling shape).
- On startup, an instance with a managed gateway plist whose stamps all match
  the current template takes no reconcile action; an instance with a missing or
  mismatched stamp dispatches a detached `gini autostart enable` exactly once
  per process and leaves the on-disk plist untouched (that enable regenerates +
  reloads it, so a failed relaunch keeps the drift detectable for the next
  start); an instance with no managed gateway plist is skipped entirely.
- `gini autostart enable` awaits the port becoming free after a `bootout` of
  the gateway/web before re-bootstrapping, so a reload (including the
  detached reconcile/refresh relaunch) never hits EADDRINUSE; the watchdog
  reload performs no port-free wait.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass.
