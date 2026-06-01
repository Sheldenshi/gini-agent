# ADR: Always-up supervision for launchd-managed instances

## Decision

A launchd-managed Gini instance is supervised to stay up across crashes,
clean exits, and self-restarts. Three per-instance LaunchAgents under
`~/Library/LaunchAgents/` enforce this:

- `ai.lilaclabs.gini.<instance>.gateway` — the Bun runtime (`src/server.ts`).
- `ai.lilaclabs.gini.<instance>.web` — the Next.js dev server (the BFF).
- `ai.lilaclabs.gini.<instance>.watchdog` — a periodic health probe.

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

- **Supervisor detection via a baked-in plist env var.** Each plist's
  `EnvironmentVariables` carries `GINI_SUPERVISOR=launchd`. At runtime
  `supervisor()` (`src/integrations/launchd.ts`) reads that env var and
  returns `"launchd"` only when the marker is present. Foreground paths
  never set it and get `null`. Every launchd-native branch (bootout as
  stop, KeepAlive respawn after self-SIGTERM, the restart-time crash-report
  ask) gates on this value, so the same code runs both supervised and
  foreground without the foreground path ever triggering launchd-only
  behavior.

- **A dedicated watchdog service.** The third LaunchAgent is a periodic
  one-shot — `StartInterval` (~30s) + `RunAtLoad`, and *no* `KeepAlive`
  (it is a short-lived probe that always exits 0, so KeepAlive would
  respawn it in a tight loop). Each tick (`gini watchdog`) health-checks
  the gateway (`/api/status`, where any HTTP response — including a 401 —
  proves the process is answering) and the web child
  (`/api/runtime/__healthz`, verified to be *our* `gini-web` on the
  matching instance), and `launchctl kickstart -k`s whichever is dead or
  hung. This covers the two gaps pure KeepAlive cannot: a
  hung-but-alive process (KeepAlive only reacts to exit) and a clean exit
  that launchd defers respawning (observed on macOS 26, where auto-respawn
  after a SIGKILL frequently pends indefinitely).

Auto-update no longer orphans the runtime. For a launchd instance,
`scheduleRuntimeRestart` (`src/runtime/update.ts`) self-SIGTERMs after the
update has already run `git reset --hard` + `bun install` synchronously;
the server's SIGTERM handler drains and exits 0, and KeepAlive respawns
the gateway with the freshly checked-out code. A detached
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
- The watchdog adds one more launchd job per instance and a localhost
  health probe every ~30s. The probe is read-only and idempotent — a
  `kickstart -k` against an already-running healthy job is a no-op, so the
  watchdog overlapping with KeepAlive's own respawn is benign.
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

- The generated gateway/web plist contains `KeepAlive` as `<true/>` plus a
  `ThrottleInterval`; the watchdog plist contains `StartInterval` +
  `RunAtLoad` and *no* `KeepAlive`.
- Both the gateway and web plist `EnvironmentVariables` carry
  `GINI_SUPERVISOR=launchd`; foreground / `gini run` env never sets it, and
  `supervisor()` returns `null` there.
- `gini stop` on a launchd instance boots out the gateway, web, and
  watchdog targets (a target that isn't loaded counts as a successful
  stop); on a foreground instance it SIGTERMs the PID and does not call
  bootout.
- An auto-update on a launchd instance self-SIGTERMs and is respawned by
  KeepAlive with the new code, and dispatches a detached
  `gini autostart kick --kind web`; on a foreground instance it uses the
  detached stop+start helper.
- A `gini watchdog` tick against a healthy instance takes no action; with
  the gateway down it `kickstart -k`s the gateway; with web down it
  `kickstart -k`s web (and queues a web crash report for consent-gated
  filing — see the crash ADR).
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass.
