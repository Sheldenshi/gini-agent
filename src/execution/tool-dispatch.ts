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
  isTerminalTaskStatus,
  mutateState,
  now,
  readState
} from "../state";
import { ApprovalRaceLostError, ApprovedActionFailedError, TaskAlreadyTerminalError, findTask, resolveApproval, runTerminalCommand } from "../agent";
import { walkFiles, simpleDiff } from "../tools/file";
import { codeExecutionCommand } from "../tools/code";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "../capabilities/subagents";
import { matchAutoApprove } from "./auto-approve";
import { resolveApprovalPolicy, type PolicyAction } from "./policy";
import { createScheduledJob, listJobs, removeJob, runJobNow, updateJob, updateJobStatus } from "../jobs";
import { createMemoryFromInput, editMemory, recall } from "../memory";
import { resolveEffectiveContext } from "./effective-context";
import { searchSessions } from "./search";
import { isSkillActive } from "../integrations/connectors";
import { riskForAction } from "./tool-risk";
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
  peekCurrentBrowserUrl,
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
    case "list_jobs":
      return { kind: "sync", result: await listJobsTool(config, taskId, args) };
    case "update_job":
      return { kind: "sync", result: await updateJobTool(config, taskId, args) };
    case "delete_job":
      return { kind: "sync", result: await deleteJobTool(config, taskId, args) };
    case "run_job":
      return { kind: "sync", result: await runJobTool(config, taskId, args) };
    case "recall_memory":
      return { kind: "sync", result: await recallMemoryTool(config, taskId, args) };
    case "add_memory":
      return { kind: "sync", result: await addMemoryTool(config, taskId, args) };
    case "update_memory":
      return { kind: "sync", result: await updateMemoryTool(config, taskId, args) };
    case "search_history":
      return { kind: "sync", result: await searchHistoryTool(config, taskId, args) };
    case "send_message":
      return pendingOrAuto(config, "messaging.send", undefined, (reason) => requestSendMessage(config, taskId, toolCallId, args, reason));
    case "invoke_mcp":
      return pendingOrAuto(config, "mcp.invoke", undefined, (reason) => requestInvokeMcp(config, taskId, toolCallId, args, reason));
    case "browser_navigate":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.navigate", () => browserNavigate(taskId, args), args) };
    case "browser_snapshot":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.snapshot", () => browserSnapshot(taskId, args), args) };
    case "browser_click":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.click", () => browserClick(taskId, args), args) };
    case "browser_type":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.type", () => browserType(taskId, args), args) };
    case "browser_press":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.press", () => browserPress(taskId, args), args) };
    case "browser_scroll":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.scroll", () => browserScroll(taskId, args), args) };
    case "browser_back":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.back", () => browserBack(taskId, args), args) };
    case "browser_console":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.console", () => browserConsole(taskId, args), args) };
    case "browser_close":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.close", () => browserClose(taskId, args), args) };
    case "browser_hover":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.hover", () => browserHover(taskId, args), args) };
    case "browser_drag":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.drag", () => browserDrag(taskId, args), args) };
    case "browser_select_option":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.select_option", () => browserSelectOption(taskId, args), args) };
    case "browser_wait_for":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.wait_for", () => browserWaitFor(taskId, args), args) };
    case "browser_tabs": {
      // tabs.list is read-only (low risk); tabs.new/switch/close mutate the
      // active page (medium). Encode that into the action label so the risk
      // registry in tool-risk.ts picks the right bucket without re-parsing
      // args downstream.
      const tabsAction = typeof args.action === "string" ? args.action : "";
      const label =
        tabsAction === "new" || tabsAction === "switch" || tabsAction === "close"
          ? `browser.tabs.${tabsAction}`
          : "browser.tabs.list";
      return { kind: "sync", result: await browserDispatch(config, taskId, label, () => browserTabs(taskId, args), args) };
    }
    case "browser_vision": {
      const result = await browserDispatch(config, taskId, "browser.vision", () => browserVision(taskId, args, config), args);
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
      return pendingOrAuto(config, "browser.upload_file", undefined, (reason) => requestBrowserUpload(config, taskId, toolCallId, args, reason));
    case "file_write":
      return pendingOrAuto(config, "file.write", undefined, (reason) => requestFileWrite(config, taskId, toolCallId, args, reason));
    case "file_patch":
      return pendingOrAuto(config, "file.patch", undefined, (reason) => requestFilePatch(config, taskId, toolCallId, args, reason));
    case "terminal_exec":
      return terminalExecDispatch(config, taskId, toolCallId, args);
    case "code_exec":
      // code_exec compiles to a terminal command. Route through the
      // policy seam as terminal.exec so dangerous-pattern matching
      // applies uniformly (a code snippet that shells out to `sudo`
      // gets gated the same way a terminal_exec would). The
      // `command` field on the payload is what the policy inspects.
      return codeExecDispatch(config, taskId, toolCallId, args);
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

// Wraps a browser tool invocation with the trace+audit ceremony every other
// chat-task tool emits. Browser tools return JSON strings on their own
// (success or error), so we don't second-guess their result — we just log
// the dispatch and pass it through. Audit risk is derived from the single
// source of truth in src/execution/tool-risk.ts:
//   - read-only paths (navigate/snapshot/hover/scroll/back/press/console/
//     close/wait_for/tabs.list/vision) are "low"
//   - side-effecting calls (click/type/drag/select_option/tabs.{new,switch,
//     close}) are "medium"
// browser.upload_file is classified "high" in the registry but never
// reaches this dispatcher: it's intercepted as an approval request in
// requestBrowserUpload and executed via agent.executeApprovedAction after
// explicit user consent.
//
// Callers pass a thunk so the legacy `(taskId, args)` tools and the
// config-bearing browser_vision can share one wrapper without forcing a
// uniform signature on the tool functions themselves.
async function browserDispatch(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  thunk: () => Promise<string>,
  args: Record<string, unknown>
): Promise<string> {
  // Pre-side-effect terminal check. Browser tools execute their
  // action (click / type / navigate / etc.) inside the thunk
  // BEFORE any audit/state mutation; without this check a
  // `cancelTask` that landed between the chat-task per-call guard
  // releasing its `mutateState` lock and our await on `thunk()`
  // would let the browser action still mutate the page. We don't
  // have a signal to thread into Playwright, so the best we can do
  // is refuse to invoke the thunk when the task is already
  // terminal.
  const preStatus = readState(config.instance).tasks.find((t) => t.id === taskId)?.status;
  if (preStatus && isTerminalTaskStatus(preStatus)) {
    return JSON.stringify({ success: false, aborted: true, error: `Browser action skipped: task is already ${preStatus}.` });
  }
  const result = await thunk();
  const risk = riskForAction(action);
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
    addAudit(
      state,
      {
        actor: "agent",
        action,
        target: safeTarget,
        risk,
        taskId: item.id,
        runId: item.runId,
        evidence: { args: safeArgs, success: parsed.success !== false, error: safeError }
      },
      { taskId: item.id }
    );
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

// Skill catalog access. Returns the full markdown body of an enabled skill
// so the model can follow its instructions. We deliberately gate on the
// "enabled" status — disabled / archived skills are invisible
// to the agent loop. The system prompt only advertises enabled skills, so
// the model shouldn't request anything else; if it does, surface the
// reason to the model as a tool error rather than silently returning empty.
async function readSkillTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const name = requireString(args, "name");
  const state = readState(config.instance);
  // When both a bundled and a user record share a name, prefer an enabled
  // bundled row first, then any enabled row. This mirrors the advertised
  // skill block: disabled rows stay invisible even when they share a name
  // with an enabled skill.
  const matches = state.skills.filter((s) => s.name === name);
  if (matches.length === 0) throw new Error(`No skill named ${name} is registered.`);
  const enabledMatches = matches.filter((s) => s.status === "enabled");
  const skill = enabledMatches.find((s) => (s.source ?? "user") === "bundled") ?? enabledMatches[0] ?? matches[0]!;
  if (skill.status !== "enabled") {
    throw new Error(`Skill ${name} is disabled (current status: ${skill.status}). Ask the user to enable it via /skills before using.`);
  }
  if (!isSkillActive(state, skill)) {
    const missing = (skill.requiredConnectors ?? []).map((entry) => entry.provider).join(", ");
    throw new Error(`Skill ${name} is inactive: required connectors not healthy (${missing || "unknown"}). Ask the user to set up the missing connector — they can click [Set up <Provider>] next to the affected skill on the /skills page, or paste the credential and you'll wire it up.`);
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Skill body read (chat-task)",
    data: { name: skill.name, version: skill.version, bytes: skill.body.length, allowedTools: skill.allowedTools }
  });
  await recordLowRiskAudit(config, taskId, "skill.read", skill.id, {
    name: skill.name,
    version: skill.version,
    bytes: skill.body.length,
    // ADR connector-provider-spec-compliance.md: capture the declared allowed-tools at read time so the audit
    // trail records the contract the agent agreed to follow when invoking
    // this skill. Not enforced at the tool dispatcher yet — see ADR connector-provider-spec-compliance.md
    // "Deferred" for the enforcement plan.
    allowedTools: skill.allowedTools
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

  // Pre-side-effect terminal check. `spawnSubagent` creates a
  // durable child task; refuse when the parent task is already
  // terminal so cancel + auto-approve doesn't leak a fresh subagent
  // run against a cancelled parent. The serialized re-check inside
  // `spawnSubagent`'s `mutateState` is the authoritative guard;
  // this is the cheap early-exit so we don't even reach the
  // record-creation lock.
  const stateNow = readState(config.instance);
  const parentStatus = stateNow.tasks.find((t) => t.id === taskId)?.status;
  if (parentStatus && isTerminalTaskStatus(parentStatus)) {
    return `Error: spawn_subagent skipped because parent task is already ${parentStatus}.`;
  }

  // Pre-flight depth check so we can return a clean error to the model
  // instead of throwing an exception that becomes a generic tool error.
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
    addAudit(
      state,
      {
        actor: "agent",
        action: "subagent.spawn",
        target: name,
        risk: "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: { name, promptBytes: prompt.length, toolsets, skills, depth }
      },
      { taskId: item.id }
    );
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
    // `spawnSubagent` refuses inside its own `mutateState` when
    // the parent task is terminal. Convert that into a clean
    // "skipped" tool result rather than the generic
    // "spawn_subagent failed" tool error so the model sees a
    // coherent no-op.
    if (message.startsWith("Cannot spawn subagent: parent task ")) {
      appendTrace(config.instance, taskId, {
        type: "task",
        message: `spawn_subagent skipped: parent task is terminal`,
        data: { message }
      });
      return `Error: spawn_subagent skipped because parent task became terminal between pre-check and spawn.`;
    }
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
  // Exactly one of (intervalSeconds, cronExpression) must drive the
  // schedule. The authoritative validation lives in `createScheduledJob`,
  // but doing a fast-path check here gives the agent a typed tool-result
  // error before we touch the per-instance lock.
  const intervalProvided = args.intervalSeconds !== undefined && args.intervalSeconds !== null;
  const cronProvided = args.cronExpression !== undefined && args.cronExpression !== null;
  if (intervalProvided && cronProvided) {
    throw new Error("Invalid input: cronExpression and intervalSeconds are mutually exclusive.");
  }
  if (!intervalProvided && !cronProvided) {
    throw new Error("Invalid input: create_job requires either intervalSeconds or cronExpression.");
  }
  let intervalSeconds: number | undefined;
  if (intervalProvided) {
    if (typeof args.intervalSeconds !== "number" || !Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0 || !Number.isInteger(args.intervalSeconds)) {
      throw new Error("Invalid input: intervalSeconds must be a positive integer.");
    }
    intervalSeconds = args.intervalSeconds;
  }
  let cronExpression: string | undefined;
  if (cronProvided) {
    if (typeof args.cronExpression !== "string" || args.cronExpression.trim().length === 0) {
      throw new Error("Invalid input: cronExpression must be a non-empty string.");
    }
    cronExpression = args.cronExpression;
  }
  let cronTimezone: string | undefined;
  if (args.cronTimezone !== undefined && args.cronTimezone !== null) {
    if (typeof args.cronTimezone !== "string" || args.cronTimezone.length === 0) {
      throw new Error("Invalid input: cronTimezone must be a non-empty string.");
    }
    cronTimezone = args.cronTimezone;
  }
  // `cronTimezone` without `cronExpression` is a payload mistake (it has
  // nothing to apply to). Reject up-front so the agent sees the error
  // before the lock-serialized re-check in `createScheduledJob` does.
  if (cronTimezone !== undefined && cronExpression === undefined) {
    throw new Error("Invalid input: cronTimezone may only be set when cronExpression is set.");
  }
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
  // Per-job auto-approve envelope. Same validation shape as
  // `createScheduledJob` so the agent gets a typed rejection (which the
  // chat-task loop relays back as a tool-result error) instead of
  // silently coercing a bogus payload. The authoritative re-check lives
  // in createScheduledJob; this is a fast-path so we can fail before
  // touching the per-instance lock.
  let dangerouslyAutoApprove: boolean | undefined;
  if (args.dangerouslyAutoApprove !== undefined && args.dangerouslyAutoApprove !== null) {
    if (typeof args.dangerouslyAutoApprove !== "boolean") {
      throw new Error("Invalid input: dangerouslyAutoApprove must be a boolean.");
    }
    dangerouslyAutoApprove = args.dangerouslyAutoApprove;
  }
  let approvalMode: "strict" | "auto" | "yolo" | undefined;
  if (args.approvalMode !== undefined && args.approvalMode !== null) {
    if (args.approvalMode !== "strict" && args.approvalMode !== "auto" && args.approvalMode !== "yolo") {
      throw new Error("Invalid input: approvalMode must be one of \"strict\" | \"auto\" | \"yolo\".");
    }
    approvalMode = args.approvalMode;
  }
  let autoApproveCommands: string[] | undefined;
  if (args.autoApproveCommands !== undefined && args.autoApproveCommands !== null) {
    if (!Array.isArray(args.autoApproveCommands)) {
      throw new Error("Invalid input: autoApproveCommands must be an array of strings.");
    }
    const cleaned: string[] = [];
    for (const entry of args.autoApproveCommands) {
      if (typeof entry !== "string") {
        throw new Error("Invalid input: autoApproveCommands entries must be strings.");
      }
      if (entry.length === 0) {
        throw new Error("Invalid input: autoApproveCommands entries must be non-empty strings.");
      }
      cleaned.push(entry);
    }
    autoApproveCommands = cleaned;
  }
  let dangerousTerminalPatterns: string[] | undefined;
  if (args.dangerousTerminalPatterns !== undefined && args.dangerousTerminalPatterns !== null) {
    if (!Array.isArray(args.dangerousTerminalPatterns)) {
      throw new Error("Invalid input: dangerousTerminalPatterns must be an array of strings.");
    }
    const cleaned: string[] = [];
    for (const entry of args.dangerousTerminalPatterns) {
      if (typeof entry !== "string") {
        throw new Error("Invalid input: dangerousTerminalPatterns entries must be strings.");
      }
      if (entry.length === 0) {
        throw new Error("Invalid input: dangerousTerminalPatterns entries must be non-empty strings.");
      }
      cleaned.push(entry);
    }
    dangerousTerminalPatterns = cleaned;
  }
  let timeoutSeconds: number | undefined;
  if (args.timeoutSeconds !== undefined && args.timeoutSeconds !== null) {
    if (typeof args.timeoutSeconds !== "number" || !Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0 || !Number.isInteger(args.timeoutSeconds)) {
      throw new Error("Invalid input: timeoutSeconds must be a positive integer.");
    }
    timeoutSeconds = args.timeoutSeconds;
  }

  // Walk task -> run -> conversation to determine whether the agent is
  // invoking us from inside a chat task. If so, we want each scheduled
  // job to publish into its OWN dedicated chat thread (so a daily report
  // doesn't bury the originating conversation under 365 future fires).
  // Otherwise (CLI / imperative task), the job runs without any chat
  // delivery target — same as before.
  const state = readState(config.instance);
  const task = state.tasks.find((item) => item.id === taskId);
  // Pre-side-effect terminal check. `create_job` persists a
  // durable scheduled job; refuse when the parent task is already
  // terminal so cancel + auto-approve doesn't leak a recurring job
  // past the cancellation. The serialized re-check inside
  // `createScheduledJob`'s `mutateState` is the authoritative
  // guard; this early-exit just avoids touching the lock.
  if (task && isTerminalTaskStatus(task.status)) {
    return `Error: create_job skipped because task is already ${task.status}.`;
  }
  // The agent's caller is "chat-bound" when its task is attached to a run
  // whose conversation still exists. That's the trigger to mint a fresh
  // chat thread for the job to deliver into.
  let invokedFromChat = false;
  if (task?.runId) {
    const run = state.runs.find((item) => item.id === task.runId);
    if (run?.conversationId) {
      const session = state.chatSessions.find((item) => item.id === run.conversationId);
      if (session) invokedFromChat = true;
    }
  }

  // Pass `parentTaskId` so `createScheduledJob`'s own `mutateState`
  // callback can re-check terminal status atomically. The earlier
  // lock-free `readState` pre-check is kept as a fast path / error-
  // message-quality improvement; this is the authoritative
  // serialization point. `createScheduledJob` throws if the parent
  // task is already terminal. When `invokedFromChat`, we ask
  // createScheduledJob to mint a fresh ChatSessionRecord atomically
  // alongside the JobRecord (single mutateState write — no orphan
  // session on a validation failure).
  let job;
  try {
    job = await createScheduledJob(config, {
      name,
      // intervalSeconds is undefined when cron drives the schedule —
      // createScheduledJob's mutual-exclusion guard treats that as the
      // "not interval-driven" case and stores 0 as the sentinel.
      intervalSeconds,
      cronExpression,
      cronTimezone,
      prompt,
      // Dedicated chat thread for chat-driven jobs. Title defaults to
      // the job name — the chat IS bound to that job's delivery, so the
      // job name is the natural label in the session list. (createChatSession
      // truncates to 80 chars.)
      createDedicatedSession: invokedFromChat ? { title: name } : undefined,
      oneShot,
      parentTaskId: taskId,
      dangerouslyAutoApprove,
      approvalMode,
      autoApproveCommands,
      dangerousTerminalPatterns,
      timeoutSeconds
    }, {
      // Inherit the originating task's owning agent so a scheduler tick
      // doesn't reattribute the job to whichever agent happens to be
      // active at fire time. Threaded through the trusted options bag
      // so a malicious HTTP client can't spoof it via the request body.
      originatingAgentId: task?.agentId
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Cannot create scheduled job: parent task ")) {
      return `Error: create_job skipped because parent task was cancelled between pre-check and job creation.`;
    }
    throw err;
  }
  // The job's chatSessionId is the freshly-minted dedicated thread when
  // invokedFromChat, or undefined for imperative/CLI invocations.
  const chatSessionId = job.chatSessionId;

  await mutateState(config.instance, (current) => {
    const item = findTask(current, taskId);
    addAudit(
      current,
      {
        actor: "agent",
        action: "job.created",
        target: job.id,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          name,
          intervalSeconds,
          cronExpression,
          cronTimezone,
          oneShot,
          chatSessionId,
          jobId: job.id,
          dangerouslyAutoApprove,
          approvalMode,
          autoApproveCommands,
          dangerousTerminalPatterns,
          timeoutSeconds
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Created scheduled job",
    data: {
      jobId: job.id,
      name,
      intervalSeconds,
      cronExpression,
      cronTimezone,
      oneShot,
      chatSessionId,
      dangerouslyAutoApprove,
      approvalMode,
      autoApproveCommands,
      dangerousTerminalPatterns,
      timeoutSeconds
    }
  });

  // Cadence string surfaces the right vocabulary back to the agent so its
  // follow-up reply to the user describes the actual schedule shape.
  const cadence = oneShot
    ? "one-shot"
    : cronExpression
      ? `cron \"${cronExpression}\" (${cronTimezone ?? "UTC"})`
      : `every ${intervalSeconds}s`;
  // When the job has a dedicated chat thread, surface its id in the
  // tool-call result so the model's follow-up reply can mention both the
  // job id and the new chat id ("Each run posts into a dedicated thread.").
  // Imperative/CLI invocations skip this suffix — there's no chat to point at.
  const sessionSuffix = chatSessionId ? ` into ${chatSessionId}` : "";
  return `Created job ${job.id} (\"${name}\"): ${cadence}, fires at ${job.nextRunAt}${sessionSuffix}.`;
}

// Read-only listing of scheduled jobs. Cheap, low-risk: just walks
// `state.jobs` and returns a compact summary the agent can reason about
// without spending tokens on internal-only fields. The agent uses this to
// resolve "this job" / "my reminder" to a real job id before calling
// update_job or delete_job.
async function listJobsTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  let nameContains: string | undefined;
  if (args.nameContains !== undefined && args.nameContains !== null) {
    if (typeof args.nameContains !== "string") {
      throw new Error("Invalid input: nameContains must be a string.");
    }
    nameContains = args.nameContains.toLowerCase();
  }
  let fullPrompt = false;
  if (args.fullPrompt !== undefined && args.fullPrompt !== null) {
    if (typeof args.fullPrompt !== "boolean") {
      throw new Error("Invalid input: fullPrompt must be a boolean.");
    }
    fullPrompt = args.fullPrompt;
  }
  const all = listJobs(config);
  const filtered = nameContains
    ? all.filter((job) => job.name.toLowerCase().includes(nameContains!))
    : all;
  // Compact summary: only the fields an agent needs to identify and
  // describe a job. Prompts default to a 200-char truncation so a
  // long-prompt job doesn't blow up the tool-result context. When the
  // caller passes `fullPrompt: true` we return verbatim prompts — the
  // agent needs this when it intends to edit a prompt (append /
  // search-and-replace), since update_job's prompt field is REPLACE-only.
  // Schedule fields are reported as-is (cronExpression+cronTimezone for
  // cron jobs, intervalSeconds for interval-driven jobs) so the agent
  // can echo the user's vocabulary.
  const summary = filtered.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    cronExpression: job.cronExpression,
    cronTimezone: job.cronTimezone,
    intervalSeconds: job.intervalSeconds,
    oneShot: job.oneShot === true,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    chatSessionId: job.chatSessionId,
    prompt: fullPrompt
      ? job.prompt
      : job.prompt.length > 200
        ? `${job.prompt.slice(0, 200)}…`
        : job.prompt
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed jobs",
    data: { total: all.length, returned: summary.length, nameContains, fullPrompt }
  });
  await recordLowRiskAudit(config, taskId, "job.listed", "jobs", {
    total: all.length,
    returned: summary.length,
    nameContains,
    fullPrompt
  });
  return JSON.stringify({ count: summary.length, jobs: summary });
}

// Patch an existing job in place. Preferred over delete+create for
// schedule/prompt/status changes — preserves job id, dedicated chat
// thread, and run history. Validation lives in `updateJob` (typed
// `Invalid input: …` errors surface back as tool-result errors).
async function updateJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Mirrors the guard pattern in
  // `create_job`: refuse when the parent task is already terminal so a
  // late cancel doesn't leak a mutation past the cancellation. The
  // serialized re-check inside `updateJob` / `updateJobStatus` (via
  // `parentTaskId`) is the authoritative guard; this early-exit avoids
  // touching the lock for the common case.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return `Error: update_job skipped because task is already ${task.status}.`;
    }
  }

  // Collect status separately — `updateJob` handles every other field but
  // status lives in `updateJobStatus` (different audit action vocabulary).
  let statusPatch: "active" | "paused" | undefined;
  if (args.status !== undefined && args.status !== null) {
    if (args.status !== "active" && args.status !== "paused") {
      throw new Error("Invalid input: status must be 'active' or 'paused'.");
    }
    statusPatch = args.status;
  }

  // Build the patch payload for `updateJob` — pass only the keys the
  // caller explicitly supplied so we don't accidentally clear fields with
  // undefined. `null` is meaningful (it's the "clear this field" signal
  // for cronExpression / cronTimezone / intervalSeconds) so we preserve
  // it.
  const patch: Record<string, unknown> = {};
  const passthrough = [
    "name",
    "prompt",
    "intervalSeconds",
    "cronExpression",
    "cronTimezone",
    "timeoutSeconds",
    "autoApproveCommands",
    "dangerouslyAutoApprove"
  ] as const;
  for (const key of passthrough) {
    if (key in args) patch[key] = args[key];
  }
  // oneShot lives on the JobRecord but isn't part of `updateJob`'s patch
  // contract — apply it directly inside the same mutateState so the audit
  // row reflects every field the agent touched. We forward it via
  // `mutateState` below after `updateJob` returns. Validate up-front so
  // we fail before any persistence happens.
  let oneShotPatch: boolean | undefined;
  if (args.oneShot !== undefined && args.oneShot !== null) {
    if (typeof args.oneShot !== "boolean") {
      throw new Error("Invalid input: oneShot must be a boolean.");
    }
    oneShotPatch = args.oneShot;
  }

  const hasFieldPatch =
    Object.keys(patch).length > 0 || oneShotPatch !== undefined;
  if (!hasFieldPatch && statusPatch === undefined) {
    throw new Error("Invalid input: update_job requires at least one field to change.");
  }

  // Capture the previous schedule shape for the audit evidence BEFORE we
  // mutate. The audit row pins the prior fields so the change is
  // reconstructable from the log alone.
  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);
  const previousSchedule = {
    cronExpression: before.cronExpression,
    cronTimezone: before.cronTimezone,
    intervalSeconds: before.intervalSeconds,
    oneShot: before.oneShot === true,
    status: before.status
  };

  // Forward `taskId` as `parentTaskId` so each mutator's own
  // `mutateState` callback can re-check terminal status atomically. The
  // earlier lock-free `readState` pre-check is kept as a fast path /
  // error-message-quality improvement; this is the authoritative
  // serialization point.
  if (hasFieldPatch && Object.keys(patch).length > 0) {
    await updateJob(config, jobId, patch, taskId);
  }
  if (oneShotPatch !== undefined) {
    // The inline oneShot mutation has no shared mutator function, so we
    // do the same atomic parent-task re-check inline.
    await mutateState(config.instance, (state) => {
      const parent = state.tasks.find((t) => t.id === taskId);
      // Match the narrower predicate used by the shared job mutators in
      // src/jobs/index.ts (createScheduledJob, updateJob, updateJobStatus,
      // removeJob): refuse only on `cancelled`/`failed`. `completed`
      // parents are permitted to manage jobs (e.g. a completed task's
      // final action may be a job cleanup or follow-up). Using the wider
      // `isTerminalTaskStatus` predicate here would diverge from the
      // sibling patches in this same update_job call and silently reject
      // the oneShot field while the schedule/name/prompt patch landed.
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot update job: parent task ${taskId} is already ${parent.status}.`);
      }
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      job.oneShot = oneShotPatch;
      job.updatedAt = now();
    });
  }
  if (statusPatch !== undefined) {
    await updateJobStatus(config, jobId, statusPatch, taskId);
  }

  const after = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!after) throw new Error(`Job not found after update: ${jobId}`);

  // Compose evidence describing exactly which fields were touched. We
  // record only the patch keys the caller supplied (plus `status` and
  // `oneShot` if present) so the audit row mirrors the agent's intent.
  const appliedFields = [
    ...Object.keys(patch),
    ...(oneShotPatch !== undefined ? ["oneShot"] : []),
    ...(statusPatch !== undefined ? ["status"] : [])
  ];
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.updated",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          jobId,
          appliedFields,
          patch: { ...patch, ...(oneShotPatch !== undefined ? { oneShot: oneShotPatch } : {}), ...(statusPatch !== undefined ? { status: statusPatch } : {}) },
          previousSchedule
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Updated scheduled job",
    data: { jobId, appliedFields }
  });

  const cadence = after.cronExpression
    ? `cron \"${after.cronExpression}\" (${after.cronTimezone ?? "UTC"})`
    : after.intervalSeconds
      ? `every ${after.intervalSeconds}s`
      : "no schedule";
  // Only an active job has a meaningful next-fire moment. A paused job's
  // `nextRunAt` may still be populated (the scheduler simply skips it
  // while paused), but stating "next fires at ..." would lie to the
  // caller. Likewise, guard against an unexpectedly absent nextRunAt on
  // active jobs so the message doesn't read "next fires at undefined".
  const firingClause =
    after.status === "paused"
      ? "will not fire until resumed"
      : after.nextRunAt
        ? `next fires at ${after.nextRunAt}`
        : "next-fire moment pending";
  return `Updated job ${after.id} (\"${after.name}\"): ${appliedFields.join(", ")}. Now ${after.status}, ${cadence}, ${firingClause}.`;
}

// Delete a job and cascade-remove its run history. Low-risk for symmetry
// with create_job: the user can always re-create. The audit row pins
// the prior schedule shape so the deleted job is reconstructable from
// the log alone.
async function deleteJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Mirrors the guard pattern in
  // `create_job`: refuse when the parent task is already terminal so a
  // late cancel doesn't leak a mutation past the cancellation. The
  // serialized re-check inside `removeJob` (via `parentTaskId`) is the
  // authoritative guard; this early-exit avoids touching the lock for
  // the common case.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return `Error: delete_job skipped because task is already ${task.status}.`;
    }
  }

  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);
  const previousSchedule = {
    name: before.name,
    cronExpression: before.cronExpression,
    cronTimezone: before.cronTimezone,
    intervalSeconds: before.intervalSeconds,
    oneShot: before.oneShot === true,
    status: before.status,
    chatSessionId: before.chatSessionId
  };
  const removed = await removeJob(config, jobId, taskId);
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.deleted",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          jobId,
          name: removed.name,
          previousSchedule
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Deleted scheduled job",
    data: { jobId, name: removed.name }
  });
  return `Deleted job ${removed.id} (\"${removed.name}\").`;
}

// Manually fire an existing scheduled job. Wraps the same `runJobNow`
// entrypoint that `POST /api/jobs/<id>/run` calls, with `trigger="manual"`
// so overlap protection is intentionally skipped (manual runs may execute
// alongside an in-flight scheduled run). The spawned task itself still
// flows through the job's configured approval envelope at fire-time.
async function runJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Lock-free fast path: avoid touching
  // the state lock when the parent task is already terminal. The
  // serialized re-check inside `runJobNow` (via `parentTaskId`) is the
  // authoritative guard against a `cancelTask` landing between this
  // pre-check and our write.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return `Error: run_job skipped because task is already ${task.status}.`;
    }
  }

  // Resolve the job up-front so we can surface its name in the return
  // string (and fail fast on an unknown id instead of letting `runJobNow`
  // throw deep in its mutateState).
  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);

  const result = await runJobNow(config, jobId, "manual", taskId);
  // `runJobNow` only returns undefined on the overlap-skip branch, which
  // is gated on trigger==="schedule" — so for "manual" it should never
  // happen in normal operation. Surface a clear error if the contract ever
  // changes rather than crashing on the destructure below.
  if (!result) {
    throw new Error(`run_job for ${jobId} produced no run (overlap skip should not apply to manual triggers).`);
  }
  // Script jobs return { jobId, runId, exitCode, stdout, stderr }; prompt
  // jobs return { jobId, runId, taskId }. The taskId is only meaningful for
  // prompt jobs — script jobs run synchronously inside `runJobNow` and
  // never spawn an agent task. Discriminate on shape.
  const runId = (result as { runId: string }).runId;
  const isScriptResult = Object.prototype.hasOwnProperty.call(result, "exitCode");
  const exitCode = isScriptResult ? (result as { exitCode: number }).exitCode : undefined;
  const stderr = isScriptResult ? (result as { stderr?: string }).stderr ?? "" : "";
  const spawnedTaskId = isScriptResult ? undefined : (result as { taskId?: string }).taskId;

  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.run.manual",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: isScriptResult
          ? { jobId, runId, exitCode }
          : { jobId, runId, spawnedTaskId }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: isScriptResult ? "Manually executed script job" : "Manually triggered job run",
    data: isScriptResult
      ? { jobId, runId, exitCode }
      : { jobId, runId, taskId: spawnedTaskId }
  });

  if (isScriptResult) {
    // Script jobs run synchronously inside `runJobNow`, so by the time we
    // return here the run is already complete. Report the result rather
    // than "Triggered" so the model can see success/failure without
    // chasing the JobRun record.
    if (exitCode === 0) {
      return `Script job ${jobId} (\"${before.name}\") completed — run ${runId}, exit 0.`;
    }
    // On failure include a truncated tail of stderr so the model can see
    // what went wrong without overwhelming context. Skip stdout — script
    // jobs are typically side-effect-driven and the audit/trace already
    // captures both streams.
    const stderrTail = stderr.length > 500 ? stderr.slice(stderr.length - 500) : stderr;
    const stderrSuffix = stderrTail ? ` stderr: ${stderrTail}` : "";
    return `Script job ${jobId} (\"${before.name}\") failed — run ${runId}, exit ${exitCode}.${stderrSuffix}`;
  }

  const taskSuffix = spawnedTaskId ? `, task ${spawnedTaskId}` : "";
  return `Triggered job ${jobId} (\"${before.name}\") — run ${runId}${taskSuffix}.`;
}

// Explicit on-demand memory recall. Wraps the same `recall()` entrypoint
// that the chat-task loop runs automatically at the start of each task,
// but exposes it to the model so it can fetch additional memory mid-
// conversation when the user references prior context. Returns a compact
// JSON-serialized summary so the model can decide whether to dig deeper.
// Low-risk / read-only.
async function recallMemoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const query = requireString(args, "query");
  let tokenBudget: number | undefined;
  if (args.tokenBudget !== undefined && args.tokenBudget !== null) {
    if (typeof args.tokenBudget !== "number" || !Number.isFinite(args.tokenBudget) || args.tokenBudget <= 0) {
      throw new Error("Invalid input: tokenBudget must be a positive number.");
    }
    tokenBudget = args.tokenBudget;
  }
  let bankId: string | undefined;
  if (args.bankId !== undefined && args.bankId !== null) {
    if (typeof args.bankId !== "string" || args.bankId.length === 0) {
      throw new Error("Invalid input: bankId must be a non-empty string.");
    }
    bankId = args.bankId;
  }
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  if (!effective.agentId) {
    throw new Error("Cannot recall memory: no active agent.");
  }
  const result = await recall(config, {
    agentId: effective.agentId,
    query,
    tokenBudget,
    bankId,
    sourceTaskId: taskId
  });
  const excerpts = result.units.map((entry) => ({
    id: entry.unit.id,
    content: entry.unit.text.length > 200 ? `${entry.unit.text.slice(0, 200)}…` : entry.unit.text,
    score: Number(entry.score.toFixed(4))
  }));
  await recordLowRiskAudit(config, taskId, "memory.recalled", query, {
    units: result.units.length,
    totalTokens: result.totalTokens,
    tokenBudget,
    bankId: bankId ?? null
  });
  return JSON.stringify({
    units: result.units.length,
    totalTokens: result.totalTokens,
    excerpts
  });
}

// Propose a new memory item. Always lands as `status: "proposed"` —
// the agent does not pin its own memory active. The user reviews via
// the existing memory approval flow (`POST /api/memory/<id>/approve`).
async function addMemoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const content = requireString(args, "content");
  let confidence = 1;
  if (args.confidence !== undefined && args.confidence !== null) {
    if (typeof args.confidence !== "number" || !Number.isFinite(args.confidence)) {
      throw new Error("Invalid input: confidence must be a number.");
    }
    confidence = Math.max(0, Math.min(1, args.confidence));
  }
  let sensitivity: "normal" | "sensitive" = "normal";
  if (args.sensitivity !== undefined && args.sensitivity !== null) {
    if (args.sensitivity !== "normal" && args.sensitivity !== "sensitive") {
      throw new Error("Invalid input: sensitivity must be 'normal' or 'sensitive'.");
    }
    sensitivity = args.sensitivity;
  }
  let provenance = "Proposed by agent";
  if (args.provenance !== undefined && args.provenance !== null) {
    if (typeof args.provenance !== "string") {
      throw new Error("Invalid input: provenance must be a string.");
    }
    provenance = args.provenance;
  }
  // Agent-proposed memory ALWAYS starts proposed — the user reviews
  // before pinning. We deliberately don't honor an inbound `status`
  // override; the catalog signature reflects that.
  const memory = await createMemoryFromInput(config, {
    content,
    confidence,
    sensitivity,
    provenance,
    status: "proposed"
  });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "memory.added",
        target: memory.id,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          memoryId: memory.id,
          contentExcerpt: content.length > 200 ? `${content.slice(0, 200)}…` : content,
          status: memory.status,
          confidence,
          sensitivity
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "memory",
    message: "Proposed new memory",
    data: { memoryId: memory.id, status: memory.status, contentBytes: content.length }
  });
  return `Proposed memory ${memory.id} (status: ${memory.status}). Awaiting user approval via /api/memory/${memory.id}/approve.`;
}

// Edit an existing memory in place. Use sparingly — `add_memory` is the
// usual path. The audit trail records every edit; the user can archive
// a bad edit via `DELETE /api/memory/<id>`.
async function updateMemoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const memoryId = requireString(args, "memoryId");
  const input: Record<string, unknown> = {};
  if (args.content !== undefined && args.content !== null) {
    if (typeof args.content !== "string") {
      throw new Error("Invalid input: content must be a string.");
    }
    input.content = args.content;
  }
  if (args.confidence !== undefined && args.confidence !== null) {
    if (typeof args.confidence !== "number" || !Number.isFinite(args.confidence)) {
      throw new Error("Invalid input: confidence must be a number.");
    }
    input.confidence = args.confidence;
  }
  if (args.sensitivity !== undefined && args.sensitivity !== null) {
    if (args.sensitivity !== "normal" && args.sensitivity !== "sensitive") {
      throw new Error("Invalid input: sensitivity must be 'normal' or 'sensitive'.");
    }
    input.sensitivity = args.sensitivity;
  }
  if (Object.keys(input).length === 0) {
    throw new Error("Invalid input: update_memory requires at least one field to change.");
  }
  const memory = await editMemory(config, memoryId, input);
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "memory.edited",
        target: memoryId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          memoryId,
          appliedFields: Object.keys(input),
          sensitivity: memory.sensitivity
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "memory",
    message: "Edited memory",
    data: { memoryId, appliedFields: Object.keys(input) }
  });
  return `Updated memory ${memory.id}: ${Object.keys(input).join(", ")}.`;
}

// Cross-session lookup wrapping `searchSessions`. Returns up to `limit`
// (default 20, capped at 100) snippets matching the query. Low-risk;
// read-only.
async function searchHistoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const query = requireString(args, "query");
  let limit = 20;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit <= 0) {
      throw new Error("Invalid input: limit must be a positive number.");
    }
    limit = Math.min(100, Math.floor(args.limit));
  }
  const results = searchSessions(config, query, limit);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Searched session history",
    data: { query, limit, hits: results.length }
  });
  await recordLowRiskAudit(config, taskId, "history.searched", query, {
    limit,
    hits: results.length
  });
  return JSON.stringify({
    count: results.length,
    results: results.map((r) => ({
      kind: r.kind,
      title: r.title,
      excerpt: r.excerpt,
      taskId: r.taskId,
      source: r.source,
      score: r.score
    }))
  });
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
    // Parent cancellation OR failure should short-circuit the wait
    // so the parent task can exit cleanly. The cascade in
    // `cancelTask` / `failTask` will eventually mark the subagent
    // terminal too, but we shouldn't pin the parent dispatch loop
    // on that round-trip. Checking `failed` (not just `cancelled`)
    // matters because a sibling approval denial flips the parent
    // through that branch.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent?.status === "cancelled" || parent?.status === "failed") {
        return { status: parent.status, error: `Parent task was ${parent.status} while subagent was running.` };
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
    addAudit(
      state,
      {
        actor: "runtime",
        action,
        target,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
}

// ---------------- Approval-gated tools ----------------

async function requestFileWrite(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const target = requireString(args, "path");
  const content = requireString(args, "content");
  assertInsideWorkspace(config.workspaceRoot, target);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    // Respect a terminal status the cancelled-task race opened up
    // between the chat loop's top-of-iteration check and our claim
    // on the per-instance lock. Throwing `TaskAlreadyTerminalError`
    // lets `pendingOrAuto` short-circuit to a "skipped" tool result
    // without creating a fresh approval row against an already-
    // terminal task.
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.write",
      target,
      risk: "high",
      reason: reasonOverride ?? "File writes are side effects and require explicit approval.",
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
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const ref = requireString(args, "ref");
  const userPath = requireString(args, "path");
  // resolveUploadPath throws on invalid / outside-workspace / symlink-escape.
  // Let it propagate so the dispatch loop surfaces the error message to the
  // model as a tool error (matching how requestFileWrite handles
  // assertInsideWorkspace failures).
  const resolved = resolveUploadPath(config.workspaceRoot, userPath);
  // Capture the destination URL before the approval is created so the
  // approval card surfaces where the file is about to land. May be null
  // when the agent hasn't opened a browser session yet (no navigation
  // before the upload request) — the approval still works, the UI just
  // can't show a destination.
  const currentUrl = peekCurrentBrowserUrl(taskId) ?? null;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "browser.upload_file",
      target: resolved.displayPath,
      risk: "high",
      reason: reasonOverride ?? "Uploading a workspace file to a remote site is a side effect and requires explicit approval.",
      payload: {
        ref,
        path: userPath,
        resolvedPath: resolved.absolute,
        currentUrl,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser upload (chat-task)",
      data: { approvalId: approval.id, target: resolved.displayPath, ref, toolCallId, destination: currentUrl }
    });
    return approval.id;
  });
}

async function requestFilePatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
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
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.patch",
      target,
      risk: "high",
      reason: reasonOverride ?? "File patches are side effects and require explicit approval.",
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

// Approval-gated send_message. Validates the bridge id and message body
// before opening the approval row so the approval card reflects a real
// target. The actual `sendMessagingOutput` call runs in
// `agent.executeApprovedAction`'s `messaging.send` branch.
async function requestSendMessage(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const bridgeId = requireString(args, "bridgeId");
  const text = requireString(args, "text");
  let target: string | undefined;
  if (args.target !== undefined && args.target !== null) {
    if (typeof args.target !== "string" || args.target.length === 0) {
      throw new Error("Invalid input: target must be a non-empty string.");
    }
    target = args.target;
  }
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    // Resolve the bridge inside the lock so a concurrent disable can't
    // sneak between our validation and the approval write.
    const bridge = state.messagingBridges.find(
      (candidate) => candidate.id === bridgeId || candidate.name === bridgeId
    );
    if (!bridge) throw new Error(`Messaging bridge not found: ${bridgeId}`);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "messaging.send",
      target: bridge.id,
      risk: "high",
      reason: reasonOverride ?? "Outbound messaging egresses data and requires explicit approval.",
      payload: {
        bridgeId: bridge.id,
        text,
        target,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging send (chat-task)",
      data: { approvalId: approval.id, bridgeId: bridge.id, target, textBytes: text.length, toolCallId }
    });
    return approval.id;
  });
}

// Approval-gated invoke_mcp. Validates the server + tool before opening
// the approval row so the approval card reflects a real target. The
// actual `invokeMcpTool` call runs in `agent.executeApprovedAction`'s
// `mcp.invoke` branch.
async function requestInvokeMcp(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const serverId = requireString(args, "serverId");
  const toolName = requireString(args, "toolName");
  let input: Record<string, unknown> = {};
  if (args.input !== undefined && args.input !== null) {
    if (typeof args.input !== "object" || Array.isArray(args.input)) {
      throw new Error("Invalid input: input must be a JSON object.");
    }
    input = args.input as Record<string, unknown>;
  }
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    // Resolve the server inside the lock so a concurrent disable can't
    // sneak between validation and the approval write.
    const server = state.mcpServers.find(
      (candidate) => candidate.id === serverId || candidate.name === serverId
    );
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.exposedTools.length > 0 && !server.exposedTools.includes(toolName)) {
      throw new Error(`MCP tool is not exposed: ${toolName}`);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "mcp.invoke",
      target: server.id,
      risk: "high",
      reason: reasonOverride ?? "Invoking an MCP tool runs external code and requires explicit approval.",
      payload: {
        serverId: server.id,
        toolName,
        input,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for MCP invoke (chat-task)",
      data: { approvalId: approval.id, serverId: server.id, toolName, toolCallId }
    });
    return approval.id;
  });
}

// Routes a terminal command through the approval-policy seam.
//
// The allowlist fast-path stays as a no-approval-row optimization for
// commands matched by `RuntimeConfig.autoApproveCommands`: those
// execute directly via `runTerminalCommand` with the matched pattern
// stamped on the side-effect audit row. Everything else goes through
// `pendingOrAuto`, which consults `resolveApprovalPolicy` to decide
// auto-approve vs gate per the active approval mode.
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
    // Short-circuit BEFORE writing the auto-approved trace if the
    // task already terminated. Without this the trace claims
    // "Auto-approved terminal command" against a cancelled task
    // before `runTerminalCommand`'s claim short-circuit catches the
    // signal. `runTerminalCommand` still independently honors the
    // registry abort once claimed, but skipping here is cheaper and
    // keeps the trace honest.
    const preStatus = await mutateState(config.instance, (state) => findTask(state, taskId).status);
    if (isTerminalTaskStatus(preStatus)) {
      return { kind: "sync", result: `Action skipped: task is already ${preStatus}.` };
    }
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

  return pendingOrAuto(
    config,
    "terminal.exec",
    { command },
    (reason) => requestTerminalExec(config, taskId, toolCallId, command, timeoutMs, pty, reason)
  );
}

// code_exec compiles a snippet to a shell command. Route through the
// policy seam as `code.exec` so the dangerous-pattern blocklist runs
// against BOTH the wrapper command AND the raw source. An argv-style
// payload like `Bun.spawn(["sudo", "apt"])` is invisible to a
// substring check against the wrapper alone (the wrapper contains
// `"sudo"` without the trailing space the literal substring needed);
// checking the source directly closes the hole. The persisted
// approval row's action stays `terminal.exec` (it really runs as one)
// — only the policy decision branches separately.
async function codeExecDispatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const language = requireString(args, "language");
  const code = requireString(args, "code");
  const command = codeExecutionCommand(language, code);
  return pendingOrAuto(
    config,
    "code.exec",
    { command, source: code, language },
    (reason) => requestCodeExecPrebuilt(config, taskId, toolCallId, language, command, code, reason)
  );
}

async function requestTerminalExec(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  command: string,
  timeoutMs: number,
  pty: boolean,
  reasonOverride?: string
): Promise<string> {
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: reasonOverride ?? "Terminal execution can change the system and requires explicit approval.",
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
}

async function requestCodeExecPrebuilt(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  language: string,
  command: string,
  source: string,
  reasonOverride?: string
): Promise<string> {
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: reasonOverride ?? "Code execution can change the system and requires explicit approval.",
      // `source` on the payload is the contract that lets the
      // policy seam (re-)resolve this as code.exec instead of
      // terminal.exec — the matcher then scans the raw source so
      // argv-style payloads can't slip past a wrapper-only check.
      payload: { command, timeoutMs: 10_000, toolCallId, language, source }
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

// ---------------- pendingOrAuto ----------------
//
// Single-point wrapper for every approval-gated tool. Consults
// `resolveApprovalPolicy(config, action, payload)` to decide whether
// the approval should pause for a human gate (`mode: "gate"`) or
// auto-resolve through the same
// `resolveApproval` -> `executeApprovedAction` pipeline a human
// approval would take (`mode: "auto"`). Approval creation, the
// approve audit row, the per-action side-effect audit, and the tool
// result string all live in one canonical place (agent.ts) instead
// of being duplicated per action. Each auto-resolved side effect
// still emits a fully populated approval row (status=approved,
// evidence.autoApproved=true, autoApprovedReason=<policy reason>)
// and a side-effect audit row, so the reviewer sees an identical
// trail to a normal flow except for the marker.
async function pendingOrAuto(
  config: RuntimeConfig,
  action: PolicyAction,
  payload: { command: string; source?: string; language?: string } | undefined,
  request: (reasonOverride?: string) => Promise<string>
): Promise<DispatchResult> {
  // Compute the policy decision BEFORE creating the approval so the
  // gate reason (`dangerous-pattern: <id>`) can flow into the
  // approval row's `reason` field. Without this, operators see only
  // the generic per-action copy ("Terminal execution can change the
  // system...") on the approval card and lose the matched-pattern
  // signal entirely.
  const decision = resolveApprovalPolicy(config, action, payload);
  const reasonOverride = decision.mode === "gate" ? decision.reason : undefined;

  // The `await request()` MUST live inside a try/catch so a
  // `TaskAlreadyTerminalError` raised by the request helper
  // (request* helpers refuse to create an approval against an
  // already-terminal task) is converted to a "skipped" sync tool
  // result rather than bubbling up as a generic tool error to the
  // model. `ApprovalRaceLostError` is ALSO caught here for symmetry,
  // although in practice it only fires from `resolveApproval` below
  // — request* helpers throw the task-terminal variant instead.
  let approvalId: string;
  try {
    approvalId = await request(reasonOverride);
  } catch (err) {
    if (err instanceof TaskAlreadyTerminalError) {
      return { kind: "sync", result: `Action skipped: task was already ${err.status} when the request reached the runtime.` };
    }
    if (err instanceof ApprovalRaceLostError) {
      return { kind: "sync", result: `Action skipped: approval was already ${err.status} by another caller.` };
    }
    throw err;
  }
  if (decision.mode === "gate") return { kind: "pending", approvalId };
  try {
    const { approval, toolResult } = await resolveApproval(config, approvalId, {
      actor: "runtime",
      resumeChatTask: false,
      evidenceExtra: { autoApproved: true, autoApprovedReason: decision.reason }
    });
    // `executeApprovedAction`'s guard can flip the approval from
    // `approved` back to `denied` (the
    // `approval.cancelled_task_terminal` audit row) and return an
    // undefined `toolResult`. Reporting "Auto-approved." in that
    // case would tell the model the action succeeded when the
    // audit trail says it was cancelled. Read the approval status
    // from the row returned by `resolveApproval` and route the
    // "denied / cancelled post-approval" case through the skipped
    // sync result.
    if (toolResult === undefined && approval.status === "denied") {
      return { kind: "sync", result: `Action skipped: approval was cancelled before the side effect ran.` };
    }
    return { kind: "sync", result: toolResult ?? "Auto-approved." };
  } catch (err) {
    // Race-loss: another caller (concurrent deny / cancel / double-
    // approve) decided this approval between our request* call and our
    // resolveApproval call. The other party is responsible for the
    // task's terminal transition; we just stop pretending we own the
    // action and let the chat-task loop's next-iteration cancellation
    // check observe the decided state. Returning a sync tool result
    // keeps the dispatch loop honest without escalating to task failure.
    if (err instanceof ApprovalRaceLostError) {
      return { kind: "sync", result: `Action skipped: approval was already ${err.status} by another caller.` };
    }
    // Side-effect failed AFTER we marked the approval approved. Wrap in
    // ApprovedActionFailedError so the chat-task loop's generic catch
    // re-throws it (instead of converting to a recoverable tool result)
    // and the outer runChatTask handler fails the owning task. Without
    // this the model would receive a string like "Error: EISDIR" and
    // could go on to declare the task complete despite the failure.
    throw new ApprovedActionFailedError(approvalId, err);
  }
}
