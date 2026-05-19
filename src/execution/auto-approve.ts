// Auto-approve allowlist matcher for shell commands.
//
// Users opt in to bypassing the approval gate for selected commands by
// listing shell-glob-like patterns in
// `RuntimeConfig.autoApproveCommands`. Each pattern is matched against
// the *full* command string the model emitted (we don't try to parse
// argv — the LLM may quote things in surprising ways and we'd rather
// surface a literal string match than a clever-but-wrong tokenizer).
//
// Pattern syntax (intentionally minimal — bash glob subset):
//   - `*`  matches any run of characters except newline
//   - `?`  matches any single character except newline
//   - everything else is literal (no character classes, no extglob)
//
// We anchor patterns to both ends so `memo *` matches "memo notes -a"
// but NOT "rm -rf / && memo notes -a". This makes the allowlist safe
// to grow incrementally without accidentally green-lighting prefix
// injections.
//
// Returns the matching pattern string (so the audit can record which
// rule fired), or undefined when no rule matches.
export function matchAutoApprove(patterns: string[] | undefined, command: string): string | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (matchOne(pattern, command)) return pattern;
  }
  return undefined;
}

function matchOne(pattern: string, command: string): boolean {
  // Build an anchored regex from the glob pattern. Escape every
  // character that has regex meaning except `*` and `?`, which we then
  // translate into their glob equivalents.
  let regex = "^";
  for (const ch of pattern) {
    if (ch === "*") regex += "[^\\n]*";
    else if (ch === "?") regex += "[^\\n]";
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  try {
    return new RegExp(regex).test(command);
  } catch {
    return false;
  }
}

// Built-in dangerous-pattern blocklist. When `approvalMode` is "auto",
// terminal commands matching any of these patterns are routed through
// the human approval gate instead of being auto-approved. Operators can
// EXTEND the list via `RuntimeConfig.dangerousTerminalPatterns` — the
// built-ins always apply on top of any user additions. The
// `autoApproveCommands` allowlist ALWAYS short-circuits the blocklist —
// an explicit operator allow beats a heuristic block. See ADR
// approval-mode.md.
//
// The patterns aim at irreversible / blast-radius-expanding shapes:
//   - `rm -rf` / `rm -fr` targeting absolute paths or $HOME / system dirs
//   - any `sudo` invocation (including via tab / pipe / etc.)
//   - pipe-to-shell (`| sh`, `| bash`, etc.) — the canonical
//     fetch-and-execute footgun
//   - chmod 777 (world-writable bit)
//   - destructive git pushes / resets
//   - writes into /etc/, ~/.ssh/, ~/.aws/ (any redirect-style or tee)
//
// Built-in matchers use regex so trivial reshuffles
// (`rm -r -f /`, `sudo\tapt`, `curl x| /bin/sh`, `git -C repo reset
// --hard`) don't slip past a literal substring check. User-supplied
// patterns continue to use substring semantics (their consequences,
// they own the rule shape) — they're wrapped into the same matcher
// shape at the boundary.

export type DangerousPattern = {
  // Stable id surfaced on audit + approval reason strings. Treat as
  // public: changing breaks downstream audit consumers that bucket on
  // it.
  id: string;
  // Human-readable description for the approval card / docs.
  description: string;
  // Whether the command should gate. Receives the raw command string.
  test: (command: string) => boolean;
};

// Tokens commonly used as command boundaries in shells (and as
// surrounding punctuation in code_exec argv-style payloads). Used by
// the `sudo` matcher and friends so a literal substring match doesn't
// fire on e.g. `sudoers`. `[` and `,` cover the argv-array shape
// `["sudo", ...]`.
const BOUNDARY = "(?:^|[\\s;&|`(\\[,])";

// Detects `rm -rf` / `rm -fr` / `rm -r -f` / `rm --recursive --force`
// shapes (flags in any order, combined or split, case-insensitive on
// r/R for the recursive flag) followed by a dangerous target argument.
// The `rm` token can be bare (`rm`), backslash-escaped to bypass a
// shell alias (`\rm`), or an absolute path (`/bin/rm`,
// `/usr/bin/rm`). Dangerous targets are any absolute path, a glob
// `*`, the current directory `.`, `~`, `$HOME`, or anything under
// `~`/`$HOME`. The bias is intentional — recursive force-delete
// against ANY real filesystem target deserves the human gate. Local
// names like `node_modules` or `./dist` still pass through.
function testDangerousRm(command: string): boolean {
  // Match the `rm` invocation: optional leading backslash (alias
  // bypass), optional absolute path prefix (`/bin/rm`), then bare
  // `rm`. Boundary on the left is start-of-string or a shell command
  // separator so `myrm` / `librm` don't trip it.
  const rmMatch = command.match(/(?:^|[\s;&|`(])(\\?(?:\/[^\s]*\/)?rm)(\s|$)/);
  if (!rmMatch) return false;
  // Pull the argv-ish tail after the `rm` token for flag + target
  // analysis. Newlines are intentionally allowed since multi-line
  // shell strings still execute as one command.
  const tail = command.slice(rmMatch.index! + rmMatch[0].length);
  const hasRecursive =
    /(?:^|\s)-(?:[a-zA-Z]*[rR][a-zA-Z]*)(?=\s|$)/.test(tail) ||
    /(?:^|\s)--recursive\b/.test(tail);
  const hasForce =
    /(?:^|\s)-(?:[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)/.test(tail) ||
    /(?:^|\s)--force\b/.test(tail);
  if (!hasRecursive || !hasForce) return false;
  // Dangerous target detection: a token that is an absolute path, a
  // glob, the current directory, `~`, `$HOME`, or anything under
  // `~/`/`$HOME/`. We split on whitespace and check each token to
  // avoid matching `/etc` as a substring of an innocent path like
  // `./etc-helper`.
  const tokens = tail.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    // Skip flag-shaped tokens — `--recursive`, `-rf`, etc. should not
    // count as a dangerous target.
    if (raw.startsWith("-")) continue;
    // Strip surrounding single/double quotes once for the comparison.
    const t = raw.replace(/^["']|["']$/g, "");
    if (t.length === 0) continue;
    if (t === "*" || t === ".") return true;
    if (t === "~" || t === "$HOME") return true;
    if (t.startsWith("~/") || t.startsWith("$HOME/")) return true;
    if (t.startsWith("/")) return true;
  }
  return false;
}

export const DEFAULT_DANGEROUS_TERMINAL_PATTERNS: readonly DangerousPattern[] = Object.freeze([
  {
    id: "rm-rf-dangerous-target",
    description: "rm -rf (or equivalent) against a system root, $HOME, or ~",
    test: testDangerousRm
  },
  {
    id: "sudo",
    description: "sudo invocation",
    // Boundary-tokenized so `sudoers` / `pseudo` don't match; whitespace
    // tolerant (tabs, newlines, leading pipes / semicolons). Also
    // catches argv-style `["sudo", ...]` payloads inside code_exec
    // sources, where the trailing boundary is a closing quote rather
    // than whitespace.
    test: (command) => new RegExp(`${BOUNDARY}["']?sudo["']?(?:\\s|[,)\\]]|$)`).test(command)
  },
  {
    id: "pipe-to-shell",
    description: "pipe to a shell interpreter (sh, bash, zsh, fish, ksh, dash)",
    // Matches `| sh`, `|sh`, `|  /bin/bash`, `| env bash`-ish wrappers
    // are NOT caught (intentional — wrap is rare and increases
    // false-positives). The interpreter binary may be a bare name or a
    // full path; we accept either.
    test: (command) => /\|\s*(?:[^\s|]*\/)?(?:sh|bash|zsh|fish|ksh|dash)(?:\s|$)/.test(command)
  },
  {
    id: "chmod-777",
    description: "chmod with world-writable bits (777 / *777*)",
    // Tolerates `chmod -R 777`, `chmod a+rwx 0777 foo`, `chmod 777`.
    // Matches a digit-cluster containing 777 to cover `0777` and
    // `1777` (sticky) too.
    test: (command) => /\bchmod\b[^\n]*\b\d*777\d*\b/.test(command)
  },
  {
    id: "git-push-force",
    description: "git push -f / --force / --force-with-lease",
    test: (command) =>
      /\bgit\b[^\n]*\bpush\b[^\n]*(?:\s-f\b|\s--force(?:-with-lease)?\b)/.test(command)
  },
  {
    id: "git-reset-hard",
    description: "git reset --hard",
    test: (command) => /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/.test(command)
  },
  {
    id: "write-system-path",
    description: "redirect or tee to /etc/, ~/.ssh/, ~/.aws/, $HOME/.ssh/, $HOME/.aws/",
    test: (command) => {
      // Redirect form (`>` / `>>` with arbitrary whitespace, including
      // none) into a dangerous path. The target prefix is captured to
      // cover both `~` and `$HOME` spellings of the home directory.
      const targets = "(?:/etc/|~/\\.ssh/|~/\\.aws/|\\$HOME/\\.ssh/|\\$HOME/\\.aws/)";
      if (new RegExp(`>>?\\s*${targets}`).test(command)) return true;
      // tee variant: `... | tee /etc/hosts` / `... | tee -a ~/.ssh/foo`.
      if (new RegExp(`\\btee\\b[^\\n]*\\s${targets}`).test(command)) return true;
      return false;
    }
  }
]);

// Wraps a list of user-supplied substring patterns into the same
// `DangerousPattern` shape the built-ins use. User patterns keep
// substring semantics — explicit additions where the operator owns
// the consequences. Whitespace-only entries are skipped (they would
// match every command).
export function userDangerousPatterns(patterns: readonly string[] | undefined): DangerousPattern[] {
  if (!patterns || patterns.length === 0) return [];
  const out: DangerousPattern[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    if (raw.trim().length === 0) continue;
    out.push({
      id: raw,
      description: `operator-supplied pattern: ${raw}`,
      test: (command) => command.includes(raw)
    });
  }
  return out;
}

// Returns the first dangerous pattern that the command matches, or
// undefined when none match. The pattern `id` is what callers stamp on
// audit + approval-reason strings. Callers should also consult
// `matchAutoApprove` first so an explicit operator allowlist wins.
export function matchDangerousTerminal(
  patterns: readonly DangerousPattern[] | undefined,
  command: string
): string | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  for (const pattern of patterns) {
    try {
      if (pattern.test(command)) return pattern.id;
    } catch {
      // Defensive: a bad user-supplied matcher shouldn't break the
      // whole policy decision. Skip and continue.
      continue;
    }
  }
  return undefined;
}
