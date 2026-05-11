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
import { join } from "node:path";
import { spawn } from "bun";
import type { Approval, RuntimeConfig, RuntimeState, Task } from "./types";
import { traceDir } from "./paths";
import {
  addAudit,
  appendLog,
  appendTaskPartial,
  appendTrace,
  assertInsideWorkspace,
  createMemory,
  createTask,
  mutateState,
  now,
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
import { syncSubagentFromTask } from "./capabilities/subagents";
// Imported from a leaf module (not src/jobs/index.ts) so we don't close
// the cycle that runs through submitTask. The finalizer flips the linked
// JobRunRecord from "running" to a terminal status when a Task with a
// jobId settles. Idempotent — safe to call from runTask, failTask, and
// cancelTask without de-duping.
import { finalizeJobRunFromTask } from "./jobs/finalize";

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
  await mutateState(config.instance, (state) => {
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
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return task;
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
    .filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled")
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
    item.status = "running";
    item.currentStep = "Thinking";
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });
  await updateRunFromTask(config, task);

  appendTrace(config.instance, taskId, { type: "task", message: "Task started", data: { input: task.input } });
  appendLog(config.instance, "task.started", { taskId });

  await Bun.sleep(10);
  const lower = task.input.toLowerCase();

  // Dispatch by input prefix. Each tool returns the resulting Task; high-risk
  // tools may have transitioned the task into waiting_approval. We flip
  // currentStep to "Working" *before* dispatching so the chat UI can
  // distinguish text-generation ("Thinking") from tool execution ("Working").
  // Approval-gated tools will overwrite to "Waiting for approval" inside the
  // tool itself; synchronous tools (read/list/find/web) keep "Working" until
  // completion.
  if (lower.startsWith("write ")) { await markWorking(config, taskId); return finishTaskTransition(config, await requestFileWrite(config, task)); }
  if (lower.startsWith("patch ")) { await markWorking(config, taskId); return finishTaskTransition(config, await requestFilePatch(config, task)); }
  if (lower.startsWith("read ")) { await markWorking(config, taskId); return finishTaskTransition(config, await readFile(config, task)); }
  if (lower.startsWith("list ")) { await markWorking(config, taskId); return finishTaskTransition(config, await listFiles(config, task)); }
  if (lower.startsWith("find ")) { await markWorking(config, taskId); return finishTaskTransition(config, await searchFiles(config, task)); }
  if (lower.startsWith("web ")) { await markWorking(config, taskId); return finishTaskTransition(config, await fetchWeb(config, task)); }
  if (lower.startsWith("code ")) { await markWorking(config, taskId); return finishTaskTransition(config, await requestCodeExecution(config, task)); }
  if (lower.startsWith("shell ")) { await markWorking(config, taskId); return finishTaskTransition(config, await requestShell(config, task)); }

  // No tool matched: fall through to provider summarization.
  const activeMemory = await mutateState(config.instance, (state) => state.memories.filter((memory) => memory.status === "active"));

  // Hindsight phase 5: auto-recall. Pull relevant facts/opinions from the
  // four-network store and inject as additional context. Best-effort — if
  // recall fails (e.g. embedding provider unavailable), continue with the
  // legacy MemoryRecord injection only.
  let recalledContext: string | undefined;
  let hindsightUnitsRecalled = 0;
  try {
    const recalled = await recall(config, { query: task.input, tokenBudget: 1500, sourceTaskId: taskId });
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
    if (lower.includes("remember ")) {
      const content = item.input.split(/remember\s+/i).at(-1)?.trim() || item.input;
      const memory = createMemory(state, {
        content,
        scope: "project",
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
  const lower = task.input.toLowerCase();
  if (lower.startsWith("read ") || lower.startsWith("list ") || lower.startsWith("find ")) return false;
  return true;
}

function scheduleAutoRetain(config: RuntimeConfig, task: Task): void {
  if (!shouldAutoRetain(task)) return;
  const text = task.summary
    ? `Task input: ${task.input}\n\nTask summary: ${task.summary}`
    : `Task input: ${task.input}`;
  retain(config, { text, sourceTaskId: task.id })
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
    return task;
  });
  appendTrace(config.instance, taskId, { type: "error", message, data: {} });
  await updateRunFromTask(config, task);
  if (task.jobId) await finalizeJobRunFromTask(config, task);
  await syncSubagentFromTask(config, task);
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
    addAudit(state, {
      actor: "runtime",
      action,
      target,
      risk: "low",
      taskId,
      evidence
    });
    task.status = "completed";
    task.currentStep = "Completed";
    task.summary = summary;
    task.updatedAt = now();
    upsertTask(state, task);
    return task;
  });
  // Hindsight phase 5: auto-retain. Skip read/list/find — they're noise.
  void scheduleAutoRetain(config, completed);
  await updateRunFromTask(config, completed);
  if (completed.jobId) await finalizeJobRunFromTask(config, completed);
  return completed;
}

export async function decideApproval(config: RuntimeConfig, approvalId: string, decision: "approve" | "deny"): Promise<Approval> {
  const approval = await mutateState(config.instance, (state) => {
    const item = state.approvals.find((candidate) => candidate.id === approvalId);
    if (!item) throw new Error(`Approval not found: ${approvalId}`);
    if (item.status !== "pending") throw new Error(`Approval is already ${item.status}`);
    item.status = decision === "approve" ? "approved" : "denied";
    item.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `approval.${item.status}`,
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
    if (decision === "deny" && item.taskId) {
      cancelPendingTaskApprovals(state, item.taskId, "sibling.denied", item.id);
      const task = state.tasks.find((t) => t.id === item.taskId);
      if (task) task.toolCallState = undefined;
    }
    return item;
  });

  if (approval.taskId) {
    appendTrace(config.instance, approval.taskId, { type: "approval", message: `Approval ${approval.status}`, data: { approvalId } });
  }

  if (decision === "deny") {
    if (approval.taskId) await failTask(config, approval.taskId, new Error(`Approval denied: ${approval.target}`));
    return approval;
  }

  await executeApprovedAction(config, approval);
  return approval;
}

async function executeApprovedAction(config: RuntimeConfig, approval: Approval): Promise<void> {
  // Chat-task approvals carry a `toolCallId` on payload — when present, we
  // run the side effect, skip task completion (the loop owns the task),
  // and feed the result back via resumeChatTask.
  const chatToolCallId = approvalToolCallId(approval.payload);

  // Halt-siblings fix (Review P1 #2): re-read the owning task and refuse
  // to execute the side effect if the task has already reached a terminal
  // state (failed via sibling denial, cancelled, completed). Without this
  // guard, two approval-gated tool calls in a single LLM turn could both
  // execute even though the first denial already failed the task.
  if (approval.taskId) {
    const taskNow = await mutateState(config.instance, (state) => {
      return state.tasks.find((t) => t.id === approval.taskId);
    });
    if (taskNow && (taskNow.status === "failed" || taskNow.status === "cancelled" || taskNow.status === "completed")) {
      appendTrace(config.instance, approval.taskId, {
        type: "approval",
        message: "Skipping approved action: task already terminal",
        data: { approvalId: approval.id, taskStatus: taskNow.status }
      });
      // Mark the approval as cancelled-after-approval so audit trail and
      // UI both surface the no-op. Approval status enum only has the
      // three values; we use "denied" plus a distinct audit action to
      // record that the cancellation was post-approval.
      await mutateState(config.instance, (state) => {
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
            runId: state.tasks.find((task) => task.id === item.taskId)?.runId,
            approvalId: item.id,
            evidence: { taskStatus: taskNow.status }
          });
        }
      });
      return;
    }
  }

  if (approval.action === "file.write") {
    const target = assertInsideWorkspace(config.workspaceRoot, String(approval.payload.path));
    const before = existsSync(target) ? readFileSync(target, "utf8") : "";
    writeFileSync(target, String(approval.payload.content));
    const task = await mutateState(config.instance, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "file.write",
        target: String(approval.payload.path),
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: { beforeBytes: before.length, afterBytes: String(approval.payload.content).length }
      });
      if (approval.taskId && !chatToolCallId) completeApprovedTask(state, approval.taskId, "File write completed.");
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File written", data: { path: approval.payload.path } });
    if (task) await updateRunFromTask(config, task);
    if (chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, `File write completed: ${approval.payload.path}`);
    }
    return;
  }

  if (approval.action === "file.patch") {
    const target = assertInsideWorkspace(config.workspaceRoot, String(approval.payload.path));
    const before = readFileSync(target, "utf8");
    const oldText = String(approval.payload.oldText);
    const newText = String(approval.payload.newText);
    if (!before.includes(oldText)) throw new Error(`Patch target text no longer exists: ${approval.payload.path}`);
    const after = before.replace(oldText, newText);
    writeFileSync(target, after);
    const task = await mutateState(config.instance, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "file.patch",
        target: String(approval.payload.path),
        risk: "high",
        taskId: approval.taskId,
        runId: approval.taskId ? state.tasks.find((task) => task.id === approval.taskId)?.runId : undefined,
        approvalId: approval.id,
        evidence: { diff: approval.payload.diff, beforeBytes: before.length, afterBytes: after.length }
      });
      if (approval.taskId && !chatToolCallId) completeApprovedTask(state, approval.taskId, "File patch completed.");
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File patched", data: { path: approval.payload.path, diff: approval.payload.diff } });
    if (task) await updateRunFromTask(config, task);
    if (chatToolCallId && approval.taskId) {
      await resumeChatTask(config, approval.taskId, chatToolCallId, `File patch completed: ${approval.payload.path}`);
    }
    return;
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
    const proc = spawn(spawnArgs, {
      cwd: config.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe"
    });
    const timeoutMs = Number(approval.payload.timeoutMs ?? 10_000);
    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    // Master plan §6.2: outputs may be truncated for at-a-glance display, but
    // the full logs must be retrievable. The audit `evidence` field keeps the
    // 4KB excerpt for inline reading (mobile, terminal); the full text is
    // written to a sibling artifact under the task's trace directory and the
    // audit + trace point at it so the UI can render "View full output".
    const artifact = approval.taskId
      ? writeTerminalArtifact(config.instance, approval.taskId, approval.id, { stdout, stderr })
      : undefined;
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
    if (chatToolCallId && approval.taskId) {
      // Feed the captured stdout/stderr back to the chat-task loop. Truncate
      // similarly to the audit trail so we don't blow the model's context.
      const summary = [
        `exit ${exitCode}`,
        stdout.length > 0 ? `stdout:\n${stdout.slice(0, 4000)}${stdout.length > 4000 ? "\n…(truncated)" : ""}` : "",
        stderr.length > 0 ? `stderr:\n${stderr.slice(0, 4000)}${stderr.length > 4000 ? "\n…(truncated)" : ""}` : ""
      ].filter(Boolean).join("\n\n");
      await resumeChatTask(config, approval.taskId, chatToolCallId, summary || `Command finished with exit ${exitCode}.`);
    }
  }
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
  const usePty = options.pty === true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const spawnArgs = usePty ? buildPtySpawnArgs(command) : ["zsh", "-lc", command];
  const proc = spawn(spawnArgs, {
    cwd: config.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe"
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);
  // Synthetic id so the artifact filename collides with neither real
  // approval ids nor sibling auto-approved runs in the same task.
  const syntheticId = `auto_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const artifact = writeTerminalArtifact(config.instance, taskId, syntheticId, { stdout, stderr });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(state, {
      actor: "runtime",
      action: "terminal.exec",
      target: command,
      risk: "high",
      taskId,
      runId: item.runId,
      evidence: {
        exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutTruncated: stdout.length > 4000,
        stderrTruncated: stderr.length > 4000,
        artifactPath: artifact.path,
        artifactRelPath: artifact.relPath,
        pty: usePty,
        ...options.evidenceExtra
      }
    });
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Command executed",
    data: {
      command,
      exitCode,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stdoutTruncated: stdout.length > 4000,
      stderrTruncated: stderr.length > 4000,
      artifactPath: artifact.path,
      artifactRelPath: artifact.relPath,
      pty: usePty,
      ...options.evidenceExtra
    }
  });
  const summary = [
    `exit ${exitCode}`,
    stdout.length > 0 ? `stdout:\n${stdout.slice(0, 4000)}${stdout.length > 4000 ? "\n…(truncated)" : ""}` : "",
    stderr.length > 0 ? `stderr:\n${stderr.slice(0, 4000)}${stderr.length > 4000 ? "\n…(truncated)" : ""}` : ""
  ].filter(Boolean).join("\n\n") || `Command finished with exit ${exitCode}.`;
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
