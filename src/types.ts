export type Lane = "dev" | "sandbox" | "production" | string;

export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type RiskLevel = "low" | "medium" | "high";

export type MemoryStatus = "proposed" | "active" | "archived" | "rejected" | "conflicted";

export type SkillStatus = "draft" | "trusted" | "disabled" | "archived";

export type JobStatus = "active" | "paused" | "failed";

export type ProviderName = "echo" | "openai" | "codex" | "openrouter" | "local";

export type ImprovementStatus = "proposed" | "approved" | "rejected" | "applied";

export type ImprovementKind = "memory" | "skill" | "job";

export type PairingStatus = "pending" | "claimed" | "expired" | "revoked";

export type DeviceStatus = "active" | "revoked";

export type PromotionStatus = "proposed" | "approved" | "rejected";

export type ToolStatus = "available" | "disabled" | "error";

export type ToolsetStatus = "enabled" | "disabled";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type McpServerStatus = "configured" | "disabled" | "error";

export type MessagingBridgeStatus = "configured" | "disabled" | "error";

export type ImportSource = "hermes" | "openclaw";

export type ProfileStatus = "active" | "inactive";

export type RelayStatus = "disabled" | "configured" | "degraded" | "error";

export type NotificationStatus = "queued" | "sent" | "failed" | "acknowledged";

export type RuntimeEventKind =
  | "task"
  | "approval"
  | "job"
  | "memory"
  | "skill"
  | "connector"
  | "mcp"
  | "messaging"
  | "provider"
  | "runtime"
  | "notification";

export type JobRunStatus = "running" | "completed" | "failed";

export type ChatMessageRole = "user" | "assistant" | "system";

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
  improvements: ImprovementProposal[];
  pairingCodes: PairingCode[];
  devices: PairedDevice[];
  promotions: PromotionProposal[];
  snapshots: SnapshotRecord[];
  tools: ToolRecord[];
  toolsets: ToolsetRecord[];
  subagents: SubagentRecord[];
  mcpServers: McpServerRecord[];
  messagingBridges: MessagingBridgeRecord[];
  importReports: ImportReport[];
  profiles: ProfileRecord[];
  activeProfileId?: string;
  relays: RelayRecord[];
  notifications: NotificationRecord[];
  events: RuntimeEvent[];
  jobRuns: JobRunRecord[];
  chatSessions: ChatSessionRecord[];
  chatMessages: ChatMessageRecord[];
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
  parentTaskId?: string;
  subagentId?: string;
  cost?: CostRecord;
}

export interface RuntimeEvent {
  id: string;
  lane: Lane;
  at: string;
  kind: RuntimeEventKind;
  action: string;
  target: string;
  taskId?: string;
  jobId?: string;
  risk: RiskLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface ChatSessionRecord {
  id: string;
  lane: Lane;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  summary?: string;
}

export interface ChatMessageRecord {
  id: string;
  lane: Lane;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  taskId?: string;
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

export interface ToolRecord {
  id: string;
  lane: Lane;
  name: string;
  description: string;
  toolset: string;
  status: ToolStatus;
  risk: RiskLevel;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolsetRecord {
  id: string;
  lane: Lane;
  name: string;
  description: string;
  status: ToolsetStatus;
  toolNames: string[];
  scopes: Array<"task" | "job" | "skill" | "subagent" | "mcp" | "messaging">;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRecord {
  id: string;
  lane: Lane;
  name: string;
  prompt: string;
  status: SubagentStatus;
  parentTaskId?: string;
  taskId?: string;
  toolsets: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  summary?: string;
}

export interface McpServerRecord {
  id: string;
  lane: Lane;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  status: McpServerStatus;
  exposedTools: string[];
  lastHealthAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingBridgeRecord {
  id: string;
  lane: Lane;
  name: string;
  kind: "telegram" | "discord" | "slack" | "email" | "imessage" | "demo" | string;
  status: MessagingBridgeStatus;
  deliveryTargets: string[];
  lastHealthAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportReport {
  id: string;
  lane: Lane;
  source: ImportSource;
  path: string;
  mode: "inspect";
  status: "completed" | "failed";
  counts: Record<string, number>;
  findings: string[];
  createdAt: string;
  error?: string;
}

export interface SessionSearchResult {
  id: string;
  lane: Lane;
  kind: "task" | "trace" | "memory" | "skill" | "audit";
  score: number;
  title: string;
  excerpt: string;
  taskId?: string;
  traceId?: string;
  source: string;
  at: string;
}

export interface ProviderCatalogItem {
  id: string;
  name: ProviderName | "openrouter" | "local" | string;
  displayName: string;
  baseUrl?: string;
  auth: "none" | "env" | "codex-oauth";
  models: string[];
  capabilities: string[];
  costHint: "free" | "external" | "unknown";
}

export interface ProfileRecord {
  id: string;
  lane: Lane;
  name: string;
  status: ProfileStatus;
  providerName?: ProviderName | "openrouter" | "local";
  model?: string;
  toolsets: string[];
  memoryScopes: Array<"user" | "project" | "device" | "temporary">;
  messagingTargets: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ParityCheck {
  id: string;
  label: string;
  status: "pass" | "partial" | "missing";
  evidence: string[];
  requiredForV1: boolean;
}

export interface RelayRecord {
  id: string;
  lane: Lane;
  name: string;
  endpoint: string;
  status: RelayStatus;
  mode: "local-only" | "lan" | "hosted";
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  message?: string;
}

export interface NotificationRecord {
  id: string;
  lane: Lane;
  kind: "approval" | "job" | "task" | "runtime" | "promotion";
  title: string;
  body: string;
  status: NotificationStatus;
  target: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  error?: string;
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
  action: "file.write" | "file.patch" | "terminal.exec" | "memory.activate" | "skill.trust" | "connector.enable";
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
  sourceTaskId?: string;
  tests: string[];
  successCount: number;
  failureCount: number;
  previousVersions: SkillVersion[];
}

export interface SkillVersion {
  version: number;
  updatedAt: string;
  description: string;
  trigger: string;
  steps: string[];
  requiredTools: string[];
  requiredPermissions: string[];
}

export interface JobRecord {
  id: string;
  lane: Lane;
  name: string;
  prompt: string;
  script?: string;
  intervalSeconds: number;
  status: JobStatus;
  deliveryTargets: string[];
  context: string[];
  retryLimit: number;
  timeoutSeconds: number;
  costBudget?: number;
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
  runIds: string[];
}

export interface JobRunRecord {
  id: string;
  lane: Lane;
  jobId: string;
  status: JobRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  attempt: number;
  trigger: "schedule" | "manual" | "replay";
  summary?: string;
  error?: string;
  cost?: CostRecord;
}

export interface CostRecord {
  provider: ProviderName | string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
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

export interface ImprovementProposal {
  id: string;
  lane: Lane;
  kind: ImprovementKind;
  status: ImprovementStatus;
  title: string;
  rationale: string;
  sourceTaskId?: string;
  sourceTraceIds: string[];
  payload: Record<string, unknown>;
  appliedTargetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PairingCode {
  id: string;
  lane: Lane;
  codeHash: string;
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedByDeviceId?: string;
}

export interface PairedDevice {
  id: string;
  lane: Lane;
  name: string;
  tokenHash: string;
  status: DeviceStatus;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface PromotionProposal {
  id: string;
  lane: Lane;
  status: PromotionStatus;
  candidateRef: string;
  evidencePath?: string;
  summary: string;
  rollbackPlan: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface SnapshotRecord {
  id: string;
  lane: Lane;
  path: string;
  reason: string;
  createdAt: string;
  taskCount: number;
  auditCount: number;
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
  cost?: CostRecord;
}
