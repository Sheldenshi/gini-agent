import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "bun";
import type { Approval, RuntimeConfig, RuntimeState, Task } from "./types";
import {
  addAudit,
  appendLog,
  appendTrace,
  assertInsideWorkspace,
  createApproval,
  createTask,
  createMemory,
  mutateState,
  now,
  upsertTask
} from "./state";
import { generateTaskSummary } from "./provider";

export function submitTask(config: RuntimeConfig, input: string, jobId?: string): Task {
  const created = createTask(config.lane, input, jobId);
  mutateState(config.lane, (state) => {
    upsertTask(state, created);
    const audit = addAudit(state, {
      actor: jobId ? "runtime" : "user",
      action: "task.submitted",
      target: created.id,
      risk: "low",
      taskId: created.id,
      evidence: { input, jobId }
    });
    created.auditIds.push(audit.id);
  });
  runTask(config, created.id).catch((error) => failTask(config, created.id, error));
  return created;
}

export async function runTask(config: RuntimeConfig, taskId: string): Promise<Task> {
  let task = mutateState(config.lane, (state) => {
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

  if (lower.startsWith("write ")) {
    return requestFileWrite(config, task);
  }
  if (lower.startsWith("shell ")) {
    return requestShell(config, task);
  }

  const activeMemory = mutateState(config.lane, (state) => state.memories.filter((memory) => memory.status === "active"));
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

  task = mutateState(config.lane, (state) => {
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
    item.updatedAt = now();
    upsertTask(state, item);
    return item;
  });

  appendTrace(config.lane, taskId, { type: "task", message: "Task completed", data: { summary: task.summary } });
  return task;
}

export async function failTask(config: RuntimeConfig, taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  mutateState(config.lane, (state) => {
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

function requestFileWrite(config: RuntimeConfig, task: Task): Task {
  const match = task.input.match(/^write\s+(.+?)\s*::\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: write <relative-path> :: <content>");
  const [, target, content] = match;
  assertInsideWorkspace(config.workspaceRoot, target);
  return mutateState(config.lane, (state) => {
    const item = findTask(state, task.id);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.write",
      target,
      risk: "high",
      reason: "File writes are side effects and require explicit approval.",
      payload: { path: target, content }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.lane, item.id, { type: "approval", message: "Approval requested for file write", data: { approvalId: approval.id, target } });
    return item;
  });
}

function requestShell(config: RuntimeConfig, task: Task): Task {
  const command = task.input.replace(/^shell\s+/i, "").trim();
  return mutateState(config.lane, (state) => {
    const item = findTask(state, task.id);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "Terminal execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs: 10_000 }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.lane, item.id, { type: "approval", message: "Approval requested for terminal command", data: { approvalId: approval.id, command } });
    return item;
  });
}

export async function decideApproval(config: RuntimeConfig, approvalId: string, decision: "approve" | "deny"): Promise<Approval> {
  const approval = mutateState(config.lane, (state) => {
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
    mutateState(config.lane, (state) => {
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
    mutateState(config.lane, (state) => {
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

function findTask(state: RuntimeState, taskId: string): Task {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}
