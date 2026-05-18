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
// terminal commands matching any of these patterns are routed through the
// human approval gate instead of being auto-approved. Operators can
// extend the list via `RuntimeConfig.dangerousTerminalPatterns`. The
// `autoApproveCommands` allowlist ALWAYS short-circuits the blocklist —
// an explicit operator allow beats a heuristic block. See ADR
// approval-mode.md.
//
// The patterns aim at irreversible / blast-radius-expanding shapes:
//   - `rm -rf` / `rm -fr` targeting absolute paths or $HOME
//   - any `sudo` invocation
//   - pipe-to-shell (`| sh`, `| bash`) — the canonical
//     fetch-and-execute footgun
//   - chmod 777 (world-writable bit)
//   - destructive git pushes / resets
//   - writes into /etc/, ~/.ssh/, ~/.aws/
//
// Each entry is a substring matcher (not a glob) — we test whether the
// command contains the pattern anywhere, which is the right semantics
// for "does this string contain `sudo `" and friends. The matcher
// returns the matched pattern (so the audit can record which rule
// fired) or undefined.
export const DEFAULT_DANGEROUS_TERMINAL_PATTERNS: readonly string[] = Object.freeze([
  "rm -rf /",
  "rm -fr /",
  "rm -rf $HOME",
  "rm -fr $HOME",
  "rm -rf ~",
  "rm -fr ~",
  "sudo ",
  "| sh",
  "| bash",
  "chmod 777",
  "git push -f",
  "git push --force",
  "git reset --hard",
  "> /etc/",
  ">> /etc/",
  "> ~/.ssh/",
  ">> ~/.ssh/",
  "> ~/.aws/",
  ">> ~/.aws/"
]);

// Returns the first dangerous pattern that the command matches (substring),
// or undefined when none match. Callers should also consult `matchAutoApprove`
// first so an explicit operator allowlist wins.
export function matchDangerousTerminal(
  patterns: readonly string[] | undefined,
  command: string
): string | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    // Patterns may carry significant trailing whitespace (e.g. "sudo "
    // requires the trailing space so we don't match a binary literally
    // named "sudoer"). Reject pure-whitespace entries via a trim check
    // without mutating the pattern itself.
    if (raw.trim().length === 0) continue;
    if (command.includes(raw)) return raw;
  }
  return undefined;
}
