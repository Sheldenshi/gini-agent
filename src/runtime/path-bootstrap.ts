// Login-shell PATH discovery helpers.
//
// Why this exists: when `gini autostart enable` writes the launchd plist,
// the baked-in PATH (see src/cli/autostart.ts:buildLaunchAgentPath) is
// the standard macOS set plus bun's dir and `~/.local/bin`. That set
// deliberately excludes per-user installer paths like
// `~/.nvm/versions/node/<v>/bin`, `~/.asdf/shims`, `~/.volta/bin`,
// pyenv, rbenv, etc. — but most CLI tools the agent shells out to
// (codex, claude as npm globals; gh on Linux via brew; …) live under
// one of those managers. Result: the launchd-spawned gateway can't see
// the binary even though `which codex` works fine in the user's
// terminal, and every PATH-sensitive lookup (provider probes, Bash
// tool, `codex exec`, …) fails quietly.
//
// We can't fix this at runtime: Bun's `spawnSync` snapshots PATH at
// process start, so mutating `process.env.PATH` after the gateway is
// already running doesn't propagate to subprocesses. The fix has to
// land in the plist itself.
//
// This module exposes the building blocks the autostart plist writer
// uses to merge the user's interactive-shell PATH into the plist's
// EnvironmentVariables. The merge runs at `gini autostart enable`
// time. If the user later switches node versions (or installs a new
// path manager), they re-run `gini autostart enable` to refresh.
//
// Best-effort: a failing or hanging shell never blocks plist
// generation. 3s timeout, falls back to the original PATH on any
// error.

import { spawnSync } from "node:child_process";

const SHELL_PATH_TIMEOUT_MS = 3_000;

export type LoginShellReader = (shell: string) => string | null;

// Run `$SHELL -ilc 'printf "%s" "$PATH"'` synchronously and return
// stdout. Returns null on timeout, non-zero exit, or empty output.
// `-i` + `-l` together mirror what a fresh terminal window does —
// users put nvm/asdf init in either `.zshrc` (interactive) or
// `.zprofile` / `.bash_profile` (login), and we want to pick up both.
// stderr is suppressed so banner output in `.zshrc` doesn't leak into
// caller logs.
export const readLoginShellPath: LoginShellReader = (shell) => {
  const result = spawnSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
    encoding: "utf8",
    timeout: SHELL_PATH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  const trimmed = (result.stdout ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Prepend any entries in `shellPath` that aren't already in `basePath`,
// preserving the relative order of both inputs. Existing entries keep
// their position; new entries land at the front so user-controlled
// dirs (nvm, asdf, …) shadow any system equivalents that happen to
// sit on the launchd-baked PATH. Blank segments are dropped.
export interface MergeReport {
  merged: string;
  added: string[];
}

export function mergeShellPath(basePath: string, shellPath: string): MergeReport {
  const baseSegments = basePath.split(":").map((s) => s.trim()).filter(Boolean);
  const shellSegments = shellPath.split(":").map((s) => s.trim()).filter(Boolean);
  const seen = new Set(baseSegments);
  const added: string[] = [];
  for (const segment of shellSegments) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    added.push(segment);
  }
  const merged = [...added, ...baseSegments].join(":");
  return { merged, added };
}
