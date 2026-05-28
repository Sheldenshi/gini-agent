// Skill-script invocation runtime.
//
// Anthropic Agent Skills are directories that can ship a `scripts/`
// subfolder with executable companions (see
// https://agentskills.io/specification). Gini extends that by letting a
// SKILL.md declare each script as a tool the agent can invoke directly:
//
//   metadata:
//     gini:
//       scripts:
//         - file: scripts/attach.ts
//           tool:
//             name: linear_attach_image
//             description: "..."
//             parameters: '{"type":"object","properties":{...}}'
//
// At catalog-build time the runtime registers a tool per declaration. When
// the agent invokes one, this module:
//
//   1. Locates the bundled SkillRecord that owns the tool name.
//   2. Resolves the script path against the skill folder.
//   3. Builds an env map = connector secrets (via the existing
//      `resolveSkillEnv` path) + GINI_* runtime context.
//   4. Spawns `bun run <script>` with the args object piped to stdin as
//      JSON. The script writes its result back to stdout as JSON.
//   5. Parses stdout. Non-zero exit, missing JSON, or empty stdout all
//      surface as `{ ok: false, error: "..." }` rather than thrown
//      exceptions, so the model can read the failure and retry / recover.
//
// Only bundled (`source: "bundled"`) skills are trusted to declare scripts
// today. User-imported skills that declare scripts have them ignored at
// registration time — running arbitrary code from a third-party skill
// install would need a separate trust review.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { spawn } from "bun";
import type { RuntimeConfig, RuntimeState, SkillRecord, SkillScript } from "../types";
import { addAudit, appendTrace, mutateState } from "../state";
import { resolveSkillEnv } from "../integrations/connectors";
import { uploadsDir } from "../paths";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — uploads can be large.

export interface SkillScriptInvocation {
  skill: SkillRecord;
  script: SkillScript;
  scriptPath: string;
}

export interface SkillScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: unknown;
  error?: string;
}

// Resolve a tool name to its owning bundled skill + script declaration.
// Returns null when no enabled bundled skill owns the name — including the
// case where the only match comes from a user-imported skill (which we
// intentionally don't expose).
export function findSkillScript(
  state: RuntimeState,
  toolName: string
): SkillScriptInvocation | null {
  for (const skill of state.skills) {
    if (skill.status !== "enabled") continue;
    if (skill.source !== "bundled") continue;
    if (!skill.scripts || skill.scripts.length === 0) continue;
    if (!skill.manifestPath) continue;
    const match = skill.scripts.find((s) => s.tool.name === toolName);
    if (!match) continue;
    const scriptPath = resolveScriptPath(skill.manifestPath, match.file);
    if (!scriptPath) continue;
    return { skill, script: match, scriptPath };
  }
  return null;
}

// Map every (enabled bundled skill, declared script) pair into a flat
// list. Used by the catalog to know which extra tools to advertise.
export function listEnabledSkillScripts(state: RuntimeState): SkillScriptInvocation[] {
  const out: SkillScriptInvocation[] = [];
  for (const skill of state.skills) {
    if (skill.status !== "enabled") continue;
    if (skill.source !== "bundled") continue;
    if (!skill.scripts || skill.scripts.length === 0) continue;
    if (!skill.manifestPath) continue;
    for (const script of skill.scripts) {
      const scriptPath = resolveScriptPath(skill.manifestPath, script.file);
      if (!scriptPath) continue;
      out.push({ skill, script, scriptPath });
    }
  }
  return out;
}

export interface InvokeSkillScriptOptions {
  taskId?: string;
  timeoutMs?: number;
  // Override env for tests (entries are merged on top of the resolved
  // connector + runtime env). Not exposed via dispatch — the agent never
  // gets to pick env vars directly.
  envOverride?: Record<string, string>;
}

// Spawn the script, pipe JSON args via stdin, capture stdout, parse as
// JSON. Always returns a SkillScriptResult; never throws on script
// failure (only on missing-script invariant violations).
export async function invokeSkillScript(
  config: RuntimeConfig,
  invocation: SkillScriptInvocation,
  args: Record<string, unknown>,
  options: InvokeSkillScriptOptions = {}
): Promise<SkillScriptResult> {
  if (!existsSync(invocation.scriptPath)) {
    throw new Error(`Skill script not found on disk: ${invocation.scriptPath}`);
  }
  const connectorEnv = await resolveSkillEnv(config, invocation.skill, options.taskId);
  const env: Record<string, string> = {
    // Pass through PATH so `bun` can be located when the runtime was
    // launched with a sparse env (e.g. a job spawn). Everything else from
    // process.env is intentionally NOT inherited — the script gets a
    // narrow surface (connector secrets + GINI_* context + overrides).
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GINI_INSTANCE: config.instance,
    GINI_UPLOADS_DIR: uploadsDir(config.instance),
    GINI_TASK_ID: options.taskId ?? "",
    ...connectorEnv,
    ...(options.envOverride ?? {})
  };

  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `Skill script ${invocation.skill.name}/${invocation.script.tool.name}`,
    data: {
      skill: invocation.skill.name,
      tool: invocation.script.tool.name,
      file: invocation.script.file
    }
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = spawn(["bun", "run", invocation.scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: dirname(invocation.scriptPath)
  });

  const stdinJson = JSON.stringify(args ?? {});
  const writer = (proc.stdin as { write: (data: Uint8Array) => Promise<number>; end: () => void });
  await writer.write(new TextEncoder().encode(stdinJson));
  writer.end();

  const timeoutHandle = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeoutHandle);

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
        target: invocation.skill.id,
        risk: "medium",
        taskId: options.taskId,
        evidence: {
          skill: invocation.skill.name,
          tool: invocation.script.tool.name,
          ok,
          exitCode,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length
        }
      },
      ctx
    );
  });

  return { ok, stdout, stderr, exitCode, parsed, error };
}

// Resolve `scripts/attach.ts` against the SKILL.md's parent directory.
// Refuses anything that escapes the skill folder (../, absolute paths,
// symlink games) so a malformed/malicious frontmatter can't reach files
// outside the skill it ships with.
function resolveScriptPath(manifestPath: string, fileRef: string): string | null {
  if (!fileRef) return null;
  if (isAbsolute(fileRef)) return null;
  const skillDir = dirname(manifestPath);
  const candidate = normalize(resolve(skillDir, fileRef));
  const skillRoot = normalize(skillDir);
  if (candidate !== skillRoot && !candidate.startsWith(`${skillRoot}/`)) {
    return null;
  }
  return candidate;
}

// Build the tool catalog entry for a skill script — used by the catalog
// builder so we don't duplicate the SkillScript → ToolFunctionSpec shape
// in two places.
export function skillScriptToolSpec(invocation: SkillScriptInvocation): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: invocation.script.tool.name,
    description: invocation.script.tool.description,
    parameters: invocation.script.tool.parameters
  };
}
