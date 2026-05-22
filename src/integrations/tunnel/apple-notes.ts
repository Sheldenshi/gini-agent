// Apple Notes integration via AppleScript / osascript.
//
// Pushes the current tunnel URL into a designated note inside the user's
// iCloud Notes account so every signed-in Apple device sees the latest URL
// without having to scan a fresh QR every restart. Updates are idempotent:
// if the note does not exist yet, it is created; if it exists, its body is
// rewritten. We never touch a note outside the configured folder, and we
// never delete or rename anything.
//
// All paths in this module assume macOS. The runtime gates calls on
// `process.platform === "darwin"` before touching it. On other platforms
// every entry point is a fast no-op so the orchestrator stays
// platform-agnostic.

export interface AppleNotesTarget {
  /** Top-level folder name inside the iCloud account. Created on demand. */
  folder: string;
  /** Note name within the folder. Created on demand. */
  noteName: string;
  /** iCloud account display name. Defaults to "iCloud". */
  account?: string;
}

export interface UpdateAppleNoteInput extends AppleNotesTarget {
  /** Body content. Plain text is rendered with default Notes styling. */
  body: string;
}

export type RunOsascript = (script: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

/**
 * Default osascript runner that shells out via Bun.spawn. Tests inject a
 * stub instead so the AppleScript surface can be exercised without ever
 * launching Notes.app.
 *
 * The first call against Notes.app on a fresh macOS user triggers an
 * Automation permission prompt. If the prompt is dismissed or fires
 * without a UI session attached (e.g. a launchd-managed runtime), the
 * osascript process can stay in I/O wait forever. We kill the child after
 * `OSASCRIPT_TIMEOUT_MS` so the manager surfaces a clean "Apple Notes
 * update failed" instead of hanging the snapshot indefinitely.
 */
export const OSASCRIPT_TIMEOUT_MS = 15_000;

export const defaultOsascriptRunner: RunOsascript = async (script) => {
  const proc = Bun.spawn(["osascript", "-l", "AppleScript", "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  }, OSASCRIPT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (timedOut) {
      return {
        stdout,
        stderr: stderr || `osascript timed out after ${OSASCRIPT_TIMEOUT_MS}ms (automation permission may be pending)`,
        exitCode: exitCode ?? -1
      };
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Returns true when the iCloud account is signed in and Notes.app exposes
 * it under the given display name. Used to decide whether to enable the
 * Apple Notes mirroring on this host.
 */
export async function isICloudAccountAvailable(
  options: { account?: string; run?: RunOsascript } = {}
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const account = options.account ?? "iCloud";
  const run = options.run ?? defaultOsascriptRunner;
  const script = `tell application "Notes"\n  set acctNames to name of every account\n  if acctNames contains ${quoteAppleScript(account)} then\n    return "yes"\n  else\n    return "no"\n  end if\nend tell`;
  try {
    const result = await run(script);
    if (result.exitCode !== 0) return false;
    return result.stdout.trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Upsert the configured note. Creates the folder if absent, then the note,
 * then writes the body. Failures bubble up as `Error` so callers can log
 * the AppleScript stderr verbatim.
 */
export async function updateAppleNote(
  input: UpdateAppleNoteInput,
  runner: RunOsascript = defaultOsascriptRunner
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("updateAppleNote only runs on macOS");
  }
  const script = buildUpdateScript(input);
  const result = await runner(script);
  if (result.exitCode !== 0) {
    const msg = result.stderr.trim() || `osascript exited with ${result.exitCode}`;
    throw new Error(`Apple Notes update failed: ${msg}`);
  }
}

/**
 * Build the AppleScript that ensures the folder + note exist and overwrites
 * the note's body. Exposed for unit tests so the generated source can be
 * snapshot-checked without invoking osascript.
 */
export function buildUpdateScript(input: UpdateAppleNoteInput): string {
  const account = quoteAppleScript(input.account ?? "iCloud");
  const folder = quoteAppleScript(input.folder);
  const noteName = quoteAppleScript(input.noteName);
  const bodyHtml = quoteAppleScript(plainTextToNotesHtml(input.body, input.noteName));
  // The script ensures the folder exists, looks for an existing note by
  // name inside it, and either updates the body or makes a fresh note.
  return [
    `tell application "Notes"`,
    `  tell account ${account}`,
    `    if not (exists folder ${folder}) then`,
    `      make new folder with properties {name:${folder}}`,
    `    end if`,
    `    tell folder ${folder}`,
    `      set existingNotes to notes whose name is ${noteName}`,
    `      if (count of existingNotes) is 0 then`,
    `        make new note with properties {name:${noteName}, body:${bodyHtml}}`,
    `      else`,
    `        set body of item 1 of existingNotes to ${bodyHtml}`,
    `      end if`,
    `    end tell`,
    `  end tell`,
    `end tell`
  ].join("\n");
}

/**
 * Notes.app interprets the `body` property as HTML. Convert plain text to
 * a Notes-friendly HTML document so newlines render as line breaks instead
 * of being collapsed into a single paragraph.
 */
export function plainTextToNotesHtml(body: string, title: string): string {
  const escaped = escapeHtml(body).replace(/\r\n|\r|\n/g, "<br>");
  const escapedTitle = escapeHtml(title);
  return `<div><h1>${escapedTitle}</h1><p>${escaped}</p></div>`;
}

/**
 * AppleScript string literal escape. Quotes the surrounding `"` and escapes
 * the two characters AppleScript treats specially inside a string literal:
 * the literal quote and the backslash.
 */
export function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
