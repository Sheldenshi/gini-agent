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
import { recall, retain } from "./domain/memory";
import { updateRunFromTask } from "./domain/runs";

export async function submitTask(config: RuntimeConfig, input: string, jobId?: string, parentTaskId?: string, subagentId?: string, runId?: string): Promise<Task> {
  const created = createTask(config.instance, input, jobId, parentTaskId, subagentId, runId);
  await mutateState(config.instance, (state) => {
    upsertTask(state, created);
    const audit = addAudit(state, {
      actor: jobId ? "runtime" : "user",
      action: "task.submitted",
      target: created.id,
      risk: "low",
      taskId: created.id,
      runId,
      evidence: { input, jobId, parentTaskId, subagentId, runId }
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
    upsertTask(state, task);
    return task;
  });
  await updateRunFromTask(config, task);
  return task;
}

export async function runTask(config: RuntimeConfig, taskId: string): Promise<Task> {
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
  // tools may have transitioned the task into waiting_approval.
  if (lower.startsWith("write ")) return finishTaskTransition(config, await requestFileWrite(config, task));
  if (lower.startsWith("patch ")) return finishTaskTransition(config, await requestFilePatch(config, task));
  if (lower.startsWith("read ")) return finishTaskTransition(config, await readFile(config, task));
  if (lower.startsWith("list ")) return finishTaskTransition(config, await listFiles(config, task));
  if (lower.startsWith("find ")) return finishTaskTransition(config, await searchFiles(config, task));
  if (lower.startsWith("web ")) return finishTaskTransition(config, await fetchWeb(config, task));
  if (lower.startsWith("code ")) return finishTaskTransition(config, await requestCodeExecution(config, task));
  if (lower.startsWith("shell ")) return finishTaskTransition(config, await requestShell(config, task));

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

  const providerResult = await generateTaskSummary(config, task.input, activeMemory, recalledContext);
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

  // Hindsight phase 5: auto-retain. Run async and don't block task completion.
  // The extractor decides whether anything factual is in the input — we only
  // pre-skip obvious tool invocations (read/list/find). Best-effort: log but
  // don't fail.
  void scheduleAutoRetain(config, task);

  return task;
}

async function finishTaskTransition(config: RuntimeConfig, task: Task): Promise<Task> {
  await updateRunFromTask(config, task);
  return task;
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
      if (approval.taskId) completeApprovedTask(state, approval.taskId, "File write completed.");
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File written", data: { path: approval.payload.path } });
    if (task) await updateRunFromTask(config, task);
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
      if (approval.taskId) completeApprovedTask(state, approval.taskId, "File patch completed.");
      return approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : undefined;
    });
    if (approval.taskId) appendTrace(config.instance, approval.taskId, { type: "tool", message: "File patched", data: { path: approval.payload.path, diff: approval.payload.diff } });
    if (task) await updateRunFromTask(config, task);
    return;
  }

  if (approval.action === "terminal.exec") {
    const command = String(approval.payload.command);
    const proc = spawn(["zsh", "-lc", command], {
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
          artifactRelPath: artifact?.relPath
        }
      });
      if (approval.taskId) completeApprovedTask(state, approval.taskId, exitCode === 0 ? "Command completed." : "Command failed.", exitCode === 0 ? undefined : stderr);
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
  }
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
