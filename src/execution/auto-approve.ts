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
    // Matches `| sh`, `|sh`, `|  /bin/bash`, and the `exec`/`eval`
    // wrapper forms (`| exec sh`, `| eval bash`) that hand the
    // remainder of the pipeline to a shell process. Other wrappers
    // (`| env bash`, `| xargs bash -c`) are NOT caught — they're
    // rarer and risk false positives. The interpreter binary may be a
    // bare name or a full path.
    test: (command) =>
      /\|\s*(?:(?:exec|eval)\s+)?(?:[^\s|]*\/)?(?:sh|bash|zsh|fish|ksh|dash)(?:\s|$)/.test(command)
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
      // none) into a dangerous path. The path may be quoted (single
      // or double) — `echo y > "/etc/hosts"` is the same write as
      // `echo y > /etc/hosts`. The target prefix covers both `~` and
      // `$HOME` spellings of the home directory.
      const targets = "(?:/etc/|~/\\.ssh/|~/\\.aws/|\\$HOME/\\.ssh/|\\$HOME/\\.aws/)";
      if (new RegExp(`>>?\\s*["']?${targets}`).test(command)) return true;
      // tee variant: `... | tee /etc/hosts` / `... | tee -a ~/.ssh/foo`.
      // Also accept a quoted target.
      if (new RegExp(`\\btee\\b[^\\n]*\\s["']?${targets}`).test(command)) return true;
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

// ---------------- source-level structural detection ----------------
//
// Scanning code_exec SOURCE with the same substring regexes used for
// shell command lines is too noisy. `# using sudo for X` and
// `print("using sudo for X")` both contain the literal `sudo` token
// with shell-style boundaries, so a generic matcher fires on them and
// gates work that has nothing to do with running sudo. The whole
// premise of "stop babysitting" is undermined when innocuous comments
// and log strings turn into approval prompts.
//
// The fix is structural: only flag a dangerous binary in source when
// it appears in an ARGV-LIKE position. Two shapes qualify:
//   1. The first element of an array literal: `["sudo", ...]`,
//      `{'sudo', ...}`, `[ "sudo" ]`. (Real code constructing argv
//      almost always puts the binary first.)
//   2. The first positional argument to a known exec-style function:
//      `Bun.spawn(...)`, `child_process.{spawn,exec,execSync,
//      execFile,execFileSync}(...)`,
//      `subprocess.{run,Popen,call,check_call,check_output,
//      getoutput,getstatusoutput}(...)`,
//      `os.{system,popen,execv,execvp,execve,execvpe,execl,execlp,
//      execle,execlpe}(...)`.
//
// Comments and bare string literals (`x = "sudo"`, `print("...sudo...")`)
// are NOT extracted — they're not in argv positions and they're the
// dominant source of false positives.
//
// Wrapper-command scanning is unchanged. `os.system("sudo apt
// update")` is still caught by the wrapper-side matcher because the
// heredoc-encoded source flows into the wrapper command and the
// literal `sudo` substring with shell boundaries appears there.
//
// User-supplied `dangerousTerminalPatterns` are NOT applied to
// source. They're already substring-based (operator owns the rule
// shape); applying them to source would multiply false positives. If
// an operator wants to gate `docker run` in source they can scope
// their rule to terminal.exec by writing it for the shell wrapper.

// Known exec-style call sites whose first positional arg becomes the
// process to launch.  The names are anchored with a word boundary so
// `mysubprocess.run` doesn't spuriously match.
const EXEC_CALL_RE =
  /(?:^|[^.\w])(?:Bun\.spawn|child_process\.(?:spawn|exec|execSync|execFile|execFileSync)|subprocess\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)|os\.(?:system|popen|execv|execvp|execve|execvpe|execl|execlp|execle|execlpe))\s*\(\s*/g;

// Array-literal first-element opener. The opener can be `[` or `{`
// followed by optional whitespace and a quote. The captured group is
// the quote character so we know how to terminate the string.
const ARRAY_LITERAL_OPENER_RE = /[\[{]\s*(["'])/g;

// Pull the contents of the next string literal starting at `start`.
// Tolerates `\"` / `\'` escapes inside the string. Returns the inner
// text plus the index after the closing quote. Returns undefined if
// there's no opening quote at `start` (skipping leading whitespace).
function readQuotedString(
  source: string,
  start: number
): { value: string; end: number } | undefined {
  let i = start;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return undefined;
  i++;
  let out = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
    i++;
  }
  return undefined;
}

// Pull the contents of an array literal whose opening `[`/`{` is at
// position `openIdx` (the regex match index of the opener). Reads
// successive quoted strings separated by commas/whitespace until a
// non-string element or the closing bracket. Returns the joined
// elements separated by spaces — the synthetic "command line" the
// generic matcher can scan.
function readStringArrayElements(source: string, openIdx: number): string {
  // openIdx points at `[` or `{`. Advance past it.
  let i = openIdx + 1;
  const elements: string[] = [];
  while (i < source.length) {
    while (i < source.length && /[\s,]/.test(source[i]!)) i++;
    if (i >= source.length) break;
    const ch = source[i]!;
    if (ch === "]" || ch === "}") break;
    if (ch !== '"' && ch !== "'") break;
    const read = readQuotedString(source, i);
    if (!read) break;
    elements.push(read.value);
    i = read.end;
  }
  return elements.join(" ");
}

// Extract synthetic command-line strings from source for structural
// scanning. Each extracted segment is what would actually be passed
// to a shell / launched as a process — never a comment, never a bare
// string literal.
function extractArgvSegments(source: string): string[] {
  const segments: string[] = [];

  // Exec-style call sites: read whatever comes after the opening `(`.
  // The first arg can be a string literal (`os.system("sudo apt")`)
  // or an array literal (`subprocess.run(["sudo", "apt"])`).
  const execRe = new RegExp(EXEC_CALL_RE);
  let m: RegExpExecArray | null;
  while ((m = execRe.exec(source)) !== null) {
    const after = m.index + m[0].length;
    // Case A: first arg is an array literal — `( [` or `( {`.
    // Find the opener (allowing whitespace).
    let j = after;
    while (j < source.length && /\s/.test(source[j]!)) j++;
    if (source[j] === "[" || source[j] === "{") {
      segments.push(readStringArrayElements(source, j));
      continue;
    }
    // Case B: first arg is a string literal.
    const read = readQuotedString(source, after);
    if (read) segments.push(read.value);
  }

  // Array literals anywhere whose first element is a string. Catches
  // `const cmd = ["sudo", ...]` even when the exec call site lives in
  // a different statement.
  const arrRe = new RegExp(ARRAY_LITERAL_OPENER_RE);
  while ((m = arrRe.exec(source)) !== null) {
    // m.index points at the `[` or `{`. The regex consumes through
    // the quote; rewind so readStringArrayElements sees the bracket.
    segments.push(readStringArrayElements(source, m.index));
  }

  return segments;
}

// Returns the first built-in dangerous pattern that fires on any
// structural segment extracted from `source`. User patterns are NOT
// applied — see the rationale block above.
export function matchDangerousSource(source: string): string | undefined {
  if (!source) return undefined;
  const segments = extractArgvSegments(source);
  if (segments.length === 0) return undefined;
  for (const segment of segments) {
    const hit = matchDangerousTerminal(DEFAULT_DANGEROUS_TERMINAL_PATTERNS, segment);
    if (hit) return hit;
  }
  return undefined;
}
