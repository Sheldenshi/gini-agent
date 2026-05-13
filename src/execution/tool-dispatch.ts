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
import { findTask, runTerminalCommand } from "../agent";
import { walkFiles, simpleDiff } from "../tools/file";
import { codeExecutionCommand } from "../tools/code";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "../capabilities/subagents";
import { matchAutoApprove } from "./auto-approve";
import { createScheduledJob } from "../jobs";
import {
  browserBack,
  browserClick,
  browserClose,
  browserConsole,
  browserDrag,
  browserHover,
  browserNavigate,
  browserPress,
  browserScroll,
  browserSelectOption,
  browserSnapshot,
  browserTabs,
  browserType,
  browserVision,
  browserWaitFor,
  resolveUploadPath
} from "../tools/browser";

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
    case "create_job":
      return { kind: "sync", result: await createJobTool(config, taskId, args) };
    case "browser_navigate":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.navigate", browserNavigate, args) };
    case "browser_snapshot":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.snapshot", browserSnapshot, args) };
    case "browser_click":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.click", browserClick, args) };
    case "browser_type":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.type", browserType, args) };
    case "browser_press":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.press", browserPress, args) };
    case "browser_scroll":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.scroll", browserScroll, args) };
    case "browser_back":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.back", browserBack, args) };
    case "browser_console":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.console", browserConsole, args) };
    case "browser_close":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.close", browserClose, args) };
    case "browser_hover":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.hover", browserHover, args) };
    case "browser_drag":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.drag", browserDrag, args) };
    case "browser_select_option":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.select_option", browserSelectOption, args) };
    case "browser_wait_for":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.wait_for", browserWaitFor, args) };
    case "browser_tabs": {
      // tabs.list is read-only (low risk); tabs.new/switch/close mutate the
      // active page (medium). Encode that into the action label so the risk
      // set in runBrowserDispatch picks the right bucket without re-parsing
      // args downstream.
      const tabsAction = typeof args.action === "string" ? args.action : "";
      const label =
        tabsAction === "new" || tabsAction === "switch" || tabsAction === "close"
          ? `browser.tabs.${tabsAction}`
          : "browser.tabs.list";
      return { kind: "sync", result: await browserDispatch(config, taskId, label, browserTabs, args) };
    }
    case "browser_vision": {
      const result = await browserDispatchWithConfig(config, taskId, "browser.vision", browserVision, args);
      // Roll the vision provider's spend into the owning task's cost row
      // so the chat UI's running token / USD total reflects the
      // out-of-band vision call. The envelope carries `cost` as a
      // CostRecord (or null) — parse it once and accumulate via
      // addCostToTask. Failures here are best-effort; the tool result
      // already flows back to the model.
      await accumulateBrowserVisionCost(config, taskId, result);
      return { kind: "sync", result };
    }
    case "browser_upload_file":
      // Uploading a workspace file egresses bytes to a remote site —
      // explicit, side-effecting, irreversible from the user's
      // perspective. Route through the approval gate like file.write.
      return { kind: "pending", approvalId: await requestBrowserUpload(config, taskId, toolCallId, args) };
    case "file_write":
      return { kind: "pending", approvalId: await requestFileWrite(config, taskId, toolCallId, args) };
    case "file_patch":
      return { kind: "pending", approvalId: await requestFilePatch(config, taskId, toolCallId, args) };
    case "terminal_exec":
      return await terminalExecDispatch(config, taskId, toolCallId, args);
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

// Wraps a browser tool function with the trace+audit ceremony every other
// chat-task tool emits. Browser tools return JSON strings on their own
// (success or error), so we don't second-guess their result — we just log
// the dispatch and pass it through. Audit risk is `low` for read-only
// surface (navigate/snapshot/scroll/back/press/console/close) and `medium`
// for the two side-effecting calls (click/type) so the activity trail
// stays consistent with how file/terminal tools are categorized.
async function browserDispatch(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  fn: (taskId: string, args: Record<string, unknown>) => Promise<string>,
  args: Record<string, unknown>
): Promise<string> {
  return runBrowserDispatch(config, taskId, action, () => fn(taskId, args), args);
}

// Variant for browser tools that need the runtime config (e.g. browser_vision,
// which threads the configured provider through to generateVisionAnalysis).
// Kept separate from browserDispatch so the 9 existing tools keep their
// stable `(taskId, args)` signature.
async function browserDispatchWithConfig(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  fn: (taskId: string, args: Record<string, unknown>, config: RuntimeConfig) => Promise<string>,
  args: Record<string, unknown>
): Promise<string> {
  return runBrowserDispatch(config, taskId, action, () => fn(taskId, args, config), args);
}

async function runBrowserDispatch(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  exec: () => Promise<string>,
  args: Record<string, unknown>
): Promise<string> {
  const result = await exec();
  // Side-effecting actions get medium risk so the activity trail flags them
  // alongside file/terminal actions; read-only paths (navigate, snapshot,
  // hover, console, scroll, back, close, vision) stay low.
  const MEDIUM_RISK_ACTIONS = new Set([
    "browser.click",
    "browser.type",
    "browser.drag",
    "browser.select_option",
    "browser.tabs.new",
    "browser.tabs.switch",
    "browser.tabs.close",
    "browser.upload_file"
  ]);
  const risk: "low" | "medium" = MEDIUM_RISK_ACTIONS.has(action) ? "medium" : "low";
  let parsed: { success?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse(result) as { success?: boolean; error?: string };
  } catch {
    // Result wasn't JSON — treat as opaque success.
    parsed = { success: true };
  }
  // When the browser tool's safety check blocks a URL (which may contain a
  // bearer/api-token pattern), the raw URL would otherwise be persisted to
  // both trace data and the audit row, where it surfaces in the activity
  // UI and on disk. Redact the URL and target in that case so secrets
  // don't leak through the audit trail. Other failures (network, timeout,
  // unknown ref) keep the URL since it's needed for debugging.
  //
  // Match both "Blocked:" (active safety rejection) and "Invalid URL:"
  // (URL parse failure) — defense in depth so any safety-rejection prefix
  // routed through this dispatcher won't leak the input string. The error
  // message itself can also echo the raw URL (e.g. `Invalid URL: <raw>`),
  // so we substitute a generic "[redacted]" string for the persisted error
  // on the redaction path while still letting the original error reach the
  // model via the returned tool result.
  const safetyBlocked =
    parsed.success === false &&
    typeof parsed.error === "string" &&
    (parsed.error.startsWith("Blocked:") || parsed.error.startsWith("Invalid URL:"));
  const safeArgs = safetyBlocked && typeof args.url === "string"
    ? { ...args, url: "[redacted]" }
    : args;
  const safeTarget = safetyBlocked && typeof args.url === "string"
    ? "[redacted]"
    : typeof args.url === "string"
      ? args.url
      : typeof args.ref === "string"
        ? args.ref
        : action;
  const safeError = safetyBlocked ? "[redacted]" : parsed.error ?? null;
  appendTrace(config.instance, taskId, {
    type: parsed.success === false ? "error" : "tool",
    message: `Browser tool ${action}`,
    data: { action, args: safeArgs, success: parsed.success !== false, error: safeError }
  });
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    state.audit.unshift({
      id: `audit_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      instance: state.instance,
      at: now(),
      actor: "agent",
      action,
      target: safeTarget,
      risk,
      taskId: item.id,
      runId: item.runId,
      evidence: { args: safeArgs, success: parsed.success !== false, error: safeError }
    });
    item.updatedAt = now();
  });
  return result;
}

// Sum a per-call CostRecord into the owning task's running cost row.
// Mirrors addCost in src/execution/chat-task.ts: token totals add; USD
// estimates add when present; provider/model track the most recent call.
// This keeps task.cost honest when out-of-band side calls (like
// browser_vision's provider request) consume tokens the main agent loop
// doesn't see directly.
async function accumulateBrowserVisionCost(
  config: RuntimeConfig,
  taskId: string,
  rawResult: string
): Promise<void> {
  let parsed: { cost?: Record<string, unknown> | null } = {};
  try {
    parsed = JSON.parse(rawResult) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed.cost || typeof parsed.cost !== "object") return;
  const increment = parsed.cost as {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedUsd?: number;
  };
  // Skip entirely if there's nothing numeric to add (e.g. the provider
  // didn't return usage). Avoids pointless mutateState round-trips.
  if (
    increment.inputTokens === undefined &&
    increment.outputTokens === undefined &&
    increment.totalTokens === undefined &&
    increment.estimatedUsd === undefined
  ) {
    return;
  }
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const sum = (a: number | undefined, b: number | undefined): number | undefined => {
      if (a === undefined && b === undefined) return undefined;
      return (a ?? 0) + (b ?? 0);
    };
    const prev = item.cost;
    item.cost = {
      provider: increment.provider ?? prev?.provider ?? "",
      model: increment.model ?? prev?.model ?? "",
      inputTokens: sum(prev?.inputTokens, increment.inputTokens),
      outputTokens: sum(prev?.outputTokens, increment.outputTokens),
      totalTokens: sum(prev?.totalTokens, increment.totalTokens),
      estimatedUsd: sum(prev?.estimatedUsd, increment.estimatedUsd)
    };
    item.updatedAt = now();
  });
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
  // Trust-hijack fix: when both a bundled and a user record share a name,
  // prefer the bundled (vendored) row first since it's the audited source
  // of truth. A user record with the same name remains independent and
  // stays draft until the user trusts it.
  const matches = state.skills.filter((s) => s.name === name);
  if (matches.length === 0) throw new Error(`No skill named ${name} is registered.`);
  const skill = matches.find((s) => (s.source ?? "user") === "bundled") ?? matches[0]!;
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

  const final = await waitForSubagentTerminal(config, subagentId, timeoutMs, taskId);

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

// Schedule a real job (cron-style) and link it to the originating chat
// session so the job's output is delivered back as an assistant message
// when it fires. Low-risk: no approval gate, since reminders should not
// pop a modal — the user can pause/delete the job at any time via /jobs.
// We discover the originating session by walking task → run → conversation.
async function createJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = requireString(args, "name");
  const prompt = requireString(args, "prompt");
  if (typeof args.intervalSeconds !== "number" || !Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0 || !Number.isInteger(args.intervalSeconds)) {
    throw new Error("Invalid input: intervalSeconds must be a positive integer.");
  }
  const intervalSeconds = args.intervalSeconds;
  // Coerce oneShot to a strict boolean. Treat `undefined`/`null` as false
  // (recurring), and anything else (string "true", number 1) is rejected
  // so the agent has a clean contract.
  let oneShot = false;
  if (args.oneShot !== undefined && args.oneShot !== null) {
    if (typeof args.oneShot !== "boolean") {
      throw new Error("Invalid input: oneShot must be a boolean.");
    }
    oneShot = args.oneShot;
  }

  // Walk task -> run -> conversation to find the originating chat session.
  // If the caller is imperative (CLI, no run, or run without conversation),
  // we leave chatSessionId undefined and the job runs without delivery
  // back into a session.
  const state = readState(config.instance);
  const task = state.tasks.find((item) => item.id === taskId);
  let chatSessionId: string | undefined;
  if (task?.runId) {
    const run = state.runs.find((item) => item.id === task.runId);
    if (run?.conversationId) {
      // Confirm the session still exists; otherwise leave undefined so the
      // dispatcher doesn't try to push the new task onto a missing record.
      const session = state.chatSessions.find((item) => item.id === run.conversationId);
      if (session) chatSessionId = session.id;
    }
  }

  const job = await createScheduledJob(config, { name, intervalSeconds, prompt, chatSessionId, oneShot });

  await mutateState(config.instance, (current) => {
    const item = findTask(current, taskId);
    addAudit(current, {
      actor: "agent",
      action: "job.created",
      target: job.id,
      risk: "low",
      taskId: item.id,
      runId: item.runId,
      evidence: { name, intervalSeconds, oneShot, chatSessionId, jobId: job.id }
    });
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Created scheduled job",
    data: { jobId: job.id, name, intervalSeconds, oneShot, chatSessionId }
  });

  const cadence = oneShot ? "one-shot" : `every ${intervalSeconds}s`;
  return `Created job ${job.id} (\"${name}\"): ${cadence}, fires at ${job.nextRunAt}.`;
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
  timeoutMs: number,
  parentTaskId?: string
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
    // Parent cancellation should short-circuit the wait so the parent
    // task can exit cleanly. The cascade in cancelTask will eventually
    // mark the subagent cancelled too, but we shouldn't pin the parent
    // dispatch loop on that round-trip.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent?.status === "cancelled") {
        return { status: "cancelled", error: "Parent task was cancelled while subagent was running." };
      }
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

// Approval-gated browser_upload_file. Validates the workspace path (and
// its symlink target) before opening the approval row so the user sees a
// real, in-workspace file on the approval card. The actual setInputFiles
// call runs in agent.executeApprovedAction's "browser.upload_file"
// branch, which calls browserUploadFileApproved with the captured ref +
// resolved path.
async function requestBrowserUpload(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const ref = requireString(args, "ref");
  const userPath = requireString(args, "path");
  // resolveUploadPath throws on invalid / outside-workspace / symlink-escape.
  // Let it propagate so the dispatch loop surfaces the error message to the
  // model as a tool error (matching how requestFileWrite handles
  // assertInsideWorkspace failures).
  const resolved = resolveUploadPath(config.workspaceRoot, userPath);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "browser.upload_file",
      target: resolved.displayPath,
      risk: "high",
      reason: "Uploading a workspace file to a remote site is a side effect and requires explicit approval.",
      payload: {
        ref,
        path: userPath,
        resolvedPath: resolved.absolute,
        currentUrl: "",
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser upload (chat-task)",
      data: { approvalId: approval.id, target: resolved.displayPath, ref, toolCallId }
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

// Either auto-approves (if the user added a matching pattern to
// `RuntimeConfig.autoApproveCommands`) or creates an approval row and
// pauses the task. Auto-approved commands still produce a high-risk
// `terminal.exec` audit row so the activity trail is identical from the
// reviewer's perspective — the only difference is `evidence.autoApproved
// = true` and `evidence.autoApprovedReason = <matched pattern>`.
async function terminalExecDispatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const command = requireString(args, "command");
  const timeoutMs = optionalNumber(args, "timeoutMs", 60_000);
  const pty = args.pty === true;

  const matchedPattern = matchAutoApprove(config.autoApproveCommands, command);
  if (matchedPattern) {
    appendTrace(config.instance, taskId, {
      type: "approval",
      message: "Auto-approved terminal command (allowlist match)",
      data: { command, pty, matchedPattern, toolCallId }
    });
    const result = await runTerminalCommand(config, taskId, command, {
      timeoutMs,
      pty,
      evidenceExtra: { autoApproved: true, autoApprovedReason: matchedPattern, toolCallId }
    });
    return { kind: "sync", result: result.summary };
  }

  const approvalId = await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "Terminal execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs, pty, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for terminal command (chat-task)",
      data: { approvalId: approval.id, command, pty, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
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
