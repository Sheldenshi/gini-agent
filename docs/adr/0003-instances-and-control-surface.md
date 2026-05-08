# ADR 0003: Instances And Control Surface

## Decision

v0 is instance-aware from the first implementation. The default instance is `dev`, and `--instance <name>` or `GINI_INSTANCE` selects another instance. The CLI, runtime API, web control surface, traces, logs, state, and config all use the selected instance.

## Context

The master plan requires future dev/sandbox/production separation. v0 does not need full promotion and rollback, but it must avoid hardcoding a single global Gini install.

## Required Now

- State paths are `~/.gini/instances/<instance>/...`.
- Log paths are `~/.gini/logs/<instance>/...`.
- `GINI_STATE_ROOT` and `GINI_LOG_ROOT` can override paths for disposable tests.
- `smoke` uses an ephemeral instance/root/port by default when no instance is supplied.
- `status` and `doctor` report instance identity.
- `reset` removes only the selected instance state.
- Runtime API and web UI expose the instance.

## Deferred

- Separate sockets and LaunchAgents per instance.
- Promotion artifacts and rollback workflows.
- Evidence bundle export.

## Consequences For Coding Agents

- New files written by the runtime should live under instance-specific roots unless they are deliberate workspace artifacts approved by the user.
- Tests and smoke flows should use non-production instances.
- Do not run concurrent install/reset/smoke work against the same instance unless the test is intentionally checking shared-instance behavior.
- Status output should make instance confusion visible.

## Acceptance Checks

- `bun run gini --instance sandbox reset` does not affect the `dev` instance.
- Multiple `bun run gini smoke` invocations can run concurrently because they create separate smoke instances by default.
- `bun run gini --instance sandbox doctor` reports `sandbox`.
- Web and API for a running instance show the same instance identity.
