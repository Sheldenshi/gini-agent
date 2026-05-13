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
  appendLog,
  appendTaskPartial,
  appendTrace,
  mutateState,
  now,
  readState
} from "../state";
import { findTask } from "../agent";
import { recall } from "../memory";
import {
  generateToolCallingResponse,
  type ToolCallingMessage,
  type ToolCall
} from "../provider";
import { buildAgentSystemContext } from "../system-prompt";
import type {
  PendingToolCall,
  RuntimeConfig,
  RuntimeState,
  SkillRecord,
  SubagentRecord,
  Task,
  TaskToolCallState
} from "../types";
import { updateRunFromTask } from "./runs";
import { buildToolCatalog, hashCatalog, toProviderTools } from "./tool-catalog";
import { dispatchToolCall } from "./tool-dispatch";
import { getSubagentForTask, syncSubagentFromTask } from "../capabilities/subagents";
import { finalizeJobRunFromTask } from "../jobs/finalize";
import { resolveEffectiveContext } from "./effective-context";

const MAX_LOOP_ITERATIONS = 8;

// runChatTask: kicks off the chat-task loop for a freshly submitted task.
// Sets the task to running, builds the initial system + user messages,
// recalls memory the same way the legacy path does, then calls runLoop.
export async function runChatTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  let task = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    item.status = "running";
    item.currentStep = "Thinking";
    item.mode = "chat";
    item.updatedAt = now();
    return item;
  });
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

  // Auto-recall: same as the legacy path. If recall fails we continue with
  // pinned memories only; the model can still answer.
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
  // Phase C: pinned memories are also per-agent. Records without an
  // agentId (pre-migration leftovers) are excluded — the migration in
  // normalizeState backfills them on first read, so this filter should
  // only drop content during the in-flight first-boot rewrite.
  const activeMemory = state.memories.filter((memory) =>
    memory.status === "active" && (!agentIdForMemory || memory.agentId === agentIdForMemory)
  );
  // Subagent path: child tasks override the default Gini preamble with the
  // subagent's own system prompt and filter the trusted-skills block by the
  // subagent's skill whitelist (when set).
  const subagent = getSubagentForTask(state, task);
  const baseSystem = subagent && subagent.systemPrompt
    ? subagent.systemPrompt
    : buildAgentSystemContext(activeMemory, recalledContext);
  const visibleSkills = filterSkillsForSubagent(state.skills, subagent);
  const skillsBlock = buildTrustedSkillsBlock(visibleSkills);
  const systemContext = skillsBlock ? `${baseSystem}\n\n${skillsBlock}` : baseSystem;

  // Conversation history: include prior turns from the same chat session so
  // the model has multi-turn context (the legacy single-shot path didn't).
  const prior = priorChatMessages(config, task);
  const messages: ToolCallingMessage[] = [
    { role: "system", content: systemContext },
    ...prior,
    { role: "user", content: task.input }
  ];

  appendTrace(config.instance, taskId, {
    type: "model",
    message: "chat-task system context built",
    data: { hindsightUnitsRecalled, priorMessages: prior.length }
  });

  return runLoop(config, taskId, messages, 0);
}

// Pull prior chat messages for multi-turn context. We synthesize an
// assistant message for any prior task that completed in the same chat
// session; we skip the in-flight task itself. Tool calls / tool results
// from prior turns are dropped — only finalized text feeds back in. This
// keeps the conversation clean without a tool-result transcript ballooning.
function priorChatMessages(config: RuntimeConfig, task: Task): ToolCallingMessage[] {
  if (!task.runId) return [];
  const state = readState(config.instance);
  const run = state.runs.find((r) => r.id === task.runId);
  if (!run?.conversationId) return [];
  const sessionId = run.conversationId;
  const stored = state.chatMessages
    .filter((m) => m.sessionId === sessionId && m.taskId !== task.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return stored
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
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

// Filter the trusted-skill list down to a subagent's whitelist. When the
// subagent has no whitelist (toolset-or-skill-undefined / inherit), the full
// list is returned. When the whitelist is set, only matching skill names
// are advertised — the read_skill tool itself still gates on `status ===
// "trusted"` so a non-trusted skill can't slip through.
function filterSkillsForSubagent(skills: SkillRecord[], subagent: SubagentRecord | undefined): SkillRecord[] {
  if (!subagent || !subagent.skillNames || subagent.skillNames.length === 0) return skills;
  const allowed = new Set(subagent.skillNames);
  return skills.filter((s) => allowed.has(s.name));
}

// Build the "Available skills:" block that gets prepended to the system
// prompt for the agent loop. We only advertise *trusted* skills (draft /
// disabled / archived stay invisible). The block lists each name +
// frontmatter description; the model uses the read_skill tool to fetch
// the full body when it actually needs the instructions. This keeps the
// resident system prompt small even when many skills are registered.
function buildTrustedSkillsBlock(skills: SkillRecord[]): string {
  const trusted = skills.filter((s) => s.status === "trusted");
  if (trusted.length === 0) return "";
  // Dedupe by name, preferring bundled records over user records when both
  // exist with the same name. Mirrors the read_skill tool's tiebreak so
  // the advertised skill description matches the body that read_skill will
  // return.
  const byName = new Map<string, SkillRecord>();
  for (const skill of trusted) {
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

// Inner loop. Calls the model, dispatches tool calls, and either completes
// the task with the final text or pauses the task waiting for approvals.
//
// The `iterationsSoFar` argument lets resumeChatTask continue counting
// across approval pauses (so a single conversation can't bypass the cap by
// chaining approvals).
async function runLoop(
  config: RuntimeConfig,
  taskId: string,
  messages: ToolCallingMessage[],
  iterationsSoFar: number
): Promise<Task> {
  // Build the tool catalog once per loop entry. If the user toggles a
  // toolset mid-pause we'll pick up the change on resume — that's a
  // feature, not a bug, and the toolsHash check protects against weird
  // schema drift.
  const state0 = readState(config.instance);
  const taskRow = state0.tasks.find((t) => t.id === taskId);
  const subagent0 = taskRow ? getSubagentForTask(state0, taskRow) : undefined;
  // Resolve the active-agent overrides (provider, toolset filter, etc.).
  // Provider override flows into generateToolCallingResponse below; the
  // toolset filter narrows buildToolCatalog before the subagent filter
  // narrows further (state → agent → subagent composition).
  const effective = resolveEffectiveContext(state0, config);
  const tools = filterToolsForSubagent(buildToolCatalog(state0, effective.toolsetFilter), subagent0);
  const providerTools = toProviderTools(tools);
  const toolsHash = hashCatalog(tools);

  let iterations = iterationsSoFar;
  let workingMessages = messages.slice();

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations += 1;

    // Cancellation bail-out. If the task was cancelled externally (e.g.
    // user clicked cancel, or a parent task's cancellation cascaded into
    // this child via cancelDescendantTasks), stop the loop here so we
    // don't keep running model calls and dispatching tools against a
    // task that's already terminal.
    {
      const cancelCheck = readState(config.instance).tasks.find((t) => t.id === taskId);
      if (!cancelCheck || cancelCheck.status === "cancelled") {
        appendTrace(config.instance, taskId, {
          type: "task",
          message: "Chat task loop noticed cancellation",
          data: { iterations }
        });
        await syncSubagentFromTask(config, cancelCheck ?? ({ id: taskId, subagentId: undefined } as unknown as Task));
        return cancelCheck ?? ({ id: taskId, status: "cancelled" } as unknown as Task);
      }
    }

    // Stream partial text into task.partialSummary just like the legacy
    // path. Debounced to avoid thrashing mutateState on every SSE delta.
    let pending = "";
    let lastFlush = 0;
    const flush = async (): Promise<void> => {
      if (!pending) return;
      const delta = pending;
      pending = "";
      lastFlush = Date.now();
      await mutateState(config.instance, (state) => {
        appendTaskPartial(state, taskId, delta);
      });
    };
    const onDelta = (text: string): void => {
      pending += text;
      if (Date.now() - lastFlush >= 150) {
        void flush();
      }
    };

    await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      item.currentStep = "Thinking";
      item.updatedAt = now();
    });

    const result = await generateToolCallingResponse(
      config,
      workingMessages,
      providerTools,
      onDelta,
      effective.providerSource === "agent" ? effective.provider : undefined
    );
    await flush();

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
        item.status = "completed";
        item.currentStep = "Completed";
        item.summary = finalText || "(no content)";
        item.cost = result.cost;
        // partialSummary is no longer the source of truth — clear it so
        // the chat UI uses the synced summary instead.
        item.partialSummary = undefined;
        item.toolCallState = undefined;
        item.updatedAt = now();
        return item;
      });
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
      return finished;
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

    const pendingApprovals: PendingToolCall[] = [];
    const toolResultMessages: ToolCallingMessage[] = [];

    for (const call of result.toolCalls) {
      await mutateState(config.instance, (state) => {
        const item = findTask(state, taskId);
        item.currentStep = `Working: ${call.function.name}`;
        item.updatedAt = now();
      });
      try {
        const dispatch = await dispatchToolCall(
          config,
          taskId,
          call.function.name,
          call.id,
          call.function.arguments
        );
        if (dispatch.kind === "sync") {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: dispatch.result
          });
        } else {
          pendingApprovals.push({
            toolCallId: call.id,
            toolName: call.function.name,
            approvalId: dispatch.approvalId
          });
        }
      } catch (error) {
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
        item.status = "waiting_approval";
        item.currentStep = "Waiting for approval";
        item.toolCallState = snapshot;
        item.updatedAt = now();
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

  // Hit the iteration cap. Complete with whatever partialSummary we have.
  const exhausted = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    item.status = "failed";
    item.currentStep = "Failed";
    item.error = `Chat task exceeded ${MAX_LOOP_ITERATIONS} model iterations.`;
    item.toolCallState = undefined;
    item.updatedAt = now();
    return item;
  });
  appendTrace(config.instance, taskId, {
    type: "error",
    message: "Chat task hit iteration cap",
    data: { iterations: MAX_LOOP_ITERATIONS }
  });
  await updateRunFromTask(config, exhausted);
  await syncSubagentFromTask(config, exhausted);
  if (exhausted.jobId) await finalizeJobRunFromTask(config, exhausted);
  return exhausted;
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
  const stage = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    if (item.status !== "waiting_approval") {
      return { task: item, ready: false as const, hasState: false as const, terminal: true as const };
    }
    if (!item.toolCallState) {
      // Nothing to resume against — most likely the snapshot was cleared by
      // a prior failure path. Caller can decide to fail the task.
      return { task: item, ready: false as const, hasState: false as const, terminal: false as const };
    }
    const pending = item.toolCallState.pending;
    const target = pending.find((p) => p.toolCallId === toolCallId);
    if (target) target.result = toolResult;
    const allResolved = pending.every((p) => typeof p.result === "string");
    return { task: item, ready: allResolved, hasState: true as const, terminal: false as const };
  });

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
  for (const entry of snapshot.pending) {
    messages.push({
      role: "tool",
      tool_call_id: entry.toolCallId,
      content: entry.result ?? "(no result)"
    });
  }

  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    item.status = "running";
    item.currentStep = "Thinking";
    item.toolCallState = undefined;
    item.updatedAt = now();
  });

  appendTrace(config.instance, taskId, {
    type: "task",
    message: "Chat task resumed after approvals",
    data: { resumedAt: snapshot.iterations }
  });

  return runLoop(config, taskId, messages, snapshot.iterations);
}
