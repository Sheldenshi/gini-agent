import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  Approval,
  AuditEvent,
  ConnectorRecord,
  DeviceStatus,
  ImportReport,
  ImprovementProposal,
  JobRecord,
  Lane,
  MemoryRecord,
  McpServerRecord,
  MessagingBridgeRecord,
  PairedDevice,
  PairingCode,
  PairingStatus,
  ProfileRecord,
  RelayRecord,
  PromotionProposal,
  RuntimeState,
  SkillRecord,
  SnapshotRecord,
  SubagentRecord,
  Task,
  ToolRecord,
  ToolsetRecord,
  TraceRecord,
  NotificationRecord
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
    improvements: [],
    pairingCodes: [],
    devices: [],
    promotions: [],
    snapshots: [],
    tools: defaultTools(lane, at),
    toolsets: defaultToolsets(lane, at),
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    profiles: [defaultProfile(lane, at)],
    activeProfileId: "profile_default",
    relays: [],
    notifications: []
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

export function createTask(lane: Lane, input: string, jobId?: string, parentTaskId?: string, subagentId?: string): Task {
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
    jobId,
    parentTaskId,
    subagentId
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

export function createPairingCode(state: RuntimeState, ttlSeconds = 600): { pairing: PairingCode; code: string } {
  const at = now();
  const code = randomPairingCode();
  const pairing: PairingCode = {
    id: id("pair"),
    lane: state.lane,
    codeHash: hashSecret(code),
    status: "pending",
    createdAt: at,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
  };
  state.pairingCodes.unshift(pairing);
  addAudit(state, {
    actor: "user",
    action: "pairing.created",
    target: pairing.id,
    risk: "medium",
    evidence: { expiresAt: pairing.expiresAt }
  });
  return { pairing, code };
}

export function claimPairingCode(state: RuntimeState, code: string, deviceName: string): { device: PairedDevice; token: string } {
  expirePairingCodes(state);
  const codeHash = hashSecret(code);
  const pairing = state.pairingCodes.find((item) => item.codeHash === codeHash && item.status === "pending");
  if (!pairing) throw new Error("Pairing code is invalid or expired.");

  const at = now();
  const token = `gini_device_${crypto.randomUUID().replaceAll("-", "")}`;
  const device: PairedDevice = {
    id: id("device"),
    lane: state.lane,
    name: deviceName.trim() || "Unnamed device",
    tokenHash: hashSecret(token),
    status: "active",
    scopes: ["tasks:read", "tasks:write", "approvals:write", "state:read"],
    createdAt: at,
    updatedAt: at
  };
  pairing.status = "claimed";
  pairing.claimedAt = at;
  pairing.claimedByDeviceId = device.id;
  state.devices.unshift(device);
  addAudit(state, {
    actor: "user",
    action: "device.paired",
    target: device.id,
    risk: "medium",
    evidence: { pairingId: pairing.id, name: device.name, scopes: device.scopes }
  });
  return { device, token };
}

export function revokeDevice(state: RuntimeState, deviceId: string): PairedDevice {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  device.status = "revoked" satisfies DeviceStatus;
  device.updatedAt = now();
  device.revokedAt = device.updatedAt;
  addAudit(state, {
    actor: "user",
    action: "device.revoked",
    target: device.id,
    risk: "medium",
    evidence: { name: device.name }
  });
  return device;
}

export function findActiveDeviceByToken(state: RuntimeState, token: string): PairedDevice | undefined {
  const tokenHash = hashSecret(token);
  const device = state.devices.find((item) => item.tokenHash === tokenHash && item.status === "active");
  if (device) {
    device.lastSeenAt = now();
    device.updatedAt = device.lastSeenAt;
  }
  return device;
}

export function createPromotionProposal(
  state: RuntimeState,
  proposal: Omit<PromotionProposal, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): PromotionProposal {
  const at = now();
  const item: PromotionProposal = {
    id: id("promo"),
    lane: state.lane,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.promotions.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "promotion.proposed",
    target: item.id,
    risk: "medium",
    evidence: { candidateRef: item.candidateRef, evidencePath: item.evidencePath }
  });
  return item;
}

export function decidePromotion(state: RuntimeState, promotionId: string, decision: "approve" | "reject"): PromotionProposal {
  const promotion = state.promotions.find((item) => item.id === promotionId);
  if (!promotion) throw new Error(`Promotion proposal not found: ${promotionId}`);
  if (promotion.status !== "proposed") throw new Error(`Promotion proposal is already ${promotion.status}`);
  promotion.status = decision === "approve" ? "approved" : "rejected";
  promotion.decidedAt = now();
  promotion.updatedAt = promotion.decidedAt;
  addAudit(state, {
    actor: "user",
    action: `promotion.${promotion.status}`,
    target: promotion.id,
    risk: "medium",
    evidence: { candidateRef: promotion.candidateRef }
  });
  return promotion;
}

export function createSnapshotRecord(
  state: RuntimeState,
  snapshot: Omit<SnapshotRecord, "id" | "lane" | "createdAt" | "taskCount" | "auditCount">
): SnapshotRecord {
  const item: SnapshotRecord = {
    id: id("snap"),
    lane: state.lane,
    createdAt: now(),
    taskCount: state.tasks.length,
    auditCount: state.audit.length,
    ...snapshot
  };
  state.snapshots.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "snapshot.created",
    target: item.id,
    risk: "medium",
    evidence: { path: item.path, reason: item.reason }
  });
  return item;
}

export function createSubagentRecord(
  state: RuntimeState,
  subagent: Omit<SubagentRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): SubagentRecord {
  const at = now();
  const item: SubagentRecord = {
    id: id("subagent"),
    lane: state.lane,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...subagent
  };
  state.subagents.unshift(item);
  addAudit(state, {
    actor: "agent",
    action: "subagent.created",
    target: item.id,
    risk: "medium",
    taskId: item.parentTaskId,
    evidence: { name: item.name, toolsets: item.toolsets }
  });
  return item;
}

export function createMcpServerRecord(
  state: RuntimeState,
  server: Omit<McpServerRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): McpServerRecord {
  const at = now();
  const item: McpServerRecord = {
    id: id("mcp"),
    lane: state.lane,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...server
  };
  state.mcpServers.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "mcp.configured",
    target: item.id,
    risk: "medium",
    evidence: { name: item.name, exposedTools: item.exposedTools }
  });
  return item;
}

export function createMessagingBridgeRecord(
  state: RuntimeState,
  bridge: Omit<MessagingBridgeRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): MessagingBridgeRecord {
  const at = now();
  const item: MessagingBridgeRecord = {
    id: id("bridge"),
    lane: state.lane,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...bridge
  };
  state.messagingBridges.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "messaging.configured",
    target: item.id,
    risk: "medium",
    evidence: { kind: item.kind, deliveryTargets: item.deliveryTargets }
  });
  return item;
}

export function createImportReport(state: RuntimeState, report: Omit<ImportReport, "id" | "lane" | "createdAt">): ImportReport {
  const item: ImportReport = {
    id: id("import"),
    lane: state.lane,
    createdAt: now(),
    ...report
  };
  state.importReports.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "import.inspected",
    target: item.id,
    risk: "low",
    evidence: { source: item.source, path: item.path, counts: item.counts }
  });
  return item;
}

export function createProfileRecord(
  state: RuntimeState,
  profile: Omit<ProfileRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): ProfileRecord {
  const at = now();
  const item: ProfileRecord = {
    id: id("profile"),
    lane: state.lane,
    status: "inactive",
    createdAt: at,
    updatedAt: at,
    ...profile
  };
  state.profiles.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "profile.created",
    target: item.id,
    risk: "low",
    evidence: { name: item.name, toolsets: item.toolsets }
  });
  return item;
}

export function createRelayRecord(state: RuntimeState, relay: Omit<RelayRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">): RelayRecord {
  const at = now();
  const item: RelayRecord = {
    id: id("relay"),
    lane: state.lane,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...relay
  };
  state.relays.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "relay.configured",
    target: item.id,
    risk: "medium",
    evidence: { mode: item.mode, endpoint: item.endpoint }
  });
  return item;
}

export function createNotificationRecord(state: RuntimeState, notification: Omit<NotificationRecord, "id" | "lane" | "status" | "createdAt" | "updatedAt">): NotificationRecord {
  const at = now();
  const item: NotificationRecord = {
    id: id("notify"),
    lane: state.lane,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...notification
  };
  state.notifications.unshift(item);
  addAudit(state, {
    actor: "runtime",
    action: "notification.queued",
    target: item.id,
    risk: "low",
    taskId: item.taskId,
    evidence: { kind: item.kind, target: item.target }
  });
  return item;
}

export function activateProfile(state: RuntimeState, idOrName: string): ProfileRecord {
  const profile = state.profiles.find((item) => item.id === idOrName || item.name === idOrName);
  if (!profile) throw new Error(`Profile not found: ${idOrName}`);
  for (const item of state.profiles) item.status = item.id === profile.id ? "active" : "inactive";
  profile.updatedAt = now();
  state.activeProfileId = profile.id;
  addAudit(state, {
    actor: "user",
    action: "profile.activated",
    target: profile.id,
    risk: "low",
    evidence: { name: profile.name }
  });
  return profile;
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
  state.pairingCodes ??= [];
  state.devices ??= [];
  state.promotions ??= [];
  state.snapshots ??= [];
  state.tools ??= defaultTools(lane, now());
  state.toolsets ??= defaultToolsets(lane, now());
  state.subagents ??= [];
  state.mcpServers ??= [];
  state.messagingBridges ??= [];
  state.importReports ??= [];
  state.profiles ??= [defaultProfile(lane, now())];
  state.activeProfileId ??= state.profiles.find((item) => item.status === "active")?.id ?? state.profiles[0]?.id;
  state.relays ??= [];
  state.notifications ??= [];
  expirePairingCodes(state);
  return state;
}

function expirePairingCodes(state: RuntimeState): void {
  const at = Date.now();
  for (const pairing of state.pairingCodes) {
    if (pairing.status === "pending" && new Date(pairing.expiresAt).getTime() <= at) {
      pairing.status = "expired" satisfies PairingStatus;
    }
  }
}

export function hashSecret(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

function randomPairingCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((value) => String(value % 10))
    .join("")
    .replace(/^(.{3})(.{3})$/, "$1-$2");
}

function defaultToolsets(lane: Lane, at: string): ToolsetRecord[] {
  return [
    {
      id: "toolset_file",
      lane,
      name: "file",
      description: "Workspace file read, search, list, and approval-gated write operations.",
      status: "enabled",
      toolNames: ["file.read", "file.search", "file.list", "file.write"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_terminal",
      lane,
      name: "terminal",
      description: "Approval-gated shell execution with timeout and trace evidence.",
      status: "enabled",
      toolNames: ["terminal.exec"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_memory",
      lane,
      name: "memory",
      description: "Inspectable memory proposal, activation, retrieval, and rejection flows.",
      status: "enabled",
      toolNames: ["memory.search", "memory.propose", "memory.activate"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_session_search",
      lane,
      name: "session_search",
      description: "Search prior tasks, traces, memories, skills, and audit events with source links.",
      status: "enabled",
      toolNames: ["session.search"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_delegation",
      lane,
      name: "delegation",
      description: "Spawn isolated subagent tasks with toolset limits and trace linkage.",
      status: "enabled",
      toolNames: ["delegate.task"],
      scopes: ["task", "job", "skill"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_mcp",
      lane,
      name: "mcp",
      description: "Expose selected external MCP tools through configured server records.",
      status: "disabled",
      toolNames: ["mcp.invoke"],
      scopes: ["task", "job", "skill", "subagent", "mcp"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_messaging",
      lane,
      name: "messaging",
      description: "Bridge task input and notifications to configured messaging channels.",
      status: "disabled",
      toolNames: ["message.send"],
      scopes: ["job", "messaging"],
      createdAt: at,
      updatedAt: at
    }
  ];
}

function defaultTools(lane: Lane, at: string): ToolRecord[] {
  return defaultToolsets(lane, at).flatMap((toolset) => toolset.toolNames.map((name) => ({
    id: `tool_${name.replaceAll(".", "_")}`,
    lane,
    name,
    description: `${name} from ${toolset.name} toolset`,
    toolset: toolset.name,
    status: toolset.status === "enabled" ? "available" : "disabled",
    risk: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send") ? "high" : "low",
    requiresApproval: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send"),
    createdAt: at,
    updatedAt: at
  })));
}

function defaultProfile(lane: Lane, at: string): ProfileRecord {
  return {
    id: "profile_default",
    lane,
    name: "default",
    status: "active",
    providerName: "echo",
    model: "gini-echo-v0",
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryScopes: ["user", "project", "device", "temporary"],
    messagingTargets: [],
    createdAt: at,
    updatedAt: at
  };
}
