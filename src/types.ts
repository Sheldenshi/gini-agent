export type Instance = "dev" | "sandbox" | "production" | string;

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

export type AgentStatus = "active" | "inactive";

export type RelayStatus = "disabled" | "configured" | "degraded" | "error";

export type NotificationStatus = "queued" | "sent" | "failed" | "acknowledged";
export type MessagingMessageStatus = "received" | "queued" | "sent" | "failed";

export type RuntimeEventKind =
  | "run"
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

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type RunKind = "conversation_turn" | "task" | "job" | "subagent" | "direct";

export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface RuntimeConfig {
  instance: Instance;
  port: number;
  token: string;
  provider: ProviderConfig;
  workspaceRoot: string;
  stateRoot: string;
  logRoot: string;
  // User-curated allowlist of shell-glob patterns that bypass the approval
  // gate for terminal_exec. Patterns match the full command string (e.g.
  // `memo *` matches any command starting with "memo "). Auto-approved
  // executions still write a `terminal.exec` audit row with
  // evidence.autoApproved=true plus the matched pattern, so the activity
  // trail stays intact. Empty / undefined means no auto-approval.
  autoApproveCommands?: string[];
}

export interface RuntimeState {
  version: 1;
  instance: Instance;
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
  agents: AgentRecord[];
  activeAgentId?: string;
  relays: RelayRecord[];
  notifications: NotificationRecord[];
  events: RuntimeEvent[];
  jobRuns: JobRunRecord[];
  chatSessions: ChatSessionRecord[];
  chatMessages: ChatMessageRecord[];
  messagingMessages: MessagingMessageRecord[];
  runs: RunRecord[];
  planSteps: PlanStepRecord[];
}

export type TaskMode = "chat" | "imperative";

// A pending tool call captured by the chat-task loop while waiting for an
// approval to resolve. Stored on the task so the loop can resume after the
// approval completes without re-running the model. `result` is filled in by
// the approval execution path (e.g. file write succeeded, command output).
export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  approvalId: string;
  result?: string;
}

// Snapshot of the tool-calling conversation needed to resume the loop after
// an approval gates a tool. We persist enough context that the runtime can
// pick up where it left off when the user approves/denies.
export interface TaskToolCallState {
  // OpenAI-shaped messages array (system, user, assistant w/ tool_calls,
  // tool result messages). We keep `unknown[]` to avoid pulling provider
  // shape into the central type module.
  messages: unknown[];
  // Stable identifier for the tool catalog used during this loop. If it
  // changes between iterations (toolset toggled, skill loaded), we don't
  // assume the prior catalog still applies.
  toolsHash: string;
  // Tool calls awaiting approval. When all of these have results filled in,
  // the loop resumes.
  pending: PendingToolCall[];
  // Iteration counter (capped to prevent runaway loops).
  iterations: number;
}

export interface Task {
  id: string;
  title: string;
  input: string;
  status: TaskStatus;
  instance: Instance;
  createdAt: string;
  updatedAt: string;
  currentStep?: string;
  summary?: string;
  // Live partial assistant text streamed from the provider while the task is
  // running. Cleared/ignored once `summary` is set on completion. Surfaced to
  // the chat UI as a synthesized streaming assistant message so the user sees
  // text mid-flight instead of waiting for the buffered final response.
  partialSummary?: string;
  error?: string;
  tracePath: string;
  auditIds: string[];
  approvalIds: string[];
  memoryIds: string[];
  skillIds: string[];
  jobId?: string;
  parentTaskId?: string;
  subagentId?: string;
  runId?: string;
  cost?: CostRecord;
  // Execution mode. "chat" routes through the tool-calling agent loop in
  // src/execution/chat-task.ts. "imperative" preserves the legacy CLI
  // prefix-dispatch behavior. Defaults to "imperative" for back-compat.
  mode?: TaskMode;
  // Resume state for the chat-task loop while waiting on an approval. Cleared
  // once the loop finishes (completed/failed) so completed tasks don't retain
  // long-lived conversation snapshots in state.
  toolCallState?: TaskToolCallState;
}

export interface RuntimeEvent {
  id: string;
  instance: Instance;
  at: string;
  kind: RuntimeEventKind;
  action: string;
  target: string;
  taskId?: string;
  jobId?: string;
  runId?: string;
  risk: RiskLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  instance: Instance;
  kind: RunKind;
  status: RunStatus;
  title: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  taskId?: string;
  jobId?: string;
  parentRunId?: string;
  subagentId?: string;
  planStepIds: string[];
  childRunIds: string[];
  approvalIds: string[];
  summary?: string;
  error?: string;
  cost?: CostRecord;
}

export interface PlanStepRecord {
  id: string;
  instance: Instance;
  runId: string;
  title: string;
  status: PlanStepStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  subagentId?: string;
  summary?: string;
  error?: string;
}

export interface ChatSessionRecord {
  id: string;
  instance: Instance;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  runIds: string[];
  summary?: string;
}

export interface ChatMessageRecord {
  id: string;
  instance: Instance;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
}

export interface TraceRecord {
  id: string;
  taskId: string;
  instance: Instance;
  at: string;
  type: "task" | "model" | "tool" | "approval" | "memory" | "job" | "connector" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolRecord {
  id: string;
  instance: Instance;
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
  instance: Instance;
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
  instance: Instance;
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
  // Slice 4 extensions: subagents now run a real constrained agent loop.
  // The system prompt overrides the parent's default Gini preamble for the
  // child task so the subagent has its own narrower instructions.
  systemPrompt: string;
  // Restricted toolset whitelist (names matching state.toolsets[].name). When
  // omitted/empty, the child inherits the parent's toolset world. When set,
  // only tools belonging to one of these toolsets are exposed (skill catalog
  // tools like read_skill stay always-on).
  toolsetIds?: string[];
  // Trusted skill name whitelist. When omitted/empty, the child sees every
  // trusted skill the parent could see. When set, the "Available skills:"
  // block in the system prompt is filtered down to this subset.
  skillNames?: string[];
  // Convenience mirror of the populated child task's summary/error so the
  // parent (or UI) can read terminal results off the subagent record without
  // joining against the task table.
  resultSummary?: string;
  resultError?: string;
}

export interface McpServerRecord {
  id: string;
  instance: Instance;
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
  instance: Instance;
  name: string;
  kind: "telegram" | "discord" | "slack" | "email" | "imessage" | "demo" | string;
  status: MessagingBridgeStatus;
  deliveryTargets: string[];
  lastHealthAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingMessageRecord {
  id: string;
  instance: Instance;
  bridgeId: string;
  direction: "inbound" | "outbound";
  status: MessagingMessageStatus;
  target: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  notificationId?: string;
  error?: string;
}

export interface ImportReport {
  id: string;
  instance: Instance;
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
  instance: Instance;
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

export interface AgentRecord {
  id: string;
  instance: Instance;
  name: string;
  status: AgentStatus;
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
  instance: Instance;
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
  instance: Instance;
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
  instance: Instance;
  at: string;
  actor: "user" | "runtime" | "agent" | "system";
  action: string;
  target: string;
  risk: RiskLevel;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  evidence?: Record<string, unknown>;
}

export interface Approval {
  id: string;
  instance: Instance;
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
  instance: Instance;
  // Phase C — per-agent isolation key. Optional in the type because legacy
  // state files persisted before Phase C don't carry it; normalizeState
  // backfills these by stamping the active agent at migration time.
  // `scope` is kept as an in-agent tag for the user's own organization;
  // `agentId` is the isolation boundary.
  agentId?: string;
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
  // Hindsight phase 6: bag for migration breadcrumbs (e.g.
  // `migratedToUnitId`). Stays optional so old persisted state files don't
  // break — readState tolerates missing fields.
  metadata?: Record<string, unknown>;
}

export interface SkillRecord {
  id: string;
  instance: Instance;
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
  // Filesystem-loaded skills carry their full markdown body (the part of the
  // SKILL.md file after the YAML frontmatter). Legacy CRUD-created skills
  // default to "" — present-but-empty so callers can rely on the field being
  // a string. The body is what gets fed back to the model when it asks to
  // "read" the skill via the read_skill tool.
  body: string;
  // Origin file path (absolute) for skills loaded from disk. Useful for
  // traceability and re-load detection. Optional because legacy
  // user-CRUD-authored skills don't have a source file.
  manifestPath?: string;
  // Parent directory name for filesystem-loaded skills (e.g. "apple" for
  // skills/apple/apple-notes/SKILL.md). Used as a UI grouping hint.
  category?: string;
  // Frontmatter `platforms` list (e.g. ["macos"]). Skills are skipped at
  // load time when the host platform isn't in this list.
  platforms?: string[];
  // Frontmatter `prerequisites`. We keep `commands` and `env` as strings —
  // strings the LLM can later inspect or check via terminal_exec.
  prerequisites?: { commands?: string[]; env?: string[] };
  // Origin of the loaded skill: "bundled" for vendored repo skills (under
  // <repo>/skills/), "user" for skills under ~/.gini/instances/<inst>/skills/.
  // Used by the loader to keep bundled and user records separate (so a
  // user-instance SKILL.md named "apple-notes" can't hijack the vendored
  // trust grant) and by the auto-trust allowlist (only bundled records may
  // be auto-trusted). Defaults to "user" for legacy records via
  // normalizeState so older state files keep loading.
  source?: "bundled" | "user";
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
  instance: Instance;
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
  // Optional originating chat session for jobs scheduled by the agent via
  // the `create_job` tool. When set, each scheduled task is linked back to
  // this session (session.taskIds/runIds) and its final summary is synced
  // as an assistant chat message. Backwards-compatible: legacy jobs without
  // this field keep their existing imperative delivery semantics.
  chatSessionId?: string;
  // One-shot reminder semantics: when true the job is auto-paused after its
  // first terminal run (success or fail). The user can resume manually
  // through /jobs. Defaults to undefined/false (recurring behavior).
  oneShot?: boolean;
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
  instance: Instance;
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
  instance: Instance;
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
  instance: Instance;
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
  instance: Instance;
  codeHash: string;
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedByDeviceId?: string;
}

export interface PairedDevice {
  id: string;
  instance: Instance;
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
  instance: Instance;
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
  instance: Instance;
  path: string;
  reason: string;
  createdAt: string;
  taskCount: number;
  auditCount: number;
}

export interface ProviderHealth {
  ok: boolean;
  provider: ProviderConfig;
  configured: boolean;
  authPath?: string;
  credentialType?: string;
  message?: string;
}

export interface ActiveAgentSnapshot {
  id: string;
  name: string;
  resolvedProvider: { name: string; model: string };
  providerSource: "agent" | "instance";
  toolsetFilter?: string[];
  messagingTargetFilter?: string[];
  // Phase C: the per-agent memory isolation key. Same as `id` today, but
  // surfaced explicitly so clients can see the namespace without
  // re-deriving the bank id or guessing how memory is scoped.
  memoryNamespace: string;
  warnings: string[];
}

export interface RuntimeStatus {
  ok: boolean;
  instance: Instance;
  port: number;
  stateRoot: string;
  workspaceRoot?: string;
  pid?: number;
  taskCounts: Record<TaskStatus, number>;
  pendingApprovals: number;
  activeJobs: number;
  missedJobs: number;
  connectors: number;
  memoryUnits?: number;
  provider?: ProviderHealth;
  activeAgent?: ActiveAgentSnapshot;
}

export interface ProviderResult {
  provider: ProviderConfig;
  text: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}
