export type Lane = "dev" | "sandbox" | "production" | string;

export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type RiskLevel = "low" | "medium" | "high";

export type MemoryStatus = "proposed" | "active" | "archived" | "rejected" | "conflicted";

export type SkillStatus = "draft" | "trusted" | "disabled" | "archived";

export type JobStatus = "active" | "paused" | "failed";

export type ProviderName = "echo" | "openai" | "codex";

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface RuntimeConfig {
  lane: Lane;
  port: number;
  token: string;
  provider: ProviderConfig;
  workspaceRoot: string;
  stateRoot: string;
  logRoot: string;
}

export interface RuntimeState {
  version: 1;
  lane: Lane;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  approvals: Approval[];
  audit: AuditEvent[];
  memories: MemoryRecord[];
  skills: SkillRecord[];
  jobs: JobRecord[];
  connectors: ConnectorRecord[];
}

export interface Task {
  id: string;
  title: string;
  input: string;
  status: TaskStatus;
  lane: Lane;
  createdAt: string;
  updatedAt: string;
  currentStep?: string;
  summary?: string;
  error?: string;
  tracePath: string;
  auditIds: string[];
  approvalIds: string[];
  memoryIds: string[];
  skillIds: string[];
  jobId?: string;
}

export interface TraceRecord {
  id: string;
  taskId: string;
  lane: Lane;
  at: string;
  type: "task" | "model" | "tool" | "approval" | "memory" | "job" | "connector" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  lane: Lane;
  at: string;
  actor: "user" | "runtime" | "agent" | "system";
  action: string;
  target: string;
  risk: RiskLevel;
  taskId?: string;
  approvalId?: string;
  evidence?: Record<string, unknown>;
}

export interface Approval {
  id: string;
  lane: Lane;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  action: "file.write" | "terminal.exec" | "memory.activate" | "skill.trust" | "connector.enable";
  target: string;
  risk: RiskLevel;
  reason: string;
  payload: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  lane: Lane;
  content: string;
  scope: "user" | "project" | "device" | "temporary";
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  confidence: number;
  status: MemoryStatus;
  sensitivity: "normal" | "sensitive";
  provenance: string;
}

export interface SkillRecord {
  id: string;
  lane: Lane;
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  requiredTools: string[];
  requiredPermissions: string[];
  status: SkillStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface JobRecord {
  id: string;
  lane: Lane;
  name: string;
  prompt: string;
  intervalSeconds: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  runCount: number;
  missedRuns: number;
  taskIds: string[];
}

export interface ConnectorRecord {
  id: string;
  lane: Lane;
  name: string;
  kind: "demo" | "github" | string;
  status: "configured" | "disabled" | "error";
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  health: "unknown" | "healthy" | "unhealthy";
  message?: string;
}

export interface RuntimeStatus {
  ok: boolean;
  lane: Lane;
  port: number;
  stateRoot: string;
  pid?: number;
  taskCounts: Record<TaskStatus, number>;
  pendingApprovals: number;
  activeJobs: number;
  missedJobs: number;
  connectors: number;
}

export interface ProviderResult {
  provider: ProviderConfig;
  text: string;
  responseId?: string;
  usage?: Record<string, unknown>;
}
