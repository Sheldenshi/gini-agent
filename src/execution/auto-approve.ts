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
