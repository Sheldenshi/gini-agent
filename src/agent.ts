// Task orchestrator. Knows how to:
//   - submit / retry / cancel a task (audit + lifecycle)
//   - dispatch a queued task to the right tool by sniffing the input prefix
//   - resolve an approval and run the side-effecting action
//
// The actual tool logic (file/web/terminal/code) lives in src/tools/*.
// Approval lifecycle helpers (completeLowRiskToolTask, executeApprovedAction)
// remain here because they are part of the orchestrator's contract with
// the rest of the runtime.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import type { Approval, RuntimeConfig, RuntimeState, Task } from "./types";
import { statePath, traceDir } from "./paths";
import {
  addAudit,
  appendLog,
  appendTaskPartial,
  appendTrace,
  assertInsideWorkspace,
  assertInsideWorkspaceNoSymlinkEscape,
  createMemory,
  createTask,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState,
  upsertTask
} from "./state";
import { generateTaskSummary } from "./provider";
import { listFiles, readFile, requestFilePatch, requestFileWrite, searchFiles } from "./tools/file";
import { fetchWeb } from "./tools/web";
import { requestShell } from "./tools/terminal";
import { requestCodeExecution } from "./tools/code";
import { recall, retain } from "./memory";
import { updateRunFromTask } from "./execution/runs";
import { runChatTask, resumeChatTask } from "./execution/chat-task";
import { approvalToolCallId } from "./execution/tool-dispatch";
import { resolveEffectiveContext } from "./execution/effective-context";
import { browserUploadFileApproved } from "./tools/browser";
import {
  abortApprovalsForTask,
  claimApproval,
  raceWithAbort,
  releaseApproval
} from "./execution/approval-execution";
import { syncSubagentFromTask } from "./capabilities/subagents";
import { resolveActiveSkillsEnv } from "./integrations/identities";
// Imported from a leaf module (not src/jobs/index.ts) so we don't close
// the cycle that runs through submitTask. The finalizer flips the linked
// JobRunRecord from "running" to a terminal status when a Task with a
// jobId settles. Idempotent — safe to call from runTask, failTask, and
// cancelTask without de-duping.
import { finalizeJobRunFromTask } from "./jobs/finalize";
import {
  matchesShape,
  shapeCode,
  shapeFind,
  shapeList,
  shapePatch,
  shapeRead,
  shapeShell,
  shapeWeb,
  shapeWrite
} from "./dispatch-shape";

export interface SubmitTaskOptions {
  jobId?: string;
  parentTaskId?: string;
  subagentId?: string;
  runId?: string;
  // Execution mode. "chat" routes through the tool-calling agent loop.
  // "imperative" preserves the legacy CLI prefix-dispatch behavior. Defaults
  // to "imperative" for back-compat with the CLI; chat callers pass "chat".
  mode?: "chat" | "imperative";
}

export async function submitTask(
  config: RuntimeConfig,
  input: string,
  jobIdOrOptions?: string | SubmitTaskOptions,
  parentTaskId?: string,
  subagentId?: string,
  runId?: string
): Promise<Task> {
  // Back-compat shim: callers pass either positional args (legacy) or an
  // options bag. New chat callers use the bag so they can set mode.
  const options: SubmitTaskOptions = typeof jobIdOrOptions === "object" && jobIdOrOptions !== null
    ? jobIdOrOptions
    : { jobId: jobIdOrOptions, parentTaskId, subagentId, runId };
  const created = createTask(config.instance, input, options.jobId, options.parentTaskId, options.subagentId, options.runId);
  if (options.mode) created.mode = options.mode;
  // When a parentTaskId is set, the upsert + the parent-status
  // check must serialize together. Without this, `spawnSubagent`'s
  // in-callback check inside `createSubagentRecord` can pass, then
  // a `cancelTask` lands between that mutation and this one, then
  // the child task is created here under an already-cancelled
  // parent that `cancelDescendantTasks`'s earlier snapshot has
  // already missed. Checking parent status INSIDE the same
  // mutateState that upserts the child closes the window. Throws
  // so the caller can clean up; `spawnSubagent`'s catch chain
  // converts to a `Cannot spawn subagent` error that tool-dispatch
  // already translates to a skipped sync result.
  await mutateState(config.instance, (state) => {
    if (options.parentTaskId) {
      const parent = state.tasks.find((t) => t.id === options.parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot submit task: parent task ${options.parentTaskId} is already ${parent.status}.`);
      }
    }
    upsertTask(state, created);
    const audit = addAudit(state, {
      actor: options.jobId ? "runtime" : "user",
      action: "task.submitted",
      target: created.id,
      risk: "low",
      taskId: created.id,
      runId: options.runId,
      evidence: { input, jobId: options.jobId, parentTaskId: options.parentTaskId, subagentId: options.subagentId, runId: options.runId, mode: options.mode }
    });
    created.auditIds.push(audit.id);
  });
  await updateRunFromTask(config, created);
  runTask(config, created.id).catch((error) => failTask(config, created.id, error));
  return created;
}

export async function retryTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  const task = await mutateState(config.instance, (state) => {
    const existing = findTask(state, taskId);
    const retry = createTask(config.instance, existing.input, existing.jobId, existing.parentTaskId, existing.subagentId, existing.runId);
    upsertTask(state, retry);
    addAudit(state, {
      actor: "user",
      action: "task.retry",
      target: retry.id,
      risk: "low",
      taskId: retry.id,
      runId: retry.runId,
      evidence: { retriedTaskId: taskId }
    });
    return retry;
  });
  runTask(config, task.id).catch((error) => failTask(config, task.id, error));
  return task;
}

export async function cancelTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  const task = await mutateState(config.instance, (state) => {
    const task = findTask(state, taskId);
    if (isTerminalTaskStatus(task.status)) return task;
    task.status = "cancelled";
    task.currentStep = "Cancelled";
    task.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "task.cancelled",
      target: taskId,
      risk: "low",
      taskId,
      runId: task.runId
    });
    // Halt-siblings fix: cancelling a task that's waiting on multiple
    // pending approvals must also tear down those approvals so a later
    // approve doesn't run a tool against a cancelled task. Clear the
    // captured tool-call snapshot in the same write.
    cancelPendingTaskApprovals(state, taskId, "task.cancelled");
    task.toolCallState = undefined;
    upsertTask(state, task);
    // Abort any in-flight approved actions for this task. The
    // abort is called INSIDE the `mutateState` callback so
    // `executeApprovedAction`'s claim and our abort serialize
    // through the per-instance lock: either the executor has
    // claimed and we abort it now, or the executor hasn't reached
    // its claim yet and will observe `task.status === "cancelled"`
    // when it gets the lock and return early without spawning the
    // side effect.
    recordInFlightAborted(state, config.instance, task, "task.cancelled");
    return task;
  });
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);
  await syncSubagentFromTask(config, task);
  // Cascade cancellation to descendant subagent tasks. If the cancelled
  // task spawned subagents (whose taskIds are children), cancel each one
  // recursively. Walk the runtime state for any task whose parentTaskId is
  // this task and is not already terminal, then cancel them.
  await cancelDescendantTasks(config, taskId);
  return task;
}

// Centralize the abortApprovalsForTask + approval.in_flight_aborted
// audit emission so cancelTask, failTask, and decideApproval-deny
// share the same exact behavior. Runs INSIDE the caller's mutateState
// callback so the abort fan-out and the audit row write happen under
// the per-instance lock.
type InFlightAbortReason = "task.cancelled" | "task.failed" | "sibling.denied";

function recordInFlightAborted(
  state: RuntimeState,
  instance: string,
  task: Task,
  reason: InFlightAbortReason,
  extraEvidence?: Record<string, unknown>
): void {
  const aborted = abortApprovalsForTask(instance, task.id, reason);
  if (aborted.length === 0) return;
  addAudit(state, {
    actor: "runtime",
    action: "approval.in_flight_aborted",
    target: task.id,
    risk: "low",
    taskId: task.id,
    runId: task.runId,
    evidence: { reason, approvalIds: aborted, ...(extraEvidence ?? {}) }
  });
}

// Mark every other pending approval that targets the given task as denied,
// audited as cancelled-by-sibling-decision. Called from the deny path of
// decideApproval and from cancelTask. Excludes `excludeApprovalId` (the
// approval that triggered the cancellation) so we don't double-audit it.
// Runs inside an existing mutateState call (not its own) so it shares the
// same write.
function cancelPendingTaskApprovals(
  state: RuntimeState,
  taskId: string,
  reason: "task.cancelled" | "sibling.denied",
  excludeApprovalId?: string
): void {
  for (const sibling of state.approvals) {
    if (sibling.taskId !== taskId) continue;
    if (sibling.status !== "pending") continue;
    if (excludeApprovalId && sibling.id === excludeApprovalId) continue;
    sibling.status = "denied";
    sibling.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: reason === "sibling.denied"
        ? "approval.cancelled_sibling_denial"
        : "approval.cancelled_task_cancelled",
      target: sibling.target,
      risk: sibling.risk,
      taskId: sibling.taskId,
      runId: state.tasks.find((task) => task.id === sibling.taskId)?.runId,
      approvalId: sibling.id,
      evidence: { reason, originatingApprovalId: excludeApprovalId }
    });
  }
}

async function cancelDescendantTasks(config: RuntimeConfig, parentTaskId: string): Promise<void> {
  // Snapshot the children synchronously so we don't recurse while mutating.
  const state = await mutateState(config.instance, (s) => s);
  const children = state.tasks
    .filter((t) => t.parentTaskId === parentTaskId)
    .filter((t) => !isTerminalTaskStatus(t.status))
    .map((t) => t.id);
  for (const childId of children) {
    try {
      await cancelTask(config, childId);
    } catch {
      // Best-effort: a race between the cancel and the natural completion
      // is fine. The next refreshSubagents tick will reconcile state.
    }
  }
}

export async function runTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  // Chat-mode tasks route through the tool-calling agent loop in
  // src/execution/chat-task.ts. The legacy prefix-dispatch path below is
  // preserved for imperative CLI commands (`gini task "write foo.txt :: hi"`).
  const initialTask = await mutateState(config.instance, (state) => findTask(state, taskId));
  if (initialTask.mode === "chat") {
    return runChatTask(config, taskId);
  }

  let task = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    // Respect a terminal status that was set BEFORE we acquired the
    // lock. An unconditional flip to "running" would overwrite a
    // `cancelled` status that `cancelTask` may have written between
    // `submitTask` returning and `runTask` scheduling. Combined with
    // `dangerouslyAutoApprove`, that would let the legacy imperative
    // path run side effects against an already-cancelled task.
    // `runChatTask` carries the matching guard for the chat-mode
    // path.
    if (isTerminalTaskStatus(item.status)) {
      return item;
    }
    item.status = "running";
    item.currentStep = "Thinking";
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });
  if (isTerminalTaskStatus(task.status)) {
    appendTrace(config.instance, taskId, {
      type: "task",
      message: `Imperative task start aborted: already ${task.status}`,
      data: { status: task.status }
    });
    return task;
  }
  await updateRunFromTask(config, task);

  appendTrace(config.instance, taskId, { type: "task", message: "Task started", data: { input: task.input } });
  appendLog(config.instance, "task.started", { taskId });

  await Bun.sleep(10);
  // Re-check the task status after the sleep so a `cancelTask` that
  // fired during the yield doesn't get overwritten by the request*
  // helpers below. The per-tool helpers also carry their own
  // `isTerminalTaskStatus` guard for defense in depth — a future
  // imperative dispatch entry point that skips `runTask` still must
  // not resurrect a cancelled task.
  const afterSleep = await mutateState(config.instance, (state) => findTask(state, taskId));
  if (isTerminalTaskStatus(afterSleep.status)) {
    appendTrace(config.instance, taskId, {
      type: "task",
      message: `Imperative task dispatch skipped: task is already ${afterSleep.status}`,
      data: { status: afterSleep.status }
    });
    return afterSleep;
  }
  const lower = task.input.toLowerCase();

  // Dispatch by input prefix *and* input shape. A bare prefix match would
  // hijack natural-language prompts that happen to start with these English
  // words ("Write a thorough plan...", "find me a restaurant"); each shape
  // gate checks that the rest of the input matches the real tool syntax
  // (write/patch require `::`, web requires `http(s)://`, find needs ` in `
  // or glob chars, etc.) before claiming the dispatch. Anything that doesn't
  // match falls through to the LLM. We flip currentStep to "Working" *before*
  // dispatching so the chat UI can distinguish text-generation ("Thinking")
  // from tool execution ("Working"). Approval-gated tools will overwrite to
  // "Waiting for approval" inside the tool itself; synchronous tools
  // (read/list/find/web) keep "Working" until completion.
  const dispatch = [
    { prefix: "write ", shape: shapeWrite, tool: requestFileWrite },
    { prefix: "patch ", shape: shapePatch, tool: requestFilePatch },
    { prefix: "read ", shape: shapeRead, tool: readFile },
    { prefix: "list ", shape: shapeList, tool: listFiles },
    { prefix: "find ", shape: shapeFind, tool: searchFiles },
    { prefix: "web ", shape: shapeWeb, tool: fetchWeb },
    { prefix: "code ", shape: shapeCode, tool: requestCodeExecution },
    { prefix: "shell ", shape: shapeShell, tool: requestShell }
  ] as const;

  for (const { prefix, shape, tool } of dispatch) {
    if (matchesShape(task.input, prefix, shape)) {
      await markWorking(config, taskId);
      const next = await tool(config, task);
      // dangerouslyAutoApprove also applies to the legacy imperative
      // path: each `request*` helper above creates exactly one
      // approval and leaves the task in `waiting_approval`. When the
      // flag is on, immediately resolve that approval through the same
      // resolveApproval pipeline the chat-task dispatcher uses, so
      // `gini task submit "write foo :: bar"` and `POST /api/tasks`
      // honor the bypass too. Errors here propagate up so submitTask's
      // `.catch(failTask)` records the side-effect failure.
      if (config.dangerouslyAutoApprove && next.status === "waiting_approval" && next.approvalIds.length > 0) {
        const approvalId = next.approvalIds[next.approvalIds.length - 1]!;
        try {
          await resolveApproval(config, approvalId, {
            actor: "runtime",
            resumeChatTask: false,
            evidenceExtra: { autoApproved: true, autoApprovedReason: "dangerouslyAutoApprove" }
          });
        } catch (err) {
          // Race-loss is benign on the imperative path too: another
          // caller decided the approval first and owns the task's
          // terminal transition. Anything else propagates to
          // submitTask's outer .catch(failTask).
          if (!(err instanceof ApprovalRaceLostError)) throw err;
        }
        const refreshed = readState(config.instance).tasks.find((t) => t.id === taskId);
        return finishTaskTransition(config, refreshed ?? next);
      }
      return finishTaskTransition(config, next);
    }
  }

  // No tool matched: fall through to provider summarization.
  // Phase C — resolve the active agent so memory access (pinned + recall +
  // proposed) all use the same isolation key.
  const memoryState = await mutateState(config.instance, (state) => state);
  const memoryEffective = resolveEffectiveContext(memoryState, config);
  const activeAgentId = memoryEffective.agentId;
  const activeMemory = memoryState.memories.filter((memory) =>
    memory.status === "active" && (!activeAgentId || memory.agentId === activeAgentId)
  );

  // Hindsight phase 5: auto-recall. Pull relevant facts/opinions from the
  // four-network store and inject as additional context. Best-effort — if
  // recall fails (e.g. embedding provider unavailable), continue with the
  // legacy MemoryRecord injection only.
  let recalledContext: string | undefined;
  let hindsightUnitsRecalled = 0;
  if (activeAgentId) {
    try {
      const recalled = await recall(config, {
        agentId: activeAgentId,
        query: task.input,
        tokenBudget: 1500,
        sourceTaskId: taskId
      });
      if (recalled.units.length > 0) {
        hindsightUnitsRecalled = recalled.units.length;
        // Pass the formatted block to the provider as system-area context;
        // generateTaskSummary places it in `instructions` (system role) so it
        // inherits the model's default trust without verbal pleading.
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

  // Debounced streaming: codex emits many small SSE deltas. Buffer them and
  // flush to state at most every ~150ms so we get smooth updates without
  // thrashing mutateState (each call serializes the full RuntimeState to
  // disk). A final flush after the stream completes drains any tail.
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

  const providerResult = await generateTaskSummary(config, task.input, activeMemory, recalledContext, onDelta);
  await flush();
  appendTrace(config.instance, taskId, {
    type: "model",
    message: `${providerResult.provider.name} provider generated response`,
    data: {
      provider: providerResult.provider,
      responseId: providerResult.responseId,
      usage: providerResult.usage,
      memoryUsed: activeMemory.map((memory) => memory.id),
      hindsightUnitsRecalled
    }
  });

  task = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    // Respect a terminal status set while `generateTaskSummary` was
    // awaiting. Without this guard a cancel landing during the
    // provider call would be silently overwritten with `completed`,
    // and the `remember` branch would also create a memory + audit
    // row against a cancelled task.
    if (isTerminalTaskStatus(item.status)) return item;
    if (lower.includes("remember ")) {
      // Phase C — reject loud when no active agent so we don't silently
      // leak into a default pool. Message matches createMemoryFromInput
      // so the gateway's statusFromErrorMessage mapping to 400 applies
      // uniformly across the legacy + remember-prefix create paths.
      if (!activeAgentId) {
        throw new Error("Cannot create memory: no active agent.");
      }
      const content = item.input.split(/remember\s+/i).at(-1)?.trim() || item.input;
      const memory = createMemory(state, {
        agentId: activeAgentId,
        content,
        sourceTaskId: item.id,
        confidence: 0.7,
        status: "proposed",
        sensitivity: "normal",
        provenance: `Proposed from task ${item.id}`
      });
      item.memoryIds.push(memory.id);
      addAudit(state, {
        actor: "agent",
        action: "memory.proposed",
        target: memory.id,
        risk: "medium",
        taskId: item.id,
        evidence: { content }
      });
      appendTrace(config.instance, taskId, { type: "memory", message: "Memory proposed", data: { memoryId: memory.id } });
    }
    item.status = "completed";
    item.currentStep = "Completed";
    item.summary = providerResult.text;
    item.cost = providerResult.cost;
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });
  if (isTerminalTaskStatus(task.status) && task.status !== "completed") {
    // The cancel landed during the await; the mutateState above
    // returned the unchanged task. Skip the completion-only
    // appendTrace/updateRunFromTask path so we don't claim
    // "Task completed" on a cancelled row.
    return task;
  }

  appendTrace(config.instance, taskId, { type: "task", message: "Task completed", data: { summary: task.summary } });
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);

  // Hindsight phase 5: auto-retain. Run async and don't block task completion.
  // The extractor decides whether anything factual is in the input — we only
  // pre-skip obvious tool invocations (read/list/find). Best-effort: log but
  // don't fail.
  void scheduleAutoRetain(config, task);

  return task;
}

async function finishTaskTransition(config: RuntimeConfig, task: Task): Promise<Task> {
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);
  return task;
}

// Sets currentStep to "Working" for a running task. Called immediately
// before dispatching to a tool so the chat UI's phase indicator can show
// "Working" (tool execution) instead of "Thinking" (LLM text generation).
// Tool implementations may later overwrite to "Waiting for approval".
async function markWorking(config: RuntimeConfig, taskId: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    item.currentStep = "Working";
    item.updatedAt = now();
    upsertTask(state, item);
  });
}

function shouldAutoRetain(task: Task): boolean {
  // Read-only / low-risk tool calls don't carry retainable facts. Everything
  // else goes through the extractor — which returns an empty fact list for
  // non-factual inputs ("hi", "ok", "yes") at the cost of one structured-LLM
  // call. We accept that cost so short personal-fact disclosures ("my name is
  // shelden", "I prefer dark mode") aren't filtered out by a length heuristic.
  //
  // We apply the same shape gates as the dispatcher so natural-language
  // prompts ("read this paper carefully", "find me a restaurant") still get
  // auto-retained even though they share an English prefix with a tool.
  if (matchesShape(task.input, "read ", shapeRead)) return false;
  if (matchesShape(task.input, "list ", shapeList)) return false;
  if (matchesShape(task.input, "find ", shapeFind)) return false;
  return true;
}

function scheduleAutoRetain(config: RuntimeConfig, task: Task): void {
  if (!shouldAutoRetain(task)) return;
  // Phase C — resolve the active agent at retain time so the new units
  // land in the right pool. If no agent is active (degenerate state), skip
  // retain rather than leaking into the default bank.
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  if (!effective.agentId) {
    appendTrace(config.instance, task.id, {
      type: "memory",
      message: "auto-retain skipped: no active agent",
      data: {}
    });
    return;
  }
  const text = task.summary
    ? `Task input: ${task.input}\n\nTask summary: ${task.summary}`
    : `Task input: ${task.input}`;
  retain(config, { agentId: effective.agentId, text, sourceTaskId: task.id })
    .then((result) => {
      appendTrace(config.instance, task.id, {
        type: "memory",
        message: "auto-retain completed",
        data: { units: result.units.length, links: result.links.length }
      });
    })
    .catch((error) => {
      appendTrace(config.instance, task.id, {
        type: "memory",
        message: "auto-retain failed",
        data: { error: error instanceof Error ? error.message : String(error) }
      });
    });
}

export async function failTask(config: RuntimeConfig, taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const task = await mutateState(config.instance, (state) => {
    const task = findTask(state, taskId);
    // Idempotent: a sibling approval denial may have already flipped
    // the task to `failed` (see decideApproval-deny). Repeating the
    // audit row would double-count the failure and the in-flight abort
    // already fired from that path, so short-circuit here.
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    task.status = "failed";
    task.error = message;
    task.currentStep = "Failed";
    task.updatedAt = now();
    addAudit(state, {
      actor: "runtime",
      action: "task.failed",
      target: taskId,
      risk: "low",
      taskId,
      runId: task.runId,
      evidence: { error: message }
    });
    // A runtime-driven failure (e.g. a side-effect throw post-
    // approval) must also abort any other in-flight approved
    // actions for the same task. Without this, a sibling tool call
    // started in the same chat-task turn would keep running and
    // emit its audit row against a `failed` task.
    recordInFlightAborted(state, config.instance, task, "task.failed");
    return task;
  });
  appendTrace(config.instance, taskId, { type: "error", message, data: {} });
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);
  await syncSubagentFromTask(config, task);
  // Cascade cancellation to descendant subagent tasks when a parent
  // task is failed (e.g. via approval denial or a runtime exception).
  // Without this, a failed parent leaves running children executing
  // under a parent that is no longer a valid context.
  // `cancelDescendantTasks` is idempotent — children already terminal
  // are skipped, and the call is safe even when there are no
  // children.
  if (task.status === "failed") {
    await cancelDescendantTasks(config, taskId);
  }
}

// Shared between agent and tool modules. Tools that complete immediately
// (file.read, file.list, file.search, web.fetch) call this to record the
// audit, set the task summary, and mark it completed in one shot.
export async function completeLowRiskToolTask(
  config: RuntimeConfig,
  taskId: string,
  summary: string,
  action: string,
  target: string,
  evidence: Record<string, unknown>
): Promise<Task> {
  const completed = await mutateState(config.instance, (state) => {
    const task = findTask(state, taskId);
    // Respect a terminal status that landed during the tool's await
    // (e.g. `web` fetch, `read` on a slow disk). Still record the
    // audit row so the operator sees what the tool produced before
    // the cancel — but don't overwrite the cancelled verdict with
    // `completed`.
    addAudit(state, {
      actor: "runtime",
      action,
      target,
      risk: "low",
      taskId,
      evidence
    });
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    task.status = "completed";
    task.currentStep = "Completed";
    task.summary = summary;
    task.updatedAt = now();
    upsertTask(state, task);
    return task;
  });
  // Don't run auto-retain extraction when the task ended cancelled
  // or failed (the cancel landed during the tool await). The
  // extractor would otherwise persist a durable memory entry
  // derived from a cancelled task's output. The run / job
  // propagation below still fires so the gateway state stays
  // consistent with the audit trail.
  if (completed.status === "completed") {
    // Hindsight phase 5: auto-retain. Skip read/list/find — they're noise.
    void scheduleAutoRetain(config, completed);
  }
  await updateRunFromTask(config, completed);
  if (completed.jobId) await finalizeJobRunFromTask(config, completed);
  return completed;
}

// Human/API entry point for approve|deny decisions. Use this from the
// approval REST handlers, the CLI `approval approve|deny` commands, and
// anywhere else a user action settles a pending approval. The approve
// branch delegates to `resolveApproval` with `actor: "user"` so the
// approval.approved audit reflects the human decision; the deny branch
// marks the row denied, auto-denies sibling approvals on the same task,
// and fails the task.
//
// If you need to auto-resolve an approval from runtime code (e.g.
// `dangerouslyAutoApprove`), call `resolveApproval` directly with
// `actor: "runtime"` and the matching `evidenceExtra` marker — that
// path is the right one to reach for, not this function.
export async function decideApproval(config: RuntimeConfig, approvalId: string, decision: "approve" | "deny"): Promise<Approval> {
  if (decision === "approve") {
    const { approval } = await resolveApproval(config, approvalId, { actor: "user", resumeChatTask: true });
    return approval;
  }

  const approval = await mutateState(config.instance, (state) => {
    const item = state.approvals.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Approval not found: ${approvalId}`);
    if (item.status !== "pending") throw new Error(`Approval is already ${item.status}`);
    item.status = "denied";
    item.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "approval.denied",
      target: item.target,
      risk: item.risk,
      taskId: item.taskId,
      runId: item.taskId ? state.tasks.find((task) => task.id === item.taskId)?.runId : undefined,
      approvalId: item.id
    });
    // Halt-siblings fix (Review P1 #2): when a single LLM turn emits
    // multiple approval-gated tool calls, denying one must immediately
    // tear down the other pending approvals on the same task and clear
    // the captured tool-call snapshot. Otherwise a sibling approved
    // *after* the denial would still execute (executeApprovedAction
    // didn't check task status) and `resumeChatTask` would re-enter the
    // loop on a failed task.
    //
    // Race fix: also flip the task to `failed` inside this SAME
    // mutateState. Previously failTask was a separate await, which gave
    // a concurrent approve-sibling's executeApprovedAction guard a
    // window between this write and the failure mutation where the
    // task still looked `waiting_approval` and the side effect ran. By
    // making the failure atomic with the denial we close that window;
    // the run/job/subagent propagation still runs below as plain
    // post-mutation work.
    let taskRowForPostMutation: Task | undefined;
    if (item.taskId) {
      cancelPendingTaskApprovals(state, item.taskId, "sibling.denied", item.id);
      const task = state.tasks.find((t) => t.id === item.taskId);
      // Idempotency: if `failTask` already flipped the task to a
      // terminal state (a runtime exception during a sibling
      // approval's side effect that raced this denial), we MUST NOT
      // re-write task.status / overwrite task.error / emit a second
      // task.failed audit row. Leave the existing terminal verdict
      // intact and skip the in-flight abort cascade — `failTask`
      // already ran its own abortApprovalsForTask via
      // recordInFlightAborted.
      if (task && !isTerminalTaskStatus(task.status)) {
        task.toolCallState = undefined;
        const message = `Approval denied: ${item.target}`;
        task.status = "failed";
        task.currentStep = "Failed";
        task.error = message;
        task.updatedAt = item.updatedAt;
        addAudit(state, {
          actor: "runtime",
          action: "task.failed",
          target: task.id,
          risk: "low",
          taskId: task.id,
          runId: task.runId,
          evidence: { error: message, viaApprovalDenied: item.id }
        });
        // A sibling denial that flips the task to failed must also
        // abort any in-flight approved-action executor on the same
        // task. Without this, an approval that won the claim race
        // before the denial keeps running and emits a normal
        // side-effect audit row against a failed task.
        recordInFlightAborted(state, config.instance, task, "sibling.denied", { originatingApprovalId: item.id });
        taskRowForPostMutation = task;
      }
    }
    return { item, task: taskRowForPostMutation };
  });

  if (approval.item.taskId) {
    appendTrace(config.instance, approval.item.taskId, { type: "approval", message: `Approval ${approval.item.status}`, data: { approvalId } });
    appendTrace(config.instance, approval.item.taskId, { type: "error", message: `Approval denied: ${approval.item.target}`, data: {} });
    if (approval.task) {
      await updateRunFromTask(config, approval.task);
      if (approval.task.jobId) await finalizeJobRunFromTask(config, approval.task);
      await syncSubagentFromTask(config, approval.task);
      // Cascade cancellation to descendant subagent tasks. The
      // deny path flips the parent task to `failed` directly inside
      // its `mutateState` callback (rather than calling `failTask`),
      // so `failTask`'s own descendant cascade doesn't run here.
      // Without this explicit cascade a parent failed by approval
      // denial leaves its running subagent children executing with
      // tools.
      await cancelDescendantTasks(config, approval.task.id);
    }
  }
  return approval.item;
}

// Mark a pending approval as approved and run its side effect through
// executeApprovedAction. Returns both the updated approval row and the
// per-action result string (file write summary, terminal output, etc.) so
// callers can synthesize a sync dispatch result when bypassing the human
// gate via `dangerouslyAutoApprove`. `evidenceExtra` is stamped onto the
// approval.approved audit row and forwarded to executeApprovedAction so
// the same fields appear on the side-effect audit row — giving the
// reviewer the full "why was this auto-approved" trail in one place.
//
// Caller responsibilities:
//   - `actor`: "user" for human-driven approvals (default), "runtime"
//     for automated approval paths like dangerouslyAutoApprove.
//   - `resumeChatTask`: true when the caller wants the chat-task loop to
//     resume after the side effect (e.g. user clicked Approve on a
//     paused task). False when the caller is dispatching the approval
//     inline and will hand the tool result back to the loop itself.
//   - `evidenceExtra`: only `{ autoApproved, autoApprovedReason }` style
//     markers belong here. The runtime owns the canonical evidence
//     fields (beforeBytes/exitCode/etc.) and merges those after this
//     bag so unrelated keys are dropped if they collide.
// Audit-marker fields that auto-approve callers can stamp onto the
// approval.approved and side-effect audit rows. Narrow on purpose — the
// runtime owns the canonical evidence (beforeBytes/exitCode/diff/etc.)
// and merges those AFTER this bag so caller markers can't overwrite
// them. Add new keys here as new auto-approve reasons appear.
export interface AutoApproveMarkers {
  autoApproved?: boolean;
  autoApprovedReason?: string;
}

// Thrown when an approved side effect itself fails (writeFileSync
// EISDIR, terminal_exec timeout, etc.). Used by the chat-task dispatch
// loop's generic try/catch as a signal to STOP — the loop's existing
// catch turns dispatch validation errors into recoverable "Error: <msg>"
// tool results, but a side-effect failure is post-decision and must
// fail the owning task instead of letting the model carry on. The
// approval row stays in `status: "approved"` and the approval.approved
// audit row stays present (both happened before the throw); the missing
// per-action audit row is the trail signal that execution failed.
export class ApprovedActionFailedError extends Error {
  public approvalId: string;
  public cause: unknown;
  constructor(approvalId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ApprovedActionFailedError";
    this.approvalId = approvalId;
    this.cause = cause;
  }
}

// Thrown when resolveApproval is called on an approval that another
// caller already decided (a concurrent deny, sibling-cancel cascade, or
// double approve). The auto-approve path uses this to distinguish "the
// approval was decided by someone else while I was scheduling" — which
// is benign and should produce a no-op tool result — from a real
// side-effect failure that must fail the owning task. The other party
// already handled the task's terminal transition; the auto path's job
// is just to stop pretending it owns the action.
export class ApprovalRaceLostError extends Error {
  public approvalId: string;
  public status: string;
  constructor(approvalId: string, status: string) {
    super(`Approval is already ${status}`);
    this.name = "ApprovalRaceLostError";
    this.approvalId = approvalId;
    this.status = status;
  }
}

// Distinct from `ApprovalRaceLostError` because the semantics
// differ. `ApprovalRaceLostError` means "another caller decided
// this approval row before we could." `TaskAlreadyTerminalError`
// means "the owning task hit a terminal status before we could even
// create the approval row." Request* helpers in the chat-task
// dispatcher throw this when their mutateState callback observes a
// cancelled / failed / completed task; pendingOrAuto converts it to
// a "skipped" tool result so the model sees a clean no-op rather
// than a tool error.
export class TaskAlreadyTerminalError extends Error {
  public taskId: string;
  public status: string;
  constructor(taskId: string, status: string) {
    super(`Task ${taskId} is already ${status}`);
    this.name = "TaskAlreadyTerminalError";
    this.taskId = taskId;
    this.status = status;
  }
}

export async function resolveApproval(
  config: RuntimeConfig,
  approvalId: string,
  opts: { actor?: "user" | "runtime"; resumeChatTask?: boolean; evidenceExtra?: AutoApproveMarkers } = {}
): Promise<{ approval: Approval; toolResult: string | undefined }> {
  const actor = opts.actor ?? "user";
  const resumeChatTaskOpt = opts.resumeChatTask ?? true;
  const approval = await mutateState(config.instance, (state) => {
    const item = state.approvals.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Approval not found: ${approvalId}`);
    if (item.status !== "pending") throw new ApprovalRaceLostError(approvalId, item.status);
    item.status = "approved";
    item.updatedAt = now();
    addAudit(state, {
      actor,
      action: "approval.approved",
      target: item.target,
      risk: item.risk,
      taskId: item.taskId,
      runId: item.taskId ? state.tasks.find((task) => task.id === item.taskId)?.runId : undefined,
      approvalId: item.id,
      evidence: opts.evidenceExtra ? { ...opts.evidenceExtra } : undefined
    });
    return item;
  });

  if (approval.taskId) {
    appendTrace(config.instance, approval.taskId, { type: "approval", message: "Approval approved", data: { approvalId } });
  }

  // Route side-effect failures through `failTask` so the HTTP/CLI
  // approve paths fail the owning task on a thrown executor.
  // Otherwise only the auto-approve path benefits from the
  // `runTask().catch(failTask)` net, and a manual approve that hit a
  // writeFileSync EISDIR / patch-text-missing throw would leave an
  // `approved` approval row with no per-action audit and a non-failed
  // task.
  //
  // The `failTask` call is best-effort so a status-probe error or a
  // `failTask` throw cannot MASK the original executor error. The
  // original error is the meaningful one for the caller (HTTP / CLI
  // handler) to render; `failTask` is bookkeeping that the runtime
  // will retry on the next external trigger anyway.
  try {
    const toolResult = await executeApprovedAction(config, approval, {
      resumeChatTask: resumeChatTaskOpt,
      evidenceExtra: opts.evidenceExtra
    });
    // Re-read the approval row to pick up any guard flip (the
    // task-terminal guard inside `executeApprovedAction` can mark
    // the approval as `denied` via the
    // `approval.cancelled_task_terminal` path while returning
    // `toolResult === undefined`). Returning the stale pre-guard
    // `approval` object would let `pendingOrAuto` mis-report
    // success to the model on a cancelled side effect.
    const refreshed = readState(config.instance).approvals.find((a) => a.id === approvalId) ?? approval;
    return { approval: refreshed, toolResult };
  } catch (error) {
    if (error instanceof ApprovalRaceLostError) throw error;
    if (approval.taskId) {
      try {
        const ownTask = await mutateState(config.instance, (state) => state.tasks.find((t) => t.id === approval.taskId));
        const ownStatus = ownTask?.status;
        // Skip `failTask` when the task is already terminal — a
        // sibling denial / cancel may have already routed through
        // `cancelTask` or `failTask`, and the in-flight registry
        // abort fired our controller. Calling `failTask` a second
        // time would emit a duplicate `task.failed` audit row (the
        // idempotency guard inside `failTask` catches this too, but
        // skipping the call here also skips the redundant
        // run/job/subagent propagation and a duplicate failure
        // trace).
        if (ownStatus !== "failed" && ownStatus !== "cancelled" && ownStatus !== "completed") {
          await failTask(config, approval.taskId, error);
        }
      } catch {
        // Best-effort: a status-probe failure or a failTask throw
        // must not mask the original `error` we're about to rethrow.
        // The next external trigger (resumeChatTask, approval API
        // poll, etc.) will observe the approval+executor state and
        // route the task to its terminal verdict.
      }
    }
    if (error instanceof ApprovedActionFailedError) throw error;
    throw new ApprovedActionFailedError(approval.id, error);
  }
}

// Internal side-effect executor. Assumes the caller (resolveApproval) has
// ALREADY marked the approval as approved and emitted the approval.approved
// audit row. This function runs the per-action work, emits the
// `<action>` audit row, optionally resumes the chat-task loop, and
// returns the per-action result string (the same string the chat-task
// loop will hand back to the model as the tool result).
//
// Do NOT call this directly from new code — go through `resolveApproval`
// or `decideApproval` so the approval state machine stays consistent.
async function executeApprovedAction(
  config: RuntimeConfig,
  approval: Approval,
  opts: { resumeChatTask?: boolean; evidenceExtra?: AutoApproveMarkers } = {}
): Promise<string | undefined> {
  const shouldResumeChat = opts.resumeChatTask ?? true;
  const extraEvidence = opts.evidenceExtra ?? {};
  // Chat-task approvals carry a `toolCallId` on payload — when present, we
  // run the side effect, skip task completion (the loop owns the task),
  // and feed the result back via resumeChatTask.
  const chatToolCallId = approvalToolCallId(approval.payload);

  // Re-read the owning task and refuse to execute the side effect
  // if it has already reached a terminal state (failed via sibling
  // denial, cancelled, completed). The task-terminal check, the
  // approval state-machine update, and the in-flight registry
  // claim are all performed inside a SINGLE `mutateState` callback
  // so they serialize through the per-instance lock together with
  // `cancelTask`'s status-flip + `abortApprovalsForTask` call. Two
  // interleavings:
  //   (a) `cancelTask`'s mutateState runs first → executor sees
  //       `task.status === "cancelled"` and skips the claim
  //       entirely.
  //   (b) Executor's mutateState runs first → registers itself in
  //       the in-flight registry; the subsequent `cancelTask`
  //       mutateState finds it and fires the abort. The executor
  //       then enters its action branch with `signal.aborted ===
  //       true` and reacts.
  // Wrap the entire claim → run → release lifecycle in a try/finally
  // so a `mutateState` write failure that happens AFTER the in-callback
  // `claimApproval` (e.g. `writeState` fails between the in-memory
  // mutation and the disk flush) does not leak the registry entry. The
  // `guardController` variable captures whatever the guard callback
  // claimed; the `finally` releases iff a claim actually happened.
  let guardController: AbortController | undefined;
  try {
    const guard = await mutateState(config.instance, (state) => {
      const taskNow = approval.taskId
        ? state.tasks.find((t) => t.id === approval.taskId)
        : undefined;
      if (taskNow && isTerminalTaskStatus(taskNow.status)) {
        const item = state.approvals.find((a) => a.id === approval.id);
        if (item && item.status === "approved") {
          item.status = "denied";
          item.updatedAt = now();
          addAudit(state, {
            actor: "runtime",
            action: "approval.cancelled_task_terminal",
            target: item.target,
            risk: item.risk,
            taskId: item.taskId,
            runId: taskNow.runId,
            approvalId: item.id,
            evidence: { taskStatus: taskNow.status }
          });
        }
        return { ok: false as const, taskStatus: taskNow.status };
      }
      // Claim the controller while still inside the lock. cancelTask's
      // `abortApprovalsForTask` call (also inside its own mutateState
      // callback) cannot interleave between this claim and the
      // task-status check above.
      guardController = claimApproval(config.instance, approval.id, approval.taskId);
      return { ok: true as const };
    });
    if (!guard.ok) {
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "approval",
          message: "Skipping approved action: task already terminal",
          data: { approvalId: approval.id, taskStatus: guard.taskStatus }
        });
      }
      return undefined;
    }
    // Hold the abort registry claim ONLY through the side effect
    // itself, not through the subsequent `resumeChatTask` (which
    // re-enters the chat-task loop and can run another model + tool
    // dispatch turn). If we kept the claim alive through resume, a
    // cancel landing during the resumed turn would fire
    // `controller.abort()` against an already-finished approval,
    // emitting a stale `approval.in_flight_aborted` row for a side
    // effect that already wrote its normal audit row. Pass
    // `shouldResumeChat: false` to `runApprovedAction` and call
    // `resumeChatTask` AFTER releasing.
    const result = await runApprovedAction(config, approval, guardController!.signal, {
      shouldResumeChat: false,
      extraEvidence,
      chatToolCallId
    });
    releaseApproval(config.instance, approval.id);
    guardController = undefined;
    if (shouldResumeChat && chatToolCallId && approval.taskId && typeof result === "string") {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  } finally {
    if (guardController) releaseApproval(config.instance, approval.id);
  }
}

interface RunApprovedActionContext {
  shouldResumeChat: boolean;
  extraEvidence: AutoApproveMarkers;
  chatToolCallId: string | undefined;
}

// Action-specific abort handling lives here so the claim/release
// wrapper above stays focused on the lifecycle. Each branch honors
// `signal.aborted` at every awaitable point: a synchronous side
// effect (file.write, file.patch) checks `signal.aborted` before
// the write; an async-but-cancellable side effect (terminal.exec)
// wires the signal into `proc.kill`; an uncancellable native API
// (browser.upload_file's setInputFiles) races the await against the
// signal and reports the result as `_aborted` if the signal wins.
async function runApprovedAction(
  config: RuntimeConfig,
  approval: Approval,
  signal: AbortSignal,
  ctx: RunApprovedActionContext
): Promise<string | undefined> {
  const { shouldResumeChat, extraEvidence, chatToolCallId } = ctx;

  if (approval.action === "file.write") {
    // Do the abort check, path validation, file I/O, and audit-row
    // write all INSIDE the same `mutateState` callback so the
    // per-instance lock serializes the sequence with any concurrent
    // `cancelTask` / `decideApproval-deny` / `failTask` mutation.
    // If we did the abort check outside the lock and then the
    // write, `cancelTask`'s callback could fire the abort BETWEEN
    // our check and our `writeFileSync` and the file would still
    // land on disk. The path-validation throw also lives inside
    // the lock for the same reason: an aborted task with an
    // invalid path emits `file.write_aborted` instead of bubbling
    // a path error up to `failTask`.
    const path = String(approval.payload.path);
    const outcome = await mutateState(config.instance, (state) => {
      if (signal.aborted) {
        return emitFileActionAbortedSync(state, approval, "file.write_aborted", extraEvidence, signal);
      }
      const target = assertInsideWorkspaceNoSymlinkEscape(config.workspaceRoot, path);
      const before = existsSync(target) ? readFileSync(target, "utf8") : "";
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(approval.payload.content));
      addAudit(state, {
        actor: "runtime",
        action: "file.write",
        target: path,
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        // Spread caller markers FIRST so the runtime-owned canonical
        // fields (beforeBytes/afterBytes/etc.) cannot be overwritten by
        // an `as any` cast smuggling extra keys past AutoApproveMarkers.
        evidence: { ...extraEvidence, beforeBytes: before.length, afterBytes: String(approval.payload.content).length }
      });
      if (approval.taskId && !chatToolCallId) completeApprovedTask(state, approval.taskId, "File write completed.");
      return {
        kind: "ok" as const,
        task: approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined
      };
    });
    if (outcome.kind === "aborted") {
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "file.write aborted by task cancellation",
          data: { path, aborted: true }
        });
      }
      if (outcome.task) await updateRunFromTask(config, outcome.task);
      return `file write aborted: task was cancelled.`;
    }
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File written", data: { path } });
    if (outcome.task) await updateRunFromTask(config, outcome.task);
    const result = `File write completed: ${path}`;
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  }

  if (approval.action === "file.patch") {
    const path = String(approval.payload.path);
    const outcome = await mutateState(config.instance, (state) => {
      if (signal.aborted) {
        return emitFileActionAbortedSync(state, approval, "file.patch_aborted", extraEvidence, signal);
      }
      // Same symlink-escape concern as file.write — the patch can land
      // its replacement bytes outside the workspace through an in-
      // workspace symlink without this validator.
      const target = assertInsideWorkspaceNoSymlinkEscape(config.workspaceRoot, path);
      const before = readFileSync(target, "utf8");
      const oldText = String(approval.payload.oldText);
      const newText = String(approval.payload.newText);
      if (!before.includes(oldText)) throw new Error(`Patch target text no longer exists: ${path}`);
      const after = before.replace(oldText, newText);
      writeFileSync(target, after);
      addAudit(state, {
        actor: "runtime",
        action: "file.patch",
        target: path,
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: { ...extraEvidence, diff: approval.payload.diff, beforeBytes: before.length, afterBytes: after.length }
      });
      if (approval.taskId && !chatToolCallId) completeApprovedTask(state, approval.taskId, "File patch completed.");
      return {
        kind: "ok" as const,
        task: approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined
      };
    });
    if (outcome.kind === "aborted") {
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "file.patch aborted by task cancellation",
          data: { path, aborted: true }
        });
      }
      if (outcome.task) await updateRunFromTask(config, outcome.task);
      return `file patch aborted: task was cancelled.`;
    }
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File patched", data: { path, diff: approval.payload.diff } });
    if (outcome.task) await updateRunFromTask(config, outcome.task);
    const result = `File patch completed: ${path}`;
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  }

  if (approval.action === "terminal.exec") {
    const command = String(approval.payload.command);
    const usePty = approval.payload.pty === true;
    // PTY-capable spawn: when the model asks for a TTY (interactive CLIs
    // like vim, memo, claude-code), we wrap with `script` so the child sees
    // stdin as a real terminal. macOS and Linux disagree on the script
    // invocation: macOS expects `script -q <typescript> <cmd...>`, Linux
    // expects `script -q -c '<cmd>' <typescript>`. We discard the
    // typescript file by pointing it at /dev/null on either platform.
    // Without the wrapper, vim immediately exits with
    // "Vim: Error reading input, exiting..." and any caller (memo notes -a,
    // git rebase -i, etc.) sees a cancelled session.
    const spawnArgs = usePty
      ? buildPtySpawnArgs(command)
      : ["zsh", "-lc", command];
    // If cancellation arrived before we even reached the spawn
    // (executor was scheduled on the runtime tick but `cancelTask`
    // ran first AFTER our claim-`mutateState` passed the guard),
    // skip the spawn entirely. The race window is genuinely narrow
    // but honoring it here keeps audit semantics consistent with
    // the post-spawn abort path.
    if (signal.aborted) {
      return await emitTerminalAborted(config, approval, extraEvidence, { command, usePty, signal });
    }
    const skillEnv = await resolveActiveSkillsEnv(config);
    const proc = spawn(spawnArgs, {
      cwd: config.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...skillEnv }
    });
    const timeoutMs = Number(approval.payload.timeoutMs ?? 10_000);
    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    // Race `proc.exited` against the abort signal to pick the
    // audit-row name. `Promise.race` uses the microtask-ordering
    // guarantee that whichever underlying promise resolves first
    // wins; that's more reliable than a side-flag where a same-tick
    // "abort fires THEN proc.exited.then microtask runs"
    // interleaving could misclassify a naturally-completed proc as
    // aborted. The losing side's promise stays pending; we await
    // `proc.exited` again below as part of the drain — already-
    // resolved promises return their settled value cheaply.
    //
    // Grandchildren teardown: `proc.kill()` only SIGTERMs the
    // immediate child. When zsh exec's the leaf command (the
    // common case for `zsh -lc "sleep 30"`), that IS the leaf. For
    // commands that fork detached children (`sleep 30 & wait`),
    // the children survive. Bun's spawn does not expose a
    // `detached` option that turns the child into a session leader,
    // so a `process.kill(-pid)` group kill is unsafe (without
    // detached, `-pid` is a non-existent or our-own process group).
    // ADR 0008 documents the residual gap; a true setsid wrap is
    // tracked as deferred work.
    let abortReason: string | undefined;
    const procExitedSentinel = proc.exited.then(() => "exited" as const);
    const abortSentinel = new Promise<"aborted">((resolve) => {
      if (signal.aborted) {
        abortReason = readSignalReason(signal);
        return resolve("aborted");
      }
      signal.addEventListener("abort", () => {
        abortReason = readSignalReason(signal);
        resolve("aborted");
      }, { once: true });
    });
    const winner = await Promise.race([procExitedSentinel, abortSentinel]);
    if (winner === "aborted") {
      try { proc.kill(); } catch { /* already exited */ }
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    } finally {
      clearTimeout(timeout);
    }
    // Master plan §6.2: outputs may be truncated for at-a-glance display, but
    // the full logs must be retrievable. The audit `evidence` field keeps the
    // 4KB excerpt for inline reading (mobile, terminal); the full text is
    // written to a sibling artifact under the task's trace directory and the
    // audit + trace point at it so the UI can render "View full output".
    const artifact = approval.taskId
      ? writeTerminalArtifact(config.instance, approval.taskId, approval.id, { stdout, stderr })
      : undefined;
    // Route the result through `terminal.exec_aborted` only when
    // the abort actually fired BEFORE the proc completed
    // (`Promise.race` winner === "aborted"). If the proc exited
    // naturally and the signal fired later — even during stream
    // drain — the regular `terminal.exec` row is correct because
    // the command DID run to completion. `abortReason` carries the
    // value passed to `controller.abort()` by `cancelTask` /
    // `failTask` / `decideApproval-deny` so the audit forensic
    // record reflects WHY the cancel happened, not just that one
    // happened.
    if (winner === "aborted") {
      const task = await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "terminal.exec_aborted",
          target: command,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: {
            ...extraEvidence,
            aborted: true,
            abortReason: abortReason ?? "task.cancelled",
            exitCode,
            stdout: stdout.slice(0, 4000),
            stderr: stderr.slice(0, 4000),
            stdoutBytes: stdout.length,
            stderrBytes: stderr.length,
            stdoutTruncated: stdout.length > 4000,
            stderrTruncated: stderr.length > 4000,
            artifactPath: artifact?.path,
            artifactRelPath: artifact?.relPath,
            pty: usePty
          }
        });
        return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
      });
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "Command aborted by task cancellation",
          data: { command, exitCode, stdoutBytes: stdout.length, stderrBytes: stderr.length, artifactPath: artifact?.path, artifactRelPath: artifact?.relPath }
        });
      }
      if (task) await updateRunFromTask(config, task);
      // Do NOT call resumeChatTask: the task is already cancelled, the
      // chat loop's halt-siblings guard already short-circuited the
      // resume.
      return `Command aborted: task was cancelled (exit ${exitCode}).`;
    }
    const task = await mutateState(config.instance, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "terminal.exec",
        target: command,
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: {
          ...extraEvidence,
          exitCode,
          stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 4000),
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          stdoutTruncated: stdout.length > 4000,
          stderrTruncated: stderr.length > 4000,
          artifactPath: artifact?.path,
          artifactRelPath: artifact?.relPath,
          pty: usePty
        }
      });
      if (approval.taskId && !chatToolCallId) completeApprovedTask(state, approval.taskId, exitCode === 0 ? "Command completed." : "Command failed.", exitCode === 0 ? undefined : stderr);
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) {
      appendTrace(config.instance, approval.taskId, {
        type: "tool",
        message: "Command executed",
        data: {
          command,
          exitCode,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          stdoutTruncated: stdout.length > 4000,
          stderrTruncated: stderr.length > 4000,
          artifactPath: artifact?.path,
          artifactRelPath: artifact?.relPath
        }
      });
    }
    if (task) await updateRunFromTask(config, task);
    // Feed the captured stdout/stderr back to the chat-task loop. Truncate
    // similarly to the audit trail so we don't blow the model's context.
    const summary = [
      `exit ${exitCode}`,
      stdout.length > 0 ? `stdout:\n${stdout.slice(0, 4000)}${stdout.length > 4000 ? "\n…(truncated)" : ""}` : "",
      stderr.length > 0 ? `stderr:\n${stderr.slice(0, 4000)}${stderr.length > 4000 ? "\n…(truncated)" : ""}` : ""
    ].filter(Boolean).join("\n\n");
    const result = summary || `Command finished with exit ${exitCode}.`;
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  }

  if (approval.action === "browser.upload_file") {
    const ref = String(approval.payload.ref);
    // We pass the USER-SUPPLIED path (approval.payload.path), not the
    // resolved one captured at approval time. browserUploadFileApproved
    // re-runs resolveUploadPath at execution time so a TOCTOU symlink
    // swap between approval and execution is caught.
    const userPath = String(approval.payload.path);
    const displayPath = userPath;
    if (!approval.taskId) {
      const result = JSON.stringify({ success: false, error: "Browser upload approval missing taskId." });
      await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "browser.upload_file",
          target: displayPath,
          risk: "high",
          taskId: undefined,
          runId: undefined,
          approvalId: approval.id,
          evidence: { ...extraEvidence, ref, path: displayPath, success: false, error: "Browser upload approval missing taskId." }
        });
      });
      return result;
    }
    // Playwright's `setInputFiles` cannot accept an `AbortSignal`,
    // so we hand `raceWithAbort` a LAZY factory: the helper only
    // invokes the factory when the signal is not already aborted,
    // which guarantees we never launch a Playwright upload that
    // we already know is doomed. When the signal fires mid-flight
    // the helper detaches the upload promise with a no-op catch
    // so a late rejection doesn't surface as unhandled. The audit
    // row reflects what the runtime acknowledged at signal
    // time, not what the browser eventually committed — the tradeoff
    // is documented in ADR 0008.
    const taskId = approval.taskId;
    const outcome = await raceWithAbort(
      () => browserUploadFileApproved(taskId, ref, config.workspaceRoot, userPath),
      signal
    );
    if (outcome.kind === "aborted") {
      const reason = readSignalReason(signal) ?? "task.cancelled";
      const abortedResult = JSON.stringify({ success: false, aborted: true, error: "Browser upload aborted: task was cancelled." });
      const task = await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "browser.upload_file_aborted",
          target: displayPath,
          risk: "high",
          taskId: approval.taskId,
          runId: state.tasks.find((t) => t.id === approval.taskId)?.runId,
          approvalId: approval.id,
          // The audit acknowledges what the runtime knew at abort
          // time. The browser may still commit the upload as a
          // background side effect; the followup audit row written
          // by the `outcome.detached` observer below records the
          // ACTUAL outcome once the detached promise settles.
          evidence: { ...extraEvidence, ref, path: displayPath, aborted: true, abortReason: reason }
        });
        return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
      });
      // Emit a follow-up audit row when the detached upload promise
      // eventually settles so the trail records whether the page
      // actually committed the file. Only schedule the observer
      // when the factory ACTUALLY started — a pre-aborted signal
      // never invokes the factory, so there's no detached side
      // effect to observe and no `_late_completion` row should be
      // emitted.
      if (outcome.started) {
        observeBrowserUploadLateCompletion({
          config,
          outcome,
          approval,
          ref,
          displayPath,
          extraEvidence
        });
      }
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "Browser upload aborted by task cancellation",
          data: { ref, path: displayPath, aborted: true }
        });
      }
      if (task) await updateRunFromTask(config, task);
      return abortedResult;
    }
    const result = outcome.value;
    let parsed: { success?: boolean; error?: string } = {};
    try {
      parsed = JSON.parse(result) as { success?: boolean; error?: string };
    } catch {
      parsed = { success: true };
    }
    const task = await mutateState(config.instance, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "browser.upload_file",
        target: displayPath,
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: { ...extraEvidence, ref, path: displayPath, success: parsed.success !== false, error: parsed.error ?? null }
      });
      if (approval.taskId && !chatToolCallId) {
        completeApprovedTask(
          state,
          approval.taskId,
          parsed.success === false ? "Browser upload failed." : "Browser upload completed.",
          parsed.success === false ? parsed.error ?? undefined : undefined
        );
      }
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) {
      appendTrace(config.instance, approval.taskId, {
        type: parsed.success === false ? "error" : "tool",
        message: `Browser tool browser.upload_file`,
        data: { ref, path: displayPath, success: parsed.success !== false, error: parsed.error ?? null }
      });
    }
    if (task) await updateRunFromTask(config, task);
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  }
  return undefined;
}

// Pull the reason passed to `controller.abort(reason)` off the
// signal so the per-action audit rows can record WHY the cancel
// happened (`task.cancelled`, `task.failed`, or `sibling.denied`)
// instead of hardcoding one. The AbortSignal spec types `reason` as
// `any`, so guard for the cases where the controller was aborted
// with no argument (reason is a `DOMException`) or with a non-string
// value.
function readSignalReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  if (typeof signal.reason === "string") return signal.reason;
  return undefined;
}

// Observe the detached Playwright upload promise after the runtime
// acknowledged the cancel. Emits a
// `browser.upload_file_late_completion` audit row when the upload
// eventually settles so the trail records whether the browser
// actually committed the file. Short-circuits when the instance
// state file has been removed between cancel and late settlement
// (uninstall / reset path), so the helper doesn't recreate a fresh
// state directory just to write a stale audit row. Late write
// failures are swallowed — the audit is best-effort by design.
interface ObserveLateCompletionInput {
  config: RuntimeConfig;
  outcome: { kind: "aborted"; started: true; detached: Promise<{ resolved: true; value: string } | { resolved: false; error: unknown }> };
  approval: Approval;
  ref: string;
  displayPath: string;
  extraEvidence: AutoApproveMarkers;
}

function observeBrowserUploadLateCompletion(input: ObserveLateCompletionInput): void {
  const { config, outcome, approval, ref, displayPath, extraEvidence } = input;
  const observedTaskId = approval.taskId;
  void outcome.detached.then(async (settled) => {
    // Defensive: if the instance state file disappeared between
    // cancel and the upload settling, skip the write. Otherwise
    // mutateState's readState would silently create a fresh empty
    // state file under the removed instance directory and stamp a
    // stale `_late_completion` row into it.
    if (!existsSync(statePath(config.instance))) return;
    let parsedLate: { success?: boolean; error?: string } = {};
    if (settled.resolved) {
      try { parsedLate = JSON.parse(settled.value) as { success?: boolean; error?: string }; } catch { parsedLate = { success: true }; }
    }
    try {
      await mutateState(config.instance, (state) => {
        addAudit(state, {
          actor: "runtime",
          action: "browser.upload_file_late_completion",
          target: displayPath,
          risk: "high",
          taskId: observedTaskId,
          runId: state.tasks.find((t) => t.id === observedTaskId)?.runId,
          approvalId: approval.id,
          evidence: {
            ...extraEvidence,
            ref,
            path: displayPath,
            afterAbort: true,
            detachedSettled: settled.resolved,
            success: settled.resolved ? parsedLate.success !== false : false,
            error: settled.resolved ? (parsedLate.error ?? null) : (settled.error instanceof Error ? settled.error.message : String(settled.error))
          }
        });
      });
    } catch {
      // Late observer write failed — instance may have been torn down
      // between the existsSync check and the mutateState. Audit is
      // best-effort; swallow so the detached promise doesn't surface
      // as an unhandled rejection.
    }
  });
}

// Synchronous helper invoked from INSIDE the file.write /
// file.patch `mutateState` callback. Writes the abort audit row
// and returns the sentinel object the caller pattern-matches on.
// Kept sync so it composes inside the lock-held callback — there
// is no post-mutation work that needs to fire from here; the
// caller emits
// the trace + updateRunFromTask after the mutateState resolves. The
// abort reason comes from `signal.reason` (set by `controller.abort`
// in cancelTask / failTask / decideApproval-deny) so the audit row
// records WHICH terminal transition triggered the abort.
function emitFileActionAbortedSync(
  state: RuntimeState,
  approval: Approval,
  action: "file.write_aborted" | "file.patch_aborted",
  extraEvidence: AutoApproveMarkers,
  signal: AbortSignal
): { kind: "aborted"; task: Task | undefined } {
  const path = String(approval.payload.path);
  addAudit(state, {
    actor: "runtime",
    action,
    target: path,
    risk: "high",
    taskId: approval.taskId,
    runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
    approvalId: approval.id,
    evidence: { ...extraEvidence, aborted: true, abortReason: readSignalReason(signal) ?? "task.cancelled" }
  });
  return {
    kind: "aborted",
    task: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined
  };
}

// Shared helper for `terminal.exec_aborted` when the abort fired
// before we ever spawned the child process. Mirrors the post-spawn
// aborted path's audit shape minus the exit code / output.
async function emitTerminalAborted(
  config: RuntimeConfig,
  approval: Approval,
  extraEvidence: AutoApproveMarkers,
  meta: { command: string; usePty: boolean; signal: AbortSignal }
): Promise<string> {
  const task = await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "terminal.exec_aborted",
      target: meta.command,
      risk: "high",
      taskId: approval.taskId,
      runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
      approvalId: approval.id,
      evidence: { ...extraEvidence, aborted: true, abortReason: readSignalReason(meta.signal) ?? "task.cancelled", pty: meta.usePty, spawnSkipped: true }
    });
    return approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  });
  if (approval.taskId) {
    appendTrace(config.instance, approval.taskId, {
      type: "tool",
      message: "Command aborted by task cancellation before spawn",
      data: { command: meta.command }
    });
  }
  if (task) await updateRunFromTask(config, task);
  return `Command aborted: task was cancelled before execution.`;
}

// Picks the right `script` invocation to wrap a shell command in a pseudo-
// terminal. macOS BSD `script` puts the typescript file first then the
// command; util-linux `script` requires `-c '<cmd>'` plus the typescript
// file. Both support `-q` to suppress the "Script started/done" banner.
// Output stays plain because we point the typescript file at /dev/null
// (we capture stdout/stderr off the spawned proc directly).
//
// The wrapped command itself is re-routed through `zsh -lc` so the model's
// command line is parsed by the same shell as a non-PTY invocation. Without
// this, the model would have to know it's running in a different shell when
// pty=true.
export function buildPtySpawnArgs(command: string): string[] {
  if (process.platform === "linux") {
    return ["script", "-q", "-c", `zsh -lc ${shellQuote(command)}`, "/dev/null"];
  }
  // macOS / BSD layout (also the default for Bun's dev env). `script -q
  // /dev/null <cmd...>` runs <cmd...> under a PTY and discards the
  // typescript file; the remaining args are the command + its argv.
  return ["script", "-q", "/dev/null", "zsh", "-lc", command];
}

// Public helper for the auto-approve path. Spawns the command, captures
// stdout/stderr, writes the artifact + audit + trace, returns the
// formatted result string the chat-task loop feeds back to the model.
// Mirrors the executeApprovedAction terminal.exec branch, minus the
// approval-row handling. `evidenceExtra` lets the caller inject
// `autoApproved` flags so the audit trail records why the approval gate
// was skipped.
export async function runTerminalCommand(
  config: RuntimeConfig,
  taskId: string,
  command: string,
  options: { timeoutMs?: number; pty?: boolean; evidenceExtra?: Record<string, unknown> } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; summary: string }> {
  // Spawn-config locals (usePty / timeoutMs / spawnArgs) live in
  // `runTerminalCommandClaimed`; this wrapper only owns the
  // claim/release lifecycle. Keeping them here would imply two
  // places compute the same spawn args.
  //
  // The synthetic approval id lets the allowlist fast-path
  // participate in the in-flight registry the same way an
  // approval-gated `terminal.exec` does. Without this claim a
  // `cancelTask` issued while an autoApproved command is running
  // has no entry to abort and the proc keeps running to completion
  // (or its timeout), writing a normal `terminal.exec` row against
  // an already-cancelled task. The id is also used for the
  // artifact filename so the on-disk evidence ties back to the
  // registry/audit trail. The claim happens BEFORE spawn so a
  // cancel that fires between claim and spawn still aborts via the
  // early `signal.aborted` check below.
  const syntheticApprovalId = `auto_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // Claim INSIDE a mutateState callback so the terminal-status
  // check and the registry claim serialize with `cancelTask`'s
  // mutation through the per-instance lock. Without this, a cancel
  // landing between `terminalExecDispatch`'s pre-check and our
  // claim has no in-flight entry to abort, and we spawn a fresh
  // proc against an already-cancelled task. The callback returns
  // either `{ ok: false }` (task already terminal — skip spawn AND
  // audit, returning a no-op summary) or `{ ok: true, controller }`
  // (claim succeeded, proceed with spawn).
  //
  // The entire spawn/race/audit lifecycle is wrapped in a
  // try/finally so a `writeState` failure inside the claim
  // mutateState (after the in-memory claim ran) still releases the
  // synthetic in-flight entry.
  let claimedController: AbortController | undefined;
  try {
    const claim = await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      if (isTerminalTaskStatus(item.status)) {
        return { ok: false as const, status: item.status };
      }
      const c = claimApproval(config.instance, syntheticApprovalId, taskId);
      claimedController = c;
      return { ok: true as const, controller: c };
    });
    if (!claim.ok) {
      appendTrace(config.instance, taskId, {
        type: "tool",
        message: `Allowlist terminal command skipped: task is already ${claim.status}`,
        data: { command, pty: options.pty === true }
      });
      return { exitCode: 0, stdout: "", stderr: "", summary: `Command skipped: task was already ${claim.status}.` };
    }
    return await runTerminalCommandClaimed(config, taskId, command, options, syntheticApprovalId, claim.controller);
  } finally {
    if (claimedController) releaseApproval(config.instance, syntheticApprovalId);
  }
}

async function runTerminalCommandClaimed(
  config: RuntimeConfig,
  taskId: string,
  command: string,
  options: { timeoutMs?: number; pty?: boolean; evidenceExtra?: Record<string, unknown> },
  syntheticApprovalId: string,
  controller: AbortController
): Promise<{ exitCode: number; stdout: string; stderr: string; summary: string }> {
  const usePty = options.pty === true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const spawnArgs = usePty ? buildPtySpawnArgs(command) : ["zsh", "-lc", command];
  const signal = controller.signal;
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let winner: "exited" | "aborted" = "exited";
  let abortReason: string | undefined;
  if (signal.aborted) {
    // Cancellation already landed (e.g. cancelTask ran between
    // terminalExecDispatch's allowlist match and this claim). Emit
    // the aborted audit row WITHOUT spawning the proc.
    winner = "aborted";
    abortReason = readSignalReason(signal);
  } else {
    const skillEnv = await resolveActiveSkillsEnv(config);
    const proc = spawn(spawnArgs, {
      cwd: config.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...skillEnv }
    });
    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const procExitedSentinel = proc.exited.then(() => "exited" as const);
    const abortSentinel = new Promise<"aborted">((resolve) => {
      signal.addEventListener("abort", () => {
        abortReason = readSignalReason(signal);
        resolve("aborted");
      }, { once: true });
    });
    winner = await Promise.race([procExitedSentinel, abortSentinel]);
    if (winner === "aborted") {
      try { proc.kill(); } catch { /* already exited */ }
    }
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  const artifact = winner === "aborted" && exitCode === 0 && stdout.length === 0 && stderr.length === 0
    ? undefined
    : writeTerminalArtifact(config.instance, taskId, syntheticApprovalId, { stdout, stderr });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(state, {
      actor: "runtime",
      action: winner === "aborted" ? "terminal.exec_aborted" : "terminal.exec",
      target: command,
      risk: "high",
      taskId,
      runId: item.runId,
      evidence: {
        ...options.evidenceExtra,
        ...(winner === "aborted" ? { aborted: true, abortReason: abortReason ?? "task.cancelled" } : {}),
        exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutTruncated: stdout.length > 4000,
        stderrTruncated: stderr.length > 4000,
        artifactPath: artifact?.path,
        artifactRelPath: artifact?.relPath,
        pty: usePty
      }
    });
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: winner === "aborted" ? "Command aborted by task cancellation" : "Command executed",
    data: {
      command,
      exitCode,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stdoutTruncated: stdout.length > 4000,
      stderrTruncated: stderr.length > 4000,
      artifactPath: artifact?.path,
      artifactRelPath: artifact?.relPath,
      pty: usePty,
      ...(winner === "aborted" ? { aborted: true } : {}),
      ...options.evidenceExtra
    }
  });
  const summary = winner === "aborted"
    ? `Command aborted: task was cancelled (exit ${exitCode}).`
    : ([
      `exit ${exitCode}`,
      stdout.length > 0 ? `stdout:\n${stdout.slice(0, 4000)}${stdout.length > 4000 ? "\n…(truncated)" : ""}` : "",
      stderr.length > 0 ? `stderr:\n${stderr.slice(0, 4000)}${stderr.length > 4000 ? "\n…(truncated)" : ""}` : ""
    ].filter(Boolean).join("\n\n") || `Command finished with exit ${exitCode}.`);
  return { exitCode, stdout, stderr, summary };
}

// POSIX-safe single-quoting for embedding a command as one shell-word
// argument (Linux script -c expects a single string). Wraps in '...' and
// escapes embedded single quotes the standard way.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Writes the full stdout/stderr for an approved terminal/code execution to a
// sibling file under the task's trace directory. The audit evidence and the
// trace record both reference the artifact so a downstream consumer (Tasks
// timeline, evidence bundle, debugging) can recover the full text even when
// the inline excerpt is truncated. Returns the absolute path and a workspace-
// relative path; callers store both so URLs can resolve regardless of which
// surface is displaying the trace.
function writeTerminalArtifact(
  instance: string,
  taskId: string,
  approvalId: string,
  output: { stdout: string; stderr: string }
): { path: string; relPath: string } {
  const dir = join(traceDir(instance), taskId);
  mkdirSync(dir, { recursive: true });
  const filename = `terminal-${approvalId}.log`;
  const path = join(dir, filename);
  // Mark stream boundaries so a single-file artifact is still navigable.
  const body = `--- stdout (${output.stdout.length} bytes) ---\n${output.stdout}\n--- stderr (${output.stderr.length} bytes) ---\n${output.stderr}\n`;
  writeFileSync(path, body);
  return { path, relPath: join("traces", taskId, filename) };
}

function completeApprovedTask(state: RuntimeState, taskId: string, summary: string, error?: string): void {
  const task = findTask(state, taskId);
  // If a late cancel landed between the abort listener firing and
  // our completion callback (the proc exited naturally just before
  // the cancel signal arrived), the task is already terminal.
  // Overwriting `cancelled` with `completed` / `failed` here would
  // silently drop the operator's cancel — and contradict the
  // `task.cancelled` audit row we already wrote. Leave the task in
  // its existing terminal state and merge only the informational
  // summary/error fields, which mirror the proc's actual outcome
  // for the trace UI without changing the verdict.
  if (isTerminalTaskStatus(task.status)) {
    task.summary = task.summary ?? summary;
    if (error && !task.error) task.error = error;
    task.updatedAt = now();
    return;
  }
  task.status = error ? "failed" : "completed";
  task.currentStep = error ? "Failed" : "Completed";
  task.summary = summary;
  task.error = error;
  task.updatedAt = now();
}

// Exported because tool modules call it to look up the task they were
// dispatched against. Throws if missing — every code path here arrives via
// runTask which already created the row, so a miss is a real bug.
export function findTask(state: RuntimeState, taskId: string): Task {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}
