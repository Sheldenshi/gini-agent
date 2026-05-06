# ADR 0003: Lanes And Control Surface

## Decision

v0 is lane-aware from the first implementation. The default lane is `dev`, and `--lane <name>` or `GINI_LANE` selects another lane. The CLI, runtime API, web control surface, traces, logs, state, and config all use the selected lane.

## Context

The master plan requires future dev/sandbox/production separation. v0 does not need full promotion and rollback, but it must avoid hardcoding a single global Gini install.

## Required Now

- State paths are `~/Library/Application Support/Gini/<lane>/...`.
- Log paths are `~/Library/Logs/Gini/<lane>/...`.
- `GINI_STATE_ROOT` and `GINI_LOG_ROOT` can override paths for disposable tests.
- `smoke` uses an ephemeral lane/root/port by default when no lane is supplied.
- `status` and `doctor` report lane identity.
- `reset` removes only the selected lane state.
- Runtime API and web UI expose the lane.

## Deferred

- Separate sockets and LaunchAgents per lane.
- Promotion artifacts and rollback workflows.
- Evidence bundle export.

## Consequences For Coding Agents

- New files written by the runtime should live under lane-specific roots unless they are deliberate workspace artifacts approved by the user.
- Tests and smoke flows should use non-production lanes.
- Do not run concurrent install/reset/smoke work against the same lane unless the test is intentionally checking shared-lane behavior.
- Status output should make lane confusion visible.

## Acceptance Checks

- `bun run gini --lane sandbox reset` does not affect the `dev` lane.
- Multiple `bun run gini smoke` invocations can run concurrently because they create separate smoke lanes by default.
- `bun run gini --lane sandbox doctor` reports `sandbox`.
- Web and API for a running lane show the same lane identity.
