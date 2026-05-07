// File tools: read/list/search are immediate-execution; write/patch raise an
// approval and pause the task until decideApproval runs.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import {
  appendTrace,
  assertInsideWorkspace,
  createApproval,
  mutateState,
  now
} from "../state";
import { completeLowRiskToolTask, findTask } from "../agent";

export async function readFile(config: RuntimeConfig, task: Task): Promise<Task> {
  const target = task.input.replace(/^read\s+/i, "").trim();
  if (!target) throw new Error("Use: read <relative-path>");
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
  const content = readFileSync(path, "utf8").slice(0, 12_000);
  appendTrace(config.lane, task.id, { type: "tool", message: "File read", data: { path: target, bytes: content.length } });
  return completeLowRiskToolTask(config, task.id, `Read ${target}\n\n${content}`, "file.read", target, { bytes: content.length });
}

export async function listFiles(config: RuntimeConfig, task: Task): Promise<Task> {
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

export async function searchFiles(config: RuntimeConfig, task: Task): Promise<Task> {
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

export async function requestFileWrite(config: RuntimeConfig, task: Task): Promise<Task> {
  const match = task.input.match(/^write\s+(.+?)\s*::\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: write <relative-path> :: <content>");
  const [, target, content] = match;
  assertInsideWorkspace(config.workspaceRoot, target);
  return mutateState(config.lane, (state: RuntimeState) => {
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

export async function requestFilePatch(config: RuntimeConfig, task: Task): Promise<Task> {
  const match = task.input.match(/^patch\s+(.+?)\s*::\s*([\s\S]+?)\s*=>\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: patch <relative-path> :: <old-text> => <new-text>");
  const [, target, oldText, newText] = match;
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  if (!existsSync(path)) throw new Error(`Cannot patch missing file: ${target}`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(oldText)) throw new Error(`Patch target text not found in ${target}`);
  const after = before.replace(oldText, newText);
  return mutateState(config.lane, (state: RuntimeState) => {
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

export function walkFiles(workspaceRoot: string, root: string, limit: number): string[] {
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

export function simpleDiff(oldText: string, newText: string): string {
  return [`--- before`, `+++ after`, ...oldText.split(/\r?\n/).map((line) => `-${line}`), ...newText.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
}
