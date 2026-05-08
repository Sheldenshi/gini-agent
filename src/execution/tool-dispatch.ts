// Tool dispatch for the chat-task agent loop.
//
// Where src/tools/* parse `task.input` (legacy CLI prefix path), this module
// dispatches by tool name + structured args. Low-risk tools execute
// synchronously and return a string result the loop feeds back to the
// model. High-risk tools create an approval and return `{ pending: true }`
// — the loop captures the approval id, snapshots its messages onto the
// task, and pauses the task. When the user resolves the approval,
// agent.executeApprovedAction runs the side effect, calls
// resumeChatTask, and the loop continues with the captured tool result.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import {
  addAudit,
  appendTrace,
  assertInsideWorkspace,
  createApproval,
  mutateState,
  now,
  readState
} from "../state";
import { findTask } from "../agent";
import { walkFiles, simpleDiff } from "../tools/file";
import { codeExecutionCommand } from "../tools/code";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "../capabilities/subagents";

export type DispatchResult =
  | { kind: "sync"; result: string }
  | { kind: "pending"; approvalId: string };

// Top-level entry. Routes the tool call to its handler. Throws on unknown
// tool names so the loop can surface that to the model as an error
// (instead of silently ignoring a hallucinated tool).
export async function dispatchToolCall(
  config: RuntimeConfig,
  taskId: string,
  toolName: string,
  toolCallId: string,
  rawArgs: string
): Promise<DispatchResult> {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(rawArgs);
  } catch (error) {
    throw new Error(`Invalid JSON arguments for ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
  }

  switch (toolName) {
    case "file_read":
      return { kind: "sync", result: await fileRead(config, taskId, args) };
    case "file_list":
      return { kind: "sync", result: await fileList(config, taskId, args) };
    case "file_search":
      return { kind: "sync", result: await fileSearch(config, taskId, args) };
    case "web_fetch":
      return { kind: "sync", result: await webFetchTool(config, taskId, args) };
    case "read_skill":
      return { kind: "sync", result: await readSkillTool(config, taskId, args) };
    case "spawn_subagent":
      return { kind: "sync", result: await spawnSubagentTool(config, taskId, args) };
    case "file_write":
      return { kind: "pending", approvalId: await requestFileWrite(config, taskId, toolCallId, args) };
    case "file_patch":
      return { kind: "pending", approvalId: await requestFilePatch(config, taskId, toolCallId, args) };
    case "terminal_exec":
      return { kind: "pending", approvalId: await requestTerminalExec(config, taskId, toolCallId, args) };
    case "code_exec":
      return { kind: "pending", approvalId: await requestCodeExec(config, taskId, toolCallId, args) };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`Argument ${key} must be a number.`);
  return value;
}

// ---------------- Sync tools ----------------

async function fileRead(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const target = requireString(args, "path");
  const full = assertInsideWorkspace(config.workspaceRoot, target);
  const stat = statSync(full);
  if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
  const content = readFileSync(full, "utf8").slice(0, 12_000);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "File read (chat-task)",
    data: { path: target, bytes: content.length }
  });
  await recordLowRiskAudit(config, taskId, "file.read", target, { bytes: content.length });
  return content;
}

async function fileList(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const target = optionalString(args, "path", ".");
  const full = assertInsideWorkspace(config.workspaceRoot, target);
  const entries = readdirSync(full)
    .slice(0, 200)
    .map((entry) => {
      const fp = join(full, entry);
      const stat = statSync(fp);
      return `${stat.isDirectory() ? "dir " : "file"} ${relative(config.workspaceRoot, fp)}`;
    });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Directory listed (chat-task)",
    data: { path: target, entries: entries.length }
  });
  await recordLowRiskAudit(config, taskId, "file.list", target, { entries: entries.length });
  return entries.join("\n") || "No entries.";
}

async function fileSearch(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const pattern = requireString(args, "pattern");
  const target = optionalString(args, "path", ".");
  const root = assertInsideWorkspace(config.workspaceRoot, target);
  const matches: string[] = [];
  for (const file of walkFiles(config.workspaceRoot, root, 300)) {
    if (matches.length >= 100) break;
    if (!isTextLike(file)) continue;
    const content = readFileSync(file, "utf8");
    const line = content.split(/\r?\n/).findIndex((value) => value.toLowerCase().includes(pattern.toLowerCase()));
    if (line >= 0) matches.push(`${relative(config.workspaceRoot, file)}:${line + 1}`);
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Files searched (chat-task)",
    data: { pattern, dir: target, matches: matches.length }
  });
  await recordLowRiskAudit(config, taskId, "file.search", pattern, { matches: matches.length });
  return matches.join("\n") || "No matches.";
}

async function webFetchTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const rawUrl = requireString(args, "url");
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("web_fetch requires an http(s) URL.");
  const response = await fetch(parsed);
  const text = (await response.text())
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Web page fetched (chat-task)",
    data: { url: parsed.toString(), status: response.status, bytes: text.length }
  });
  await recordLowRiskAudit(config, taskId, "web.fetch", parsed.toString(), { status: response.status, bytes: text.length });
  return text || `Fetched ${parsed.toString()} with HTTP ${response.status}.`;
}

// Skill catalog access. Returns the full markdown body of a trusted skill
// so the model can follow its instructions. We deliberately gate on the
// "trusted" status — draft / disabled / archived skills are invisible
// to the agent loop. The system prompt only advertises trusted skills, so
// the model shouldn't request anything else; if it does, surface the
// reason to the model as a tool error rather than silently returning empty.
async function readSkillTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const name = requireString(args, "name");
  const state = readState(config.instance);
  const skill = state.skills.find((s) => s.name === name);
  if (!skill) throw new Error(`No skill named ${name} is registered.`);
  if (skill.status !== "trusted") {
    throw new Error(`Skill ${name} is not trusted (current status: ${skill.status}). Ask the user to trust it via /skills before using.`);
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Skill body read (chat-task)",
    data: { name: skill.name, version: skill.version, bytes: skill.body.length }
  });
  await recordLowRiskAudit(config, taskId, "skill.read", skill.id, {
    name: skill.name,
    version: skill.version,
    bytes: skill.body.length
  });
  return skill.body || "(skill body is empty)";
}

// Spawn a constrained subagent and wait for its terminal state. The model
// gets the child's summary back as the tool result. We deliberately resolve
// synchronously (from the model's perspective) so the agent loop sees a
// straightforward request/response pattern and doesn't need a separate
// resume flow for delegation. Approval-gated tool calls inside the
// subagent block the subagent task, not the parent — the parent just
// polls for the final state.
//
// Depth is capped via MAX_SUBAGENT_DEPTH to prevent runaway nesting; the
// cap is enforced both here (before submitting) and inside spawnSubagent
// itself for defense-in-depth.
async function spawnSubagentTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = requireString(args, "name");
  const prompt = requireString(args, "prompt");
  const systemPrompt = typeof args.system_prompt === "string" ? args.system_prompt : undefined;
  const toolsets = Array.isArray(args.toolsets) ? args.toolsets.map(String) : undefined;
  const skills = Array.isArray(args.skills) ? args.skills.map(String) : undefined;
  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 5 * 60 * 1000;

  // Pre-flight depth check so we can return a clean error to the model
  // instead of throwing an exception that becomes a generic tool error.
  const stateNow = readState(config.instance);
  const depth = subagentDepth(stateNow, taskId);
  if (depth >= MAX_SUBAGENT_DEPTH) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "spawn_subagent rejected: depth cap reached",
      data: { depth, cap: MAX_SUBAGENT_DEPTH, name }
    });
    return `Error: max_subagent_depth_exceeded (current depth ${depth}, cap ${MAX_SUBAGENT_DEPTH}). Refusing to spawn '${name}'.`;
  }

  // Audit + trace the delegation call before launching the child. Medium
  // risk because it doesn't directly mutate the world, but it commits
  // model time / spend on a tangent.
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    addAudit(state, {
      actor: "agent",
      action: "subagent.spawn",
      target: name,
      risk: "medium",
      taskId: item.id,
      runId: item.runId,
      evidence: { name, promptBytes: prompt.length, toolsets, skills, depth }
    });
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Spawning subagent '${name}'`,
    data: { name, toolsets, skills, depth }
  });

  let subagentId: string | undefined;
  try {
    const created = await spawnSubagent(config, {
      name,
      prompt,
      systemPrompt,
      toolsets,
      skills,
      parentTaskId: taskId
    });
    subagentId = created.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTrace(config.instance, taskId, {
      type: "error",
      message: `spawn_subagent failed: ${message}`,
      data: { name }
    });
    return `Error: ${message}`;
  }

  // Reflect the parent's currentStep so the UI shows what we're waiting on.
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    item.currentStep = `Waiting on subagent ${name}`;
    item.updatedAt = now();
  });

  const final = await waitForSubagentTerminal(config, subagentId, timeoutMs);

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Subagent '${name}' finished`,
    data: { subagentId, status: final.status, hasSummary: Boolean(final.summary), hasError: Boolean(final.error) }
  });

  // Format the result. We return a compact JSON-shaped string so the model
  // can parse if it wants, but the strings inside are human-readable.
  const payload = {
    subagentId,
    status: final.status,
    summary: final.summary ?? null,
    error: final.error ?? null
  };
  return JSON.stringify(payload);
}

// Poll the subagent record until its child task reaches a terminal state,
// or `timeoutMs` elapses. We poll instead of using events because the
// runtime state mutation queue is the canonical cross-call sync point and
// the chat-task loop's terminal transitions already call syncSubagentFromTask.
//
// On timeout we return a synthetic record with status "timeout" so the
// caller can recover (the underlying task continues running and may still
// complete later — its eventual completion will sync into the record).
async function waitForSubagentTerminal(
  config: RuntimeConfig,
  subagentId: string,
  timeoutMs: number
): Promise<{ status: string; summary?: string; error?: string }> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const pollMs = 100;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) return { status: "missing", error: `Subagent ${subagentId} disappeared.` };
    if (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled") {
      return {
        status: sub.status,
        summary: sub.resultSummary ?? sub.summary,
        error: sub.resultError ?? sub.error
      };
    }
    await Bun.sleep(pollMs);
  }
  return { status: "timeout", error: `Subagent ${subagentId} did not finish within ${timeoutMs}ms.` };
}

function isTextLike(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ["", ".ts", ".js", ".json", ".md", ".txt", ".html", ".css", ".yml", ".yaml"].includes(ext);
}

async function recordLowRiskAudit(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  target: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    // addAudit is imported transitively via createApproval/etc., but the
    // chat-task path needs a direct audit record here without changing task
    // status. Use the same shape the legacy completeLowRiskToolTask uses.
    state.audit.unshift({
      id: `audit_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      instance: state.instance,
      at: now(),
      actor: "runtime",
      action,
      target,
      risk: "low",
      taskId: item.id,
      runId: item.runId,
      evidence
    });
    item.updatedAt = now();
  });
}

// ---------------- Approval-gated tools ----------------

async function requestFileWrite(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const target = requireString(args, "path");
  const content = requireString(args, "content");
  assertInsideWorkspace(config.workspaceRoot, target);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.write",
      target,
      risk: "high",
      reason: "File writes are side effects and require explicit approval.",
      payload: { path: target, content, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for file write (chat-task)",
      data: { approvalId: approval.id, target, toolCallId }
    });
    return approval.id;
  });
}

async function requestFilePatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const target = requireString(args, "path");
  const oldText = requireString(args, "oldText");
  const newText = requireString(args, "newText");
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  if (!existsSync(path)) throw new Error(`Cannot patch missing file: ${target}`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(oldText)) throw new Error(`Patch target text not found in ${target}`);
  const after = before.replace(oldText, newText);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.patch",
      target,
      risk: "high",
      reason: "File patches are side effects and require explicit approval.",
      payload: {
        path: target,
        oldText,
        newText,
        diff: simpleDiff(oldText, newText),
        beforeBytes: before.length,
        afterBytes: after.length,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for file patch (chat-task)",
      data: { approvalId: approval.id, target, diff: approval.payload.diff, toolCallId }
    });
    return approval.id;
  });
}

async function requestTerminalExec(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const command = requireString(args, "command");
  const timeoutMs = optionalNumber(args, "timeoutMs", 10_000);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "Terminal execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for terminal command (chat-task)",
      data: { approvalId: approval.id, command, toolCallId }
    });
    return approval.id;
  });
}

async function requestCodeExec(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const language = requireString(args, "language");
  const code = requireString(args, "code");
  const command = codeExecutionCommand(language, code);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: "Code execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs: 10_000, toolCallId, language }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for code execution (chat-task)",
      data: { approvalId: approval.id, language, toolCallId }
    });
    return approval.id;
  });
}

// Helper: pull the captured tool_call_id off an approval payload. The
// chat-task loop persists the originating tool_call_id on the approval
// payload so when the approval resolves, the runtime knows which message
// in the snapshot to update with the tool result.
export function approvalToolCallId(payload: Record<string, unknown>): string | undefined {
  const id = payload.toolCallId;
  return typeof id === "string" ? id : undefined;
}
