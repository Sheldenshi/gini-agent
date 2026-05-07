// Task orchestrator. Knows how to:
//   - submit / retry / cancel a task (audit + lifecycle)
//   - dispatch a queued task to the right tool by sniffing the input prefix
//   - resolve an approval and run the side-effecting action
//
// The actual tool logic (file/web/terminal/code) lives in src/tools/*.
// Approval lifecycle helpers (completeLowRiskToolTask, executeApprovedAction)
// remain here because they are part of the orchestrator's contract with
// the rest of the runtime.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "bun";
import type { Approval, RuntimeConfig, RuntimeState, Task } from "./types";
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

export async function submitTask(config: RuntimeConfig, input: string, jobId?: string, parentTaskId?: string, subagentId?: string): Promise<Task> {
  const created = createTask(config.lane, input, jobId, parentTaskId, subagentId);
  await mutateState(config.lane, (state) => {
    upsertTask(state, created);
    const audit = addAudit(state, {
      actor: jobId ? "runtime" : "user",
      action: "task.submitted",
      target: created.id,
      risk: "low",
      taskId: created.id,
      evidence: { input, jobId, parentTaskId, subagentId }
    });
    created.auditIds.push(audit.id);
  });
  runTask(config, created.id).catch((error) => failTask(config, created.id, error));
  return created;
}

export async function retryTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  const task = await mutateState(config.lane, (state) => {
    const existing = findTask(state, taskId);
    const retry = createTask(config.lane, existing.input, existing.jobId, existing.parentTaskId, existing.subagentId);
    upsertTask(state, retry);
    addAudit(state, {
      actor: "user",
      action: "task.retry",
      target: retry.id,
      risk: "low",
      taskId: retry.id,
      evidence: { retriedTaskId: taskId }
    });
    return retry;
  });
  runTask(config, task.id).catch((error) => failTask(config, task.id, error));
  return task;
}

export async function cancelTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  return mutateState(config.lane, (state) => {
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
      taskId
    });
    upsertTask(state, task);
    return task;
  });
}

export async function runTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  let task = await mutateState(config.lane, (state) => {
    const item = findTask(state, taskId);
    item.status = "running";
    item.currentStep = "Thinking";
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });

  appendTrace(config.lane, taskId, { type: "task", message: "Task started", data: { input: task.input } });
  appendLog(config.lane, "task.started", { taskId });

  await Bun.sleep(10);
  const lower = task.input.toLowerCase();

  // Dispatch by input prefix. Each tool returns the resulting Task; high-risk
  // tools may have transitioned the task into waiting_approval.
  if (lower.startsWith("write ")) return requestFileWrite(config, task);
  if (lower.startsWith("patch ")) return requestFilePatch(config, task);
  if (lower.startsWith("read ")) return readFile(config, task);
  if (lower.startsWith("list ")) return listFiles(config, task);
  if (lower.startsWith("find ")) return searchFiles(config, task);
  if (lower.startsWith("web ")) return fetchWeb(config, task);
  if (lower.startsWith("code ")) return requestCodeExecution(config, task);
  if (lower.startsWith("shell ")) return requestShell(config, task);

  // No tool matched: fall through to provider summarization.
  const activeMemory = await mutateState(config.lane, (state) => state.memories.filter((memory) => memory.status === "active"));
  const providerResult = await generateTaskSummary(config, task.input, activeMemory);
  appendTrace(config.lane, taskId, {
    type: "model",
    message: `${providerResult.provider.name} provider generated response`,
    data: {
      provider: providerResult.provider,
      responseId: providerResult.responseId,
      usage: providerResult.usage,
      memoryUsed: activeMemory.map((memory) => memory.id)
    }
  });

  task = await mutateState(config.lane, (state) => {
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
      appendTrace(config.lane, taskId, { type: "memory", message: "Memory proposed", data: { memoryId: memory.id } });
    }
    item.status = "completed";
    item.currentStep = "Completed";
    item.summary = providerResult.text;
    item.cost = providerResult.cost;
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });

  appendTrace(config.lane, taskId, { type: "task", message: "Task completed", data: { summary: task.summary } });
  return task;
}

export async function failTask(config: RuntimeConfig, taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await mutateState(config.lane, (state) => {
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
      evidence: { error: message }
    });
  });
  appendTrace(config.lane, taskId, { type: "error", message, data: {} });
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
  return mutateState(config.lane, (state) => {
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
}

export async function decideApproval(config: RuntimeConfig, approvalId: string, decision: "approve" | "deny"): Promise<Approval> {
  const approval = await mutateState(config.lane, (state) => {
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
      approvalId: item.id
    });
    return item;
  });

  if (approval.taskId) {
    appendTrace(config.lane, approval.taskId, { type: "approval", message: `Approval ${approval.status}`, data: { approvalId } });
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
    await mutateState(config.lane, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "file.write",
        target: String(approval.payload.path),
        risk: "high",
        taskId: approval.taskId,
        approvalId: approval.id,
        evidence: { beforeBytes: before.length, afterBytes: String(approval.payload.content).length }
      });
      if (approval.taskId) completeApprovedTask(state, approval.taskId, "File write completed.");
    });
    if (approval.taskId) appendTrace(config.lane, approval.taskId, { type: "tool", message: "File written", data: { path: approval.payload.path } });
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
    await mutateState(config.lane, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "file.patch",
        target: String(approval.payload.path),
        risk: "high",
        taskId: approval.taskId,
        approvalId: approval.id,
        evidence: { diff: approval.payload.diff, beforeBytes: before.length, afterBytes: after.length }
      });
      if (approval.taskId) completeApprovedTask(state, approval.taskId, "File patch completed.");
    });
    if (approval.taskId) appendTrace(config.lane, approval.taskId, { type: "tool", message: "File patched", data: { path: approval.payload.path, diff: approval.payload.diff } });
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
    await mutateState(config.lane, (state) => {
      addAudit(state, {
        actor: "runtime",
        action: "terminal.exec",
        target: command,
        risk: "high",
        taskId: approval.taskId,
        approvalId: approval.id,
        evidence: { exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }
      });
      if (approval.taskId) completeApprovedTask(state, approval.taskId, exitCode === 0 ? "Command completed." : "Command failed.", exitCode === 0 ? undefined : stderr);
    });
    if (approval.taskId) appendTrace(config.lane, approval.taskId, { type: "tool", message: "Command executed", data: { command, exitCode } });
  }
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
