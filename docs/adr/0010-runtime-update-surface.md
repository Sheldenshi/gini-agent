# ADR 0010: Runtime update surface and automatic restart

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

The web control plane surfaces the version in the sidebar and lets the
operator trigger the update from the browser. The browser still never
receives the gateway bearer token; the Next.js BFF forwards the request
to the gateway like other `/api/runtime/*` calls.

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
- Browser-triggered updates schedule a post-response restart helper so the
  HTTP response can flush before the current gateway exits.
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
