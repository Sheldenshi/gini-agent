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
  dependencies, and schedules a restart when the checked-out commit
  changed.

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
- The scheduled restart is supervisor-aware. On a launchd-supervised
  instance the runtime self-SIGTERMs (drains, exits 0) and `KeepAlive`
  respawns it with the freshly checked-out code — no detached stop+start
  helper that would reparent and orphan the respawn outside supervision —
  plus a detached `gini autostart kick --kind web` re-execs the web service
  for any new `web/` dependencies. Foreground / `gini run` instances keep
  the detached stop+start helper because there is no KeepAlive to respawn
  them. The always-respawn KeepAlive model, the watchdog, and the
  bootout-as-stop contract live in
  [Always-Up Supervision](always-up-supervision.md); this ADR cross-links
  rather than duplicating them.
- Update remains scoped to the installer-managed runtime. Repo worktrees
  should still use normal git workflows.

## Acceptance Checks

- The sidebar shows a package/git version and an Update button.
- Clicking Update calls `POST /api/update`; when commits changed, the
  current runtime is restarted without asking for manual stop/start.
- `gini update` no longer prints a manual restart instruction.
- Existing guardrails still reject missing runtimes and unexpected git
  origins.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` pass.
