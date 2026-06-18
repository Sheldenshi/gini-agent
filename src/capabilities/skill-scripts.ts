// Skill-script invocation runtime (lean version).
//
// Anthropic Agent Skills are directories that can ship a `scripts/`
// subdirectory with executable companions. Gini discovers scripts by
// listing the top-level files in each enabled skill's scripts/ folder —
// no frontmatter declaration. The model invokes them through the generic
// `skill_run({skill, script, args})` tool, which:
//
//   1. Locates the SkillRecord by name (bundled OR user-installed —
//      same dispatch path, the on-disk source is just where the file
//      lives).
//   2. Resolves the script file (matching basename without extension
//      against the requested name).
//   3. Picks an interpreter based on the file extension (.ts → bun,
//      .sh → sh, .py → python3, otherwise honor the shebang).
//   4. Spawns with stdin = JSON args, env = connector secrets +
//      GINI_* runtime context, captures stdout as the JSON result.
//
// Subdirectories under scripts/ are intentionally NOT scanned — they're
// the author's space for helpers a script imports from.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { spawn } from "bun";
import type { RuntimeConfig, RuntimeState, SkillRecord } from "../types";
import { addAudit, appendTrace, mutateState } from "../state";
import { resolveSkillEnv } from "../integrations/connectors";
import { uploadsDir } from "../paths";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface SkillScriptHandle {
  skill: SkillRecord;
  scriptName: string;
  scriptPath: string;
}

// Find the enabled skill matching by name and resolve its scripts dir.
// Returns null when there's no enabled skill by that name. We don't
// distinguish bundled vs user-installed here — both ship scripts the
// same way and the install_skill flow is what gates third-party trust.
function findSkillByName(state: RuntimeState, name: string): SkillRecord | null {
  return state.skills.find((s) => s.name === name && s.status === "enabled") ?? null;
}

function scriptsDirFor(skill: SkillRecord): string | null {
  if (!skill.manifestPath) return null;
  const dir = join(dirname(skill.manifestPath), "scripts");
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

// Look up `<skill>/scripts/<name>.<any>` by matching the basename without
// extension. The first hit wins so the script author picks the runtime
// by their extension choice (rare to ship two scripts with the same
// stem). Subdirectories under scripts/ are skipped — they're author
// helper space.
export function findSkillScript(
  state: RuntimeState,
  skillName: string,
  scriptName: string
): SkillScriptHandle | null {
  const skill = findSkillByName(state, skillName);
  if (!skill) return null;
  const scriptsDir = scriptsDirFor(skill);
  if (!scriptsDir) return null;
  let entries: string[];
  try {
    entries = readdirSync(scriptsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(scriptsDir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const stem = basename(entry, extname(entry));
    if (stem === scriptName) {
      return { skill, scriptName, scriptPath: full };
    }
  }
  return null;
}

// List the script names (basenames without extension) every enabled
// skill ships. Used by the system-prompt skills block so the model
// sees what's available without having to read_skill for each one
// individually. Stable ordering across boots (sort within each skill)
// for prompt-cache stability.
export function listEnabledSkillScripts(state: RuntimeState): Array<{ skill: string; scripts: string[] }> {
  const out: Array<{ skill: string; scripts: string[] }> = [];
  for (const skill of state.skills) {
    if (skill.status !== "enabled") continue;
    const scriptsDir = scriptsDirFor(skill);
    if (!scriptsDir) continue;
    let entries: string[];
    try {
      entries = readdirSync(scriptsDir);
    } catch {
      continue;
    }
    const scripts: string[] = [];
    for (const entry of entries) {
      const full = join(scriptsDir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      scripts.push(basename(entry, extname(entry)));
    }
    if (scripts.length === 0) continue;
    scripts.sort();
    out.push({ skill: skill.name, scripts });
  }
  out.sort((a, b) => a.skill.localeCompare(b.skill));
  return out;
}

export interface InvokeSkillScriptOptions {
  taskId?: string;
  timeoutMs?: number;
  envOverride?: Record<string, string>;
  // Per-turn / per-approval abort signal. When it fires, the spawned script's
  // immediate process is SIGTERM'd (same kill the timeout uses), so a cancelled
  // approved skill.run stops the subprocess at the source rather than running
  // to its full timeout. Detached grandchildren inside a shell script survive,
  // the same residual limitation documented for terminal.exec — see
  // docs/adr/approval-execution-abort.md.
  signal?: AbortSignal;
}

export interface SkillScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: unknown;
  error?: string;
  // True only when the abort signal WON the race against the script's natural
  // exit (or was already aborted before the spawn) — i.e. the cancel actually
  // killed the run. A signal that fires AFTER the script already exited
  // cleanly (the drain window) does NOT set this, so a completed run is never
  // mislabeled aborted. Mirrors terminal.exec's `winner === "aborted"`.
  aborted: boolean;
}

// Spawn the script with the right interpreter, pipe JSON args via stdin,
// capture stdout, parse as JSON. Non-zero exits, missing JSON, and
// timeouts all surface as { ok: false } — callers never throw.
export async function invokeSkillScript(
  config: RuntimeConfig,
  handle: SkillScriptHandle,
  args: Record<string, unknown>,
  options: InvokeSkillScriptOptions = {}
): Promise<SkillScriptResult> {
  if (!existsSync(handle.scriptPath)) {
    throw new Error(`Skill script not found on disk: ${handle.scriptPath}`);
  }
  const connectorEnv = await resolveSkillEnv(config, handle.skill, options.taskId);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GINI_INSTANCE: config.instance,
    GINI_UPLOADS_DIR: uploadsDir(config.instance),
    GINI_WORKSPACE: config.workspaceRoot,
    GINI_TASK_ID: options.taskId ?? "",
    // Non-secret ambient session vars that real CLIs rely on (e.g. gws's
    // macOS keychain decryption resolves the login keychain via USER/LOGNAME).
    // These are session identity/locale, not secrets — connector SECRETS
    // still come only via resolveSkillEnv above, so this stays within the
    // skill-env containment boundary (see ADR skill-connector-consent.md).
    ...ambientEnv(),
    ...connectorEnv,
    ...(options.envOverride ?? {})
  };

  const cmd = commandFor(handle.scriptPath);
  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `Skill script ${handle.skill.name}/${handle.scriptName}`,
    data: {
      skill: handle.skill.name,
      script: handle.scriptName,
      interpreter: cmd[0],
      argBytes: JSON.stringify(args).length
    }
  });

  const { signal } = options;
  // Skip the spawn entirely when the cancel already landed: starting a
  // high-risk script (connector env, workspace access) only to SIGTERM it a
  // tick later is a needless side effect, and mirrors terminal.exec's
  // pre-spawn `signal.aborted` guard. Reported as aborted so the caller settles
  // the row `denied`.
  if (signal?.aborted) {
    if (options.taskId) {
      appendTrace(config.instance, options.taskId, {
        type: "tool",
        message: `Skill script ${handle.skill.name}/${handle.scriptName} skipped: task was cancelled`,
        data: { skill: handle.skill.name, script: handle.scriptName, aborted: true }
      });
    }
    return { ok: false, stdout: "", stderr: "", exitCode: -1, parsed: null, error: "Skill script aborted: task was cancelled.", aborted: true };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: dirname(handle.scriptPath)
  });

  const stdinJson = JSON.stringify(args ?? {});
  const writer = proc.stdin as { write: (data: Uint8Array) => Promise<number>; end: () => void };
  await writer.write(new TextEncoder().encode(stdinJson));
  writer.end();

  const timeoutHandle = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);

  // Honor the caller's abort signal: a cancel mid-run SIGTERMs the immediate
  // process so the script stops at the source. Race `proc.exited` against the
  // abort to derive a TRUTHFUL aborted verdict: `winner === "aborted"` only
  // when the signal settled the race BEFORE the proc exited on its own. A
  // signal that fires AFTER the proc already exited cleanly (the drain window)
  // loses the race, so a completed run is never mislabeled aborted — the same
  // microtask-ordered discipline terminal.exec uses. `Promise.race` is
  // resilient to listener-timing: the abort sentinel can only win if it
  // resolves first, regardless of when removeEventListener runs.
  let onAbort: (() => void) | undefined;
  const exitedSentinel = proc.exited.then(() => "exited" as const);
  const abortSentinel = new Promise<"aborted">((resolve) => {
    if (!signal) return; // never resolves — proc.exited always wins
    onAbort = (): void => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const winner = await Promise.race([exitedSentinel, abortSentinel]);
  if (winner === "aborted") {
    try { proc.kill(); } catch { /* already exited */ }
  }
  const aborted = winner === "aborted";

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
  } finally {
    clearTimeout(timeoutHandle);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  let parsed: unknown = null;
  let parseError: string | undefined;
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const ok = exitCode === 0 && parseError === undefined && parsed !== null;
  let error: string | undefined;
  if (exitCode !== 0) {
    error = `Script exited ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`;
  } else if (parseError) {
    error = `Script stdout was not JSON: ${parseError}`;
  } else if (parsed === null) {
    error = "Script produced no JSON output.";
  }

  await mutateState(config.instance, (state) => {
    const ctx = options.taskId ? { taskId: options.taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: options.taskId ? "agent" : "runtime",
        action: "skill.script.invoked",
        target: handle.skill.id,
        risk: "medium",
        taskId: options.taskId,
        evidence: {
          skill: handle.skill.name,
          script: handle.scriptName,
          interpreter: cmd[0],
          ok,
          exitCode,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length
        }
      },
      ctx
    );
  });

  return { ok, stdout, stderr, exitCode, parsed, error, aborted };
}

// Benign, non-secret ambient session/locale vars to pass through from the
// gateway's process env when present. CLIs like gws need USER/LOGNAME to
// resolve the macOS login keychain; locale/term/tmpdir keep tool output
// well-behaved. Only forward keys that are actually set so we never inject
// empty strings.
const AMBIENT_ENV_KEYS = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"] as const;

function ambientEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AMBIENT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Pick the right interpreter based on the script's extension. Unknown
// extensions fall through to executing the file directly (relying on the
// shebang + executable bit).
function commandFor(scriptPath: string): string[] {
  const ext = extname(scriptPath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".js":
    case ".mjs":
      return ["bun", "run", scriptPath];
    case ".sh":
    case ".bash":
      return ["bash", scriptPath];
    case ".py":
      return ["python3", scriptPath];
    default:
      return [scriptPath];
  }
}
