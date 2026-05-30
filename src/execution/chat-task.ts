// Chat-task agent loop.
//
// runChatTask is the entry point used by submitTask when mode === "chat".
// It builds a tool list, builds a conversation, calls the model with native
// tool-calling, dispatches the resulting tool calls, and feeds results back
// to the model until the model produces a final text answer.
//
// Approval-gated tools pause the loop. The runtime persists the in-flight
// messages array onto the task, transitions the task to waiting_approval,
// and returns. When the approval resolves through agent.executeApprovedAction,
// the side effect runs and resumeChatTask() is called with the captured
// tool result; the loop then continues from where it stopped.

import {
  appendEvent,
  appendLog,
  appendTaskPartial,
  appendTrace,
  createChatMessage,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState,
  readTrace
} from "../state";
import { ApprovedActionFailedError, findTask, scheduleAutoRetain } from "../agent";
import { recall } from "../memory";
import {
  generateToolCallingResponse,
  type ToolCallingMessage,
  type MessageContentPart,
  type ToolCall
} from "../provider";
import { uploadDataUrl } from "../state/uploads";
import {
  SOUL_SOFT_CAP_CHARS,
  USER_SOFT_CAP_CHARS,
  buildAgentSystemContext,
  buildBoundJobsBlock,
  decideIdentityEmission,
  identityBudgetState,
  renderFullIdentity
} from "../system-prompt";
import { loadInstructions, loadSoul, loadUserProfile } from "../runtime/identity-files";
import type {
  AgentIdentity,
  CostRecord,
  IdentitySnapshotRecord,
  JobRecord,
  PendingToolCall,
  RuntimeConfig,
  RuntimeState,
  SkillRecord,
  SubagentRecord,
  Task,
  TaskToolCallState,
  ToolCallSummary
} from "../types";
import type { EffectiveContext } from "./effective-context";
import { updateRunFromTask } from "./runs";
import { buildToolCatalog, hashCatalog, toProviderTools } from "./tool-catalog";
import {
  emitAuthorizationRequested,
  emitSetupRequested,
  emitAssistantTextStart,
  emitPhase,
  emitSystemNote,
  emitToolCallRunning,
  emitToolCallStatus,
  emitToolResult,
  finalizeAssistantText,
  resolveEmitContext,
  updateAssistantTextDelta,
  type ChatEmitContext
} from "./chat-task-emit";
import { dispatchToolCall, parseToolArgsLenient } from "./tool-dispatch";
import { getSubagentForTask, syncSubagentFromTask } from "../capabilities/subagents";
import { autoRenameChatAfterTurn } from "./chat";
import { finalizeJobRunFromTask } from "../jobs/finalize";
import { isSkillActive } from "../integrations/connectors";
import { getProvider } from "../integrations/connectors/registry";
import { resolveEffectiveContext } from "./effective-context";

// Default safety cap on chat-task loop iterations. Each iteration is one
// model call (followed by zero or more tool dispatches). Most tasks finish
// in well under 10 iterations; the cap exists to bound runaway loops, not
// to be a meaningful budget for normal work. Power users can override this
// per-instance via `config.agent.maxIterations` in `~/.gini/instances/<inst>/config.json`.
const MAX_LOOP_ITERATIONS = 90;

// Resolve the effective iteration cap from config, falling back to the
// default when the user hasn't set one or set an invalid value. Validation
// is intentionally minimal — positive integer or fall back. We log a single
// warning trace from runLoop on fallback so the user can spot the typo.
function resolveIterationCap(config: RuntimeConfig): { cap: number; warnReason?: string } {
  const raw = config.agent?.maxIterations;
  if (raw === undefined) return { cap: MAX_LOOP_ITERATIONS };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      cap: MAX_LOOP_ITERATIONS,
      warnReason: `agent.maxIterations must be a positive integer; got ${JSON.stringify(raw)}. Using default ${MAX_LOOP_ITERATIONS}.`
    };
  }
  return { cap: raw };
}

// Add an incremental cost record (from a single model call) into a running
// accumulator. Token totals sum across calls; USD estimates sum when
// present. `provider`/`model` track the most recent call so the surfaced
// cost row reflects whichever model spent the bulk of the budget — this
// mirrors how upstream UIs display task.cost as the latest provider used
// rather than a multi-provider rollup.
function addCost(accumulator: CostRecord | undefined, increment: CostRecord | undefined): CostRecord | undefined {
  if (!increment) return accumulator;
  if (!accumulator) {
    // Clone to avoid the caller mutating the original later.
    return { ...increment };
  }
  const sum = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    provider: increment.provider ?? accumulator.provider,
    model: increment.model ?? accumulator.model,
    inputTokens: sum(accumulator.inputTokens, increment.inputTokens),
    outputTokens: sum(accumulator.outputTokens, increment.outputTokens),
    totalTokens: sum(accumulator.totalTokens, increment.totalTokens),
    estimatedUsd: sum(accumulator.estimatedUsd, increment.estimatedUsd)
  };
}

// Cap on Task.recentToolCalls length. The UI only renders this while a task
// is in-flight; older entries scroll off-screen anyway. A small cap keeps
// the state JSON bounded even on long tool-heavy loops.
const MAX_RECENT_TOOL_CALLS = 20;

// Build a compact, single-line preview of tool-call arguments for the chat
// UI. JSON object inputs render as `key=value, key=value`; arrays/scalars
// fall back to the trimmed JSON. Whitespace is collapsed and the result
// truncated with an ellipsis. Returns "" when there are no arguments.
function buildArgsPreview(rawArgs: string | undefined): string {
  if (!rawArgs) return "";
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    const fallback = collapse(rawArgs);
    return fallback.length > 200 ? `${fallback.slice(0, 199)}…` : fallback;
  }
  let preview: string;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      let valStr: string;
      if (typeof v === "string") valStr = v;
      else {
        try { valStr = JSON.stringify(v); } catch { valStr = String(v); }
      }
      parts.push(`${k}=${valStr}`);
    }
    preview = parts.join(", ");
  } else {
    try { preview = JSON.stringify(parsed); } catch { preview = String(parsed); }
  }
  preview = collapse(preview);
  if (preview.length > 200) preview = `${preview.slice(0, 199)}…`;
  return preview;
}

// Push a new tool-call entry onto Task.recentToolCalls, capping length.
// Mutates `item` in place — caller must already be inside `mutateState`.
function pushRecentToolCall(item: Task, summary: ToolCallSummary): void {
  const list = item.recentToolCalls ?? [];
  list.push(summary);
  if (list.length > MAX_RECENT_TOOL_CALLS) {
    list.splice(0, list.length - MAX_RECENT_TOOL_CALLS);
  }
  item.recentToolCalls = list;
}

// Flip a tool-call entry's status (and stamp completedAt). No-op if the
// entry isn't found — older entries can be evicted by the cap above.
function updateRecentToolCall(
  item: Task,
  toolCallId: string,
  status: "done" | "error"
): void {
  const list = item.recentToolCalls;
  if (!list) return;
  const entry = list.find((c) => c.id === toolCallId);
  if (!entry) return;
  entry.status = status;
  entry.completedAt = now();
}

// runChatTask: kicks off the chat-task loop for a freshly submitted task.
// Sets the task to running, builds the initial system + user messages,
// recalls memory the same way the legacy path does, then calls runLoop.
export async function runChatTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  let task = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    // Respect a terminal status that was set BEFORE we acquired
    // the lock. An unconditional flip to "running" would overwrite
    // a `cancelled` status that `cancelTask` may have written
    // between `submitTask` returning and `runChatTask` scheduling
    // — letting a cancelled task continue running its tool-calling
    // loop. Returning the item as-is lets the loop's terminal-bail
    // check exit cleanly below.
    if (isTerminalTaskStatus(item.status)) {
      return item;
    }
    item.status = "running";
    item.currentStep = "Thinking";
    item.mode = "chat";
    item.updatedAt = now();
    return item;
  });
  if (isTerminalTaskStatus(task.status)) {
    appendTrace(config.instance, taskId, {
      type: "task",
      message: `Chat task start aborted: already ${task.status}`,
      data: { status: task.status }
    });
    return task;
  }
  await updateRunFromTask(config, task);

  appendTrace(config.instance, taskId, {
    type: "task",
    message: "Chat task started",
    data: { input: task.input }
  });
  appendLog(config.instance, "task.started", { taskId, mode: "chat" });

  // Resolve the active agent up-front so memory recall and pinned-memory
  // filtering both use the same isolation key (Phase C). Without an active
  // agent we skip auto-recall — Hindsight requires a namespace.
  const stateForAgent = readState(config.instance);
  const effectiveForAgent = resolveEffectiveContext(stateForAgent, config);
  const agentIdForMemory = effectiveForAgent.agentId;

  // Auto-recall: queries the Hindsight bank for relevant context. If
  // recall fails we continue without it — the model can still answer
  // off USER.md / SOUL.md and the task input.
  let recalledContext: string | undefined;
  let hindsightUnitsRecalled = 0;
  if (agentIdForMemory) {
    try {
      const recalled = await recall(config, {
        agentId: agentIdForMemory,
        query: task.input,
        tokenBudget: 1500,
        sourceTaskId: taskId
      });
      if (recalled.units.length > 0) {
        hindsightUnitsRecalled = recalled.units.length;
        recalledContext = recalled.units
          .map((entry, idx) => `${idx + 1}. (${entry.unit.network}) ${entry.unit.text}`)
          .join("\n");
      }
    } catch (error) {
      appendTrace(config.instance, taskId, {
        type: "memory",
        message: "auto-recall failed",
        data: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  const state = readState(config.instance);
  // `state.memories` was removed as part of the memory-surface
  // consolidation; identity facts live in USER.md and recalled-from-
  // Hindsight memory now. See ADR runtime-identity-files.md.
  // Subagent path: child tasks override the default Gini preamble with the
  // subagent's own system prompt and filter the enabled-skills block by the
  // subagent's skill whitelist (when set).
  const subagent = getSubagentForTask(state, task);
  // Tell-once-plus-delta identity injection (only for the non-subagent
  // parent path — subagents get their own override prompt and short-lived
  // context). The decision function returns either the full block, just
  // the changed fields, or "" when nothing changed. Compute the would-be
  // snapshot here but DEFER the write to inside runLoop so that the
  // snapshot only advances after the prompt actually reaches the
  // provider; otherwise a cancellation between runChatTask's exit
  // and runLoop's first model call would mark identity as "emitted"
  // when the model never saw it, leaving the next turn's delta
  // referencing a baseline the model has no memory of.
  let identityBlock: string | undefined;
  let pendingIdentitySnapshot: { conversationId: string; snapshot: IdentitySnapshotRecord } | undefined;
  if (!subagent) {
    const identity = buildAgentIdentity(config, state, effectiveForAgent);
    const conversationId = task.runId
      ? state.runs.find((r) => r.id === task.runId)?.conversationId
      : undefined;
    if (conversationId) {
      const snapshot = state.identitySnapshots?.[conversationId];
      const turnCount = state.runs.filter((r) => r.conversationId === conversationId).length;
      const decision = decideIdentityEmission(identity, snapshot, turnCount);
      identityBlock = decision.content;
      if (decision.nextSnapshot) {
        pendingIdentitySnapshot = { conversationId, snapshot: decision.nextSnapshot };
      }
    } else {
      // No chat session (e.g. CLI/imperative entry that still routes
      // through runChatTask): emit full identity every time. No
      // snapshot persistence because there's no conversation to key on.
      identityBlock = renderFullIdentity(identity);
    }
  }
  // Runtime identity files (INSTRUCTIONS.md / SOUL.md / USER.md). The
  // subagent path opts out — subagents already get an override prompt.
  // Blocked files emit a runtime trace warning but never crash the
  // gateway. See ADR runtime-identity-files.md.
  let instructionsOverride: string | undefined;
  let soulBlock: string | undefined;
  let userProfileBlock: string | undefined;
  if (!subagent) {
    const onBlocked = (filename: string, findings: string[]): void => {
      appendTrace(config.instance, taskId, {
        type: "model",
        message: `identity file blocked: ${filename}`,
        data: { filename, findings }
      });
    };
    instructionsOverride = loadInstructions(config.instance, { onBlocked }) ?? undefined;
    soulBlock = loadSoul(config.instance, effectiveForAgent.agentId, { onBlocked }) ?? undefined;
    userProfileBlock = loadUserProfile(config.instance, { onBlocked }) ?? undefined;
    // Surface "over cap" identity files to the trace so the operator can
    // see the model is pushing past the soft cap. Skipped for BLOCKED
    // notices (already audited via onBlocked) and absent files.
    if (userProfileBlock && !userProfileBlock.startsWith("[BLOCKED:")) {
      const budget = identityBudgetState(userProfileBlock, USER_SOFT_CAP_CHARS);
      if (budget.overCap) {
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "identity file budget exceeded: USER.md",
          data: { file: "USER.md", used: budget.used, cap: budget.cap, pct: budget.pct }
        });
      }
    }
    if (soulBlock && !soulBlock.startsWith("[BLOCKED:")) {
      const budget = identityBudgetState(soulBlock, SOUL_SOFT_CAP_CHARS);
      if (budget.overCap) {
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "identity file budget exceeded: SOUL.md",
          data: { file: "SOUL.md", used: budget.used, cap: budget.cap, pct: budget.pct }
        });
      }
    }
  }
  const baseSystem = subagent && subagent.systemPrompt
    ? subagent.systemPrompt
    : buildAgentSystemContext(recalledContext, identityBlock, {
        instructionsOverride,
        soul: soulBlock,
        userProfile: userProfileBlock
      });
  const filteredSkills = filterSkillsForSubagent(state.skills, subagent);
  const visibleSkills = filteredSkills.filter((skill) => isSkillActive(state, skill));
  const skillsBlock = buildEnabledSkillsBlock(visibleSkills);
  // Inactive-but-available skills (enabled, but a required connector is
  // missing). Surfaced so the model knows it can call request_connector
  // to ask the user to wire things up instead of erroring out or
  // hallucinating an answer.
  const inactiveSkills = filteredSkills.filter(
    (skill) => skill.status === "enabled" && !isSkillActive(state, skill)
  );
  const inactiveSkillsBlock = buildInactiveSkillsBlock(inactiveSkills);
  // Bound-jobs block: if this chat session has one or more JobRecords whose
  // chatSessionId matches, surface them in the system prompt so the model
  // can act on "this job" / "the reminder" without first calling list_jobs.
  // Applies to both the default Gini preamble and the subagent prompt --
  // the binding is a property of the chat session, not the prompt source.
  const boundJobs = findBoundJobsForTask(state, task);
  const boundJobsBlock = buildBoundJobsBlock(boundJobs);
  // Advertise configured http MCP servers so the model knows mcp_call is
  // wired up against this server and can locate the matching skill before
  // invoking. Only "configured" status surfaces; disabled/error servers
  // stay hidden the same way disabled skills do.
  const mcpServersBlock = buildMcpServersBlock(state);
  const sections = [baseSystem];
  if (skillsBlock) sections.push(skillsBlock);
  if (inactiveSkillsBlock) sections.push(inactiveSkillsBlock);
  if (mcpServersBlock) sections.push(mcpServersBlock);
  if (boundJobsBlock) sections.push(boundJobsBlock);
  const systemContext = sections.join("\n\n");

  // Conversation history: include prior turns from the same chat session so
  // the model has multi-turn context (the legacy single-shot path didn't).
  const prior = priorChatMessages(config, task);
  const messages: ToolCallingMessage[] = [
    { role: "system", content: systemContext },
    ...prior,
    buildUserMessage(config, task)
  ];

  appendTrace(config.instance, taskId, {
    type: "model",
    message: "chat-task system context built",
    data: { hindsightUnitsRecalled, priorMessages: prior.length }
  });

  return runLoop(config, taskId, messages, 0, pendingIdentitySnapshot, effectiveForAgent);
}

// Capture the runtime identity exposed to the model via the system
// prompt. Pulled from the same data sources gini status reads so the
// agent's self-report stays consistent with the CLI's view of the
// instance. Returns "(none)" placeholders for the optional agent fields
// when state has no active agent (system-driven flows).
export function buildAgentIdentity(
  config: RuntimeConfig,
  state: RuntimeState,
  effective: EffectiveContext
): AgentIdentity {
  const agent = effective.agentId
    ? state.agents.find((a) => a.id === effective.agentId)
    : undefined;
  // An undefined `effective.toolsetFilter` does NOT mean "zero toolsets".
  // Per src/execution/effective-context.ts, an undefined filter means the
  // agent imposes no restriction, so every enabled toolset is exposed by
  // src/execution/tool-catalog.ts. Render the actual ground truth — the
  // names of every enabled toolset in state — so the identity block does
  // not falsely tell the model `(none)` when in fact every tool is live.
  //
  // When the filter IS set, intersect against the same enabled-toolset
  // set buildToolCatalog uses to compose the actual catalog. Otherwise
  // the identity block would advertise disabled-in-state or unknown
  // toolset names that the agent declared in its whitelist but that the
  // catalog filters out at dispatch — telling the model a tool family
  // is available when it cannot actually call any of those tools. The
  // EffectiveContext.warnings field already exists to surface the drift
  // to operators; the prompt block reports ground truth.
  const enabledToolsetNames = new Set(
    state.toolsets.filter((toolset) => toolset.status === "enabled").map((toolset) => toolset.name)
  );
  const toolsets = effective.toolsetFilter
    ? Array.from(effective.toolsetFilter).filter((name) => enabledToolsetNames.has(name)).sort()
    : Array.from(enabledToolsetNames).sort();
  return {
    instance: config.instance,
    runtimePort: config.port,
    agentName: agent?.name ?? "default",
    agentId: effective.agentId ?? "(none)",
    provider: `${effective.provider.name}/${effective.provider.model}`,
    toolsets,
    memoryNamespace: effective.memoryNamespace ?? "(none)"
  };
}

// Resolve the chat session id behind this task and scan state.jobs for
// records whose `chatSessionId` matches. Returns [] when:
//   - the task has no runId (legacy non-chat path)
//   - the run isn't found, or has no conversationId (not a chat run)
//   - no JobRecord points at this session
// Callers feed the result into buildBoundJobsBlock; an empty array yields
// an empty string so the systemContext doesn't carry a stray header.
function findBoundJobsForTask(state: RuntimeState, task: Task): JobRecord[] {
  if (!task.runId) return [];
  const run = state.runs.find((r) => r.id === task.runId);
  if (!run?.conversationId) return [];
  const sessionId = run.conversationId;
  return state.jobs.filter((job) => job.chatSessionId === sessionId);
}

// Resolve the chat session id behind a task via its run's conversationId.
// Returns undefined for tasks with no chat session (subagent children,
// imperative CLI runs) — those paths skip transcript persistence.
function resolveChatSessionId(state: RuntimeState, task: Task): string | undefined {
  if (!task.runId) return undefined;
  const run = state.runs.find((r) => r.id === task.runId);
  return run?.conversationId ?? undefined;
}

// Persist one tool-calling transcript row so the model can replay its own
// prior tool calls + results on the next turn (see ADR
// agent-loop-tool-calling.md). Rows are tagged kind:"tool_transcript" and
// stay out of the human-facing JSON views (chat.ts). No-op when the task
// has no chat session (sessionId undefined) or has already reached a
// terminal status — a transcript row written after cancel/fail would
// outlive the turn it belongs to.
function persistTranscriptRow(
  config: RuntimeConfig,
  taskId: string,
  sessionId: string | undefined,
  row: {
    role: "assistant" | "tool";
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }
): void {
  if (!sessionId) return;
  void mutateState(config.instance, (state) => {
    const item = state.tasks.find((t) => t.id === taskId);
    if (item && isTerminalTaskStatus(item.status)) return;
    // A concurrent deleteChat between two persist points would otherwise let
    // createChatMessage recreate orphan rows for a session that no longer
    // exists; no-op when the session has vanished mid-turn.
    if (!state.chatSessions.some((s) => s.id === sessionId)) return;
    createChatMessage(state, {
      sessionId,
      role: row.role,
      content: row.content,
      taskId,
      runId: item?.runId,
      kind: "tool_transcript",
      ...(row.toolCalls ? { toolCalls: row.toolCalls } : {}),
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {})
    });
  });
}

// Pull prior chat messages for multi-turn context. We replay the full
// ordered transcript of every prior turn in the same chat session —
// user/assistant text plus the assistant tool_calls and role:"tool" results
// persisted as kind:"tool_transcript" rows — so the model sees the structured
// results of its own earlier actions (a created issue's id, a read_skill
// body) instead of re-deriving them. The in-flight task is excluded (its own
// turn is built live in workingMessages).
function priorChatMessages(config: RuntimeConfig, task: Task): ToolCallingMessage[] {
  const state = readState(config.instance);
  const sessionId = resolveChatSessionId(state, task);
  if (!sessionId) return [];
  const stored = state.chatMessages
    .filter((m) => m.sessionId === sessionId && m.taskId !== task.id)
    .sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt);
      if (byTime !== 0) return byTime;
      return (a.seq ?? 0) - (b.seq ?? 0);
    });

  // Map durable rows to provider messages. Assistant rows carrying toolCalls
  // and role:"tool" result rows become tool-calling messages; plain
  // user/assistant text rows keep their legacy shape (vision content for
  // user images).
  const mapped: (ToolCallingMessage & { __toolCallIds?: string[] })[] = [];
  for (const m of stored) {
    if (m.role === "tool" && m.kind === "tool_transcript") {
      mapped.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
      continue;
    }
    if (m.role === "assistant" && m.kind === "tool_transcript") {
      const toolCalls = m.toolCalls ?? [];
      mapped.push({
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        tool_calls: toolCalls as ToolCall[],
        __toolCallIds: toolCalls.map((c) => c.id)
      });
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      if (m.role === "user" && m.images && m.images.length > 0) {
        mapped.push({ role: "user", content: buildVisionContent(config, m.content, m.images) });
      } else {
        mapped.push({ role: m.role, content: m.content });
      }
    }
  }

  // Defensive pairing pass. Providers reject an assistant tool_calls message
  // whose ids aren't each answered by a following role:"tool" message, and
  // reject orphan tool messages. A partially-persisted turn (process died
  // mid-loop) can leave either. Tool result rows are persisted immediately
  // after their assistant row, so we pair each assistant tool_calls row with
  // the role:"tool" rows in its own local window — the rows that follow it up
  // to the next assistant/user row — matching the assistant's own ids. A
  // session-global id map would mispair when two turns reuse the same
  // tool_call_id (the text-backstop path synthesizes ids from
  // name:args:index, so the same tool+args on two turns collides). Drop orphan
  // tool rows, and drop any assistant tool_calls row missing one of its paired
  // results — so replay can never produce a provider 400.
  const paired: ToolCallingMessage[] = [];
  for (let i = 0; i < mapped.length; i++) {
    const msg = mapped[i]!;
    if (msg.role === "tool") continue; // emitted alongside its assistant below
    if (msg.role === "assistant" && msg.__toolCallIds) {
      const ids = msg.__toolCallIds;
      // Collect the tool result rows in this assistant row's local window.
      const resultsInWindow = new Map<string, ToolCallingMessage>();
      for (let j = i + 1; j < mapped.length; j++) {
        const next = mapped[j]!;
        if (next.role !== "tool") break; // window ends at the next non-tool row
        if (typeof next.tool_call_id === "string") {
          resultsInWindow.set(next.tool_call_id, next);
        }
      }
      const results = ids.map((id) => resultsInWindow.get(id));
      if (ids.length === 0 || results.some((r) => r === undefined)) continue; // drop unpaired turn
      const { __toolCallIds, ...assistant } = msg;
      paired.push(assistant);
      for (const result of results) paired.push(result as ToolCallingMessage);
      continue;
    }
    paired.push(msg);
  }
  return paired;
}

// Build the latest user-turn message. When the task carries image refs the
// content becomes a parts array so the provider sees both text and images;
// otherwise it stays a plain string (the legacy text-only path).
function buildUserMessage(config: RuntimeConfig, task: Task): ToolCallingMessage {
  if (task.images && task.images.length > 0) {
    return { role: "user", content: buildVisionContent(config, task.input, task.images) };
  }
  return { role: "user", content: task.input };
}

// Render image refs as data URLs at dispatch time. The provider can't
// authenticate against /api/uploads/:id, so we inline base64 bytes. A
// missing/unreadable upload is dropped with a trace; the text part is
// retained so the model still gets the user's words.
function buildVisionContent(
  config: RuntimeConfig,
  text: string,
  images: ReadonlyArray<{ id: string; mimeType: string }>
): MessageContentPart[] {
  const parts: MessageContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const image of images) {
    const dataUrl = uploadDataUrl(config.instance, image.id);
    if (!dataUrl) {
      appendLog(config.instance, "chat.image.missing", { uploadId: image.id });
      continue;
    }
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  // Provider requires non-empty content. If every image failed to load and
  // there was no text, fall through to an empty text part so we never send
  // an empty parts array.
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

// Restrict the parent-built tool catalog to the subagent's toolset
// whitelist. Skill-catalog tools (read_skill) and web_fetch are always
// allowed (mirrors buildToolCatalog's permissive defaults). When the
// subagent has no whitelist (undefined/empty), the parent catalog passes
// through unchanged.
function filterToolsForSubagent<T extends { toolset: string; function: { name: string } }>(
  tools: T[],
  subagent: SubagentRecord | undefined
): T[] {
  if (!subagent || !subagent.toolsetIds || subagent.toolsetIds.length === 0) return tools;
  const allowed = new Set(subagent.toolsetIds);
  return tools.filter((tool) => {
    if (tool.function.name === "read_skill") return true;
    if (tool.function.name === "web_fetch") return true;
    return allowed.has(tool.toolset);
  });
}

// Filter the enabled-skill list down to a subagent's whitelist. When the
// subagent has no whitelist (toolset-or-skill-undefined / inherit), the full
// list is returned. When the whitelist is set, only matching skill names
// are advertised — the read_skill tool itself still gates on
// `status === "enabled"` so a disabled skill can't slip through.
function filterSkillsForSubagent(skills: SkillRecord[], subagent: SubagentRecord | undefined): SkillRecord[] {
  if (!subagent || !subagent.skillNames || subagent.skillNames.length === 0) return skills;
  const allowed = new Set(subagent.skillNames);
  return skills.filter((s) => allowed.has(s.name));
}

// Build the "Available skills:" block that gets prepended to the system
// prompt for the agent loop. We only advertise enabled skills (disabled /
// archived stay invisible). The block lists each name +
// frontmatter description; the model uses the read_skill tool to fetch
// the full body when it actually needs the instructions. This keeps the
// resident system prompt small even when many skills are registered.
function buildEnabledSkillsBlock(skills: SkillRecord[]): string {
  const enabled = skills.filter((s) => s.status === "enabled");
  if (enabled.length === 0) return "";
  // Dedupe by name, preferring bundled records over user records when both
  // exist with the same name. Mirrors the read_skill tool's tiebreak so
  // the advertised skill description matches the body that read_skill will
  // return.
  const byName = new Map<string, SkillRecord>();
  for (const skill of enabled) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, skill);
      continue;
    }
    const existingSource = existing.source ?? "user";
    const candidateSource = skill.source ?? "user";
    if (existingSource !== "bundled" && candidateSource === "bundled") {
      byName.set(skill.name, skill);
    }
  }
  const lines = Array.from(byName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const desc = s.description.trim() || "(no description)";
      return `- ${s.name}: ${desc}`;
    });
  return [
    "Available skills (call read_skill with the skill name to load full instructions):",
    ...lines
  ].join("\n");
}

// Inactive-but-enabled skills block. Distinct from buildEnabledSkillsBlock:
// these skills are turned on but unusable because a required connector is
// missing. We tell the model exactly which provider needs connecting so it
// can either invoke the provider's setup skill (when the provider declares
// one) or call `request_connector` directly to ask the user to connect.
//
// Skills with `requiredConnectors` undefined / empty are skipped: those are
// inactive for some other reason (validation status, etc.) and there's no
// connector affordance to offer.
//
// We group by provider — multiple product skills often share the same
// connector (e.g. all Google Workspace skills share google-oauth-desktop),
// and emitting one line per provider keeps the block compact and points
// the model at a single setup path per connector.
//
// Exported for unit testing; production callers use it via runChatTask.
export function buildInactiveSkillsBlock(skills: SkillRecord[]): string {
  const candidates = skills.filter(
    (skill) => skill.status === "enabled" && (skill.requiredConnectors?.length ?? 0) > 0
  );
  if (candidates.length === 0) return "";
  // Same dedupe rule as buildEnabledSkillsBlock so the same skill name
  // doesn't show up twice when bundled + user copies coexist.
  const byName = new Map<string, SkillRecord>();
  for (const skill of candidates) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, skill);
      continue;
    }
    const existingSource = existing.source ?? "user";
    const candidateSource = skill.source ?? "user";
    if (existingSource !== "bundled" && candidateSource === "bundled") {
      byName.set(skill.name, skill);
    }
  }
  // Group dedup'd skills by provider id. setupSkill is captured per
  // provider — if any skill's required provider declares one, the
  // provider-level line directs the model to invoke that skill instead
  // of calling request_connector directly.
  const grouped = new Map<string, { skills: string[]; setupSkill?: string }>();
  for (const skill of byName.values()) {
    for (const req of skill.requiredConnectors ?? []) {
      const entry = grouped.get(req.provider) ?? { skills: [] };
      entry.skills.push(skill.name);
      const module = getProvider(req.provider);
      if (module?.setupSkill) entry.setupSkill = module.setupSkill;
      grouped.set(req.provider, entry);
    }
  }
  const lines = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => {
      const skillList = Array.from(new Set(entry.skills)).sort().join(", ");
      if (entry.setupSkill) {
        return `- ${provider} (used by: ${skillList}) — run \`read_skill\` with \`${entry.setupSkill}\` first; request_connector will be rejected until you do.`;
      }
      return `- ${provider} (used by: ${skillList}) — call \`request_connector\` with provider id \`${provider}\` to ask the user to connect.`;
    });
  // The setup skill is the ONLY correct path for the listed providers.
  // Without this directive, the model has shortcutted to browser_navigate
  // (opening gmail.com / calendar.google.com / a Google sign-in page) to
  // extract data or coax the user into signing in outside the proper flow.
  // Browser tools exist for unrelated web tasks; they are not a bypass for
  // the connector handshake.
  const hasSetupSkill = Array.from(grouped.values()).some((entry) => entry.setupSkill);
  const intro = hasSetupSkill
    ? "Skills below need an external connector. The runtime gates `request_connector` for providers that declare a setup skill — call `read_skill` with the setup skill first (it owns the full prerequisite flow and will invoke request_connector itself). For providers WITHOUT a setup skill, call `request_connector` with the provider id directly."
    : "Skills below need an external connector. For providers with a setup skill listed, invoke that skill first (it walks through any install / OAuth / project provisioning, then captures credentials). Otherwise, call `request_connector` with the provider id directly.";
  const sections: string[] = [
    intro,
    ...lines
  ];
  if (hasSetupSkill) {
    sections.push(
      "IMPORTANT: When a skill above lists a setup skill, that setup skill is the ONLY correct path to satisfy the user's request. Do NOT use `browser_navigate`, `browser_click`, or other browser tools to access the provider's web surface directly (e.g. navigating to gmail.com or calendar.google.com to extract data, or opening a Google sign-in page outside the setup flow). The browser tools are for unrelated tasks. If the user asks for something that requires a missing-connector skill, your first step is `read_skill` with the listed setup skill — never `browser_navigate`."
    );
  }
  return sections.join("\n");
}

// Advertise configured http MCP servers in the system prompt. The model
// reads this block to know which servers are available to mcp_call and
// which skill body to load for the per-server tool reference. Stdio
// servers are intentionally omitted — the v0 stdio path is a stub and
// surfacing it would invite the model to call something that can't
// actually serve MCP traffic.
function buildMcpServersBlock(state: RuntimeState): string {
  const servers = state.mcpServers.filter(
    (s) => s.status === "configured" && s.transport === "http"
  );
  if (servers.length === 0) return "";
  const lines = servers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const count = s.tools?.length ?? 0;
      const suffix = count > 0 ? ` (${count} tool${count === 1 ? "" : "s"})` : "";
      return `- ${s.name}${suffix} — call read_skill name='${s.name}' for the curated tool reference.`;
    });
  return [
    "Configured MCP servers (use the `mcp_call` tool to invoke):",
    ...lines
  ].join("\n");
}

// Inner loop. Calls the model, dispatches tool calls, and either completes
// the task with the final text or pauses the task waiting for approvals.
//
// The `iterationsSoFar` argument lets resumeChatTask continue counting
// across approval pauses (so a single conversation can't bypass the cap by
// chaining approvals).
//
// `pendingIdentitySnapshot` is forwarded from runChatTask on fresh
// task entry. It is the would-be identity snapshot for this conversation
// turn, deferred from runChatTask so that the snapshot only commits
// to state AFTER the first model call returns successfully. This closes
// the cancel-before-send window: a task cancelled between runChatTask
// and runLoop's first iteration leaves state.identitySnapshots intact, so
// the model's view of identity stays consistent with the snapshot the
// next turn computes its delta against. resumeChatTask never sets this
// argument because the originating turn already either committed or
// abandoned its snapshot.
//
// `inheritedEffective` carries the EffectiveContext that runChatTask
// already resolved when building the identity block, so the tool
// catalog, toolset filter, and provider override fired here all stay
// consistent with what the identity block told the model. Without this
// inheritance, a `gini agents use <other>` (or any other mutation that
// flips the active agent / its provider / its toolsets) landing in the
// async window between runChatTask's resolve and this one would
// desynchronize the identity block from the actual model call.
// resumeChatTask deliberately omits it: an approval resume is a
// separate logical entry and is allowed to pick up agent changes since
// the originating turn (matching the existing comment at "toolset
// mid-pause we'll pick up the change on resume").
async function runLoop(
  config: RuntimeConfig,
  taskId: string,
  messages: ToolCallingMessage[],
  iterationsSoFar: number,
  pendingIdentitySnapshot?: { conversationId: string; snapshot: IdentitySnapshotRecord },
  inheritedEffective?: EffectiveContext
): Promise<Task> {
  // Build the tool catalog once per loop entry. If the user toggles a
  // toolset mid-pause we'll pick up the change on resume — that's a
  // feature, not a bug, and the toolsHash check protects against weird
  // schema drift.
  const state0 = readState(config.instance);
  const taskRow = state0.tasks.find((t) => t.id === taskId);
  const subagent0 = taskRow ? getSubagentForTask(state0, taskRow) : undefined;
  // Resolve the chat session id once per loop entry so each persist point
  // below can stamp a tool_transcript row. Undefined for subagent/imperative
  // tasks (no chat session), in which case persistTranscriptRow is a no-op.
  const transcriptSessionId = taskRow ? resolveChatSessionId(state0, taskRow) : undefined;
  // Resolve the active-agent overrides (provider, toolset filter, etc.).
  // Provider override flows into generateToolCallingResponse below; the
  // toolset filter narrows buildToolCatalog before the subagent filter
  // narrows further (state → agent → subagent composition). On fresh
  // entry runChatTask hands us the already-resolved EffectiveContext;
  // resumeChatTask omits it so the resume picks up any agent change.
  const effective = inheritedEffective ?? resolveEffectiveContext(state0, config);
  const tools = filterToolsForSubagent(buildToolCatalog(state0, effective.toolsetFilter), subagent0);
  const providerTools = toProviderTools(tools);
  const toolsHash = hashCatalog(tools);

  const { cap, warnReason } = resolveIterationCap(config);
  if (warnReason) {
    // Only emit the invalid-config warning once per task. resumeChatTask
    // re-enters runLoop after every approval, so without this guard a task
    // that bounces through several approvals would log the same warning
    // for each resume — noisy and confusing in the trace.
    const priorTraces = readTrace(config.instance, taskId);
    const alreadyWarned = priorTraces.some(
      (t) =>
        t.type === "warning" &&
        typeof (t.data as Record<string, unknown> | undefined)?.reason === "string" &&
        (t.data as Record<string, unknown>).reason === warnReason
    );
    if (!alreadyWarned) {
      appendTrace(config.instance, taskId, {
        type: "warning",
        message: `Invalid agent.maxIterations config; using default.`,
        data: { reason: warnReason, defaultCap: MAX_LOOP_ITERATIONS }
      });
    }
  }

  let iterations = iterationsSoFar;
  let workingMessages = messages.slice();
  // Carry the running cost across approval resumes by seeding from the
  // task's existing cost row (set by a prior runLoop entry). Each model
  // call adds into this accumulator and we write it back on every
  // persistence point so partial work is never lost — including on pause,
  // graceful exhaustion, and the failure fallback.
  let accumulatedCost: CostRecord | undefined = taskRow?.cost ? { ...taskRow.cost } : undefined;

  // Resolve the ChatBlock emission context once per runLoop entry. Tasks
  // with no chat session (subagent children, imperative CLI runs) get
  // `undefined`, in which case the emit* helpers are no-ops. Per ADR
  // chat-block-protocol.md, subagent inner work stays opaque to the
  // user — only the parent's `spawn_subagent` tool_call surfaces.
  const emitCtx: ChatEmitContext | undefined = resolveEmitContext(config, taskId);
  // Tracks the in-flight assistant_text block id for delta upserts so a
  // streaming model response only emits a single block per loop
  // iteration. Reset between iterations so the next provider call gets
  // a fresh block.
  let inFlightAssistantBlockId: string | undefined;
  let inFlightAssistantText = "";

  while (iterations < cap) {
    iterations += 1;

    // Terminal-state bail-out. If the task was already moved to any
    // terminal status — cancelled externally, failed by a concurrent
    // approval denial, or completed by a parallel path — stop the loop
    // here so we don't (a) keep running model calls against a dead
    // task or (b) overwrite the terminal status with a later
    // "completed" write at the end of the loop. Previously this only
    // checked for "cancelled", which let a race-lost auto-approve
    // continue iterating after a concurrent user-deny had already
    // failed the task.
    {
      const terminalCheck = readState(config.instance).tasks.find((t) => t.id === taskId);
      if (!terminalCheck || isTerminalTaskStatus(terminalCheck.status)) {
        appendTrace(config.instance, taskId, {
          type: "task",
          message: `Chat task loop noticed terminal status (${terminalCheck?.status ?? "missing"})`,
          data: { iterations, status: terminalCheck?.status }
        });
        await syncSubagentFromTask(config, terminalCheck ?? ({ id: taskId, subagentId: undefined } as unknown as Task));
        return terminalCheck ?? ({ id: taskId, status: "cancelled" } as unknown as Task);
      }
    }

    // Stream partial text into task.partialSummary just like the legacy
    // path. Debounced to avoid thrashing mutateState on every SSE delta.
    //
    // We also accrete the streamed text into an assistant_text ChatBlock
    // for the new protocol. The first delta inserts the block; every
    // subsequent delta upserts with the full running text so reconnecting
    // clients always observe a monotonically growing string and never
    // splice partial deltas themselves (ADR chat-block-protocol.md).
    // Both writes are debounced together so a thousand-token response
    // doesn't trigger a thousand SQLite UPDATEs.
    let pending = "";
    let lastFlush = 0;
    // Reset per-iteration: a new model call gets a fresh assistant_text
    // block. The terminal flip to `streaming: false` happens at the
    // completion / iteration-cap / cancellation paths below.
    inFlightAssistantBlockId = undefined;
    inFlightAssistantText = "";
    const flush = async (): Promise<void> => {
      if (!pending) return;
      const delta = pending;
      pending = "";
      lastFlush = Date.now();
      await mutateState(config.instance, (state) => {
        appendTaskPartial(state, taskId, delta);
      });
      // Mirror the same flush boundary to the assistant_text block so
      // SSE subscribers see the same cadence the partialSummary path
      // exposes today. The block carries the FULL accreted text (not
      // the delta), so a reconnect always observes a monotonically
      // growing string and never needs to splice deltas itself.
      if (emitCtx) {
        inFlightAssistantText += delta;
        if (!inFlightAssistantBlockId) {
          const block = emitAssistantTextStart(emitCtx, inFlightAssistantText);
          inFlightAssistantBlockId = block?.id;
        } else {
          updateAssistantTextDelta(emitCtx, inFlightAssistantBlockId, inFlightAssistantText);
        }
      }
    };
    const onDelta = (text: string): void => {
      pending += text;
      if (Date.now() - lastFlush >= 150) {
        void flush();
      }
    };

    // Re-check terminal status under the lock that flips
    // currentStep to "Thinking" so a cancel queued between the
    // lock-free top-of-loop check and this mutation doesn't get
    // overwritten — AND so we don't fire a fresh provider call on
    // a cancelled task.
    const preModelGuard = await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      if (isTerminalTaskStatus(item.status)) {
        return { proceed: false as const, status: item.status };
      }
      item.currentStep = "Thinking";
      item.updatedAt = now();
      return { proceed: true as const };
    });
    if (!preModelGuard.proceed) {
      appendTrace(config.instance, taskId, {
        type: "task",
        message: `Chat task bail-out: terminal status (${preModelGuard.status}) observed before model call`,
        data: { iterations, status: preModelGuard.status }
      });
      const stale = readState(config.instance).tasks.find((t) => t.id === taskId);
      return stale ?? ({ id: taskId, status: "cancelled" } as unknown as Task);
    }
    // Phase block paired with the currentStep flip above so the chat UI
    // renders the same "Thinking" marker the web/mobile clients already
    // synthesize from currentStep today. Subsequent per-tool phases
    // ("Working: <toolName>") emit per dispatch inside the loop below.
    emitPhase(emitCtx, "Thinking");

    const result = await generateToolCallingResponse(
      config,
      workingMessages,
      providerTools,
      onDelta,
      effective.providerSource === "agent" ? effective.provider : undefined
    );
    await flush();
    accumulatedCost = addCost(accumulatedCost, result.cost);

    // First successful provider call in this runLoop entry: commit the
    // deferred identity snapshot. We only persist once per fresh
    // runChatTask entry; subsequent iterations within the same
    // tool-calling loop reuse the same system prompt the model already
    // ingested, so the snapshot must not advance on each iteration. By
    // landing the write here we guarantee state.identitySnapshots only
    // records identity that genuinely reached the provider.
    //
    // Skip the write if the chat session was deleted between the
    // snapshot decision (in runChatTask) and now -- otherwise the
    // deferred write would recreate the orphan entry that
    // deleteChatSession just cleared. The mutateState lock serializes
    // with deleteChatSession, so the existence check here is decisive.
    if (pendingIdentitySnapshot) {
      const pending = pendingIdentitySnapshot;
      pendingIdentitySnapshot = undefined;
      await mutateState(config.instance, (st) => {
        if (!st.chatSessions.some((session) => session.id === pending.conversationId)) {
          return;
        }
        if (!st.identitySnapshots) st.identitySnapshots = {};
        st.identitySnapshots[pending.conversationId] = pending.snapshot;
      });
    }

    appendTrace(config.instance, taskId, {
      type: "model",
      message: `${result.provider.name} provider replied (iteration ${iterations})`,
      data: {
        provider: result.provider,
        responseId: result.responseId,
        usage: result.usage,
        toolCalls: result.toolCalls.length,
        finishReason: result.finishReason
      }
    });

    // Final answer path: no tool calls, model said stop (or unknown but
    // produced text).
    if (result.toolCalls.length === 0) {
      const finalText = result.text || "";
      const finished = await mutateState(config.instance, (state) => {
        const item = findTask(state, taskId);
        // Respect a prior terminal status. `cancelTask` may have
        // flipped the task to `cancelled` while
        // `generateToolCallingResponse` was in flight; overwriting
        // to `completed` here would silently drop the operator's
        // cancel.
        if (isTerminalTaskStatus(item.status)) return item;
        item.status = "completed";
        item.currentStep = "Completed";
        item.summary = finalText || "(no content)";
        item.cost = accumulatedCost;
        // partialSummary is no longer the source of truth — clear it so
        // the chat UI uses the synced summary instead.
        item.partialSummary = undefined;
        item.toolCallState = undefined;
        item.updatedAt = now();
        return item;
      });
      // Finalize the streaming assistant_text block (if any) with the
      // model's full text, then emit a terminal "Completed" phase. We
      // skip the finalize when the task was cancelled mid-stream —
      // cancelTask owns the streaming-text flip in that case so the
      // partial-text invariant from ADR risks §4 holds.
      if (finished.status === "completed") {
        if (inFlightAssistantBlockId) {
          finalizeAssistantText(emitCtx, inFlightAssistantBlockId, finalText || "(no content)");
        } else if (finalText) {
          // No streaming deltas observed (provider returned the whole
          // string at once). Emit the final block in one shot so the
          // client still gets an assistant_text row.
          const block = emitAssistantTextStart(emitCtx, finalText);
          if (block?.id) finalizeAssistantText(emitCtx, block.id, finalText);
        }
        emitPhase(emitCtx, "Completed");
      }
      appendTrace(config.instance, taskId, {
        type: "task",
        message: "Chat task completed",
        data: { summary: finished.summary, iterations }
      });
      await updateRunFromTask(config, finished);
      await syncSubagentFromTask(config, finished);
      // Chat-mode tasks spawned by a scheduled job (create_job tool path)
      // need the same finalize hook the imperative path uses, otherwise
      // the JobRunRecord stays stuck in `running` and the chat-session
      // delivery never fires. Idempotent — no-op for tasks without jobId.
      if (finished.jobId) await finalizeJobRunFromTask(config, finished);
      // Hindsight phase 5: auto-retain on chat-task completion. Without
      // this, anything the user says in chat ("my name is X") never lands
      // in the per-agent memory bank, so cross-chat recall surfaces
      // nothing. Fire-and-forget — mirror the legacy `runTask` site. Guard
      // with the post-mutateState status so a cancel that landed during
      // the model's text stream doesn't retain a cancelled output.
      if (finished.status === "completed") {
        void scheduleAutoRetain(config, finished);
        if (finished.chatSessionId) {
          void autoRenameChatAfterTurn(config, finished.chatSessionId).catch((error) => {
            appendLog(config.instance, "chat.auto_title.failed", {
              sessionId: finished.chatSessionId,
              taskId: finished.id,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
      return finished;
    }

    // Terminal re-check between model response and tool dispatch.
    // Without this, a cancel that landed during the
    // `generateToolCallingResponse` await still lets synchronous
    // side-effecting tools run (browser click/type, create_job).
    // Approval-gated tool helpers carry their own guard; this check
    // closes the gap for low-risk tools.
    {
      const postModelStatus = readState(config.instance).tasks.find((t) => t.id === taskId)?.status;
      if (postModelStatus && isTerminalTaskStatus(postModelStatus)) {
        appendTrace(config.instance, taskId, {
          type: "task",
          message: `Chat task bail-out: terminal status (${postModelStatus}) observed after model response, before tool dispatch`,
          data: { iterations, toolCalls: result.toolCalls.length, postModelStatus }
        });
        const stale = readState(config.instance).tasks.find((t) => t.id === taskId);
        return stale ?? ({ id: taskId, status: "cancelled" } as unknown as Task);
      }
    }

    // Tool-call path: append the assistant message (with tool_calls), then
    // dispatch each call. Synchronous tools resolve immediately; gated
    // tools snapshot state and pause the task.
    const assistantMessage: ToolCallingMessage = {
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls
    };
    workingMessages.push(assistantMessage);
    // Persist the assistant tool_calls row so next turn replays it. Its
    // paired tool results are persisted per call below (sync / skip /
    // dispatch-error) or in resumeChatTask (gated path).
    persistTranscriptRow(config, taskId, transcriptSessionId, {
      role: "assistant",
      content: result.text ?? "",
      toolCalls: result.toolCalls
    });

    const pendingApprovals: PendingToolCall[] = [];
    const toolResultMessages: ToolCallingMessage[] = [];

    // Before we start dispatching tool calls, finalize the streaming
    // assistant_text block (if any) so clients see the model's
    // pre-tool-call narration as a settled block rather than a
    // perpetually-streaming row. The next iteration will allocate a
    // fresh block for whatever text the model emits after the tool
    // results come back.
    if (inFlightAssistantBlockId) {
      finalizeAssistantText(
        emitCtx,
        inFlightAssistantBlockId,
        inFlightAssistantText || (result.text ?? "")
      );
      inFlightAssistantBlockId = undefined;
      inFlightAssistantText = "";
    }

    // Tracks whether an earlier call in this turn returned a pending
    // approval. Subsequent calls in the same `result.toolCalls` array
    // MUST be skipped (not dispatched) so their side effects don't
    // race the user's approval decision — e.g. an LLM turn that emits
    // `[browser_fill_secrets, browser_click]` would otherwise fire
    // browser_click on an empty form before the user submits the
    // credential card. Each skipped call still gets a synthetic
    // tool_result so the message-history stays paired
    // (assistant_message tool_call → tool result) and the LLM can
    // re-evaluate after the approval resolves.
    let pausedThisTurn = false;
    for (const call of result.toolCalls) {
      if (pausedThisTurn) {
        const skipMessage = "Skipped: a prior tool call in this turn requires approval. Will re-evaluate after that approval resolves.";
        const skipContent = JSON.stringify({ ok: false, skipped: true, reason: skipMessage });
        toolResultMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: skipContent
        });
        persistTranscriptRow(config, taskId, transcriptSessionId, {
          role: "tool",
          toolCallId: call.id,
          content: skipContent
        });
        emitToolCallStatus(emitCtx, { callId: call.id, status: "error", errorMessage: skipMessage });
        emitToolResult(emitCtx, { callId: call.id, result: skipMessage });
        await mutateState(config.instance, (state) => {
          updateRecentToolCall(findTask(state, taskId), call.id, "done");
        });
        appendTrace(config.instance, taskId, {
          type: "tool",
          message: "Tool call skipped: prior pending approval in same turn",
          data: { toolCallId: call.id, toolName: call.function.name }
        });
        continue;
      }
      // Re-check terminal status under the same `mutateState` lock
      // that flips currentStep. The post-model bail-out above is
      // lock-free (`readState`), which leaves a window where a
      // queued `cancelTask` could land between that `readState` and
      // this mutation. Without this guard, currentStep gets set on
      // a cancelled task and `dispatchToolCall` proceeds into side
      // effects (browser click/type, spawn_subagent, create_job)
      // before the next iteration's top-of-loop check observes the
      // cancel.
      const argsPreview = buildArgsPreview(call.function.arguments);
      const startedAt = now();
      const guard = await mutateState(config.instance, (state) => {
        const item = findTask(state, taskId);
        if (isTerminalTaskStatus(item.status)) {
          return { proceed: false as const, status: item.status };
        }
        item.currentStep = `Working: ${call.function.name}`;
        item.updatedAt = startedAt;
        pushRecentToolCall(item, {
          id: call.id,
          name: call.function.name,
          argsPreview,
          status: "running",
          startedAt
        });
        return { proceed: true as const };
      });
      if (!guard.proceed) {
        appendTrace(config.instance, taskId, {
          type: "task",
          message: `Chat task bail-out: terminal status (${guard.status}) observed before dispatch of ${call.function.name}`,
          data: { iterations, toolCallId: call.id, postLockStatus: guard.status }
        });
        const stale = readState(config.instance).tasks.find((t) => t.id === taskId);
        return stale ?? ({ id: taskId, status: "cancelled" } as unknown as Task);
      }
      // Per-tool phase + tool_call(running) emission. Args are parsed
      // leniently — emission must never abort dispatch on malformed
      // JSON, so a bad-arg call still gets a row with `argsFull: {}`
      // and the standard tool_call_id linkage to the eventual error.
      emitPhase(emitCtx, `Working: ${call.function.name}`);
      const parsedArgs = parseToolArgsLenient(call.function.arguments);
      emitToolCallRunning(emitCtx, {
        toolName: call.function.name,
        callId: call.id,
        args: parsedArgs
      });
      try {
        const dispatch = await dispatchToolCall(
          config,
          taskId,
          call.function.name,
          call.id,
          call.function.arguments,
          workingMessages
        );
        if (dispatch.kind === "sync") {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: dispatch.result
          });
          persistTranscriptRow(config, taskId, transcriptSessionId, {
            role: "tool",
            toolCallId: call.id,
            content: dispatch.result
          });
          // Flip the tool_call row to `ok` and append a tool_result
          // block carrying a truncated preview of the dispatch result.
          emitToolCallStatus(emitCtx, { callId: call.id, status: "ok" });
          emitToolResult(emitCtx, { callId: call.id, result: dispatch.result });
          // Mirror onto the legacy Task.recentToolCalls display payload so
          // clients still reading the task record (rather than the block
          // stream) see the same status flip.
          await mutateState(config.instance, (state) => {
            updateRecentToolCall(findTask(state, taskId), call.id, "done");
          });
        } else {
          pendingApprovals.push({
            toolCallId: call.id,
            toolName: call.function.name,
            approvalId: dispatch.approvalId
          });
          // From this point on, remaining tool calls in the same turn
          // are skipped — their side effects must not race the
          // user's approval decision.
          pausedThisTurn = true;
          // Re-read the gate row to surface action/summary on the right
          // block kind. Authorizations carry risk and render with an
          // Approve/Deny pair; SetupRequests are user-actor and render
          // with action-specific layouts (Connect / credential inputs /
          // Submit). See docs/adr/authorization-vs-setup-request.md.
          const stateForBlock = readState(config.instance);
          const authRow = stateForBlock.authorizations.find((a) => a.id === dispatch.approvalId);
          if (authRow) {
            emitAuthorizationRequested(emitCtx, {
              authorizationId: authRow.id,
              action: authRow.action,
              risk: authRow.risk,
              summary: authRow.reason ?? authRow.target
            });
          } else {
            const setupRow = stateForBlock.setupRequests.find((s) => s.id === dispatch.approvalId);
            if (setupRow) {
              emitSetupRequested(emitCtx, {
                setupRequestId: setupRow.id,
                action: setupRow.action,
                summary: setupRow.reason ?? setupRow.target
              });
            }
          }
          // Approval-gated tools haven't actually run yet, but from the
          // UI's perspective the agent is no longer "dispatching" this
          // call — it's now waiting on the user. Mark done on the legacy
          // recentToolCalls payload so the row stops spinning; the
          // approval block conveys the gate.
          await mutateState(config.instance, (state) => {
            updateRecentToolCall(findTask(state, taskId), call.id, "done");
          });
        }
      } catch (error) {
        // An approved side effect (file.write, terminal.exec, etc.) that
        // failed AFTER the approval was marked approved is fundamentally
        // different from a validation/dispatch error: the human gate (or
        // its dangerouslyAutoApprove equivalent) was already burned, so
        // letting the model retry as if nothing happened risks declaring
        // the task complete despite an audit-row gap. Let those escape
        // up to runChatTask's outer .catch so the task is failed.
        if (error instanceof ApprovedActionFailedError) {
          await mutateState(config.instance, (state) => {
            updateRecentToolCall(findTask(state, taskId), call.id, "error");
          });
          throw error;
        }

        // Dispatch failed (bad args, unknown tool, validation error). Feed
        // the error back to the model as the tool result so it can recover.
        const message = error instanceof Error ? error.message : String(error);
        appendTrace(config.instance, taskId, {
          type: "error",
          message: `Tool call ${call.function.name} failed: ${message}`,
          data: { toolCallId: call.id }
        });
        toolResultMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: ${message}`
        });
        persistTranscriptRow(config, taskId, transcriptSessionId, {
          role: "tool",
          toolCallId: call.id,
          content: `Error: ${message}`
        });
        emitToolCallStatus(emitCtx, {
          callId: call.id,
          status: "error",
          errorMessage: message
        });
        await mutateState(config.instance, (state) => {
          updateRecentToolCall(findTask(state, taskId), call.id, "error");
        });
      }
    }

    // Append all sync tool results before deciding to pause.
    workingMessages.push(...toolResultMessages);

    if (pendingApprovals.length > 0) {
      // Snapshot the conversation onto the task and pause.
      const snapshot: TaskToolCallState = {
        messages: workingMessages,
        toolsHash,
        pending: pendingApprovals,
        iterations
      };
      const paused = await mutateState(config.instance, (state) => {
        const item = findTask(state, taskId);
        // Respect a prior terminal status so a cancel that fired
        // during the tool-dispatch span doesn't get overwritten by
        // `waiting_approval`.
        if (isTerminalTaskStatus(item.status)) return item;
        item.status = "waiting_approval";
        item.currentStep = "Waiting for approval";
        item.toolCallState = snapshot;
        // Persist the partial cost up to this pause so it isn't lost if
        // the approval is denied (failTask reads the row as-is) or the
        // task waits a long time before resuming.
        item.cost = accumulatedCost;
        item.updatedAt = now();
        appendEvent(
          state,
          { kind: "task", action: "task.waiting_approval", target: item.id, taskId: item.id, risk: "medium", summary: "task.waiting_approval" },
          { taskId: item.id }
        );
        return item;
      });
      appendTrace(config.instance, taskId, {
        type: "approval",
        message: "Chat task paused for approval",
        data: { approvalIds: pendingApprovals.map((p) => p.approvalId), iterations }
      });
      await updateRunFromTask(config, paused);
      return paused;
    }

    // All sync — keep looping.
  }

  // Hit the iteration cap. Instead of failing outright, give the model one
  // last turn with NO tools available and an explicit instruction to write
  // a final answer summarizing what it learned and what it couldn't finish.
  // The summary call's cost is recorded on the task just like any other
  // model call. If the summary call itself fails (provider error, etc.),
  // fall back to the legacy failure path so we don't lose the user's work.
  const summaryInstruction =
    `You have reached the maximum number of tool-calling iterations (${cap}). ` +
    `No further tools are available. Please write a final answer summarizing ` +
    `what you have learned so far and what you were unable to complete.`;
  const summaryMessages: ToolCallingMessage[] = [
    ...workingMessages,
    { role: "user", content: summaryInstruction }
  ];
  try {
    const summaryResult = await generateToolCallingResponse(config, summaryMessages, []);
    accumulatedCost = addCost(accumulatedCost, summaryResult.cost);
    const finalText = summaryResult.text || "(no content)";
    const exhausted = await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      // Respect a prior terminal status.
      if (isTerminalTaskStatus(item.status)) return item;
      item.status = "completed";
      item.currentStep = `Completed (iteration cap reached: ${cap})`;
      item.summary = finalText;
      item.cost = accumulatedCost;
      item.partialSummary = undefined;
      item.toolCallState = undefined;
      item.updatedAt = now();
      return item;
    });
    // Emit the exhaustion summary as a final assistant_text block and a
    // terminal Completed phase. The system_note marks the cap-reached
    // condition explicitly so clients can render a hint without parsing
    // the currentStep string.
    if (exhausted.status === "completed") {
      const block = emitAssistantTextStart(emitCtx, finalText);
      if (block?.id) finalizeAssistantText(emitCtx, block.id, finalText);
      emitSystemNote(emitCtx, `Iteration cap reached (${cap}). Returning best-effort summary.`);
      emitPhase(emitCtx, "Completed");
    }
    appendTrace(config.instance, taskId, {
      type: "warning",
      message: `Iteration cap (${cap}) reached; produced summary in tool-less final turn.`,
      data: { iterations: cap }
    });
    appendTrace(config.instance, taskId, {
      type: "model",
      message: `${summaryResult.provider.name} provider produced exhaustion summary`,
      data: {
        provider: summaryResult.provider,
        responseId: summaryResult.responseId,
        usage: summaryResult.usage,
        finishReason: summaryResult.finishReason
      }
    });
    await updateRunFromTask(config, exhausted);
    await syncSubagentFromTask(config, exhausted);
    if (exhausted.jobId) await finalizeJobRunFromTask(config, exhausted);
    if (exhausted.status === "completed") {
      void scheduleAutoRetain(config, exhausted);
      if (exhausted.chatSessionId) {
        void autoRenameChatAfterTurn(config, exhausted.chatSessionId).catch((error) => {
          appendLog(config.instance, "chat.auto_title.failed", {
            sessionId: exhausted.chatSessionId,
            taskId: exhausted.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
    return exhausted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      // Respect a prior terminal status.
      if (isTerminalTaskStatus(item.status)) return item;
      item.status = "failed";
      item.currentStep = "Failed";
      item.error = `Chat task exceeded ${cap} model iterations.`;
      // Preserve the accumulated cost from the loop so the audit row
      // reflects all model calls leading up to the failed summary turn.
      item.cost = accumulatedCost;
      item.toolCallState = undefined;
      item.updatedAt = now();
      return item;
    });
    // Cap-reached fail path: emit a system_note so the chat thread has
    // an explicit marker rather than just trailing off after the last
    // assistant_text. Phase blocks track currentStep; the system_note
    // captures the error condition.
    emitSystemNote(emitCtx, `Iteration cap reached (${cap}) and summary call failed: ${message}`);
    emitPhase(emitCtx, "Failed");
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "Chat task hit iteration cap and tool-less summary call failed",
      data: { iterations: cap, summaryError: message }
    });
    await updateRunFromTask(config, exhausted);
    await syncSubagentFromTask(config, exhausted);
    if (exhausted.jobId) await finalizeJobRunFromTask(config, exhausted);
    return exhausted;
  }
}

// Helper for resumeChatTask's stage-1 mutateState. Extracted so the
// race-window poll-and-retry can re-stage from a single point.
// Returns one of four shapes:
//   - terminal: task in completed/failed/cancelled — bail
//   - notYetWaiting: task in "running" still racing the loop's
//     persist to "waiting_approval" — caller should retry briefly
//   - hasState:false — task is waiting but its toolCallState was
//     cleared (failure-path artifact); caller logs and exits
//   - ready (true/false) — normal flow, ready means all pending
//     resolved and the loop should re-enter
async function stageResume(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  toolResult: string
): Promise<{
  task: Task;
  ready: boolean;
  hasState: boolean;
  terminal: boolean;
  notYetWaiting: boolean;
}> {
  return mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    if (item.status !== "waiting_approval") {
      // Distinguish actually-terminal (legitimate bail) from
      // not-yet-waiting (race-window — caller should retry).
      const truly = isTerminalTaskStatus(item.status);
      return {
        task: item,
        ready: false,
        hasState: false,
        terminal: truly,
        notYetWaiting: !truly
      };
    }
    if (!item.toolCallState) {
      // Nothing to resume against — most likely the snapshot was cleared by
      // a prior failure path. Caller can decide to fail the task.
      return { task: item, ready: false, hasState: false, terminal: false, notYetWaiting: false };
    }
    const pending = item.toolCallState.pending;
    const target = pending.find((p) => p.toolCallId === toolCallId);
    if (target) target.result = toolResult;
    const allResolved = pending.every((p) => typeof p.result === "string");
    return { task: item, ready: allResolved, hasState: true, terminal: false, notYetWaiting: false };
  });
}

// Resume a paused chat task after one of its tool approvals resolved.
// `toolResult` is the textual result (stdout, file write status, etc.)
// captured by agent.executeApprovedAction. The runtime calls this with the
// originating tool_call_id so the loop can tag the right message.
//
// Behavior:
//   - Records the result against the matching pending entry.
//   - If any pending approvals remain, leaves the task waiting.
//   - Once all results are in, appends them as `tool` messages and
//     re-enters the loop from the next iteration.
export async function resumeChatTask(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  toolResult: string
): Promise<Task> {
  // Halt-siblings fix (Review P1 #2): never flip a non-waiting_approval
  // task back to running. If the task has already failed (e.g. a sibling
  // approval was denied), been cancelled, or completed, just no-op so we
  // don't restart a terminal task's loop.
  //
  // Race-window fix: a fast /connect can land BEFORE the chat-task
  // loop has persisted waiting_approval (the approval block is
  // emitted to the SSE stream earlier than the post-loop mutateState
  // that flips the status). In that window status is still
  // "running" — NOT terminal — but the original code's
  // `status !== "waiting_approval"` short-circuit lumped it in with
  // terminal and silently orphaned the task. Distinguish the two:
  // a truly-terminal status bails as before; a still-running task
  // gets a brief poll-and-retry budget so the resume catches the
  // loop's flip to waiting_approval (~one mutateState boundary
  // away). 1000ms total budget over 10x 100ms ticks is generous
  // for the manual-click case and bounded enough for automated
  // /connect callers (CLI scripts, test harnesses, the messaging
  // pollers) that race the loop more aggressively.
  // The budget/tick are overridable via env so in-process test harnesses
  // (which resolve the race within a couple of mutateState boundaries, or
  // never enter the loop because their task never reaches waiting_approval)
  // don't pay the full 1s wall on every resume. Production keeps the
  // 1000/100 defaults — the `|| DEFAULT` fallback fires for unset/zero/NaN
  // env, so the operational budget is unchanged unless an operator opts in.
  const RESUME_WAIT_FOR_WAITING_BUDGET_MS = Number(process.env.GINI_RESUME_WAIT_BUDGET_MS) || 1000;
  const RESUME_WAIT_FOR_WAITING_TICK_MS = Number(process.env.GINI_RESUME_WAIT_TICK_MS) || 100;
  const resumeDeadline = Date.now() + RESUME_WAIT_FOR_WAITING_BUDGET_MS;
  let stage = await stageResume(config, taskId, toolCallId, toolResult);
  while (stage.notYetWaiting && Date.now() < resumeDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, RESUME_WAIT_FOR_WAITING_TICK_MS));
    stage = await stageResume(config, taskId, toolCallId, toolResult);
  }

  if (stage.terminal) {
    appendTrace(config.instance, taskId, {
      type: "approval",
      message: "Resume request ignored: task is terminal",
      data: { toolCallId, taskStatus: stage.task.status }
    });
    return stage.task;
  }
  if (!stage.hasState) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "Chat task resume requested but toolCallState was missing",
      data: { toolCallId }
    });
    return stage.task;
  }
  if (!stage.ready) {
    // Another approval is still pending. Leave the task waiting.
    return stage.task;
  }

  // Stage 2: pull the snapshot, append tool result messages, and continue
  // the loop.
  const snapshot = stage.task.toolCallState!;
  const messages = (snapshot.messages as ToolCallingMessage[]).slice();
  // Resolve the emit context once for the chat-block flips below. Tasks
  // without a chat session (subagent children) skip emission, matching
  // the loop-entry behavior in runLoop.
  const resumeEmitCtx = resolveEmitContext(config, taskId);
  // Resolve the chat session once so each gated tool result lands as a
  // tool_transcript row paired with the assistant tool_calls row that
  // runLoop persisted before the pause.
  const resumeSessionId = resolveChatSessionId(readState(config.instance), stage.task);
  for (const entry of snapshot.pending) {
    const resumeResult = entry.result ?? "(no result)";
    messages.push({
      role: "tool",
      tool_call_id: entry.toolCallId,
      content: resumeResult
    });
    persistTranscriptRow(config, taskId, resumeSessionId, {
      role: "tool",
      toolCallId: entry.toolCallId,
      content: resumeResult
    });
    // Pair the resumed tool_result message with a chat-block update so
    // clients see the previously-running tool_call flip to `ok` and a
    // tool_result row appear. We only flip to `ok` here — a denial path
    // already routed through decideApproval(deny) which we'll handle
    // separately, and dispatch errors are already emitted at the
    // chat-task loop's main dispatch branch.
    emitToolCallStatus(resumeEmitCtx, { callId: entry.toolCallId, status: "ok" });
    if (typeof entry.result === "string") {
      emitToolResult(resumeEmitCtx, { callId: entry.toolCallId, result: entry.result });
    }
  }

  const resumed = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    // A terminal status set between `resumeChatTask` entry and this
    // lock acquisition wins. Skip the resume so the loop doesn't
    // re-enter a cancelled task.
    if (isTerminalTaskStatus(item.status)) return item;
    item.status = "running";
    item.currentStep = "Thinking";
    item.toolCallState = undefined;
    item.updatedAt = now();
    return item;
  });
  if (isTerminalTaskStatus(resumed.status)) {
    appendTrace(config.instance, taskId, {
      type: "task",
      message: `Resume aborted: task is already ${resumed.status}`,
      data: { status: resumed.status }
    });
    return resumed;
  }

  appendTrace(config.instance, taskId, {
    type: "task",
    message: "Chat task resumed after approvals",
    data: { resumedAt: snapshot.iterations }
  });

  return runLoop(config, taskId, messages, snapshot.iterations);
}
