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
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import {
  addAudit,
  appendTrace,
  assertInsideWorkspace,
  createApproval,
  createChatMessage,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState
} from "../state";
import { ApprovalRaceLostError, ApprovedActionFailedError, TaskAlreadyTerminalError, cancelTask, findTask, resolveApproval, runTerminalCommand } from "../agent";
import { walkFiles, simpleDiff } from "../tools/file";
import { codeExecutionCommand } from "../tools/code";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "../capabilities/subagents";
import { matchAutoApprove } from "./auto-approve";
import { resolveApprovalPolicy, type PolicyAction } from "./policy";
import { createScheduledJob, listJobs, removeJob, runJobNow, updateJob, updateJobStatus } from "../jobs";
import { recall } from "../memory";
import {
  dedupeAppendLines,
  loadSoul,
  loadUserProfile,
  previewRemoveUserProfileSection,
  removeSoulSection,
  removeUserProfileSection,
  scanForInjection,
  soulPath,
  userProfilePath,
  writeSoul,
  writeUserProfile,
  type IdentityFileStatus
} from "../runtime/identity-files";
import { resolveEffectiveContext } from "./effective-context";
import { searchSessions } from "./search";
import { installSkillFromBody, setSkillStatus } from "../capabilities/skills";
import { isSkillActive } from "../integrations/connectors";
import { getProvider } from "../integrations/connectors/registry";
import { invokeMcpTool } from "../integrations/mcp";
import { listAllowedChats } from "../integrations/messaging";
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
import { parseFillSecretSlots, sanitizeUrlForAuditTarget } from "./browser-fill-secrets-types";

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
  rawArgs: string,
  // Current chat-task turn's in-flight message buffer. Only the loop in
  // chat-task.ts owns this — it accumulates assistant tool_calls and tool
  // results across iterations of the same task run, none of which land on
  // `task.toolCallState.messages` until the task pauses for approval. Gates
  // that need to inspect the current turn's tool history (e.g. the
  // setup-skill gate inside request_connector) must look here too, not
  // only at the persisted snapshot. Optional so test callers that bypass
  // the loop keep working.
  messageHistory?: readonly unknown[]
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
    case "edit_soul":
      return { kind: "sync", result: await editSoulTool(config, taskId, args) };
    case "edit_user_profile":
      return { kind: "sync", result: await editUserProfileTool(config, taskId, args) };
    case "search_history":
      return { kind: "sync", result: await searchHistoryTool(config, taskId, args) };
    case "send_message":
      return pendingOrAuto(config, "messaging.send", undefined, (reason) => requestSendMessage(config, taskId, toolCallId, args, reason));
    case "cancel_task":
      return { kind: "sync", result: await cancelTaskTool(config, taskId, args) };
    case "install_skill":
      return { kind: "sync", result: await installSkillTool(config, taskId, args) };
    case "enable_skill":
      return { kind: "sync", result: await setSkillStatusTool(config, taskId, args, "enabled") };
    case "disable_skill":
      return { kind: "sync", result: await setSkillStatusTool(config, taskId, args, "disabled") };
    case "mcp_call":
      return { kind: "sync", result: await mcpCallTool(config, taskId, args) };
    case "request_connector":
      return await requestConnectorTool(config, taskId, toolCallId, args, messageHistory);
    case "browser_fill_secrets":
      return await browserFillSecretsTool(config, taskId, toolCallId, args);
    case "request_messaging_bridge":
      return await requestMessagingBridgeTool(config, taskId, toolCallId, args);
    case "list_messaging_bridges":
      return { kind: "sync", result: await listMessagingBridgesTool(config) };
    case "list_messaging_pairings":
      return { kind: "sync", result: await listMessagingPairingsTool(config, args) };
    case "wait_for_messaging_pair":
      return await waitForMessagingPairTool(config, taskId, toolCallId, args);
    case "request_messaging_pairing":
      return await requestMessagingPairingTool(config, taskId, toolCallId, args);
    case "request_remove_messaging_bridge":
      return await requestRemoveMessagingBridgeTool(config, taskId, toolCallId, args);
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
    case "browser_connect":
      // Spawning a managed Chrome surfaces a desktop window and
      // creates a persistent per-instance profile dir — the
      // trust-establishment moment that gates every subsequent
      // browser action. Route through the approval gate so the
      // user sees an explicit "open a browser window for X" card.
      // The policy seam falls through to `{ mode: "gate" }` for
      // this action under "auto" mode (yolo still auto-approves).
      return pendingOrAuto(config, "browser.connect", undefined, (reason) => requestBrowserConnect(config, taskId, toolCallId, args, reason));
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

// Forgiving variant of parseArgs for ChatBlock emission. The strict
// parseArgs above throws on malformed JSON to keep dispatch correct;
// emission must never abort the loop, so this helper returns an empty
// object on failure and lets the chat-task loop continue. Used by
// emitToolCallRunning in chat-task.ts.
export function parseToolArgsLenient(raw: string): Record<string, unknown> {
  try {
    return parseArgs(raw);
  } catch {
    return {};
  }
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

// Classify a host string as one of: loopback (127/8, ::1, "localhost",
// "0.0.0.0"), private (RFC1918 IPv4 + ULA IPv6), linkLocal (169.254/16,
// fe80::/10), public (anything else parsable), or unknown (a hostname
// we can't classify without DNS resolution).
function classifyHost(host: string): "loopback" | "private" | "linkLocal" | "public" | "unknown" {
  const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = stripped.toLowerCase();
  // Literal hostnames that always mean loopback regardless of /etc/hosts
  // mapping. "*.localhost" is RFC 6761 — DNS clients SHOULD treat it as
  // local even if a public DNS server returns something else, so we
  // refuse it pre-resolution.
  if (lower === "localhost" || lower.endsWith(".localhost")) return "loopback";
  const ipVersion = isIP(stripped);
  if (ipVersion === 4) {
    const parts = stripped.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return "unknown";
    if (parts[0] === 127) return "loopback";
    if (parts[0] === 0) return "loopback";
    if (parts[0] === 10) return "private";
    if (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) return "private";
    if (parts[0] === 192 && parts[1] === 168) return "private";
    if (parts[0] === 169 && parts[1] === 254) return "linkLocal";
    // RFC 6598 carrier-grade NAT space: 100.64.0.0/10. Not RFC1918
    // but treated equivalently — these are not globally routable and
    // can be used to reach a CGN-internal service that proxies the
    // SSRF target. Span: 100.64 through 100.127.
    if (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) return "private";
    // RFC 2544 benchmark/test space: 198.18.0.0/15. Often routed to
    // internal lab gear; treat as private for the same reason.
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return "private";
    return "public";
  }
  if (ipVersion === 6) {
    if (lower === "::1" || lower === "::" || lower === "::0") return "loopback";
    // Unique local addresses (fc00::/7) and link-local (fe80::/10). The
    // prefix check is loose but errs on the side of refusing more than
    // strictly necessary, which is the right direction for an SSRF
    // guard.
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    // IPv6 link-local is fe80::/10 — first 10 bits 1111111010, so
    // the leading hex byte is fe80–febf. A prefix check on "fe80"
    // misses fe81..febf; widen to the full /10 range.
    if (/^fe[89ab]/.test(lower)) return "linkLocal";
    // IPv4-mapped IPv6 forms. Three shapes are all valid IPv6
    // literals for the same underlying IPv4 address; each must be
    // reclassified on the embedded IPv4 or the guard is bypassable:
    //   a. mixed dot-quad: "::ffff:127.0.0.1"
    //   b. pure hex IPv4-mapped: "::ffff:7f00:1"
    //   c. deprecated IPv4-compatible: "::7f00:1" (no ffff). Node's
    //      URL parser normalizes "[::127.0.0.1]" to this form, so
    //      it shows up unprompted even when the agent passed a
    //      dot-quad-looking URL.
    const mappedDotQuad = lower.match(/^::ffff:([\d.]+)$/);
    if (mappedDotQuad) return classifyHost(mappedDotQuad[1] ?? "");
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const compatHex = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const hex = mappedHex ?? compatHex;
    if (hex) {
      const hi = parseInt(hex[1] ?? "0", 16);
      const lo = parseInt(hex[2] ?? "0", 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return classifyHost(ipv4);
      }
    }
    return "public";
  }
  return "unknown";
}

// SSRF guard for the agent's web_fetch tool. The agent might be
// prompt-injected into fetching the local BFF
// (http://127.0.0.1:<bff>/api/runtime/approvals) which would inject
// the runtime bearer and return state including secrets. Refuse
// loopback / RFC1918 / link-local destinations both at the URL
// literal AND post-DNS so a hostname that resolves to a private
// address can't sneak through. Doesn't defeat full DNS rebinding
// (TTL=0 swap between resolve and fetch) — that's a separate
// hardening layer that would require dialing the resolved IP
// directly.
async function assertPublicWebFetchTarget(parsed: URL): Promise<void> {
  const literalKind = classifyHost(parsed.hostname);
  if (literalKind === "loopback" || literalKind === "private" || literalKind === "linkLocal") {
    throw new Error(
      `web_fetch refuses ${literalKind} destination ${parsed.hostname}: agent tools may not reach loopback, RFC1918, or link-local addresses.`
    );
  }
  if (literalKind === "unknown") {
    // It's a hostname we couldn't classify pre-DNS. Resolve and
    // re-classify the address.
    try {
      const { address } = await lookup(parsed.hostname);
      const resolvedKind = classifyHost(address);
      if (resolvedKind === "loopback" || resolvedKind === "private" || resolvedKind === "linkLocal") {
        throw new Error(
          `web_fetch refuses ${parsed.hostname} (resolves to ${resolvedKind} address ${address}).`
        );
      }
    } catch (err) {
      // DNS failure: let the subsequent fetch surface the failure
      // organically; don't swallow our own refusal.
      if (err instanceof Error && err.message.startsWith("web_fetch refuses")) throw err;
    }
  }
}

// Cap on automatic redirect hops. Five is consistent with the
// default browser limit and prevents a server that 302s in a loop
// from holding the agent's tool slot.
const WEB_FETCH_MAX_REDIRECTS = 5;

async function webFetchTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const rawUrl = requireString(args, "url");
  let current = new URL(rawUrl);
  if (current.protocol !== "https:" && current.protocol !== "http:") throw new Error("web_fetch requires an http(s) URL.");
  await assertPublicWebFetchTarget(current);

  // Manual redirect handling: default fetch() follows redirects, which
  // would let a public URL 302 into loopback / RFC1918 and bypass the
  // pre-fetch guard. Loop with redirect:"manual" and re-validate the
  // Location target on every hop. The fetch DNS resolution still
  // happens inside fetch() so a full DNS-rebinding attacker (TTL=0
  // swap between assertPublicWebFetchTarget's lookup and the actual
  // dial) can still slip through — closing that requires dialing the
  // resolved IP directly with hostname-in-Host-header + SNI overrides,
  // which Bun doesn't expose cleanly today. The redirect-bypass leg
  // is the bigger blast radius and is closed here.
  let response: Response;
  let hops = 0;
  for (;;) {
    response = await fetch(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    if (hops >= WEB_FETCH_MAX_REDIRECTS) {
      throw new Error(`web_fetch refused after ${WEB_FETCH_MAX_REDIRECTS} redirects from ${parsed_origin(current)} (loop or chain too long).`);
    }
    // Resolve relative redirects against the previous URL so we
    // validate the actual destination, not a partial path.
    const next = new URL(location, current);
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new Error(`web_fetch refuses redirect to non-http(s) URL: ${next.protocol}`);
    }
    await assertPublicWebFetchTarget(next);
    current = next;
    hops += 1;
  }
  const text = (await response.text())
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
  // Log only the origin (protocol + host) in trace + audit. The
  // path can carry tokens (signed-URL signatures, OAuth-via-path
  // styles, the occasional poorly-designed "personal key in URL"
  // pattern) and any server-controlled redirect can add more, so
  // including pathname risks leaking credentials into the trace.
  // Operators who need the exact endpoint can read the original
  // tool_call args from the conversation transcript; the audit
  // row's job is to attest "the agent reached this host" without
  // revealing what it asked for.
  const sanitizedUrl = `${current.protocol}//${current.host}`;
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Web page fetched (chat-task)",
    data: { url: sanitizedUrl, status: response.status, bytes: text.length, redirects: hops }
  });
  await recordLowRiskAudit(config, taskId, "web.fetch", sanitizedUrl, { status: response.status, bytes: text.length, redirects: hops });
  return text || `Fetched ${sanitizedUrl} with HTTP ${response.status}.`;
}

// Tiny helper kept inline because it's only used by the redirect-cap
// error message — avoids leaking query strings / fragments into the
// exception while still naming the origin of the redirect chain.
function parsed_origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
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

// Generic MCP tool dispatch. Routes (server, tool, arguments) to the
// matching McpServerRecord and returns the flattened text content the
// tool produced. Errors come back as a JSON envelope rather than thrown
// exceptions so the model can read the failure and recover (e.g. retry
// with corrected arguments) instead of seeing a generic tool-error.
//
// Result text is capped at 12000 chars to bound prompt growth; Linear's
// list_issues can return many pages of issue blobs.
async function mcpCallTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const serverName = requireString(args, "server");
  const toolName = requireString(args, "tool");
  const toolArgs = (args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments))
    ? args.arguments as Record<string, unknown>
    : {};
  const state = readState(config.instance);
  const server = state.mcpServers.find(
    (item) => item.name.toLowerCase() === serverName.toLowerCase() || item.id === serverName
  );
  if (!server) {
    return JSON.stringify({ ok: false, error: `Unknown MCP server: ${serverName}. Configured servers: ${state.mcpServers.map((s) => s.name).join(", ") || "(none)"}` });
  }
  if (server.status !== "configured") {
    return JSON.stringify({ ok: false, error: `MCP server ${server.name} is not configured (status: ${server.status}). Ask the user to run 'gini mcp health ${server.name}' or re-add credentials.` });
  }
  if (server.transport === "http" && !server.url) {
    return JSON.stringify({ ok: false, error: `MCP server ${server.name} is http transport but has no url.` });
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `MCP tool ${server.name}/${toolName}`,
    data: { server: server.name, tool: toolName, argBytes: JSON.stringify(toolArgs).length }
  });
  let result: { ok: boolean; stdout?: string; message?: string };
  try {
    result = await invokeMcpTool(config, server.id, toolName, toolArgs, { taskId });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.message ?? "MCP tool failed.", content: truncate(result.stdout ?? "", 12_000) });
  }
  return truncate(result.stdout ?? "", 12_000);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
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

// Propose an edit to the active agent's SOUL.md. The body always lands
// as SOUL.md.proposed; the user approves via the identity-files
// approval API before the new content rides the next system prompt.
// `set` replaces the body; `append` layers a new section under the
// existing approved body; `remove` drops the first paragraph containing
// a substring (`needle`) from the existing approved body. All three
// route through the same propose-vs-approve gate.
// See ADR runtime-identity-files.md.
async function editSoulTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = optionalString(args, "action", "set");
  if (action !== "set" && action !== "append" && action !== "remove") {
    throw new Error("Invalid input: action must be 'set', 'append', or 'remove'.");
  }
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  const agentId = effective.agentId;
  if (!agentId) {
    throw new Error("Cannot edit SOUL.md: no active agent.");
  }
  if (action === "remove") {
    const needle = requireString(args, "needle");
    const removeResult = removeSoulSection(config.instance, agentId, needle, "proposed");
    if (!removeResult.ok) {
      // No mutation hit disk — surface a clean failure to the model so
      // it can retry with a different needle instead of assuming the
      // proposal landed. We deliberately do NOT throw: an invalid input
      // should leave the conversation intact.
      const reason = removeResult.reason === "no source"
        ? "no approved SOUL.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove SOUL.md section: ${reason}.`;
    }
    await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      addAudit(
        state,
        {
          actor: "agent",
          action: "identity.soul.proposed",
          target: removeResult.path,
          risk: "low",
          taskId: item.id,
          runId: item.runId,
          evidence: {
            agentId,
            action,
            needle,
            path: removeResult.path,
            scanFindings: removeResult.scanFindings
          }
        },
        { taskId: item.id }
      );
      item.updatedAt = now();
    });
    appendTrace(config.instance, taskId, {
      type: "model",
      message: "Proposed SOUL.md remove",
      data: { agentId, action, needle, path: removeResult.path, scanFindings: removeResult.scanFindings }
    });
    return `Proposed SOUL.md edit at ${removeResult.path} (removed paragraph matching "${needle}"). Awaiting user approval via POST /api/identity-files/soul/approve.`;
  }
  const content = requireString(args, "content");
  // For 'append', the new proposal carries the existing approved body
  // followed by a blank line and the new content. The approved file
  // stays the source of truth — proposals are not chained on top of
  // earlier unapproved proposals. Lines from `content` that already
  // exist verbatim in the existing body are dropped so a model that
  // re-emits the current file alongside the new fact doesn't duplicate.
  let body = content;
  let appendDedupeDropped = 0;
  if (action === "append") {
    const existing = loadSoul(config.instance, agentId);
    if (existing && existing.trim().length > 0 && !existing.startsWith("[BLOCKED:")) {
      const dedupe = dedupeAppendLines(existing, content);
      appendDedupeDropped = dedupe.droppedLineCount;
      if (dedupe.empty) {
        // Nothing new to append — surface a no-op so the model knows the
        // write was redundant and the file stays clean. Audit + trace
        // record the suppression so it stays observable.
        await mutateState(config.instance, (state) => {
          const item = findTask(state, taskId);
          addAudit(
            state,
            {
              actor: "agent",
              action: "identity.soul.append.noop",
              target: soulPath(config.instance, agentId),
              risk: "low",
              taskId: item.id,
              runId: item.runId,
              evidence: { agentId, droppedLineCount: appendDedupeDropped }
            },
            { taskId: item.id }
          );
          item.updatedAt = now();
        });
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "SOUL.md append no-op (all lines already present)",
          data: { agentId, droppedLineCount: appendDedupeDropped }
        });
        return `No SOUL.md change: all appended lines already exist in the approved body.`;
      }
      body = `${existing.trim()}\n\n${dedupe.residual}`;
    }
  }
  const result = writeSoul(config.instance, agentId, body, "proposed");
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "identity.soul.proposed",
        target: result.path,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          agentId,
          action,
          path: result.path,
          contentBytes: body.length,
          scanFindings: result.scanFindings,
          ...(appendDedupeDropped > 0 ? { droppedLineCount: appendDedupeDropped } : {})
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "model",
    message: "Proposed SOUL.md edit",
    data: { agentId, action, path: result.path, contentBytes: body.length, scanFindings: result.scanFindings }
  });
  const scanNote = result.scanFindings.length > 0
    ? ` (scan flagged: ${result.scanFindings.join(", ")}; content blocked from prompt until approved)`
    : "";
  return `Proposed SOUL.md edit at ${result.path}${scanNote}. Awaiting user approval via POST /api/identity-files/soul/approve.`;
}

// Propose an edit to the instance-scoped USER.md. Same propose →
// approve flow as edit_soul. Instance-scoped so user identity carries
// across agent switches.
async function editUserProfileTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = optionalString(args, "action", "set");
  if (action !== "set" && action !== "append" && action !== "remove") {
    throw new Error("Invalid input: action must be 'set', 'append', or 'remove'.");
  }
  if (action === "remove") {
    const needle = requireString(args, "needle");
    // Pre-scan the post-remove body so a hostile pattern that survives
    // the deletion still routes through the propose path. Without the
    // pre-scan a remove against a file whose remaining paragraphs trip
    // the scanner would auto-approve a tainted body.
    const preview = previewRemoveUserProfileSection(config.instance, needle);
    if (!preview.ok) {
      const reason = preview.reason === "no source"
        ? "no approved USER.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove USER.md section: ${reason}.`;
    }
    const targetStatus: IdentityFileStatus = preview.scanFindings.length > 0 ? "proposed" : "approved";
    const removeResult = removeUserProfileSection(config.instance, needle, targetStatus);
    if (!removeResult.ok) {
      // The pre-scan already confirmed there is a source and a match — a
      // fall-through here is only reachable on a concurrent filesystem
      // race; surface the same clean failure shape.
      const reason = removeResult.reason === "no source"
        ? "no approved USER.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove USER.md section: ${reason}.`;
    }
    const autoApproved = removeResult.status === "approved";
    const auditAction = autoApproved
      ? "identity.user_profile.approved"
      : "identity.user_profile.proposed";
    await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      addAudit(
        state,
        {
          actor: "agent",
          action: auditAction,
          target: removeResult.path,
          risk: autoApproved ? "low" : "medium",
          taskId: item.id,
          runId: item.runId,
          evidence: {
            action,
            needle,
            path: removeResult.path,
            scanFindings: removeResult.scanFindings,
            autoApproved
          }
        },
        { taskId: item.id }
      );
      item.updatedAt = now();
    });
    appendTrace(config.instance, taskId, {
      type: "model",
      message: autoApproved
        ? "USER.md remove (auto-approved)"
        : "USER.md remove blocked from prompt (proposed)",
      data: { action, needle, path: removeResult.path, scanFindings: removeResult.scanFindings, autoApproved }
    });
    if (!autoApproved) {
      const scanNote = ` (scan flagged: ${removeResult.scanFindings.join(", ")}; content blocked from prompt until approved)`;
      return `Proposed USER.md remove at ${removeResult.path}${scanNote}. Awaiting user approval via POST /api/identity-files/user/approve.`;
    }
    return `Updated USER.md at ${removeResult.path} (removed paragraph matching "${needle}").`;
  }
  const content = requireString(args, "content");
  let body = content;
  let appendDedupeDropped = 0;
  if (action === "append") {
    const existing = loadUserProfile(config.instance);
    if (existing && existing.trim().length > 0 && !existing.startsWith("[BLOCKED:")) {
      // Drop lines from `content` that already live verbatim in the
      // existing body so a model that re-emits the current file
      // alongside the new fact doesn't duplicate (the dominant
      // overshoot pattern on weaker tool-calling models). When the
      // residual is empty no write happens — the file is already
      // current.
      const dedupe = dedupeAppendLines(existing, content);
      appendDedupeDropped = dedupe.droppedLineCount;
      if (dedupe.empty) {
        await mutateState(config.instance, (state) => {
          const item = findTask(state, taskId);
          addAudit(
            state,
            {
              actor: "agent",
              action: "identity.user_profile.append.noop",
              target: userProfilePath(config.instance),
              risk: "low",
              taskId: item.id,
              runId: item.runId,
              evidence: { droppedLineCount: appendDedupeDropped }
            },
            { taskId: item.id }
          );
          item.updatedAt = now();
        });
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "USER.md append no-op (all lines already present)",
          data: { droppedLineCount: appendDedupeDropped }
        });
        return `No USER.md change: all appended lines already exist.`;
      }
      body = `${existing.trim()}\n\n${dedupe.residual}`;
    }
  }
  // Pre-scan the proposed body. When the scan flags a threat the write
  // is routed to `.proposed` (matching edit_soul semantics) so a hostile
  // body never lands at the approved path. Only clean bodies auto-approve.
  // See ADR runtime-identity-files.md.
  const previewScan = scanForInjection(body, "USER.md");
  const targetStatus: IdentityFileStatus = previewScan.findings.length > 0 ? "proposed" : "approved";
  const result = writeUserProfile(config.instance, body, targetStatus);
  const autoApproved = result.status === "approved";
  const auditAction = autoApproved
    ? "identity.user_profile.approved"
    : "identity.user_profile.proposed";
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: auditAction,
        target: result.path,
        risk: autoApproved ? "low" : "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          action,
          path: result.path,
          contentBytes: body.length,
          scanFindings: result.scanFindings,
          autoApproved,
          ...(appendDedupeDropped > 0 ? { droppedLineCount: appendDedupeDropped } : {})
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "model",
    message: autoApproved
      ? "USER.md edit (auto-approved)"
      : "USER.md edit blocked from prompt (proposed)",
    data: { action, path: result.path, contentBytes: body.length, scanFindings: result.scanFindings, autoApproved }
  });
  if (!autoApproved) {
    const scanNote = ` (scan flagged: ${result.scanFindings.join(", ")}; content blocked from prompt until approved)`;
    return `Proposed USER.md edit at ${result.path}${scanNote}. Awaiting user approval via POST /api/identity-files/user/approve.`;
  }
  return `Updated USER.md at ${result.path}.`;
}

// Cross-session lookup wrapping `searchSessions`. Returns up to `limit`
// (default 20, capped at 100) snippets matching the query. Low-risk and
// read-only — no audit row, matching the sibling read-only meta tools
// (`file_read`, `file_search`, `read_skill`). The per-task trace below
// is the right narrative seam for "the agent searched X".
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

// Cancel a task. Refuses to cancel the CURRENT task — that would
// terminate the running conversation. Wraps `cancelTask`, which already
// refuses on already-terminal tasks and cascades to child subagents.
// Self-cancel is guarded twice: the lock-free pre-check below is the
// fast path that lets the model see a friendly message instead of an
// error, and `cancelTask(..., callerTaskId)` re-checks inside its
// serialized mutateState callback so a request that slips between the
// pre-check and the mutation still throws before any state change.
async function cancelTaskTool(
  config: RuntimeConfig,
  callerTaskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const targetTaskId = requireString(args, "taskId");
  if (targetTaskId === callerTaskId) {
    return `Error: cannot cancel the current task — that would terminate the running conversation. Use this only for child subagents or unrelated tasks.`;
  }
  const stateNow = readState(config.instance);
  const target = stateNow.tasks.find((t) => t.id === targetTaskId);
  if (!target) throw new Error(`Task not found: ${targetTaskId}`);
  if (isTerminalTaskStatus(target.status)) {
    return `Task ${targetTaskId} is already ${target.status}; no action taken.`;
  }
  const cancelled = await cancelTask(config, targetTaskId, callerTaskId);
  await mutateState(config.instance, (state) => {
    const item = findTask(state, callerTaskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "task.cancel.requested",
        target: targetTaskId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: { targetTaskId, previousStatus: target.status, newStatus: cancelled.status }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, callerTaskId, {
    type: "task",
    message: "Requested task cancellation",
    data: { targetTaskId, previousStatus: target.status, newStatus: cancelled.status }
  });
  return `Cancelled task ${targetTaskId} (was ${target.status}, now ${cancelled.status}).`;
}

// Install a skill from a raw SKILL.md body. Wraps installSkillFromBody,
// which validates the manifest, writes it to disk, and reloads the skill
// registry. Returns the new skill id + name + validation issues so the
// model can surface a useful confirmation.
async function installSkillTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const body = requireString(args, "body");
  let category: string | undefined;
  if (args.category !== undefined && args.category !== null) {
    if (typeof args.category !== "string" || args.category.length === 0) {
      throw new Error("Invalid input: category must be a non-empty string.");
    }
    category = args.category;
  }
  let files: Array<{ name: string; content: string }> | undefined;
  if (args.files !== undefined && args.files !== null) {
    if (!Array.isArray(args.files)) {
      throw new Error("Invalid input: files must be an array.");
    }
    const cleaned: Array<{ name: string; content: string }> = [];
    for (const entry of args.files) {
      if (!entry || typeof entry !== "object") {
        throw new Error("Invalid input: files entries must be objects with name+content.");
      }
      const candidate = entry as { name?: unknown; content?: unknown };
      if (typeof candidate.name !== "string" || candidate.name.length === 0) {
        throw new Error("Invalid input: files entries require a non-empty name.");
      }
      if (typeof candidate.content !== "string") {
        throw new Error("Invalid input: files entries require a string content.");
      }
      cleaned.push({ name: candidate.name, content: candidate.content });
    }
    files = cleaned;
  }
  const installed = await installSkillFromBody(config, { body, category, files });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "skill.installed",
        target: installed.skill.id,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          skillId: installed.skill.id,
          name: installed.skill.name,
          manifestPath: installed.manifestPath,
          validationIssues: installed.validation.issues
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Installed skill",
    data: { skillId: installed.skill.id, name: installed.skill.name, manifestPath: installed.manifestPath }
  });
  const issuesSuffix = installed.validation.issues.length > 0
    ? ` Warnings: ${installed.validation.issues.join("; ")}.`
    : "";
  return `Installed skill ${installed.skill.id} ("${installed.skill.name}") at ${installed.manifestPath}.${issuesSuffix}`;
}

// Enable / disable a registered skill. Wraps setSkillStatus, which
// writes the matching skill.enabled / skill.disabled audit row.
async function setSkillStatusTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>,
  status: "enabled" | "disabled"
): Promise<string> {
  const skillId = requireString(args, "skillId");
  const skill = await setSkillStatus(config, skillId, status);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: status === "enabled" ? "Enabled skill" : "Disabled skill",
    data: { skillId: skill.id, name: skill.name, status }
  });
  await recordLowRiskAudit(config, taskId, status === "enabled" ? "skill.enable.requested" : "skill.disable.requested", skill.id, {
    skillId: skill.id,
    name: skill.name,
    status
  });
  return `${status === "enabled" ? "Enabled" : "Disabled"} skill ${skill.id} ("${skill.name}").`;
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

// Approval-gated browser_connect. Spawns a visible managed Chrome
// after user consent. The reason flows onto the approval row's
// evidence so the UI can render a friendlier label ("Open a browser
// window — <reason>") instead of the generic terminal-exec card.
// The actual connectBrowser() call runs in agent.executeApprovedAction's
// "browser.connect" branch.
async function requestBrowserConnect(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const reason = requireString(args, "reason");
  // Headless is opt-in: only honor an explicit boolean true. Anything else
  // (undefined, false, non-boolean) maps to the existing visible default
  // so legacy callers that never set the field keep getting a headed
  // managed Chrome. The flag rides on the approval payload so the
  // executor in agent.ts can pass it through to connectBrowser when the
  // user approves.
  const headless = args.headless === true;
  // Optional target URL — the page the agent was trying to reach. When the
  // user clicks "Connect" the open-browser endpoint launches visible Chrome
  // and navigates here directly, so the user lands on the sign-in form
  // instead of an empty about:blank. Validated minimally; safetyCheck runs
  // server-side in the open-browser endpoint before navigation.
  const urlArg = typeof args.url === "string" ? args.url.trim() : "";
  const url = urlArg.length > 0 ? urlArg : undefined;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(state, {
      taskId: item.id,
      action: "browser.connect",
      // Use the reason as the target so the approval card surfaces
      // it prominently. The web UI also reads evidence.reason for
      // the body when rendering a browser.connect card.
      target: reason,
      risk: "medium",
      reason: reasonOverride ?? "Opening a managed browser window requires explicit approval.",
      payload: { reason, toolCallId, headless, url }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser connect (chat-task)",
      data: { approvalId: approval.id, reason, toolCallId, headless, url }
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
    // Tool-handler gate for the per-bridge target allow-list. The catalog
    // description promises this enforcement ("Optional delivery target
    // (chat id) on the bridge's allow-list"). `sendMessagingOutput` does
    // its own active-agent target filter, but that's a separate envelope
    // (the agent's allowed targets, not the bridge's) — without this
    // check an explicit target the bridge doesn't recognize would land
    // an approval row and surface as a runtime failure post-approval.
    // Keeping the check here makes the failure mode loud at tool-call
    // time so the model can correct itself. When `target` is omitted,
    // sendMessagingOutput falls back to the first allowed target (see
    // `bridge.deliveryTargets[0]`), which is the documented behavior.
    if (target !== undefined && !bridge.deliveryTargets.includes(target)) {
      throw new Error(
        `Invalid input: target '${target}' is not on bridge '${bridge.id}' allow-list (delivery targets: ${bridge.deliveryTargets.join(", ") || "<none>"})`
      );
    }
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

// Request that the user connect an external provider. Routed through the
// approval state machine so the chat-task loop pauses naturally — the
// task moves to waiting_approval, the chat UI renders a Connect card
// (branched on `action === "connector.request"`), and the loop resumes
// when the user finishes the secret entry via POST /api/approvals/<id>/connect.
//
// The side effect happens in the connect endpoint, NOT in
// executeApprovedAction: the endpoint calls createConnector + checkConnector,
// then resolves the approval. The corresponding executeApprovedAction
// branch is a no-op string that simply tells the model "connected, proceed".
async function requestConnectorTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  messageHistory?: readonly unknown[]
): Promise<DispatchResult> {
  const providerId = requireString(args, "provider");
  const reason = requireString(args, "reason");
  const provider = getProvider(providerId);
  if (!provider) {
    // Synchronous error so the model can recover (it picked a bogus
    // provider id). Matches how mcp_call surfaces unknown servers.
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Unknown provider: ${providerId}. The user has no path to connect this.`
      })
    };
  }

  // The model owns the full user-visible string. The skill body (when one
  // applies) shows the format — the model reads it, substitutes any real
  // values like project IDs, and passes the finished text here. No runtime
  // templating: `reason` becomes the approval's `reason` verbatim.

  // Fast path: if a healthy + configured connector already exists for
  // this provider, the model is calling defensively. Tell it to proceed
  // and skip the round-trip through the approval UI.
  const state = readState(config.instance);
  const existing = state.connectors.find(
    (c) => c.provider === providerId && c.status === "configured" && c.health === "healthy"
  );
  if (existing) {
    return {
      kind: "sync",
      result: `${provider.label} is already connected. Proceed with the original request.`
    };
  }

  // Setup-skill gate: providers that declare `setupSkill` own a multi-step
  // prerequisite flow (install CLI, OAuth, project provisioning, enable
  // APIs, etc.) before credential capture is meaningful. The model has
  // been observed bypassing the skill and calling request_connector
  // directly with a generic reason, leaving the user without the
  // prerequisites needed to mint credentials. Refuse the call when the
  // task's tool-call history shows no prior `read_skill` for the
  // declared setup skill — the error directs the model there, the
  // skill body itself calls request_connector at the end, and the
  // resumed call passes this same gate naturally because the
  // intervening read_skill is now in the message history.
  //
  // Look in BOTH the in-flight workingMessages (current turn's tool
  // history, only available via the chat-task loop's messageHistory
  // arg) AND the persisted snapshot on task.toolCallState. The
  // snapshot is only written when a task pauses for approval, so the
  // first time the model calls request_connector inside the same turn
  // it just called read_skill, only messageHistory has the evidence.
  if (provider.setupSkill) {
    const task = state.tasks.find((t) => t.id === taskId);
    const persisted = task?.toolCallState?.messages ?? [];
    const inFlight = messageHistory ?? [];
    const allMessages: readonly unknown[] = [...persisted, ...inFlight];
    const hasReadSetup = allMessages.some((m) => {
      if (!m || typeof m !== "object") return false;
      const msg = m as { role?: unknown; tool_calls?: unknown };
      if (msg.role !== "assistant") return false;
      const calls = msg.tool_calls;
      if (!Array.isArray(calls)) return false;
      return calls.some((c) => {
        if (!c || typeof c !== "object") return false;
        const call = c as { function?: { name?: unknown; arguments?: unknown } };
        const fn = call.function;
        if (!fn || fn.name !== "read_skill") return false;
        try {
          const args = typeof fn.arguments === "string"
            ? JSON.parse(fn.arguments)
            : (fn.arguments ?? {});
          return (args as { name?: unknown })?.name === provider.setupSkill;
        } catch {
          return false;
        }
      });
    });
    if (!hasReadSetup) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `This provider's setup is owned by the '${provider.setupSkill}' skill. Call \`read_skill\` with name '${provider.setupSkill}' first — that skill body walks through the required prerequisites (install, OAuth, project provisioning, APIs) and itself calls request_connector at the end.`
        })
      };
    }
  }

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(mutable, {
      taskId: item.id,
      action: "connector.request",
      target: provider.id,
      risk: "low",
      reason,
      payload: {
        provider: provider.id,
        providerLabel: provider.label,
        providerDescription: provider.description,
        reason,
        fields: provider.fields,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Persist the model's `reason` as a durable assistant bubble in the
    // chat session so it survives past approval resolution. Without this,
    // the bubble exists only while the task is `waiting_approval` (via
    // the synthesizer in getChatSession) and disappears once the user
    // saves the form — leaving no record of the instructions they just
    // acted on. Tag with kind:"approval_reason" so syncChatTaskResult's
    // single-summary-per-task short-circuit doesn't mistake this for the
    // task's final summary.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason"
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for connector connect (chat-task)",
      data: { approvalId: approval.id, provider: provider.id, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Browser-fill-secrets tool. Mints a browser.fill_secret approval
// whose payload carries the slots the agent wants the user to fill.
// Same chat-block emission path as request_connector — the chat-task
// loop's pending-approval handler emits an approval_requested block
// into the chat stream as soon as this returns { kind: "pending" }.
// The card renders inline. On Submit, the BFF forwards to
// POST /api/approvals/<id>/connect, which detects the action and
// runs the playwright-fill branch (see src/http.ts). Values are
// never written to state, audit, or trace payloads.
async function browserFillSecretsTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard: the amber approval card is React UI on the BFF, and
  // the messaging bridge mirrors (telegram-poller, discord-poller) only
  // relay assistant_text after the task reaches a terminal status.
  // Minting a fill_secret approval would park the task in
  // awaiting_approval, the mirror would skip with
  // reply_skip_non_terminal, and the user on Telegram/Discord would see
  // a typing indicator that eventually stops — no error, no card, no
  // way to submit. Fail the tool synchronously so the agent gets a
  // tool_result it can verbalize back as a plain assistant message
  // ("open the web chat to enter credentials"), which the mirror will
  // relay once the task settles.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  // Read both `source` (inbound bridge descriptor on live chat
  // sessions) and `outboundMirror` (bridge descriptor on dedicated
  // job-spawned sessions whose `source` is intentionally undefined
  // so they don't compete for inbound routing — see ChatSessionRecord
  // doc in src/types.ts). A scheduled job spawned from a Telegram
  // chat has source=undefined but outboundMirror.kind="telegram",
  // and submits with mode:"chat" so the full tool catalog is in
  // scope — without checking outboundMirror, the guard would let
  // such a job mint a fill_secret approval that no user can
  // complete (no web card was ever rendered, finalize.ts routes
  // the eventual reply back through outboundMirror to Telegram).
  // Mirror finalize.ts:161's `outboundMirror ?? source` precedent.
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (surfaceKind === "telegram" || surfaceKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `browser_fill_secrets only works in the web chat (this conversation is over ${surfaceKind}). Reply to the user in text asking them to open the web chat to enter their credentials, then continue once they confirm.`
      })
    };
  }

  const slots = parseFillSecretSlots(args.slots);
  if (slots.length === 0) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "browser_fill_secrets requires at least one valid slot (name + locator)."
      })
    };
  }
  // Slot names are the map key the chat card uses for both the React
  // list key and the fillValues record (BlockApprovalRequested.tsx); the
  // /connect handler also looks up secrets by name. Duplicate names
  // would silently share a single user-entered value across multiple
  // distinct DOM locators — picture an agent emitting two "password"
  // slots whose locators target username + password fields — so the
  // user types one value and both inputs receive it. Reject up-front
  // with a clear error.
  const seenNames = new Set<string>();
  const duplicates: string[] = [];
  for (const slot of slots) {
    if (seenNames.has(slot.name)) {
      duplicates.push(slot.name);
    } else {
      seenNames.add(slot.name);
    }
  }
  if (duplicates.length > 0) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `browser_fill_secrets slot names must be unique. Duplicates: ${Array.from(new Set(duplicates)).join(", ")}.`
      })
    };
  }
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `The agent is asking you to fill ${slots.length} field${slots.length === 1 ? "" : "s"} on the current page.`;

  // Build a stable target string so the approval card can show
  // which page the fill targets. The structural copy of the
  // approved URL lives on `payload.approvedUrl` (see the
  // createApproval call below) — the safety check in
  // src/execution/browser-fill-secrets.ts reads from there, NOT
  // from a parseable substring of target. `target` is the
  // human-readable label that flows into the audit row. Strip
  // query strings and fragments before recording — they
  // frequently carry tokens (OAuth `code`/`state`, password-reset
  // `token`, session ids, magic-link nonces) and the audit
  // writer-boundary only drops `evidence` on redacted:true, leaving
  // `target` intact.
  const liveUrl = peekCurrentBrowserUrl(taskId);
  const approvedUrl = sanitizeUrlForAuditTarget(liveUrl);
  // Refuse dispatch when no live browser session exists. Without a
  // captured origin, the user has no way to consent to a specific
  // page, and the /connect origin guard has nothing to compare
  // against — secrets typed into the chat card would land on
  // whatever page the session points at by /connect time, which
  // may not be the page the agent intended (or the page the user
  // would have approved if they could see it). The agent should
  // browser_navigate to the form's page first, then call
  // browser_fill_secrets with locators from the resulting snapshot.
  if (!approvedUrl) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "browser_fill_secrets requires an active browser session on the page being filled. Call browser_navigate (and browser_snapshot if needed) first, then re-issue this tool with locators from the snapshot."
      })
    };
  }
  const target = approvedUrl;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(mutable, {
      taskId: item.id,
      action: "browser.fill_secret",
      target,
      risk: "high",
      reason,
      // Structural fields the /connect handler reads:
      //   - slots: which DOM elements to fill (kept; parsed by
      //     parseFillSecretSlots at every consumer).
      //   - approvedUrl: the origin (protocol+host+port) captured
      //     at dispatch time, used as the load-bearing equality
      //     check against the live page URL before any .fill()
      //     runs. Stored structurally (not encoded in target's
      //     substring) so a future tweak to target formatting
      //     can't silently weaken the safety check. Pathname is
      //     stripped by sanitizeUrlForAuditTarget because
      //     reset/magic-link URLs can carry tokens in the path
      //     component.
      //   - toolCallId: the originating tool_call_id the chat-task
      //     loop uses to thread the resume tool result.
      payload: { slots, reason, toolCallId, approvedUrl }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Mirror the reason into the chat session so it survives past
    // approval resolution, same pattern as requestConnectorTool.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason"
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser.fill_secret",
      data: { approvalId: approval.id, slotCount: slots.length, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Messaging-bridge add affordance. Mints a `messaging.add_bridge`
// approval whose card surfaces a name input and a password-masked
// bot-token input inside the chat — the same inline-card pattern
// `browser_fill_secrets` and `request_connector` use. On Submit, the
// BFF forwards values to POST /api/approvals/<id>/connect, which
// routes into addMessagingBridge (the same code path the CLI and the
// settings page already call). The bot token never enters the model
// context, audit evidence, or the chat transcript — same hygiene as
// browser.fill_secret.
async function requestMessagingBridgeTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as browser_fill_secrets. The amber
  // card renders only in the web chat; a task running over Telegram
  // or Discord that minted this approval would park in
  // awaiting_approval forever with no submission path. Refuse early
  // so the agent can verbalize "open the web chat to add the bridge"
  // back to the user.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (surfaceKind === "telegram" || surfaceKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_bridge only works in the web chat (this conversation is over ${surfaceKind}). Reply to the user in text asking them to open the web chat to add the bridge there.`
      })
    };
  }

  const rawKind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
  // The chat card collects only name + bot token; Discord bridges
  // need a deliveryTargets channel-ID list that the card doesn't
  // surface, so an "add a discord bridge from chat" approval would
  // be unactionable (settings dialog + CLI are the only paths that
  // collect channel IDs). The catalog enum restricts kind to
  // "telegram", but the model can violate the schema; refuse here
  // with a clear message that points the user at the right surface
  // so the agent can fall back to plain text instead of minting a
  // dead-end approval card.
  if (rawKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "request_messaging_bridge cannot add a Discord bridge from chat: the card does not collect the required channel-IDs list. Tell the user to open the settings page and click \"Add Discord\" there."
      })
    };
  }
  if (rawKind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_bridge requires kind: "telegram" (got ${JSON.stringify(args.kind)}).`
      })
    };
  }
  const kind = "telegram" as const;
  const kindLabel = "Telegram";
  const suggestedName = typeof args.suggestedName === "string" && args.suggestedName.trim().length > 0
    ? args.suggestedName.trim()
    : `my-${kind}-bot`;
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `Add a ${kindLabel} bridge so this agent can talk to you on ${kindLabel}.`;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(mutable, {
      taskId: item.id,
      action: "messaging.add_bridge",
      target: kind,
      risk: "high",
      reason,
      // Structural payload fields the /connect handler reads:
      //   - kind: telegram | discord, drives the addMessagingBridge
      //     branch + the per-kind help text under the form.
      //   - suggestedName: prefilled value for the name input; the
      //     user can change it before submitting.
      //   - toolCallId: links the resume tool result back to the
      //     originating tool_call in the chat-task loop.
      payload: { kind, suggestedName, reason, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Mirror the reason into the chat session so it survives past
    // approval resolution — same pattern as requestConnectorTool /
    // browserFillSecretsTool.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason"
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.add_bridge",
      data: { approvalId: approval.id, kind, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Read-only inventory of configured messaging bridges. Returns the
// minimum every caller needs (id, name, kind, status, bot username
// from metadata) so the agent can answer "what bridges do I have?"
// or pick the right id for a follow-up request_remove_messaging_bridge
// without leaking the encrypted secret refs / per-chat allowlists.
async function listMessagingBridgesTool(config: RuntimeConfig): Promise<string> {
  const state = readState(config.instance);
  const bridges = state.messagingBridges.map((bridge) => {
    const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
    const botUsername = typeof meta.botUsername === "string" ? meta.botUsername : undefined;
    return {
      id: bridge.id,
      name: bridge.name,
      kind: bridge.kind,
      status: bridge.status,
      message: bridge.message ?? null,
      botUsername: botUsername ?? null,
      createdAt: bridge.createdAt,
      updatedAt: bridge.updatedAt
    };
  });
  return JSON.stringify({ ok: true, bridges });
}

// Read-only view of a Telegram bridge's pending pairing requests +
// current allowlist. Mirrors the data MessagingCard's
// TelegramPendingRequests component polls so the agent sees what
// the operator would see in settings. Returns ok:false (string
// envelope, not throw) on unknown bridges or non-telegram kinds so
// the model gets a recoverable tool result instead of a hard error.
async function listMessagingPairingsTool(
  config: RuntimeConfig,
  args: Record<string, unknown>
): Promise<string> {
  const bridge = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridge) {
    return JSON.stringify({ ok: false, error: "list_messaging_pairings requires a 'bridge' (id or name)." });
  }
  try {
    const view = listAllowedChats(config, bridge);
    // Redact verificationCode + verificationCodeExpiresAt from the
    // tool envelope. The code is a security-critical token whose
    // entire purpose is preventing TOFU enrollment race attacks
    // (see messaging.ts `DeniedChatAttempt`); a prompt-injected
    // agent that could read it would be able to scrape live codes
    // and race the legitimate user. The model doesn't need the
    // code to pair: request_messaging_pairing's dispatcher reads
    // the same listAllowedChats view server-side when minting the
    // approval, and the operator confirms the code by eye against
    // what the bot DM'd them. The settings UI still gets the full
    // view via its own /api/messaging/* path; only the model-
    // facing tool envelope is redacted.
    const safeRecentDeniedChats = view.recentDeniedChats.map((entry) => ({
      chatId: entry.chatId,
      chatType: entry.chatType,
      sender: entry.sender,
      lastAttemptAt: entry.lastAttemptAt
    }));
    return JSON.stringify({
      ok: true,
      bridge,
      allowedChatIds: view.allowedChatIds,
      ownerChatId: view.ownerChatId,
      recentDeniedChats: safeRecentDeniedChats
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// Pairing-approval affordance. Mints a messaging.approve_pairing
// approval whose payload carries everything the chat card needs to
// render the confirmation (bridge id+name+botUsername, chat id+type,
// sender, verification code + expiry). Approve / Reject both flow
// through /api/approvals/<id>/connect (Reject just sends
// `{ reject: true }`); /approve refuses this action.
//
// The dispatcher reads the pending row up-front and refuses if the
// chat is already enrolled, no longer pending, or the code has
// expired — gives the agent a recoverable tool_result instead of
// minting a card the operator can't act on.

// Shape of a pending recentDeniedChats entry that both
// requestMessagingPairingTool and waitForMessagingPairTool consume
// when minting a messaging.approve_pairing approval. Fields match
// what BlockApprovalRequested.tsx pulls off the payload.
interface PendingPairForApproval {
  chatId: number;
  chatType?: string;
  sender?: string;
  verificationCode?: string;
  verificationCodeExpiresAt?: string;
}

// Single source of truth for messaging.approve_pairing approval
// minting. Both the explicit-request tool (requestMessagingPairingTool)
// and the wait-loop tool (waitForMessagingPairTool) build the same
// approval shape, including the chat-task plumbing (approvalIds.push,
// approval_reason chat message, appendTrace). Centralizing it keeps
// the two call sites from drifting when the card grows a new payload
// field — adding the field here propagates to both.
async function mintPairingApproval(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  bridge: { id: string; name: string; metadata?: Record<string, unknown> },
  pending: PendingPairForApproval,
  reasonOverride?: string
): Promise<string> {
  const reason = reasonOverride
    ?? `Confirm the verification code below matches what you received on Telegram before approving chat ${pending.chatId}.`;
  const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
  const botUsername = typeof meta.botUsername === "string" ? meta.botUsername : undefined;
  return mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(mutable, {
      taskId: item.id,
      action: "messaging.approve_pairing",
      target: `${bridge.id}:${pending.chatId}`,
      risk: "medium",
      reason,
      payload: {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        botUsername: botUsername ?? null,
        chatId: pending.chatId,
        chatType: pending.chatType ?? "private",
        sender: pending.sender ?? null,
        verificationCode: pending.verificationCode ?? null,
        verificationCodeExpiresAt: pending.verificationCodeExpiresAt ?? null,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason"
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.approve_pairing",
      data: { approvalId: approval.id, bridgeId: bridge.id, chatId: pending.chatId, toolCallId }
    });
    return approval.id;
  });
}

async function requestMessagingPairingTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as requestMessagingBridgeTool /
  // browserFillSecretsTool. The approval card renders only in the
  // web chat; a task spawned from a Telegram (or Discord) bridge
  // that minted this approval would park in awaiting_approval
  // forever, and the telegram-poller would skip relay via
  // reply_skip_non_terminal. Refuse early so the agent can fall
  // back to plain text ("open the web chat to approve the pairing").
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (surfaceKind === "telegram" || surfaceKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_pairing only works in the web chat (this conversation is over ${surfaceKind}). Tell the user to open the web chat to approve the pairing.`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "request_messaging_pairing requires a 'bridge' (id or name)." })
    };
  }
  const chatIdRaw = args.chatId;
  const chatId = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  if (!Number.isFinite(chatId)) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `request_messaging_pairing requires a numeric 'chatId' (got ${JSON.stringify(args.chatId)}).` })
    };
  }
  const state = readState(config.instance);
  const bridge = state.messagingBridges.find((b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName);
  if (!bridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  if (bridge.kind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Pairing approvals only apply to telegram bridges (got '${bridge.kind}').` })
    };
  }
  const view = listAllowedChats(config, bridge.id);
  if (view.allowedChatIds.includes(chatId)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Chat ${chatId} is already enrolled on bridge '${bridge.name}'. No pairing card needed.`
      })
    };
  }
  const pending = view.recentDeniedChats.find((entry) => entry.chatId === chatId);
  if (!pending) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `No pending pairing request for chat ${chatId} on bridge '${bridge.name}'. Have the user DM the bot to mint a fresh request.`
      })
    };
  }
  if (pending.verificationCodeExpiresAt) {
    const expiresAt = Date.parse(pending.verificationCodeExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `Verification code for chat ${chatId} expired. Tell the user to DM the bot again to mint a fresh code.`
        })
      };
    }
  }
  // Group chats deliberately have no verification code (the bot can't
  // DM a per-user code through a group), and the chat-card approve
  // path requires one for the verification handshake. messaging-
  // pairing-connect.ts refuses code-less approves, so without this
  // up-front check the agent would mint a card whose Approve button
  // bounces — only Reject would work and the card would sit there
  // until the operator gave up. Refuse the mint instead so the
  // agent surfaces the right next step to the user (settings page
  // or `gini messaging allow`).
  if (!pending.verificationCode) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Chat ${chatId} on bridge '${bridge.name}' has no verification code (likely a group chat). Group enrollments don't go through the chat-card handshake — tell the user to open the settings page (or run \`gini messaging allow ${bridge.name} ${chatId}\`) to approve.`
      })
    };
  }

  const reasonOverride = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : undefined;
  const approvalId = await mintPairingApproval(
    config,
    taskId,
    toolCallId,
    bridge,
    { ...pending, chatId },
    reasonOverride
  );
  return { kind: "pending", approvalId };
}

// Server-side blocking tool the agent calls right after a
// successful request_messaging_bridge. Polls the bridge's
// recentDeniedChats every second for up to `timeoutSeconds`; the
// moment a fresh pending row shows up, mints a
// messaging.approve_pairing approval bound to the agent's task and
// returns {kind:"pending", approvalId} so the chat-task loop pauses
// on the approval card. Lets the agent stay engaged with the user
// through the bridge-add → user-DMs-bot → operator-approves dance
// without returning control and asking the user to come back.
//
// Exit paths:
//   - Pending row arrives → mint approval → pending DispatchResult
//   - Task cancelled mid-wait → sync ok:false with "cancelled"
//   - Timeout → sync ok:false with "timeout" so the agent can
//     surface the option to keep waiting or skip
//
// Reuses the same surface guard as the other request_ tools: a
// Telegram/Discord-sourced chat can't surface an approval the
// remote user can't act on.
async function waitForMessagingPairTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (surfaceKind === "telegram" || surfaceKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `wait_for_messaging_pair only works in the web chat (this conversation is over ${surfaceKind}).`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "wait_for_messaging_pair requires a 'bridge' (id or name)." })
    };
  }
  const requestedTimeoutSeconds = typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds
    : 600;
  // Clamp to a sane window. The lower bound keeps a too-short
  // call from racing the poll interval; the upper bound caps how
  // long we tie up the chat-task awaiting an external event.
  const timeoutSeconds = Math.max(10, Math.min(1800, Math.round(requestedTimeoutSeconds)));
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  const POLL_INTERVAL_MS = 1000;

  // Validate bridge existence + kind up-front so we don't burn
  // the timeout on a typo'd name. The wait predicate itself
  // re-reads state every tick, so no snapshot is held here:
  // surfacing a pending row that arrived BEFORE the wait started
  // is still legitimate (the operator hasn't acted on it yet),
  // and approved rows are removed from recentDeniedChats so they
  // can't loop back. The previous snapshot-diff predicate raced
  // with the natural "user DMs the bot between bridge create and
  // wait_for_messaging_pair start" window — pre-existing rows
  // were filtered out as not-new even though they represented the
  // exact unresolved pair the agent was waiting for.
  const initialBridge = readState(config.instance).messagingBridges.find(
    (b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName
  );
  if (!initialBridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  if (initialBridge.kind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `wait_for_messaging_pair only applies to telegram bridges (got '${initialBridge.kind}').` })
    };
  }
  // Snapshot the allowlist at wait start so we can detect a chat
  // getting enrolled out-of-band (settings page click, CLI
  // `gini messaging allow`, or another agent's parallel
  // request_messaging_pairing) WHILE this wait is running. allowChat
  // both removes the pending row AND adds chatId to allowedChatIds,
  // so the pending-row predicate alone can't tell us "someone else
  // approved it" from "no one has DM'd yet" — both look like
  // "nothing to surface." Without this snapshot, the agent would
  // time out and tell the user "DM the bot again" even though they
  // were already enrolled.
  const initialAllowedSnapshot = new Set<number>(
    Array.isArray((initialBridge.metadata ?? {} as Record<string, unknown>).allowedChatIds)
      ? ((initialBridge.metadata ?? {}).allowedChatIds as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : []
  );

  const reasonText = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : undefined;

  // Poll loop. readState is in-process cached, so this is cheap.
  while (Date.now() < deadlineMs) {
    const liveState = readState(config.instance);

    // Abort if the task itself was cancelled mid-wait.
    const liveTask = liveState.tasks.find((t) => t.id === taskId);
    if (liveTask && isTerminalTaskStatus(liveTask.status)) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: "wait_for_messaging_pair aborted: task was cancelled."
        })
      };
    }

    const liveBridge = liveState.messagingBridges.find(
      (b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName
    );
    if (!liveBridge) {
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, error: `Messaging bridge no longer exists: ${bridgeIdOrName}.` })
      };
    }
    const liveMeta = (liveBridge.metadata ?? {}) as {
      allowedChatIds?: unknown;
      recentDeniedChats?: Array<{
        chatId: number;
        chatType?: string;
        sender?: string;
        verificationCode?: string;
        verificationCodeExpiresAt?: string;
      }>;
    };
    const livePending = liveMeta.recentDeniedChats ?? [];
    const allowedSet = new Set<number>(
      Array.isArray(liveMeta.allowedChatIds)
        ? liveMeta.allowedChatIds.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : []
    );

    // Out-of-band enrollment detection: any chat in the current
    // allowlist that wasn't there at wait start is a fresh
    // approval landed via settings / CLI / a parallel agent flow.
    // Return success so the agent can tell the user "the chat is
    // enrolled, you can DM the bot now" instead of timing out.
    const freshlyEnrolled: number[] = [];
    for (const chatId of allowedSet) {
      if (!initialAllowedSnapshot.has(chatId)) freshlyEnrolled.push(chatId);
    }
    if (freshlyEnrolled.length > 0) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: true,
          outOfBand: true,
          enrolledChatIds: freshlyEnrolled,
          message: `Chat ${freshlyEnrolled.join(", ")} got enrolled on bridge '${liveBridge.name}' out-of-band (settings page, CLI, or a parallel agent flow) while waiting. The user can DM the bot now.`
        })
      };
    }

    // Surface the first pending row that the operator can act on:
    // (a) has a verification code (groups never mint a code and
    // are not approvable via the chat-card handshake — they go
    // through the settings page / CLI), (b) isn't already enrolled
    // on the bridge's allowlist (defensive; allowChat clears
    // recentDeniedChats on enroll), and (c) the code hasn't
    // expired. Without (c), an operator who left the chat tab
    // open across the 10-minute code TTL would be presented an
    // approval card whose Approve action would fail at allowChat's
    // expired-code throw. Mirrors the expiry guard inside
    // requestMessagingPairingTool.
    const nowMs = Date.now();
    const newOrRotated = livePending.find((entry) => {
      if (!entry.verificationCode) return false;
      if (allowedSet.has(entry.chatId)) return false;
      if (entry.verificationCodeExpiresAt) {
        const expiresAt = Date.parse(entry.verificationCodeExpiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
      }
      return true;
    });

    if (newOrRotated && newOrRotated.verificationCode) {
      // Delegate to the shared mintPairingApproval helper so the
      // payload shape stays in lockstep with requestMessagingPairingTool.
      // The helper writes its own "Approval requested" trace; add a
      // wait-variant trace afterward so an operator inspecting the
      // task log can tell the card came from the polling loop instead
      // of an explicit request_messaging_pairing call.
      const approvalId = await mintPairingApproval(
        config,
        taskId,
        toolCallId,
        liveBridge,
        newOrRotated,
        reasonText
      );
      appendTrace(config.instance, taskId, {
        type: "approval",
        message: "Approval requested for messaging.approve_pairing (wait_for_messaging_pair)",
        data: { approvalId, bridgeId: liveBridge.id, chatId: newOrRotated.chatId, toolCallId }
      });
      return { kind: "pending", approvalId };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    kind: "sync",
    result: JSON.stringify({
      ok: false,
      error: `wait_for_messaging_pair timed out after ${timeoutSeconds}s with no inbound pair on bridge '${initialBridge.name}'. The user can DM the bot again — call wait_for_messaging_pair to retry, or move on if they're not pairing right now.`
    })
  };
}

// Bridge-removal affordance. Mints a messaging.remove_bridge
// approval whose card asks the operator to confirm tearing down a
// configured bridge from chat. Approve POSTs `{}` to /connect; the
// runtime calls removeMessagingBridge (same path as the CLI / the
// settings page's Remove button). Tasks see the resume tool result
// once removal completes.
async function requestRemoveMessagingBridgeTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as the other request_ tools.
  // The destructive confirmation card renders only in the web chat;
  // a task spawned from a Telegram (or Discord) bridge that minted
  // this approval would park in awaiting_approval forever.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (surfaceKind === "telegram" || surfaceKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_remove_messaging_bridge only works in the web chat (this conversation is over ${surfaceKind}). Tell the user to open the web chat to confirm bridge removal.`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "request_remove_messaging_bridge requires a 'bridge' (id or name)." })
    };
  }
  const state = readState(config.instance);
  const bridge = state.messagingBridges.find((b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName);
  if (!bridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `Remove the ${bridge.kind} bridge '${bridge.name}'? This deletes its bot token; past messages stay in history.`;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createApproval(mutable, {
      taskId: item.id,
      action: "messaging.remove_bridge",
      target: bridge.id,
      risk: "high",
      reason,
      payload: {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        kind: bridge.kind,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason"
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.remove_bridge",
      data: { approvalId: approval.id, bridgeId: bridge.id, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
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
// creates an Approval row (status transitions pending -> approved
// through resolveApproval, same as a human approval) and writes the
// `autoApproved=true` + `autoApprovedReason=<policy reason>` markers
// onto the resolution audit rows. The reviewer sees an identical
// trail to a normal flow except for the marker on the audit row.
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
