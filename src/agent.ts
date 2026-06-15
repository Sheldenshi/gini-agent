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
import type {
  Authorization,
  ChatClientSurface,
  ImageAttachment,
  RuntimeConfig,
  RuntimeState,
  SetupRequest,
  SetupRequestAction,
  Task
} from "./types";
import { statePath, traceDir } from "./paths";
import {
  addAudit,
  appendEvent,
  appendLog,
  appendTaskPartial,
  appendTrace,
  assertInsideWorkspace,
  assertInsideWorkspaceNoSymlinkEscape,
  createTask,
  findInFlightAssistantTextForTask,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState,
  recordProviderAuthFailure,
  upsertTask
} from "./state";
import type { AgentContext } from "./state/audit";

// Helper: resolve the AgentContext for an authorization/setup-request row.
// Both record kinds carry either a taskId (then the task owns attribution)
// or an agentId (minted outside a task context); fall back to system only
// if both are absent, which only happens for legacy rows.
function approvalAgentContext(row: { taskId?: string; agentId?: string }): AgentContext {
  if (row.taskId) return { taskId: row.taskId, agentId: row.agentId };
  if (row.agentId) return { agentId: row.agentId };
  return { system: true };
}

// Find any pending or resolved row by id across both collections. After the
// Authorization / SetupRequest split callers that only know the id (HTTP
// handlers, the chat-task resume path, the imperative dispatch fallback)
// use this to avoid leaking the split into every call site. Returns the
// row and which collection it lives in.
function findAuthorization(state: RuntimeState, id: string): Authorization | undefined {
  return state.authorizations.find((row) => row.id === id);
}
function findSetupRequest(state: RuntimeState, id: string): SetupRequest | undefined {
  return state.setupRequests.find((row) => row.id === id);
}
function findApprovalRow(state: RuntimeState, id: string):
  | { kind: "authorization"; row: Authorization }
  | { kind: "setup_request"; row: SetupRequest }
  | undefined {
  const auth = findAuthorization(state, id);
  if (auth) return { kind: "authorization", row: auth };
  const setup = findSetupRequest(state, id);
  if (setup) return { kind: "setup_request", row: setup };
  return undefined;
}
import {
  ProviderAuthError,
  generateTaskSummary,
  providerAuthNote,
  redactSecrets
} from "./provider";
import { listFiles, readFile, requestFilePatch, requestFileWrite, searchFiles } from "./tools/file";
import { fetchWeb } from "./tools/web";
import { requestShell } from "./tools/terminal";
import { requestCodeExecution } from "./tools/code";
import { recall, retain } from "./memory";
import { updateRunFromTask } from "./execution/runs";
import { runChatTask, resumeChatTask } from "./execution/chat-task";
import {
  emitPhase,
  emitSystemNote,
  emitToolCallStatus,
  finalizeAssistantText,
  resolveEmitContext
} from "./execution/chat-task-emit";
import { approvalToolCallId, capToolResultText } from "./execution/tool-dispatch";
import { findSelfOperation } from "./execution/self-registry";
import { redactSensitiveToolArgs } from "./execution/tool-args-redact";
import { resolveApprovalPolicy, type PolicyAction } from "./execution/policy";
import { resolveEffectiveContext } from "./execution/effective-context";
import { browserDownloadApproved, browserUploadFileApproved } from "./tools/browser";
import { connectBrowser } from "./capabilities/browser-connect";
import { findSkillScript, invokeSkillScript } from "./capabilities/skill-scripts";
import {
  abortApprovalsForTask,
  claimApproval,
  raceWithAbort,
  releaseApproval
} from "./execution/approval-execution";
import { syncSubagentFromTask } from "./capabilities/subagents";
import { sendMessagingOutput } from "./integrations/messaging";
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
  // Explicit owning agent id. Overrides the runtime's active agent at
  // submission time. Required for callers whose execution context originates
  // from a record stamped at an earlier moment (scheduled jobs, subagent
  // spawns, in-task create_job) so the new task inherits the originating
  // agent rather than whichever agent happens to be active right now.
  agentId?: string;
  // Originating chat session, when the task was submitted from a chat
  // message. Stamped on the task so the UI can resolve task -> session
  // without fetching the unscoped chatMessages list.
  chatSessionId?: string;
  // Image refs attached to the user message that spawned this task.
  // Threaded through to Task.images so the chat-task loop can dispatch
  // vision content without re-reading the chat message.
  images?: ImageAttachment[];
  // Client surface of the user message that spawned this task. Threaded
  // through to Task.clientSurface so the per-turn prompt can name the
  // surface of the CURRENT message. See ADR client-surface-context.md.
  clientSurface?: ChatClientSurface;
  // Set when the task replies inside a thread. Stamped on the task so
  // resolveEmitContext threads the whole response (every emit* block lands
  // tagged with the same thread_id/parent_block_id), not just the user turn.
  threadId?: string;
  parentBlockId?: string;
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
  const effective = resolveEffectiveContext(readState(config.instance), config);
  const created = createTask(
    config.instance,
    input,
    options.jobId,
    options.parentTaskId,
    options.subagentId,
    options.runId,
    options.agentId ?? effective.agentId,
    options.chatSessionId
  );
  if (options.mode) created.mode = options.mode;
  if (options.images && options.images.length > 0) created.images = options.images;
  if (options.clientSurface) created.clientSurface = options.clientSurface;
  if (options.threadId) created.threadId = options.threadId;
  if (options.parentBlockId) created.parentBlockId = options.parentBlockId;
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
    const audit = addAudit(
      state,
      {
        actor: options.jobId ? "runtime" : "user",
        action: "task.submitted",
        target: created.id,
        risk: "low",
        taskId: created.id,
        runId: options.runId,
        evidence: { input, jobId: options.jobId, parentTaskId: options.parentTaskId, subagentId: options.subagentId, runId: options.runId, mode: options.mode }
      },
      { taskId: created.id, agentId: created.agentId }
    );
    created.auditIds.push(audit.id);
  });
  await updateRunFromTask(config, created);
  runTask(config, created.id).catch((error) => failTask(config, created.id, error));
  return created;
}

export async function retryTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  const task = await mutateState(config.instance, (state) => {
    const existing = findTask(state, taskId);
    const effective = resolveEffectiveContext(state, config);
    const retry = createTask(
      config.instance,
      existing.input,
      existing.jobId,
      existing.parentTaskId,
      existing.subagentId,
      existing.runId,
      existing.agentId ?? effective.agentId,
      existing.chatSessionId
    );
    upsertTask(state, retry);
    addAudit(
      state,
      {
        actor: "user",
        action: "task.retry",
        target: retry.id,
        risk: "low",
        taskId: retry.id,
        runId: retry.runId,
        evidence: { retriedTaskId: taskId }
      },
      { taskId: retry.id, agentId: retry.agentId }
    );
    return retry;
  });
  runTask(config, task.id).catch((error) => failTask(config, task.id, error));
  return task;
}

export async function cancelTask(
  config: RuntimeConfig,
  taskId: string,
  // Optional parent-task guard. When set and equal to `taskId`, refuse
  // inside the serialized mutateState callback BEFORE any state change.
  // Mirrors the pattern run_job uses to close the race window between a
  // lock-free pre-check and the mutation: callers that need a strict
  // self-cancel guard pass their own taskId here. cancel_task does that.
  // Callers without that requirement (HTTP `/api/tasks/:id/cancel`)
  // omit the arg and keep their original behavior.
  parentTaskId?: string
): Promise<Task> {
  const task = await mutateState(config.instance, (state) => {
    const task = findTask(state, taskId);
    if (parentTaskId !== undefined && parentTaskId === taskId) {
      throw new Error(
        "Cannot cancel the current task — that would terminate the running conversation."
      );
    }
    if (isTerminalTaskStatus(task.status)) return task;
    task.status = "cancelled";
    task.currentStep = "Cancelled";
    task.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "task.cancelled",
        target: taskId,
        risk: "low",
        taskId,
        runId: task.runId
      },
      { taskId }
    );
    // Halt-siblings fix: cancelling a task that's waiting on multiple
    // pending approvals must also tear down those approvals so a later
    // approve doesn't run a tool against a cancelled task. Clear the
    // captured tool-call snapshot in the same write. Also drop the loaded
    // deferred-tool set: a cancelled task is terminal and must not retain
    // dead state that a future read could mistake for live context.
    cancelPendingTaskApprovals(state, taskId, "task.cancelled");
    task.toolCallState = undefined;
    task.loadedTools = undefined;
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
  // Chat-block emission for cancellation (ADR chat-block-protocol.md
  // risks §4). Flip any in-flight streaming assistant_text to
  // `streaming: false` while keeping the partial text the user already
  // saw, THEN emit a system_note("Cancelled") and the terminal
  // "Cancelled" phase. Best-effort: a chat-blocks read/write failure
  // here must not block the rest of the cancellation lifecycle.
  try {
    const emitCtx = resolveEmitContext(config, taskId);
    if (emitCtx) {
      const inFlight = findInFlightAssistantTextForTask(config.instance, taskId);
      if (inFlight) {
        finalizeAssistantText(emitCtx, inFlight.blockId, inFlight.text);
      }
      emitSystemNote(emitCtx, "Cancelled");
      emitPhase(emitCtx, "Cancelled");
    }
  } catch (error) {
    appendLog(config.instance, "chat.cancel_block.emit_failed", {
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // Cascade cancellation to descendant subagent tasks. If the cancelled
  // task spawned subagents (whose taskIds are children), cancel each one
  // recursively. Walk the runtime state for any task whose parentTaskId is
  // this task and is not already terminal, then cancel them.
  await cancelDescendantTasks(config, taskId);
  return task;
}

// Centralize the abortApprovalsForTask + authorization.in_flight_aborted
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
  addAudit(
    state,
    {
      actor: "runtime",
      action: "authorization.in_flight_aborted",
      target: task.id,
      risk: "low",
      taskId: task.id,
      runId: task.runId,
      evidence: { reason, approvalIds: aborted, ...(extraEvidence ?? {}) }
    },
    { taskId: task.id }
  );
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
  for (const sibling of state.authorizations) {
    if (sibling.taskId !== taskId) continue;
    if (sibling.status !== "pending") continue;
    if (excludeApprovalId && sibling.id === excludeApprovalId) continue;
    sibling.status = "denied";
    sibling.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: reason === "sibling.denied"
          ? "authorization.cancelled_sibling_denial"
          : "authorization.cancelled_task_cancelled",
        target: sibling.target,
        risk: sibling.risk,
        taskId: sibling.taskId,
        runId: state.tasks.find((task) => task.id === sibling.taskId)?.runId,
        approvalId: sibling.id,
        evidence: { reason, originatingApprovalId: excludeApprovalId }
      },
      { taskId }
    );
  }
  for (const sibling of state.setupRequests) {
    if (sibling.taskId !== taskId) continue;
    if (sibling.status !== "pending") continue;
    if (excludeApprovalId && sibling.id === excludeApprovalId) continue;
    sibling.status = "cancelled";
    sibling.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: reason === "sibling.denied"
          ? "setup.cancelled_sibling_denial"
          : "setup.cancelled_task_cancelled",
        target: sibling.target,
        risk: "low",
        taskId: sibling.taskId,
        runId: state.tasks.find((task) => task.id === sibling.taskId)?.runId,
        approvalId: sibling.id,
        evidence: { reason, originatingApprovalId: excludeApprovalId }
      },
      { taskId }
    );
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
    appendEvent(
      state,
      { kind: "task", action: "task.running", target: item.id, taskId: item.id, risk: "low", summary: "task.running" },
      { taskId: item.id }
    );
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
      // Imperative path also routes through the central approval-policy
      // seam. Each `request*` helper above creates exactly one approval
      // and leaves the task in `waiting_approval`; we then resolve the
      // policy decision off the just-created approval row (its action
      // and payload.command) and either auto-resolve through the same
      // resolveApproval pipeline the chat-task dispatcher uses, or
      // leave the task paused for the human gate. Errors propagate to
      // submitTask's `.catch(failTask)` so a side-effect failure is
      // recorded on the task.
      if (next.status === "waiting_approval" && next.approvalIds.length > 0) {
        const approvalId = next.approvalIds[next.approvalIds.length - 1]!;
        // Imperative dispatch only ever mints authorizations (file/web/
        // terminal/code). SetupRequest actions (browser.connect /
        // connector.request / browser.fill_secret) come from the chat-task
        // tool catalog, not from the prefix-dispatch path here.
        const approval = findAuthorization(readState(config.instance), approvalId);
        const policyAction = approval
          ? mapApprovalToPolicyAction(approval.action, approval.payload)
          : undefined;
        if (policyAction) {
          // Forward the full shape the policy needs. For code.exec we
          // MUST pass `source` (and `language` for symmetry) so the
          // matcher scans the raw snippet and an argv-style payload
          // like `Bun.spawn(["sudo", "apt"])` doesn't slip past the
          // wrapper-only check. For plain terminal.exec the wrapper
          // command is the whole shape.
          const payload =
            approval && typeof approval.payload.command === "string"
              ? policyAction === "code.exec"
                ? {
                    command: approval.payload.command,
                    source:
                      typeof approval.payload.source === "string"
                        ? approval.payload.source
                        : "",
                    language:
                      typeof approval.payload.language === "string"
                        ? approval.payload.language
                        : undefined
                  }
                : { command: approval.payload.command }
              : undefined;
          const decision = resolveApprovalPolicy(config, policyAction, payload);
          if (decision.mode === "auto") {
            try {
              await resolveAuthorization(config, approvalId, {
                actor: "runtime",
                resumeChatTask: false,
                evidenceExtra: { autoApproved: true, autoApprovedReason: decision.reason }
              });
            } catch (err) {
              // Race-loss is benign on the imperative path too:
              // another caller decided the approval first and owns
              // the task's terminal transition. Anything else
              // propagates to submitTask's outer .catch(failTask).
              if (!(err instanceof ApprovalRaceLostError)) throw err;
            }
            const refreshed = readState(config.instance).tasks.find((t) => t.id === taskId);
            return finishTaskTransition(config, refreshed ?? next);
          }
        }
      }
      return finishTaskTransition(config, next);
    }
  }

  // No tool matched: fall through to provider summarization.
  // Phase C — resolve the active agent so Hindsight recall uses the
  // right isolation key. Legacy `state.memories` pinned-memory access
  // was removed as part of the memory-surface consolidation; identity
  // facts live in USER.md and recalled-from-Hindsight memory now. See
  // ADR runtime-identity-files.md.
  const memoryState = await mutateState(config.instance, (state) => state);
  const memoryEffective = resolveEffectiveContext(memoryState, config);
  const activeAgentId = memoryEffective.agentId;

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
        // gets higher-priority placement without verbal pleading.
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

  const providerResult = await generateTaskSummary(config, task.input, recalledContext, onDelta, undefined, taskId);
  await flush();
  appendTrace(config.instance, taskId, {
    type: "model",
    message: `${providerResult.provider.name} provider generated response`,
    data: {
      provider: providerResult.provider,
      responseId: providerResult.responseId,
      usage: providerResult.usage,
      hindsightUnitsRecalled
    }
  });

  task = await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    // Respect a terminal status set while `generateTaskSummary` was
    // awaiting. Without this guard a cancel landing during the
    // provider call would be silently overwritten with `completed`.
    if (isTerminalTaskStatus(item.status)) return item;
    // The legacy "remember <fact>" prefix used to create a proposed
    // MemoryRecord row at task completion. That path was removed when
    // `state.memories` was consolidated into USER.md / SOUL.md /
    // Hindsight. Long-term retention now flows through auto-retain
    // (scheduleAutoRetain below); identity facts route through
    // `edit_user_profile`. See ADR runtime-identity-files.md.
    item.status = "completed";
    item.currentStep = "Completed";
    item.summary = providerResult.text;
    item.cost = providerResult.cost;
    item.updatedAt = now();
    upsertTask(state, item);
    appendEvent(
      state,
      { kind: "task", action: "task.completed", target: item.id, taskId: item.id, risk: "low", summary: "task.completed" },
      { taskId: item.id }
    );
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
  // Sam", "I prefer dark mode") aren't filtered out by a length heuristic.
  //
  // We apply the same shape gates as the dispatcher so natural-language
  // prompts ("read this paper carefully", "find me a restaurant") still get
  // auto-retained even though they share an English prefix with a tool.
  if (matchesShape(task.input, "read ", shapeRead)) return false;
  if (matchesShape(task.input, "list ", shapeList)) return false;
  if (matchesShape(task.input, "find ", shapeFind)) return false;
  return true;
}

export function scheduleAutoRetain(config: RuntimeConfig, task: Task): void {
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
  // Enrich provider auth failures with a named provider + re-auth CTA (issue
  // #205) ONLY when the error is a ProviderAuthError — i.e. it originated at a
  // provider call (tagged with the provider that served the turn), not a
  // tool/browser/terminal failure whose message merely mentions "401".
  const authProvider = error instanceof ProviderAuthError ? error.provider : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Redact credential-shaped substrings from provider auth errors before they
  // are stored (task.error, audit) or rendered (the note's detail) — some
  // providers echo a partial key in the error text.
  const message = authProvider ? redactSecrets(rawMessage) : rawMessage;
  const task = await mutateState(config.instance, (state) => {
    // Persist the needs-reauth record BEFORE the task lookup and terminal
    // guard below: credential state is independent of task lifecycle, and a
    // concurrent cancel (user Stop racing a just-rejected 401) or sibling
    // approval denial that flipped the task terminal first must not drop the
    // record — Settings would keep saying "Connected" against a dead
    // credential (issue #233). recordProviderAuthFailure carries its own
    // ok→needs_reauth transition dedup, so this cannot double-audit.
    // `message` is already redacted above.
    if (authProvider) {
      recordProviderAuthFailure(state, { provider: authProvider, detail: message, taskId });
    }
    // The two `runTask(...).catch(failTask(...))` fire-and-forget call
    // sites in createTask/retryTask can race with test cleanup or a
    // parent-task cancelation that removes the task row before this
    // catch handler runs. A removed task is more terminal than
    // "failed" — nothing left to audit, nothing left to update — so
    // no-op rather than throwing an unhandled "Task not found" out
    // through an already-detached promise chain.
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    // Idempotent: a sibling approval denial may have already flipped
    // the task to `failed` (see decideApproval-deny). Repeating the
    // audit row would double-count the failure and the in-flight abort
    // already fired from that path, so short-circuit here.
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    task.status = "failed";
    task.error = message;
    // Record the failed provider so syncChatTaskResult can render the same
    // actionable, provider-named message for legacy/text-only clients that the
    // chat system note shows the web (issue #205).
    if (authProvider) {
      task.authErrorProvider = authProvider;
    }
    task.currentStep = "Failed";
    task.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "task.failed",
        target: taskId,
        risk: "low",
        taskId,
        runId: task.runId,
        evidence: { error: message }
      },
      { taskId }
    );
    // A runtime-driven failure (e.g. a side-effect throw post-
    // approval) must also abort any other in-flight approved
    // actions for the same task. Without this, a sibling tool call
    // started in the same chat-task turn would keep running and
    // emit its audit row against a `failed` task.
    recordInFlightAborted(state, config.instance, task, "task.failed");
    return task;
  });
  if (!task) return;
  appendTrace(config.instance, taskId, { type: "error", message, data: {} });
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);
  await syncSubagentFromTask(config, task);
  // Chat-block emission for failure. Mirrors cancelTask's invariant:
  // partial assistant_text stays visible (we flip to streaming: false
  // rather than dropping), then a system_note carries the error
  // message and a "Failed" phase marks the terminal state. Best-effort
  // — failures during chat-block emission would otherwise mask the
  // task-failure caller's view.
  if (task.status === "failed") {
    try {
      const emitCtx = resolveEmitContext(config, taskId);
      if (emitCtx) {
        const inFlight = findInFlightAssistantTextForTask(config.instance, taskId);
        if (inFlight) {
          finalizeAssistantText(emitCtx, inFlight.blockId, inFlight.text);
        }
        // When the turn died because the provider credential failed, replace
        // the raw provider line with an actionable note that names the
        // provider and carries re-auth metadata for the client CTA (issue
        // #205). Every other failure passes the raw message through unchanged.
        if (authProvider) {
          const note = providerAuthNote(authProvider, message);
          emitSystemNote(emitCtx, note.text, note.authError);
        } else {
          emitSystemNote(emitCtx, message);
        }
        emitPhase(emitCtx, "Failed");
      }
    } catch (error) {
      appendLog(config.instance, "chat.fail_block.emit_failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
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
    addAudit(
      state,
      {
        actor: "runtime",
        action,
        target,
        risk: "low",
        taskId,
        evidence
      },
      { taskId }
    );
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
export async function decideApproval(config: RuntimeConfig, approvalId: string, decision: "approve" | "deny"): Promise<Authorization> {
  if (decision === "approve") {
    const { approval } = await resolveAuthorization(config, approvalId, { actor: "user", resumeChatTask: true });
    return approval;
  }

  const approval = await mutateState(config.instance, (state) => {
    const item = state.authorizations.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Authorization not found: ${approvalId}`);
    if (item.status !== "pending") throw new Error(`Authorization is already ${item.status}`);
    item.status = "denied";
    item.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "authorization.denied",
        target: item.target,
        risk: item.risk,
        taskId: item.taskId,
        runId: item.taskId ? state.tasks.find((task) => task.id === item.taskId)?.runId : undefined,
        approvalId: item.id
      },
      item.taskId
        ? { taskId: item.taskId, agentId: item.agentId }
        : item.agentId
          ? { agentId: item.agentId }
          : { system: true }
    );
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
        // A denied/failed task is terminal — drop the loaded deferred-tool
        // set alongside the tool-call snapshot so no dead state lingers.
        task.loadedTools = undefined;
        const message = `Approval denied: ${item.target}`;
        task.status = "failed";
        task.currentStep = "Failed";
        task.error = message;
        task.updatedAt = item.updatedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "task.failed",
            target: task.id,
            risk: "low",
            taskId: task.id,
            runId: task.runId,
            evidence: { error: message, viaAuthorizationDenied: item.id }
          },
          { taskId: task.id }
        );
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
    // Chat-block emission for the denial path. Flip the matching
    // tool_call row to `denied` (callId lives on approval.payload as
    // `toolCallId`), emit the system_note, and mark the terminal
    // phase. The denial bypasses failTask's emission path so we do
    // the equivalent inline. Best-effort: a SQLite failure here
    // doesn't block the rest of the lifecycle.
    try {
      const taskIdForEmit = approval.item.taskId;
      const emitCtx = resolveEmitContext(config, taskIdForEmit);
      if (emitCtx) {
        const toolCallId = approvalToolCallId(approval.item.payload);
        if (toolCallId) {
          emitToolCallStatus(emitCtx, { callId: toolCallId, status: "denied" });
        }
        if (approval.task) {
          const inFlight = findInFlightAssistantTextForTask(config.instance, taskIdForEmit);
          if (inFlight) {
            finalizeAssistantText(emitCtx, inFlight.blockId, inFlight.text);
          }
          emitSystemNote(emitCtx, `Approval denied: ${approval.item.target}`);
          emitPhase(emitCtx, "Failed");
        }
      }
    } catch (error) {
      appendLog(config.instance, "chat.deny_block.emit_failed", {
        approvalId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
// them.
//
// `autoApprovedReason` values produced by the runtime:
//   - "approval-mode-auto"   — approvalMode "auto" auto-approved a
//                              safe action (file.write, file.patch,
//                              browser.upload_file, or a safe
//                              terminal.exec / code_exec).
//   - "approval-mode-yolo"   — approvalMode "yolo" auto-approved
//                              everything (legacy
//                              `dangerouslyAutoApprove: true` aliases
//                              to this).
//   - "<allowlist pattern>"  — `RuntimeConfig.autoApproveCommands`
//                              matched the command (terminal.exec
//                              fast path; the matched pattern is the
//                              reason).
// Add new keys here as new auto-approve reasons appear.
export interface AutoApproveMarkers {
  autoApproved?: boolean;
  autoApprovedReason?: string;
}

// Translate an approval row's `action` field into the corresponding
// `PolicyAction` the approval-policy seam understands. Returns
// undefined for actions that aren't approval-eligible at the policy
// layer (memory.activate, skill.enable, connector.enable — those are
// audit labels, not policy-gated tools). Imperative dispatch uses
// this to look up the right policy decision after the request* helper
// has already created the approval row.
//
// code.exec is persisted on the approval row as action:"terminal.exec"
// (since the eventual side effect is a shell exec), but the POLICY
// decision must branch on the code.exec rule so the matcher scans
// BOTH the wrapper command AND the raw source. We disambiguate by
// looking for `source` on the payload — both request paths
// (chat-task `requestCodeExecPrebuilt`, imperative
// `requestCodeExecution`) persist `source` on the payload exactly so
// this re-resolution can find it.
export function mapApprovalToPolicyAction(
  action: Authorization["action"],
  payload?: Record<string, unknown>
): PolicyAction | undefined {
  if (action === "terminal.exec") {
    if (payload && typeof payload.source === "string") return "code.exec";
    return "terminal.exec";
  }
  if (action === "file.write" || action === "file.patch" || action === "browser.upload_file" || action === "browser.download") {
    return action;
  }
  if (action === "messaging.send") {
    return action;
  }
  if (action === "self.config") {
    return action;
  }
  return undefined;
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

export async function resolveAuthorization(
  config: RuntimeConfig,
  approvalId: string,
  opts: { actor?: "user" | "runtime"; resumeChatTask?: boolean; evidenceExtra?: AutoApproveMarkers } = {}
): Promise<{ approval: Authorization; toolResult: string | undefined }> {
  const actor = opts.actor ?? "user";
  const resumeChatTaskOpt = opts.resumeChatTask ?? true;
  const approval = await mutateState(config.instance, (state) => {
    const item = state.authorizations.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Authorization not found: ${approvalId}`);
    if (item.status !== "pending") throw new ApprovalRaceLostError(approvalId, item.status);
    item.status = "approved";
    item.updatedAt = now();
    addAudit(
      state,
      {
        actor,
        action: "authorization.approved",
        target: item.target,
        risk: item.risk,
        taskId: item.taskId,
        runId: item.taskId ? state.tasks.find((task) => task.id === item.taskId)?.runId : undefined,
        approvalId: item.id,
        evidence: opts.evidenceExtra ? { ...opts.evidenceExtra } : undefined
      },
      approvalAgentContext(item)
    );
    return item;
  });

  if (approval.taskId) {
    appendTrace(config.instance, approval.taskId, { type: "approval", message: "Approval approved", data: { approvalId } });
    // Flip the chat surface out of "needs approval" for the side-effect
    // window. The approved action can run for a long time (terminal.exec up
    // to its timeout) before resumeChatTask writes anything, and the gate
    // block would otherwise stay the newest activity-bearing row — thread
    // lists and the panel composer would keep reporting waiting_approval
    // while the command is actually executing. A non-terminal phase block
    // emitted before the executor makes the backwards activity scan read
    // "running" for the whole window. Best-effort like the deny path's
    // emission: a SQLite failure here must not block the side effect.
    try {
      const emitCtx = resolveEmitContext(config, approval.taskId);
      if (emitCtx) emitPhase(emitCtx, `Working: ${approval.action}`);
    } catch (error) {
      appendLog(config.instance, "chat.approve_block.emit_failed", {
        approvalId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
    // `authorization.cancelled_task_terminal` path while returning
    // `toolResult === undefined`). Returning the stale pre-guard
    // `approval` object would let `pendingOrAuto` mis-report
    // success to the model on a cancelled side effect.
    const refreshed = readState(config.instance).authorizations.find((a) => a.id === approvalId) ?? approval;
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

// Resolve a SetupRequest. The user-actor flow: the HTTP handler claims the
// row here (pending → completed/cancelled) and runs the action's side
// effects around that claim per the action's designed flow —
// browser.connect runs connectBrowser BEFORE resolving; connector
// create+probe, playwright fill, and messaging connect/remove/pairing run
// AFTER the claim wins. No side-effect dispatch happens here — that's the
// difference from resolveAuthorization. See
// docs/adr/authorization-vs-setup-request.md.

// Whether completing a setup request emits a non-terminal `Working: <action>`
// phase block right after the complete-claim wins. true: the action's side
// effects run AFTER the claim (connector probe, playwright fill, messaging
// network calls), so the activity scan must read "running" — not a stale
// waiting_approval — while they execute, mirroring the authorization approve
// path. false: emitting would lie —
//   - browser.connect runs its side effects BEFORE the claim and the resolve
//     itself stages the toolResult resume;
//   - skill.grant_connector's multi-credential flow mints the NEXT grant card
//     without a new gate block, and the old gate block staying newest is what
//     keeps the thread truthfully waiting on the next credential.
// Exhaustive over SetupRequestAction so adding an action forces a decision
// here at compile time instead of silently inheriting the wrong window
// behavior.
const SETUP_COMPLETE_EMITS_WORKING_PHASE: Record<SetupRequestAction, boolean> = {
  "connector.request": true,
  "browser.fill_secret": true,
  "messaging.add_bridge": true,
  "messaging.approve_pairing": true,
  "messaging.remove_bridge": true,
  "chat.choice": true,
  "browser.connect": false,
  "skill.grant_connector": false
};

export async function resolveSetupRequest(
  config: RuntimeConfig,
  approvalId: string,
  decision: "complete" | "cancel",
  opts: {
    actor?: "user" | "runtime";
    toolResult?: string;
    resumeChatTask?: boolean;
    awaitResume?: boolean;
  } = {}
): Promise<SetupRequest> {
  const actor = opts.actor ?? "user";
  const resume = opts.resumeChatTask ?? true;
  const result = await mutateState(config.instance, (state) => {
    const item = state.setupRequests.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Setup request not found: ${approvalId}`);
    if (item.status !== "pending") throw new ApprovalRaceLostError(approvalId, item.status);
    item.status = decision === "complete" ? "completed" : "cancelled";
    item.updatedAt = now();
    addAudit(
      state,
      {
        actor,
        action: decision === "complete" ? "setup.completed" : "setup.cancelled",
        target: item.target,
        risk: "low",
        taskId: item.taskId,
        runId: item.taskId ? state.tasks.find((task) => task.id === item.taskId)?.runId : undefined,
        approvalId: item.id,
        evidence: { action: item.action }
      },
      approvalAgentContext(item)
    );
    // On connector.request cancel, feed a negative tool result back into the
    // chat loop so the agent can either find another path or explain that it
    // needs the connector. chat.choice cancel (the card's Skip affordance)
    // resumes the same way with a skip fallback — skipping a question must
    // never kill the turn. Other setup cancellations still fail the owning
    // task: those flows are user-supplied secret/login actions where there is
    // no safe generic continuation contract yet.
    let taskRow: Task | undefined;
    let resumeCancelledConnector = false;
    if (decision === "cancel" && item.taskId) {
      const toolCallId = approvalToolCallId(item.payload);
      const task = state.tasks.find((t) => t.id === item.taskId);
      if ((item.action === "connector.request" || item.action === "chat.choice") && toolCallId && task && !isTerminalTaskStatus(task.status)) {
        task.updatedAt = item.updatedAt;
        resumeCancelledConnector = true;
        return { item, task: taskRow, resumeCancelledConnector };
      }
      cancelPendingTaskApprovals(state, item.taskId, "sibling.denied", item.id);
      if (task && !isTerminalTaskStatus(task.status)) {
        task.toolCallState = undefined;
        // Cancelling setup fails the task (terminal) — drop the loaded
        // deferred-tool set alongside the tool-call snapshot.
        task.loadedTools = undefined;
        const message = `Setup cancelled: ${item.target}`;
        task.status = "failed";
        task.currentStep = "Failed";
        task.error = message;
        task.updatedAt = item.updatedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "task.failed",
            target: task.id,
            risk: "low",
            taskId: task.id,
            runId: task.runId,
            evidence: { error: message, viaSetupCancelled: item.id }
          },
          { taskId: task.id }
        );
        recordInFlightAborted(state, config.instance, task, "sibling.denied", { originatingApprovalId: item.id });
        taskRow = task;
      }
    }
    return { item, task: taskRow, resumeCancelledConnector };
  });

  if (decision === "complete" && SETUP_COMPLETE_EMITS_WORKING_PHASE[result.item.action] && result.item.taskId) {
    // Best-effort like the cancel path's emission: a SQLite failure here
    // must not block the caller's side effects.
    try {
      const emitCtx = resolveEmitContext(config, result.item.taskId);
      if (emitCtx) emitPhase(emitCtx, `Working: ${result.item.action}`);
    } catch (error) {
      appendLog(config.instance, "chat.setup_complete_block.emit_failed", {
        setupRequestId: approvalId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (decision === "cancel" && result.resumeCancelledConnector && result.item.taskId) {
    const toolCallId = approvalToolCallId(result.item.payload);
    if (resume && toolCallId) {
      const toolResult = result.item.action === "chat.choice"
        ? "User skipped the question. Continue with your best judgment, or explain what you need if you cannot proceed without an answer."
        : `User canceled connector setup for ${result.item.target}. ` +
          `Continue without that connector if possible. If the original request requires it, tell the user what input or connector is needed.`;
      if (opts.awaitResume === false) {
        void resumeChatTask(config, result.item.taskId, toolCallId, toolResult).catch((error) =>
          failTask(config, result.item.taskId!, error)
        );
      } else {
        await resumeChatTask(config, result.item.taskId, toolCallId, toolResult);
      }
    }
  }

  if (decision === "cancel" && result.task) {
    await updateRunFromTask(config, result.task);
    if (result.task.jobId) await finalizeJobRunFromTask(config, result.task);
    await syncSubagentFromTask(config, result.task);
    try {
      const emitCtx = resolveEmitContext(config, result.task.id);
      if (emitCtx) {
        const toolCallId = approvalToolCallId(result.item.payload);
        if (toolCallId) {
          emitToolCallStatus(emitCtx, {
            callId: toolCallId,
            status: "denied",
            errorMessage: result.task.error ?? `Setup cancelled: ${result.item.target}`
          });
        }
        const inFlight = findInFlightAssistantTextForTask(config.instance, result.task.id);
        if (inFlight) {
          finalizeAssistantText(emitCtx, inFlight.blockId, inFlight.text);
        }
        emitSystemNote(emitCtx, result.task.error ?? `Setup cancelled: ${result.item.target}`);
        emitPhase(emitCtx, "Failed");
      }
    } catch (error) {
      appendLog(config.instance, "chat.setup_cancel_block.emit_failed", {
        taskId: result.task.id,
        setupRequestId: approvalId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await cancelDescendantTasks(config, result.task.id);
  }

  // Resume the chat-task loop with the synthesized tool result. The
  // /complete handler computes the result string (e.g. "Connected to X.
  // Proceed.") since it owns the side-effect outcome.
  if (resume && decision === "complete" && opts.toolResult !== undefined && result.item.taskId) {
    const toolCallId = approvalToolCallId(result.item.payload);
    const taskId = result.item.taskId;
    if (toolCallId) {
      if (opts.awaitResume === false) {
        // Detached resume. The resumed agent run can be long — it retries
        // the original request now that the connector exists. The
        // HTTP-driven completion path (the chat connect modal's POST
        // /complete) must return as soon as the connector is saved and
        // verified, so the modal closes immediately and the user watches
        // the agent stream on. Mirrors submitTask's fire-and-forget
        // runTask(...).catch(failTask) instead of blocking the request for
        // the whole run.
        void resumeChatTask(config, taskId, toolCallId, opts.toolResult).catch((error) =>
          failTask(config, taskId, error)
        );
      } else {
        await resumeChatTask(config, taskId, toolCallId, opts.toolResult);
      }
    }
  }
  return result.item;
}

// Internal side-effect executor. Assumes the caller (resolveAuthorization) has
// ALREADY marked the approval as approved and emitted the authorization.approved
// audit row. This function runs the per-action work, emits the
// `<action>` audit row, optionally resumes the chat-task loop, and
// returns the per-action result string (the same string the chat-task
// loop will hand back to the model as the tool result).
//
// Do NOT call this directly from new code — go through `resolveApproval`
// or `decideApproval` so the approval state machine stays consistent.
async function executeApprovedAction(
  config: RuntimeConfig,
  approval: Authorization,
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
        const item = state.authorizations.find((a) => a.id === approval.id);
        if (item && item.status === "approved") {
          item.status = "denied";
          item.updatedAt = now();
          addAudit(
            state,
            {
              actor: "runtime",
              action: "authorization.cancelled_task_terminal",
              target: item.target,
              risk: item.risk,
              taskId: item.taskId,
              runId: taskNow.runId,
              approvalId: item.id,
              evidence: { taskStatus: taskNow.status }
            },
            item.taskId
              ? { taskId: item.taskId, agentId: item.agentId }
              : item.agentId
                ? { agentId: item.agentId }
                : { system: true }
          );
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
    // emitting a stale `authorization.in_flight_aborted` row for a side
    // effect that already wrote its normal audit row. Pass
    // `shouldResumeChat: false` to `runApprovedAction` and call
    // `resumeChatTask` AFTER releasing.
    const rawResult = await runApprovedAction(config, approval, guardController!.signal, {
      shouldResumeChat: false,
      extraEvidence,
      chatToolCallId
    });
    releaseApproval(config.instance, approval.id);
    guardController = undefined;
    // The approved side effect's result becomes a role:"tool" message via
    // resumeChatTask, a path that does NOT pass through dispatchToolCall's
    // cap. Apply the same universal per-tool ceiling here so a large
    // terminal/self-op result can't dominate the model context.
    const result = typeof rawResult === "string" ? capToolResultText(rawResult, approval.action) : rawResult;
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
  approval: Authorization,
  signal: AbortSignal,
  ctx: RunApprovedActionContext
): Promise<string | undefined> {
  const { shouldResumeChat, extraEvidence, chatToolCallId } = ctx;

  // SetupRequest actions (browser.connect, connector.request,
  // browser.fill_secret, and the messaging.* connect actions —
  // add_bridge, approve_pairing, remove_bridge) no longer reach this
  // executor — their side effects run inside the
  // /api/setup-requests/:id/complete endpoint (delegating to the bounded
  // runMessaging*Connect / runFillSecretConnect modules), not through
  // Authorization side-effect dispatch. See
  // docs/adr/authorization-vs-setup-request.md.

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
      addAudit(
        state,
        {
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
        },
        approvalAgentContext(approval)
      );
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
      addAudit(
        state,
        {
          actor: "runtime",
          action: "file.patch",
          target: path,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: { ...extraEvidence, diff: approval.payload.diff, beforeBytes: before.length, afterBytes: after.length }
        },
        approvalAgentContext(approval)
      );
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
    const proc = spawn(spawnArgs, {
      cwd: config.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env }
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
    // ADR approval-execution-abort.md documents the residual gap; a true setsid wrap is
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
        addAudit(
          state,
          {
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
          },
          approvalAgentContext(approval)
        );
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
      addAudit(
        state,
        {
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
        },
        approvalAgentContext(approval)
      );
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
        addAudit(
          state,
          {
            actor: "runtime",
            action: "browser.upload_file",
            target: displayPath,
            risk: "high",
            taskId: undefined,
            runId: undefined,
            approvalId: approval.id,
            evidence: { ...extraEvidence, ref, path: displayPath, success: false, error: "Browser upload approval missing taskId." }
          },
          approvalAgentContext(approval)
        );
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
    // is documented in ADR approval-execution-abort.md.
    const taskId = approval.taskId;
    const outcome = await raceWithAbort(
      () => browserUploadFileApproved(taskId, ref, config.workspaceRoot, userPath),
      signal
    );
    if (outcome.kind === "aborted") {
      const reason = readSignalReason(signal) ?? "task.cancelled";
      const abortedResult = JSON.stringify({ success: false, aborted: true, error: "Browser upload aborted: task was cancelled." });
      const task = await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
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
          },
          approvalAgentContext(approval)
        );
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
        observeBrowserActionLateCompletion({
          config,
          outcome,
          approval,
          action: "browser.upload_file_late_completion",
          target: displayPath,
          evidenceBase: { ref, path: displayPath },
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
      addAudit(
        state,
        {
          actor: "runtime",
          action: "browser.upload_file",
          target: displayPath,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: { ...extraEvidence, ref, path: displayPath, success: parsed.success !== false, error: parsed.error ?? null }
        },
        approvalAgentContext(approval)
      );
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

  if (approval.action === "browser.download") {
    const ref = String(approval.payload.ref);
    const sourceUrl = typeof approval.payload.currentUrl === "string" ? approval.payload.currentUrl : "";
    const target = sourceUrl || ref;
    if (!approval.taskId) {
      const result = JSON.stringify({ success: false, error: "Browser download approval missing taskId." });
      await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "browser.download",
            target,
            risk: "high",
            taskId: undefined,
            runId: undefined,
            approvalId: approval.id,
            evidence: { ...extraEvidence, ref, source: sourceUrl || null, success: false, error: "Browser download approval missing taskId." }
          },
          approvalAgentContext(approval)
        );
      });
      return result;
    }
    // Same lazy-factory abort contract as browser.upload_file: the
    // Playwright click + download capture cannot take an AbortSignal, so
    // raceWithAbort only starts it when the signal is not already
    // aborted, and a mid-flight abort detaches the promise (observed
    // below for the late-completion audit row).
    const taskId = approval.taskId;
    const outcome = await raceWithAbort(
      () => browserDownloadApproved(taskId, ref, config.instance),
      signal
    );
    if (outcome.kind === "aborted") {
      const reason = readSignalReason(signal) ?? "task.cancelled";
      const abortedResult = JSON.stringify({ success: false, aborted: true, error: "Browser download aborted: task was cancelled." });
      const task = await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "browser.download_aborted",
            target,
            risk: "high",
            taskId: approval.taskId,
            runId: state.tasks.find((t) => t.id === approval.taskId)?.runId,
            approvalId: approval.id,
            // The audit acknowledges what the runtime knew at abort
            // time. The browser may still commit the download as a
            // background side effect; the followup audit row written
            // by the `outcome.detached` observer below records the
            // ACTUAL outcome once the detached promise settles.
            evidence: { ...extraEvidence, ref, source: sourceUrl || null, aborted: true, abortReason: reason }
          },
          approvalAgentContext(approval)
        );
        return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
      });
      if (outcome.started) {
        observeBrowserActionLateCompletion({
          config,
          outcome,
          approval,
          action: "browser.download_late_completion",
          target,
          evidenceBase: { ref, source: sourceUrl || null },
          extraEvidence
        });
      }
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "Browser download aborted by task cancellation",
          data: { ref, source: sourceUrl || null, aborted: true }
        });
      }
      if (task) await updateRunFromTask(config, task);
      return abortedResult;
    }
    const result = outcome.value;
    let parsed: { success?: boolean; error?: string; path?: string; size?: number; downloadUrl?: string | null } = {};
    try {
      parsed = JSON.parse(result) as { success?: boolean; error?: string; path?: string; size?: number; downloadUrl?: string | null };
    } catch {
      parsed = { success: true };
    }
    const task = await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "browser.download",
          target,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: {
            ...extraEvidence,
            ref,
            source: sourceUrl || null,
            // The URL the bytes actually came from (page-URL `source` is
            // only where the click happened) — reported by the gated
            // download path in browser.ts.
            downloadUrl: parsed.downloadUrl ?? null,
            savedPath: parsed.path ?? null,
            size: parsed.size ?? null,
            success: parsed.success !== false,
            error: parsed.error ?? null
          }
        },
        approvalAgentContext(approval)
      );
      if (approval.taskId && !chatToolCallId) {
        completeApprovedTask(
          state,
          approval.taskId,
          parsed.success === false ? "Browser download failed." : "Browser download completed.",
          parsed.success === false ? parsed.error ?? undefined : undefined
        );
      }
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) {
      appendTrace(config.instance, approval.taskId, {
        type: parsed.success === false ? "error" : "tool",
        message: `Browser tool browser.download`,
        data: { ref, source: sourceUrl || null, savedPath: parsed.path ?? null, size: parsed.size ?? null, success: parsed.success !== false, error: parsed.error ?? null }
      });
    }
    if (task) await updateRunFromTask(config, task);
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, result);
    }
    return result;
  }

  if (approval.action === "skill.run") {
    // Approved skill_run on a script gated via requires.approval (see
    // ADR skill-script-approval-gating.md). Calls invokeSkillScript
    // directly — the skill_run dispatch gate already fired when this
    // approval was created, so re-routing through dispatch would gate
    // it twice. The hook handler's invokeSkillScript path is likewise
    // untouched by the gate.
    const skillName = String(approval.payload.skillName ?? "");
    const scriptName = String(approval.payload.scriptName ?? "");
    const scriptArgs = (approval.payload.scriptArgs && typeof approval.payload.scriptArgs === "object" && !Array.isArray(approval.payload.scriptArgs))
      ? approval.payload.scriptArgs as Record<string, unknown>
      : {};
    if (signal.aborted) {
      const aborted = JSON.stringify({ ok: false, aborted: true, error: "skill.run aborted: task was cancelled." });
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "skill.run aborted by task cancellation",
          data: { skill: skillName, script: scriptName, aborted: true }
        });
      }
      return aborted;
    }
    // Re-resolve the script handle at execution time: the skill may have
    // been disabled (or the script removed) between the approval request
    // and the user's decision. Fail the tool result cleanly rather than
    // running against a stale handle.
    let resultStr: string;
    let resultOk: boolean;
    const handle = findSkillScript(readState(config.instance), skillName, scriptName);
    if (!handle) {
      resultOk = false;
      resultStr = JSON.stringify({
        ok: false,
        error: `Skill script not found: ${skillName}/${scriptName}. The skill may have been disabled since the approval was requested.`
      });
    } else {
      // Same result mapping as skillRunTool so the model sees an
      // identical tool-result shape on both the gated and ungated paths.
      const result = await invokeSkillScript(config, handle, scriptArgs, { taskId: approval.taskId });
      resultOk = result.ok;
      if (result.parsed !== null && result.parsed !== undefined) {
        resultStr = typeof result.parsed === "string" ? result.parsed : JSON.stringify(result.parsed);
      } else {
        resultStr = JSON.stringify({ ok: result.ok, error: result.error ?? "Skill script returned no output." });
      }
    }
    const task = await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.run",
          target: `${skillName}/${scriptName}`,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: { ...extraEvidence, skill: skillName, script: scriptName, ok: resultOk }
        },
        approvalAgentContext(approval)
      );
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) {
      appendTrace(config.instance, approval.taskId, {
        type: "tool",
        message: "skill.run completed",
        data: { skill: skillName, script: scriptName, ok: resultOk }
      });
    }
    if (task) await updateRunFromTask(config, task);
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, resultStr);
    }
    return resultStr;
  }

  if (approval.action === "messaging.send") {
    const bridgeId = String(approval.payload.bridgeId ?? "");
    const text = String(approval.payload.text ?? "");
    const target = typeof approval.payload.target === "string" ? approval.payload.target : undefined;
    if (signal.aborted) {
      const aborted = JSON.stringify({ success: false, aborted: true, error: "messaging.send aborted: task was cancelled." });
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "messaging.send aborted by task cancellation",
          data: { bridgeId, target, aborted: true }
        });
      }
      return aborted;
    }
    let resultPayload: { ok: boolean; messageId?: string; status?: string; error?: string };
    try {
      // Thread the task's abort signal through so a cancel that races
      // in after approval but before the Telegram/Discord POST completes
      // tears the request down instead of egressing the message. The
      // bridge's outbound HTTP path already wires the signal into
      // fetch(); this is the seam that hands it across.
      const message = await sendMessagingOutput(
        config,
        bridgeId,
        { text, target, taskId: approval.taskId },
        { signal }
      );
      resultPayload = { ok: message.status === "sent", messageId: message.id, status: message.status, error: message.error ?? undefined };
    } catch (error) {
      resultPayload = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const task = await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "agent",
          action: "messaging.send",
          target: bridgeId,
          risk: "high",
          taskId: approval.taskId,
          runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
          approvalId: approval.id,
          evidence: {
            ...extraEvidence,
            bridgeId,
            target: target ?? null,
            textBytes: text.length,
            ok: resultPayload.ok,
            messageId: resultPayload.messageId ?? null,
            error: resultPayload.error ?? null
          }
        },
        approvalAgentContext(approval)
      );
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) {
      appendTrace(config.instance, approval.taskId, {
        type: "tool",
        message: "messaging.send completed",
        data: { bridgeId, target, ok: resultPayload.ok, messageId: resultPayload.messageId, error: resultPayload.error }
      });
    }
    if (task) await updateRunFromTask(config, task);
    const resultStr = JSON.stringify(resultPayload);
    if (shouldResumeChat && chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, resultStr);
    }
    return resultStr;
  }

  if (approval.action === "self.config") {
    // The side effect is the registry handler itself (set_provider /
    // use_agent / create_agent). It was deferred to approval time; re-read
    // {opName, args} from the payload and run it now. The handler writes its
    // own trace + audit rows, so this branch just runs it and feeds the
    // result back to the chat-task loop.
    const opName = String(approval.payload.opName ?? "");
    const opArgs = (approval.payload.args && typeof approval.payload.args === "object" && !Array.isArray(approval.payload.args))
      ? approval.payload.args as Record<string, unknown>
      : {};
    if (signal.aborted) {
      const aborted = JSON.stringify({ ok: false, aborted: true, error: "self.config aborted: task was cancelled." });
      if (approval.taskId) {
        appendTrace(config.instance, approval.taskId, {
          type: "tool",
          message: "self.config aborted by task cancellation",
          data: { opName, aborted: true }
        });
      }
      return aborted;
    }
    const op = findSelfOperation(opName);
    if (!op || !approval.taskId) {
      return JSON.stringify({ ok: false, error: `Unknown self operation: ${opName}.` });
    }
    const resultStr = await op.handler(config, approval.taskId, opArgs);
    // The handler writes its own low-risk operation trace; this row carries
    // approvalId so the operation outcome is joinable to the approval that
    // authorized it. Mirrors the messaging.send execute-side audit.
    let resultOk: boolean | null = null;
    try {
      const parsed = JSON.parse(resultStr);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        resultOk = parsed.ok;
      }
    } catch {
      // Best-effort: a non-JSON handler result leaves ok null.
    }
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "agent",
          action: "self.config",
          target: opName,
          risk: "medium",
          taskId: approval.taskId,
          runId: state.tasks.find((t) => t.id === approval.taskId)?.runId,
          approvalId: approval.id,
          evidence: { ...extraEvidence, opName, ok: resultOk }
        },
        approvalAgentContext(approval)
      );
      // Scrub any secret args (set_provider.apiKey, rotate_connector.token,
      // add_mcp_server.headers) from the now-resolved approval payload. The
      // approvals list serves the payload to clients, so the historical row
      // must not retain credentials. The handler already ran above, so the
      // real args are no longer needed. The brief pending window (strict
      // mode, before approval) keeps the real args so the action can execute
      // on approval — only the approving user sees that, which is acceptable.
      const row = state.authorizations.find((a) => a.id === approval.id);
      if (row && row.payload.args && typeof row.payload.args === "object" && !Array.isArray(row.payload.args)) {
        row.payload.args = redactSensitiveToolArgs(row.payload.args as Record<string, unknown>);
      }
    });
    if (shouldResumeChat && chatToolCallId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, resultStr);
    }
    return resultStr;
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

// Observe a detached Playwright side-effect promise (upload or download)
// after the runtime acknowledged the cancel. Emits a
// `browser.<action>_late_completion` audit row when the side effect
// eventually settles so the trail records whether the browser
// actually committed it. Short-circuits when the instance
// state file has been removed between cancel and late settlement
// (uninstall / reset path), so the helper doesn't recreate a fresh
// state directory just to write a stale audit row. Late write
// failures are swallowed — the audit is best-effort by design.
interface ObserveLateCompletionInput {
  config: RuntimeConfig;
  outcome: { kind: "aborted"; started: true; detached: Promise<{ resolved: true; value: string } | { resolved: false; error: unknown }> };
  approval: Authorization;
  action: "browser.upload_file_late_completion" | "browser.download_late_completion";
  target: string;
  // Action-specific evidence fields ({ ref, path } for upload,
  // { ref, source } for download). Merged before the runtime-owned
  // late-settlement markers so those can't be overridden.
  evidenceBase: Record<string, unknown>;
  extraEvidence: AutoApproveMarkers;
}

function observeBrowserActionLateCompletion(input: ObserveLateCompletionInput): void {
  const { config, outcome, approval, action, target, evidenceBase, extraEvidence } = input;
  const observedTaskId = approval.taskId;
  void outcome.detached.then(async (settled) => {
    // Defensive: if the instance state file disappeared between
    // cancel and the side effect settling, skip the write. Otherwise
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
        addAudit(
          state,
          {
            actor: "runtime",
            action,
            target,
            risk: "high",
            taskId: observedTaskId,
            runId: state.tasks.find((t) => t.id === observedTaskId)?.runId,
            approvalId: approval.id,
            evidence: {
              ...extraEvidence,
              ...evidenceBase,
              afterAbort: true,
              detachedSettled: settled.resolved,
              success: settled.resolved ? parsedLate.success !== false : false,
              error: settled.resolved ? (parsedLate.error ?? null) : (settled.error instanceof Error ? settled.error.message : String(settled.error))
            }
          },
          approvalAgentContext(approval)
        );
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
  approval: Authorization,
  action: "file.write_aborted" | "file.patch_aborted",
  extraEvidence: AutoApproveMarkers,
  signal: AbortSignal
): { kind: "aborted"; task: Task | undefined } {
  const path = String(approval.payload.path);
  addAudit(
    state,
    {
      actor: "runtime",
      action,
      target: path,
      risk: "high",
      taskId: approval.taskId,
      runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
      approvalId: approval.id,
      evidence: { ...extraEvidence, aborted: true, abortReason: readSignalReason(signal) ?? "task.cancelled" }
    },
    approvalAgentContext(approval)
  );
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
  approval: Authorization,
  extraEvidence: AutoApproveMarkers,
  meta: { command: string; usePty: boolean; signal: AbortSignal }
): Promise<string> {
  const task = await mutateState(config.instance, (state) => {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "terminal.exec_aborted",
        target: meta.command,
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: { ...extraEvidence, aborted: true, abortReason: readSignalReason(meta.signal) ?? "task.cancelled", pty: meta.usePty, spawnSkipped: true }
      },
      approvalAgentContext(approval)
    );
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
    const proc = spawn(spawnArgs, {
      cwd: config.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env }
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
    addAudit(
      state,
      {
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
      },
      { taskId }
    );
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
