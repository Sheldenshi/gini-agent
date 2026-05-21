// Login-shell PATH bootstrap.
//
// Why this exists: when the gateway runs under macOS launchd (the
// `gini autostart` flow), launchd hands it the minimal PATH baked into
// the plist by `src/cli/autostart.ts:buildLaunchAgentPath` — bun's dir,
// `~/.local/bin`, and the standard `/usr/local/bin:/opt/homebrew/bin:
// /usr/bin:/bin:/usr/sbin:/sbin`. That set deliberately excludes
// per-user installer paths like `~/.nvm/versions/node/<v>/bin`,
// `~/.asdf/shims`, `~/.volta/bin`, pyenv, rbenv, etc.
//
// Users install most CLI tools through one of those managers. `codex`
// and `claude` both ship as npm globals, which on a typical Mac live
// under nvm. So out of the box the launchd-spawned gateway can't see
// the binary even though `which codex` works fine in the user's
// terminal — and every PATH-sensitive lookup the gateway does
// (provider probes, the Bash tool, `codex exec`, `gh`, ...) breaks
// quietly.
//
// The fix is to read the user's interactive-shell PATH once at gateway
// boot and merge it into `process.env.PATH`. That reproduces what
// `bun run gini run` sees when started from the terminal (the gateway
// inherits the shell's env), without committing to a specific
// version-manager path layout. Switching node versions later only
// requires restarting the gateway — the next boot re-reads the live
// shell PATH.
//
// Contract:
//   - Best-effort. Failure is logged but never throws.
//   - Synchronous (spawnSync) so subsequent imports / spawns see the
//     augmented PATH without ordering hazards.
//   - 3s timeout on the shell invocation; a broken `.zshrc` won't
//     wedge gateway startup.
//   - Pure prepend-and-dedupe: existing PATH entries are preserved at
//     their original positions, new entries from the login shell are
//     prepended. The launchd-baked bun dir therefore stays reachable,
//     and the user's nvm dir wins over any system node that happens
//     to be on the launchd PATH.
//   - Skipped under tests (NODE_ENV=test, BUN_TEST, or an explicit
//     GINI_SKIP_PATH_BOOTSTRAP=1) so unit suites don't pay the
//     per-process shell-spawn cost or pick up developer-shell quirks.

import { spawnSync } from "node:child_process";

const SHELL_PATH_TIMEOUT_MS = 3_000;

export interface PathBootstrapReport {
  applied: boolean;
  reason?: "no-shell" | "skip-env" | "shell-failed" | "shell-empty" | "no-new-entries";
  shell?: string;
  added?: string[];
  finalLength?: number;
}

export interface BootstrapOptions {
  // Test seam: inject the spawnSync result. Defaults to the real shell call.
  readLoginShellPath?: (shell: string) => string | null;
  // Test seam: override `$SHELL`. Defaults to process.env.SHELL.
  shell?: string;
  // Test seam: override skip detection. Defaults to NODE_ENV/BUN_TEST/
  // GINI_SKIP_PATH_BOOTSTRAP heuristics.
  skip?: boolean;
}

export function augmentPathFromLoginShell(options: BootstrapOptions = {}): PathBootstrapReport {
  const skip = options.skip ?? shouldSkip();
  if (skip) return { applied: false, reason: "skip-env" };

  const shell = options.shell ?? process.env.SHELL;
  if (!shell) return { applied: false, reason: "no-shell" };

  const read = options.readLoginShellPath ?? readLoginShellPath;
  let raw: string | null;
  try {
    raw = read(shell);
  } catch {
    return { applied: false, reason: "shell-failed", shell };
  }
  if (raw === null) return { applied: false, reason: "shell-failed", shell };
  const trimmed = raw.trim();
  if (!trimmed) return { applied: false, reason: "shell-empty", shell };

  const shellSegments = trimmed.split(":").map((s) => s.trim()).filter(Boolean);
  const currentSegments = (process.env.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set(currentSegments);
  const added: string[] = [];
  for (const segment of shellSegments) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    added.push(segment);
  }
  if (added.length === 0) {
    return { applied: false, reason: "no-new-entries", shell };
  }

  // Prepend so the user's nvm/asdf/volta paths win over any system node
  // that happens to sit on the launchd-baked PATH. Existing entries keep
  // their relative order at the tail.
  const merged = [...added, ...currentSegments].join(":");
  process.env.PATH = merged;
  return { applied: true, shell, added, finalLength: merged.length };
}

function shouldSkip(): boolean {
  if (process.env.GINI_SKIP_PATH_BOOTSTRAP === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.BUN_TEST === "1" || process.env.BUN_TEST === "true") return true;
  return false;
}

function readLoginShellPath(shell: string): string | null {
  // `-ilc` = interactive + login + run a command. We need both -i and -l
  // because users put nvm/asdf init in either `.zshrc` (interactive) or
  // `.zprofile` / `.bash_profile` (login). Combining them mirrors what
  // a fresh terminal window does.
  // `printf "%s"` instead of `echo $PATH` avoids the trailing newline so
  // we don't have to strip it.
  const result = spawnSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
    encoding: "utf8",
    timeout: SHELL_PATH_TIMEOUT_MS,
    // Stderr is suppressed so a noisy `.zshrc` (welcome banners, etc.)
    // doesn't bleed into runtime logs. PATH lands on stdout.
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

export const __testing = {
  shouldSkip
};
