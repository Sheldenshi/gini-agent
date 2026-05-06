import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
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

export function submitTask(config: RuntimeConfig, input: string, jobId?: string, parentTaskId?: string, subagentId?: string): Task {
  const created = createTask(config.lane, input, jobId, parentTaskId, subagentId);
  mutateState(config.lane, (state) => {
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

export function retryTask(config: RuntimeConfig, taskId: string): Task {
  const task = mutateState(config.lane, (state) => {
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

export function cancelTask(config: RuntimeConfig, taskId: string): Task {
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
  if (lower.startsWith("patch ")) {
    return requestFilePatch(config, task);
  }
  if (lower.startsWith("read ")) {
    return readFile(config, task);
  }
  if (lower.startsWith("list ")) {
    return listFiles(config, task);
  }
  if (lower.startsWith("find ")) {
    return searchFiles(config, task);
  }
  if (lower.startsWith("web ")) {
    return fetchWeb(config, task);
  }
  if (lower.startsWith("code ")) {
    return requestCodeExecution(config, task);
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

function requestFilePatch(config: RuntimeConfig, task: Task): Task {
  const match = task.input.match(/^patch\s+(.+?)\s*::\s*([\s\S]+?)\s*=>\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: patch <relative-path> :: <old-text> => <new-text>");
  const [, target, oldText, newText] = match;
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  if (!existsSync(path)) throw new Error(`Cannot patch missing file: ${target}`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(oldText)) throw new Error(`Patch target text not found in ${target}`);
  const after = before.replace(oldText, newText);
  return mutateState(config.lane, (state) => {
    const item = findTask(state, task.id);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "file.patch",
      target,
      risk: "high",
      reason: "File patches are side effects and require explicit approval.",
      payload: { path: target, oldText, newText, diff: simpleDiff(oldText, newText), beforeBytes: before.length, afterBytes: after.length }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.lane, item.id, { type: "approval", message: "Approval requested for file patch", data: { approvalId: approval.id, target, diff: approval.payload.diff } });
    return item;
  });
}

function readFile(config: RuntimeConfig, task: Task): Task {
  const target = task.input.replace(/^read\s+/i, "").trim();
  if (!target) throw new Error("Use: read <relative-path>");
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
  const content = readFileSync(path, "utf8").slice(0, 12_000);
  appendTrace(config.lane, task.id, { type: "tool", message: "File read", data: { path: target, bytes: content.length } });
  return completeLowRiskToolTask(config, task.id, `Read ${target}\n\n${content}`, "file.read", target, { bytes: content.length });
}

function listFiles(config: RuntimeConfig, task: Task): Task {
  const target = task.input.replace(/^list\s+/i, "").trim() || ".";
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  const entries = readdirSync(path)
    .slice(0, 200)
    .map((entry) => {
      const full = join(path, entry);
      const stat = statSync(full);
      return `${stat.isDirectory() ? "dir " : "file"} ${relative(config.workspaceRoot, full)}`;
    });
  appendTrace(config.lane, task.id, { type: "tool", message: "Directory listed", data: { path: target, entries: entries.length } });
  return completeLowRiskToolTask(config, task.id, entries.join("\n") || "No entries.", "file.list", target, { entries: entries.length });
}

function searchFiles(config: RuntimeConfig, task: Task): Task {
  const [, rawPattern = "", rawDir = "."] = task.input.match(/^find\s+(.+?)(?:\s+in\s+(.+))?$/i) ?? [];
  const pattern = rawPattern.trim();
  if (!pattern) throw new Error("Use: find <pattern> [in relative-dir]");
  const root = assertInsideWorkspace(config.workspaceRoot, rawDir.trim() || ".");
  const matches: string[] = [];
  for (const file of walkFiles(config.workspaceRoot, root, 300)) {
    if (matches.length >= 100) break;
    if (!isTextLike(file)) continue;
    const content = readFileSync(file, "utf8");
    const line = content.split(/\r?\n/).findIndex((value) => value.toLowerCase().includes(pattern.toLowerCase()));
    if (line >= 0) matches.push(`${relative(config.workspaceRoot, file)}:${line + 1}`);
  }
  appendTrace(config.lane, task.id, { type: "tool", message: "Files searched", data: { pattern, dir: rawDir, matches: matches.length } });
  return completeLowRiskToolTask(config, task.id, matches.join("\n") || "No matches.", "file.search", pattern, { matches: matches.length });
}

async function fetchWeb(config: RuntimeConfig, task: Task): Promise<Task> {
  const rawUrl = task.input.replace(/^web\s+/i, "").trim();
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Use: web <http-or-https-url>");
  const response = await fetch(parsed);
  const text = (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12_000);
  appendTrace(config.lane, task.id, { type: "tool", message: "Web page fetched", data: { url: parsed.toString(), status: response.status, bytes: text.length } });
  return completeLowRiskToolTask(config, task.id, text || `Fetched ${parsed.toString()} with HTTP ${response.status}.`, "web.fetch", parsed.toString(), { status: response.status, bytes: text.length });
}

function requestCodeExecution(config: RuntimeConfig, task: Task): Task {
  const match = task.input.match(/^code\s+(\w+)\s*::\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: code js|python :: <code>");
  const [, language, code] = match;
  return mutateState(config.lane, (state) => {
    const item = findTask(state, task.id);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: "Code execution can change the system and requires explicit approval.",
      payload: { command: codeExecutionCommand(language, code), timeoutMs: 10_000 }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.lane, item.id, { type: "approval", message: "Approval requested for code execution", data: { approvalId: approval.id, language } });
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

function completeLowRiskToolTask(config: RuntimeConfig, taskId: string, summary: string, action: string, target: string, evidence: Record<string, unknown>): Task {
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

function walkFiles(workspaceRoot: string, root: string, limit: number): string[] {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift()!;
    const stat = statSync(current);
    if (stat.isFile()) {
      files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".git" || entry.startsWith(".gini")) continue;
      const full = join(current, entry);
      assertInsideWorkspace(workspaceRoot, relative(workspaceRoot, full));
      queue.push(full);
    }
  }
  return files;
}

function isTextLike(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ["", ".ts", ".js", ".json", ".md", ".txt", ".html", ".css", ".yml", ".yaml"].includes(ext);
}

function codeExecutionCommand(language: string, code: string): string {
  if (language === "js" || language === "ts") {
    return `bun -e ${JSON.stringify(code)}`;
  }
  if (language === "python" || language === "py") {
    return `python3 - <<'PY'\n${code}\nPY`;
  }
  throw new Error(`Unsupported code language: ${language}`);
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

  if (approval.action === "file.patch") {
    const target = assertInsideWorkspace(config.workspaceRoot, String(approval.payload.path));
    const before = readFileSync(target, "utf8");
    const oldText = String(approval.payload.oldText);
    const newText = String(approval.payload.newText);
    if (!before.includes(oldText)) throw new Error(`Patch target text no longer exists: ${approval.payload.path}`);
    const after = before.replace(oldText, newText);
    writeFileSync(target, after);
    mutateState(config.lane, (state) => {
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

function simpleDiff(oldText: string, newText: string): string {
  return [`--- before`, `+++ after`, ...oldText.split(/\r?\n/).map((line) => `-${line}`), ...newText.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
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
