# ADR 0003: Instances And Control Surface

## Decision

Gini is instance-aware. The default instance is `dev`, and `--instance <name>` or `GINI_INSTANCE` selects another instance. The CLI, runtime API, web control plane, traces, logs, state, config, workspace, and memory database all use the selected instance.

## Context

Multiple coding agents, worktrees, smoke tests, and personal runtimes need to coexist on one machine. Gini must avoid hardcoding a single global install.

## Required Now

- State paths are `~/.gini/instances/<instance>/...`.
- Logs live under the selected instance directory.
- `GINI_STATE_ROOT` and `GINI_LOG_ROOT` can override paths for disposable tests.
- `smoke` uses an ephemeral instance/root/port by default when no instance is supplied.
- `status` and `doctor` report instance identity.
- `reset` and `uninstall` affect only the selected instance.
- Runtime API and web UI expose the instance.
- Per-instance runtime and web ports are deterministic and collision-aware.

## Deferred

- Separate LaunchAgents per instance.
- Fully automated production/sandbox promotion and rollback.
- Remote multi-device relay and push paths.

## Consequences For Coding Agents

- New runtime-owned files should live under instance-specific roots unless they are deliberate workspace artifacts approved by the user.
- Tests and smoke flows should use non-production instances.
- Do not run concurrent install/reset work against the same instance unless the test is intentionally checking shared-instance behavior.
- Status output should make instance confusion visible.

## Acceptance Checks

- `bun run gini --instance sandbox reset` does not affect the `dev` instance.
- Multiple `bun run gini smoke` invocations can run concurrently because they create separate smoke instances by default.
- `bun run gini --instance sandbox doctor` reports `sandbox`.
- Web and API for a running instance show the same instance identity.
