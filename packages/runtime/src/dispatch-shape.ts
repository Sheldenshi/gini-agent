// Shape gates for imperative tool-prefix dispatch.
//
// The task orchestrator routes inputs starting with "write ", "read ", "list ",
// "find ", "web ", "patch ", "code ", or "shell " to the matching tool. But a
// bare-prefix match hijacks natural-language prompts that happen to start with
// those English words ("Write a thorough plan...", "find me a restaurant"),
// which then crash inside the tool because the rest of the input isn't valid
// tool syntax.
//
// Each gate below inspects the *rest* of the input (after the prefix and
// trimmed) and returns true only when the remainder looks like real tool
// syntax. The orchestrator only claims the dispatch when the gate passes;
// otherwise the input falls through to the LLM as the user intended.

/** `write <relative-path> :: <content>` — requires the `::` separator. */
export function shapeWrite(rest: string): boolean {
  return rest.includes("::");
}

/** `patch <relative-path> :: <old> => <new>` — requires both `::` and `=>`. */
export function shapePatch(rest: string): boolean {
  return rest.includes("::") && rest.includes("=>");
}

/** `read <path>` — single path token (no spaces) or a path-like prefix. */
export function shapeRead(rest: string): boolean {
  if (!rest) return false;
  return !rest.includes(" ") || /^[.~/]/.test(rest);
}

/** `list [<path>]` — empty (cwd), single token, or a path-like prefix. */
export function shapeList(rest: string): boolean {
  if (!rest) return true;
  return !rest.includes(" ") || /^[.~/]/.test(rest);
}

/** `find <pattern> in <dir>` — requires ` in ` separator or glob chars. */
export function shapeFind(rest: string): boolean {
  return / in /.test(rest) || /[*?[\]]/.test(rest);
}

/** `web <url>` — must start with `http://` or `https://`. */
export function shapeWeb(rest: string): boolean {
  return /^https?:\/\//i.test(rest);
}

/** `code <lang> :: <source>` — must begin with a supported language tag and `::`. */
export function shapeCode(rest: string): boolean {
  return /^(js|python|javascript)\s*::/i.test(rest);
}

/**
 * `shell <command>` — looks like a real command: a path-leading token (./foo,
 * /usr/bin/x, ~/bin), a hyphen flag (-l, --all), a pipe/redirect/glob, or
 * other shell metacharacter. Rejects sentences like "shell out the work".
 */
export function shapeShell(rest: string): boolean {
  return /(^|\s)[./~][^\s]*|\s-[a-zA-Z]|[|<>;&$`]|[*?]/.test(rest);
}

export type ShapeGate = (rest: string) => boolean;

/**
 * Returns true if `input` (full task input, any case) starts with `prefix`
 * AND the remainder satisfies `shape`. Used by both the dispatcher and by
 * auto-retain to decide whether an input is a real tool call.
 */
export function matchesShape(input: string, prefix: string, shape: ShapeGate): boolean {
  const lower = input.toLowerCase();
  if (!lower.startsWith(prefix)) return false;
  const rest = input.slice(prefix.length).trim();
  return shape(rest);
}
