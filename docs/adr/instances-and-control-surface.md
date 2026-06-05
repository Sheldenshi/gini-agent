# ADR: Instances And Control Surface

## Decision

Gini is instance-aware. There are two flavors:

- **Production end-users** run the installed `gini` CLI (from `curl|bash`). The wrapper at `~/.local/bin/gini` always sets `GINI_INSTANCE=default`, pinning end-users to a single `default` instance with stable, memorable ports (web `7777`, runtime `7778`).
- **Developers** run `bun run gini ...` from a repo checkout. The instance is auto-derived from the repo root directory basename (e.g. `gini-agent`, or whatever a worktree is named), so each worktree gets isolated state without typing `--instance`. Ports for these instances are deterministic per-name hashes within a 100-port window, so parallel worktrees coexist without manual port wrangling.

`--instance <name>` or `GINI_INSTANCE` overrides either default. The CLI, runtime API, web control plane, traces, logs, state, config, workspace, and memory database all use the selected instance.

## Context

The `default` instance exists for end-users; everything else exists for developers. Most users will only ever see `default` and never think about the concept. Developers running coding agents in parallel Conductor worktrees need isolation by default — sharing a single `dev` instance across worktrees silently mixed state and was a frequent footgun.

Pinning `default` to fixed memorable ports lets `gini start` produce a stable URL (`http://127.0.0.1:7777`) that users can bookmark, share in docs, and recognize. Pinning is wrong for developer worktrees because two worktrees on the same machine would collide; hashing the worktree name keeps them independent.

## Required Now

- State paths are `~/.gini/instances/<instance>/...`.
- Logs live under the selected instance directory.
- `GINI_STATE_ROOT` and `GINI_LOG_ROOT` can override paths for disposable tests.
- `smoke` uses an ephemeral instance/root/port by default when no instance is supplied.
- `status` and `doctor` report instance identity.
- `reset` and `uninstall --instance <name>` affect only the selected instance; `uninstall` (no flag) performs a full uninstall with prompts that can also clear every instance.
- Runtime API and web UI expose the instance.
- The `default` instance gets pinned ports (web `7777`, runtime `7778`).
- All other instances get deterministic hash-derived ports within a 100-port window.

## Implemented Since

- **Per-instance LaunchAgents (macOS).** Each instance now writes three
  user-domain LaunchAgents under `~/Library/LaunchAgents/`:
  `ai.lilaclabs.gini.<instance>.gateway` (Bun runtime, runs
  `src/server.ts` directly), `ai.lilaclabs.gini.<instance>.web`
  (Next.js dev server, gated on the gateway becoming healthy via a
  shell shim), and `ai.lilaclabs.gini.<instance>.watchdog` (a periodic
  health probe). The gateway and web are supervised with `KeepAlive`
  set to `true` (launchd always respawns on *any* exit, including a
  clean `exit 0` from an auto-update self-restart), so `gini stop`
  unloads them via `launchctl bootout` rather than relying on a clean
  exit. The watchdog covers the gaps KeepAlive can't — a
  wedged-but-alive process, a launchd-deferred respawn, and a deregistered
  core service it re-bootstraps via `autostart enable`. Provider
  secrets from `~/.gini/secrets.env` are merged into the gateway plist's
  `EnvironmentVariables` only — the web BFF never invokes a provider
  directly, so it gets none. Subcommands `gini autostart
  enable|disable|status|kick` manage the set; uninstall tears them
  down and reports any launchctl failures. See
  [Always-Up Supervision](always-up-supervision.md),
  `src/cli/autostart.ts`, and `src/cli/commands/autostart.ts`.

## Deferred

- Linux `systemd --user` parity for autostart (macOS-only in v1).
- Fully automated production/sandbox promotion and rollback.
- Remote multi-device relay and push paths.

## Consequences For Coding Agents

- New runtime-owned files should live under instance-specific roots unless they are deliberate workspace artifacts approved by the user.
- Tests and smoke flows should use non-`default` instances (they get their own ephemeral or named instance).
- Do not run concurrent install/reset work against the same instance unless the test is intentionally checking shared-instance behavior.
- Status output should make instance confusion visible.

## Acceptance Checks

- `bun run gini --instance sandbox reset` does not affect the auto-derived worktree instance.
- Multiple `bun run gini smoke` invocations can run concurrently because they create separate smoke instances by default.
- `bun run gini --instance sandbox doctor` reports `sandbox`.
- `bun run gini status` from a worktree directory reports the worktree basename as the instance.
- `gini status` from the installed wrapper reports instance `default` on ports 7777/7778.
- Web and API for a running instance show the same instance identity.
