import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  Approval,
  AuditEvent,
  ConnectorRecord,
  ImprovementProposal,
  JobRecord,
  Lane,
  MemoryRecord,
  RuntimeState,
  SkillRecord,
  Task,
  TraceRecord
} from "./types";
import { ensureDir, laneRoot, logDir, statePath, traceDir } from "./paths";

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createEmptyState(lane: Lane): RuntimeState {
  const at = now();
  return {
    version: 1,
    lane,
    createdAt: at,
    updatedAt: at,
    tasks: [],
    approvals: [],
    audit: [],
    memories: [],
    skills: [],
    jobs: [],
    connectors: [
      {
        id: "conn_demo",
        lane,
        name: "Demo Connector",
        kind: "demo",
        status: "configured",
        scopes: ["demo:read"],
        createdAt: at,
        updatedAt: at,
        health: "unknown"
      }
    ],
    improvements: []
  };
}

export function readState(lane: Lane): RuntimeState {
  ensureDir(laneRoot(lane));
  const path = statePath(lane);
  if (!existsSync(path)) {
    const state = createEmptyState(lane);
    writeState(lane, state);
    return state;
  }
  const state = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
  return normalizeState(lane, state);
}

export function writeState(lane: Lane, state: RuntimeState): void {
  ensureDir(laneRoot(lane));
  state.updatedAt = now();
  const path = statePath(lane);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, path);
}

export function mutateState<T>(lane: Lane, fn: (state: RuntimeState) => T): T {
  const state = readState(lane);
  const result = fn(state);
  writeState(lane, state);
  return result;
}

export function appendTrace(lane: Lane, taskId: string, record: Omit<TraceRecord, "id" | "taskId" | "lane" | "at">): TraceRecord {
  ensureDir(traceDir(lane));
  const trace: TraceRecord = {
    id: id("trace"),
    taskId,
    lane,
    at: now(),
    ...record
  };
  const path = tracePath(lane, taskId);
  const line = `${JSON.stringify(trace)}\n`;
  writeFileSync(path, line, { flag: "a" });
  return trace;
}

export function readTrace(lane: Lane, taskId: string): TraceRecord[] {
  const path = tracePath(lane, taskId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRecord);
}

export function tracePath(lane: Lane, taskId: string): string {
  return join(traceDir(lane), `${taskId}.jsonl`);
}

export function appendLog(lane: Lane, message: string, data?: Record<string, unknown>): void {
  ensureDir(logDir(lane));
  writeFileSync(
    join(logDir(lane), "runtime.jsonl"),
    `${JSON.stringify({ at: now(), lane, message, data })}\n`,
    { flag: "a" }
  );
}

export function taskCounts(tasks: Task[]): Record<Task["status"], number> {
  return {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    waiting_approval: tasks.filter((task) => task.status === "waiting_approval").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length
  };
}

export function addAudit(state: RuntimeState, event: Omit<AuditEvent, "id" | "lane" | "at">): AuditEvent {
  const audit: AuditEvent = {
    id: id("audit"),
    lane: state.lane,
    at: now(),
    ...event
  };
  state.audit.unshift(audit);
  return audit;
}

export function upsertTask(state: RuntimeState, task: Task): Task {
  const index = state.tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  return task;
}

export function createTask(lane: Lane, input: string, jobId?: string): Task {
  const at = now();
  const taskId = id("task");
  return {
    id: taskId,
    title: input.slice(0, 80) || "Untitled task",
    input,
    status: "queued",
    lane,
    createdAt: at,
    updatedAt: at,
    tracePath: tracePath(lane, taskId),
    auditIds: [],
    approvalIds: [],
    memoryIds: [],
    skillIds: [],
    jobId
  };
}

export function createApproval(state: RuntimeState, approval: Omit<Approval, "id" | "lane" | "status" | "createdAt" | "updatedAt">): Approval {
  const at = now();
  const item: Approval = {
    id: id("approval"),
    lane: state.lane,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...approval
  };
  state.approvals.unshift(item);
  addAudit(state, {
    actor: "runtime",
    action: "approval.requested",
    target: item.target,
    risk: item.risk,
    taskId: item.taskId,
    approvalId: item.id,
    evidence: { action: item.action, reason: item.reason }
  });
  return item;
}

export function createMemory(state: RuntimeState, memory: Omit<MemoryRecord, "id" | "lane" | "createdAt" | "updatedAt">): MemoryRecord {
  const at = now();
  const item: MemoryRecord = {
    id: id("mem"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    ...memory
  };
  state.memories.unshift(item);
  return item;
}

export function createSkill(state: RuntimeState, skill: Omit<SkillRecord, "id" | "lane" | "createdAt" | "updatedAt" | "version">): SkillRecord {
  const at = now();
  const item: SkillRecord = {
    id: id("skill"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...skill
  };
  state.skills.unshift(item);
  return item;
}

export function createJob(state: RuntimeState, job: Omit<JobRecord, "id" | "lane" | "createdAt" | "updatedAt" | "status" | "lastRunAt" | "lastSuccessAt" | "lastFailureAt" | "lastError" | "runCount" | "missedRuns" | "taskIds">): JobRecord {
  const at = now();
  const item: JobRecord = {
    id: id("job"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    status: "active",
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    ...job
  };
  state.jobs.unshift(item);
  return item;
}

export function createImprovementProposal(
  state: RuntimeState,
  proposal: Omit<ImprovementProposal, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): ImprovementProposal {
  const at = now();
  const item: ImprovementProposal = {
    id: id("impr"),
    lane: state.lane,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.improvements.unshift(item);
  addAudit(state, {
    actor: "agent",
    action: "improvement.proposed",
    target: item.id,
    risk: "medium",
    taskId: item.sourceTaskId,
    evidence: { kind: item.kind, sourceTraceIds: item.sourceTraceIds }
  });
  return item;
}

export function updateConnectorHealth(connector: ConnectorRecord): ConnectorRecord {
  connector.lastHealthAt = now();
  connector.health = connector.status === "configured" ? "healthy" : "unhealthy";
  connector.message = connector.kind === "demo" ? "Demo connector is available without secrets." : connector.message;
  connector.updatedAt = now();
  return connector;
}

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, targetPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${targetPath}`);
  }
  return target;
}

function normalizeState(lane: Lane, state: RuntimeState): RuntimeState {
  state.lane = lane;
  state.improvements ??= [];
  state.connectors ??= [];
  state.tasks ??= [];
  state.approvals ??= [];
  state.audit ??= [];
  state.memories ??= [];
  state.skills ??= [];
  state.jobs ??= [];
  return state;
}
