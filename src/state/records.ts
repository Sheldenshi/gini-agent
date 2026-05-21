import type {
  Approval,
  ChatMessageRecord,
  ChatSessionRecord,
  ConnectorRecord,
  DeviceStatus,
  ImportReport,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  Instance,
  McpServerRecord,
  MemoryRecord,
  MessagingBridgeRecord,
  MessagingMessageRecord,
  NotificationRecord,
  PairedDevice,
  PairingCode,
  AgentRecord,
  PromotionProposal,
  RelayRecord,
  RunRecord,
  RuntimeState,
  SkillRecord,
  SnapshotRecord,
  SubagentRecord,
  Task,
  PlanStepRecord
} from "../types";
import { id, now } from "./ids";
import { addAudit, appendEvent, type AgentContext } from "./audit";
import { tracePath } from "./trace";
import { hashSecret, randomPairingCode } from "./security";
import { expirePairingCodes } from "./store";

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

export function upsertTask(state: RuntimeState, task: Task): Task {
  const index = state.tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  return task;
}

// Appends streamed delta text to a task's `partialSummary`, bumping
// updatedAt. Used by runTask to expose mid-flight provider output to the
// chat UI without waiting for the buffered final response. Silently no-ops
// if the task no longer exists (cancellation race).
export function appendTaskPartial(state: RuntimeState, taskId: string, delta: string): void {
  if (!delta) return;
  const task = state.tasks.find((existing) => existing.id === taskId);
  if (!task) return;
  task.partialSummary = (task.partialSummary ?? "") + delta;
  task.updatedAt = now();
}

export function createTask(
  instance: Instance,
  input: string,
  jobId?: string,
  parentTaskId?: string,
  subagentId?: string,
  runId?: string,
  agentId?: string,
  chatSessionId?: string
): Task {
  const at = now();
  const taskId = id("task");
  return {
    id: taskId,
    title: input.slice(0, 80) || "Untitled task",
    input,
    status: "queued",
    instance,
    agentId,
    createdAt: at,
    updatedAt: at,
    tracePath: tracePath(instance, taskId),
    auditIds: [],
    approvalIds: [],
    memoryIds: [],
    skillIds: [],
    jobId,
    parentTaskId,
    subagentId,
    runId,
    chatSessionId
  };
}

export function createRun(
  state: RuntimeState,
  run: Omit<RunRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "planStepIds" | "childRunIds" | "approvalIds">
): RunRecord {
  const at = now();
  const item: RunRecord = {
    id: id("run"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    planStepIds: [],
    childRunIds: [],
    approvalIds: [],
    ...run
  };
  state.runs.unshift(item);
  if (item.parentRunId) {
    const parent = state.runs.find((candidate) => candidate.id === item.parentRunId);
    if (parent && !parent.childRunIds.includes(item.id)) parent.childRunIds.push(item.id);
  }
  if (item.conversationId) {
    const session = state.chatSessions.find((candidate) => candidate.id === item.conversationId);
    if (session && !session.runIds.includes(item.id)) {
      session.runIds.push(item.id);
      session.updatedAt = at;
    }
  }
  // Resolve the originating agent so the run.created event lands under the
  // right inbox even when the run is bound to a chat session or scheduled
  // job whose owning agent isn't the currently active one. taskId resolves
  // later (via linkRunToTask) so don't rely on it here — chain
  // session → job → system instead.
  appendEvent(
    state,
    {
      kind: "run",
      action: "run.created",
      target: item.id,
      runId: item.id,
      risk: "low",
      summary: item.title,
      data: { kind: item.kind, conversationId: item.conversationId, parentRunId: item.parentRunId },
      jobId: item.jobId
    },
    item.conversationId
      ? { sessionId: item.conversationId }
      : item.jobId
        ? { jobId: item.jobId }
        : { system: true }
  );
  return item;
}

export function createPlanStep(
  state: RuntimeState,
  step: Omit<PlanStepRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): PlanStepRecord {
  const at = now();
  const item: PlanStepRecord = {
    id: id("step"),
    instance: state.instance,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...step
  };
  state.planSteps.unshift(item);
  const run = state.runs.find((candidate) => candidate.id === item.runId);
  if (run && !run.planStepIds.includes(item.id)) run.planStepIds.push(item.id);
  // Walk the parent run (conversationId -> session, jobId -> job, taskId
  // -> task) so the step event inherits the same agent attribution as
  // run.created. AgentContext keeps the chain explicit at the call site.
  const stepTaskId = item.taskId ?? run?.taskId;
  const stepAgent: AgentContext = run?.conversationId
    ? { sessionId: run.conversationId }
    : run?.jobId
      ? { jobId: run.jobId }
      : stepTaskId
        ? { taskId: stepTaskId }
        : { system: true };
  appendEvent(
    state,
    {
      kind: "run",
      action: "run.step.created",
      target: item.runId,
      runId: item.runId,
      taskId: stepTaskId,
      risk: "low",
      summary: item.title,
      data: { stepId: item.id },
      jobId: run?.jobId
    },
    stepAgent
  );
  return item;
}

export function createChatSession(
  state: RuntimeState,
  title: string,
  source?: ChatSessionRecord["source"],
  agentId?: string,
  origin?: ChatSessionRecord["origin"]
): ChatSessionRecord {
  const at = now();
  const session: ChatSessionRecord = {
    id: id("chat"),
    instance: state.instance,
    agentId,
    title: title.slice(0, 80) || "Untitled chat",
    createdAt: at,
    updatedAt: at,
    messageIds: [],
    taskIds: [],
    runIds: [],
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {})
  };
  state.chatSessions.unshift(session);
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.created",
      target: session.id,
      risk: "low",
      summary: `Chat session created: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Find an existing chat session bound to a (bridge, chat_id) pair, or
// create one. We key on the bridge id + chat id so that if a user
// disables and re-creates the bridge, conversations from a different
// bridge id start fresh (which matches the user's mental model: a new
// bridge is a new bot).
export function findOrCreateTelegramChatSession(
  state: RuntimeState,
  bridgeId: string,
  chatId: number
): ChatSessionRecord {
  const target = String(chatId);
  const existing = state.chatSessions.find((session) =>
    session.source?.kind === "telegram" &&
    session.source.bridgeId === bridgeId &&
    session.source.chatId === chatId
  );
  if (existing) return existing;
  return createChatSession(state, `Telegram chat ${target}`, {
    kind: "telegram",
    bridgeId,
    chatId,
    target
  }, state.activeAgentId);
}

// Discord channels map 1:1 to chat sessions. We key on (bridgeId,
// channelId) so re-creating the bridge starts a fresh conversation —
// same mental model as Telegram. The target is the channel snowflake
// the dispatcher hands back to sendMessagingOutput.
export function findOrCreateDiscordChatSession(
  state: RuntimeState,
  bridgeId: string,
  channelId: string
): ChatSessionRecord {
  const existing = state.chatSessions.find((session) =>
    session.source?.kind === "discord" &&
    session.source.bridgeId === bridgeId &&
    session.source.channelId === channelId
  );
  if (existing) return existing;
  return createChatSession(state, `Discord channel ${channelId}`, {
    kind: "discord",
    bridgeId,
    channelId,
    target: channelId
  });
}

export function deleteChatSession(state: RuntimeState, id: string): ChatSessionRecord {
  const index = state.chatSessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`Chat session not found: ${id}`);
  const session = state.chatSessions[index]!;
  state.chatSessions.splice(index, 1);
  state.chatMessages = state.chatMessages.filter((message) => message.sessionId !== id);
  // Identity snapshots are keyed on conversationId (the chat session id),
  // so removing the session must drop the matching snapshot or we leak
  // one IdentitySnapshotRecord per deleted chat forever.
  if (state.identitySnapshots) {
    delete state.identitySnapshots[id];
  }
  // The session record is gone from state.chatSessions; resolve via the
  // captured agentId so the event still attributes to the owner.
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.deleted",
      target: id,
      risk: "low",
      summary: `Chat session deleted: ${session.title}`
    },
    session.agentId ? { agentId: session.agentId } : { system: true }
  );
  return session;
}

export function renameChatSession(state: RuntimeState, id: string, title: string): ChatSessionRecord {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);
  const trimmed = title.trim();
  session.title = (trimmed ? trimmed.slice(0, 80) : "") || "Untitled chat";
  session.updatedAt = now();
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.renamed",
      target: session.id,
      risk: "low",
      summary: `Chat session renamed: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

export function createChatMessage(
  state: RuntimeState,
  message: Omit<ChatMessageRecord, "id" | "instance" | "createdAt">
): ChatMessageRecord {
  const item: ChatMessageRecord = {
    id: id("msg"),
    instance: state.instance,
    createdAt: now(),
    ...message
  };
  state.chatMessages.push(item);
  const session = state.chatSessions.find((candidate) => candidate.id === item.sessionId);
  if (session) {
    session.messageIds.push(item.id);
    if (item.taskId && !session.taskIds.includes(item.taskId)) session.taskIds.push(item.taskId);
    if (item.runId && !session.runIds.includes(item.runId)) session.runIds.push(item.runId);
    session.updatedAt = item.createdAt;
    if (item.role === "assistant") session.summary = item.content.slice(0, 240);
  }
  return item;
}

export function createApproval(
  state: RuntimeState,
  approval: Omit<Approval, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): Approval {
  const at = now();
  // Inherit agentId from the originating task when the caller didn't supply
  // one. Approvals follow the task that requested them — that's the agent
  // whose inbox the row should land in.
  const taskAgentId = approval.taskId
    ? state.tasks.find((task) => task.id === approval.taskId)?.agentId
    : undefined;
  const item: Approval = {
    id: id("approval"),
    instance: state.instance,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...approval,
    agentId: approval.agentId ?? taskAgentId
  };
  state.approvals.unshift(item);
  addAudit(
    state,
    {
      actor: "runtime",
      action: "approval.requested",
      target: item.target,
      risk: item.risk,
      taskId: item.taskId,
      approvalId: item.id,
      evidence: { action: item.action, reason: item.reason }
    },
    item.taskId
      ? { taskId: item.taskId, agentId: item.agentId }
      : item.agentId
        ? { agentId: item.agentId }
        : { system: true }
  );
  return item;
}

export function createMemory(
  state: RuntimeState,
  memory: Omit<MemoryRecord, "id" | "instance" | "createdAt" | "updatedAt">
): MemoryRecord {
  const at = now();
  const item: MemoryRecord = {
    id: id("mem"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    ...memory
  };
  state.memories.unshift(item);
  return item;
}

export function createSkill(
  state: RuntimeState,
  skill: Omit<SkillRecord, "id" | "instance" | "createdAt" | "updatedAt" | "version" | "tests" | "successCount" | "failureCount" | "previousVersions" | "body"> & Partial<Pick<SkillRecord, "tests" | "successCount" | "failureCount" | "previousVersions" | "body" | "manifestPath" | "category" | "platforms" | "prerequisites" | "requiredConnectors" | "allowedTools" | "license" | "compatibility" | "manifestVersion" | "validationStatus" | "validationMessage" | "source">>
): SkillRecord {
  const at = now();
  const item: SkillRecord = {
    id: id("skill"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    version: 1,
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...skill
  };
  state.skills.unshift(item);
  return item;
}

export function createJob(
  state: RuntimeState,
  job: Omit<JobRecord, "id" | "instance" | "createdAt" | "updatedAt" | "status" | "lastRunAt" | "lastSuccessAt" | "lastFailureAt" | "lastError" | "runCount" | "missedRuns" | "taskIds" | "runIds" | "deliveryTargets" | "context" | "retryLimit" | "timeoutSeconds"> & Partial<Pick<JobRecord, "runIds" | "deliveryTargets" | "context" | "retryLimit" | "timeoutSeconds">>
): JobRecord {
  const at = now();
  const item: JobRecord = {
    id: id("job"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    status: "active",
    deliveryTargets: [],
    context: [],
    retryLimit: 0,
    timeoutSeconds: 600,
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    runIds: [],
    ...job
  };
  state.jobs.unshift(item);
  return item;
}

export function createJobRun(
  state: RuntimeState,
  run: Omit<JobRunRecord, "id" | "instance" | "createdAt" | "updatedAt" | "status" | "attempt">
): JobRunRecord {
  const at = now();
  const item: JobRunRecord = {
    id: id("jobrun"),
    instance: state.instance,
    status: "running",
    attempt: state.jobRuns.filter((candidate) => candidate.jobId === run.jobId).length + 1,
    createdAt: at,
    updatedAt: at,
    ...run
  };
  state.jobRuns.unshift(item);
  appendEvent(
    state,
    {
      kind: "job",
      action: "job.run.started",
      target: run.jobId,
      jobId: run.jobId,
      risk: "low",
      summary: `Job run started for ${run.jobId}`,
      data: { runId: item.id, trigger: item.trigger }
    },
    { jobId: run.jobId, agentId: run.agentId }
  );
  return item;
}

export function createImprovementProposal(
  state: RuntimeState,
  proposal: Omit<ImprovementProposal, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): ImprovementProposal {
  const at = now();
  const item: ImprovementProposal = {
    id: id("impr"),
    instance: state.instance,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.improvements.unshift(item);
  addAudit(
    state,
    {
      actor: "agent",
      action: "improvement.proposed",
      target: item.id,
      risk: "medium",
      taskId: item.sourceTaskId,
      evidence: { kind: item.kind, sourceTraceIds: item.sourceTraceIds }
    },
    item.sourceTaskId ? { taskId: item.sourceTaskId } : { system: true }
  );
  return item;
}

export function createPairingCode(
  state: RuntimeState,
  ttlSeconds = 600
): { pairing: PairingCode; code: string } {
  const at = now();
  const code = randomPairingCode();
  const pairing: PairingCode = {
    id: id("pair"),
    instance: state.instance,
    codeHash: hashSecret(code),
    status: "pending",
    createdAt: at,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
  };
  state.pairingCodes.unshift(pairing);
  // Device pairing is instance-scoped (not per-agent); the resulting device
  // can act under any agent the operator activates next.
  addAudit(
    state,
    {
      actor: "user",
      action: "pairing.created",
      target: pairing.id,
      risk: "medium",
      evidence: { expiresAt: pairing.expiresAt }
    },
    { system: true }
  );
  return { pairing, code };
}

export function claimPairingCode(
  state: RuntimeState,
  code: string,
  deviceName: string
): { device: PairedDevice; token: string } {
  expirePairingCodes(state);
  const codeHash = hashSecret(code);
  const pairing = state.pairingCodes.find((item) => item.codeHash === codeHash && item.status === "pending");
  if (!pairing) throw new Error("Pairing code is invalid or expired.");

  const at = now();
  const token = `gini_device_${crypto.randomUUID().replaceAll("-", "")}`;
  const device: PairedDevice = {
    id: id("device"),
    instance: state.instance,
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
  // Paired devices are instance-scoped; the operator hasn't picked an
  // agent for them at pairing time.
  addAudit(
    state,
    {
      actor: "user",
      action: "device.paired",
      target: device.id,
      risk: "medium",
      evidence: { pairingId: pairing.id, name: device.name, scopes: device.scopes }
    },
    { system: true }
  );
  return { device, token };
}

export function revokeDevice(state: RuntimeState, deviceId: string): PairedDevice {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  device.status = "revoked" satisfies DeviceStatus;
  device.updatedAt = now();
  device.revokedAt = device.updatedAt;
  // Devices are instance-scoped, not per-agent.
  addAudit(
    state,
    {
      actor: "user",
      action: "device.revoked",
      target: device.id,
      risk: "medium",
      evidence: { name: device.name }
    },
    { system: true }
  );
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
  proposal: Omit<PromotionProposal, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): PromotionProposal {
  const at = now();
  const item: PromotionProposal = {
    id: id("promo"),
    instance: state.instance,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.promotions.unshift(item);
  // Promotions decide instance-wide runtime upgrades; they don't belong
  // to a specific agent.
  addAudit(
    state,
    {
      actor: "user",
      action: "promotion.proposed",
      target: item.id,
      risk: "medium",
      evidence: { candidateRef: item.candidateRef, evidencePath: item.evidencePath }
    },
    { system: true }
  );
  return item;
}

export function decidePromotion(
  state: RuntimeState,
  promotionId: string,
  decision: "approve" | "reject"
): PromotionProposal {
  const promotion = state.promotions.find((item) => item.id === promotionId);
  if (!promotion) throw new Error(`Promotion proposal not found: ${promotionId}`);
  if (promotion.status !== "proposed") throw new Error(`Promotion proposal is already ${promotion.status}`);
  promotion.status = decision === "approve" ? "approved" : "rejected";
  promotion.decidedAt = now();
  promotion.updatedAt = promotion.decidedAt;
  addAudit(
    state,
    {
      actor: "user",
      action: `promotion.${promotion.status}`,
      target: promotion.id,
      risk: "medium",
      evidence: { candidateRef: promotion.candidateRef }
    },
    { system: true }
  );
  return promotion;
}

export function createSnapshotRecord(
  state: RuntimeState,
  snapshot: Omit<SnapshotRecord, "id" | "instance" | "createdAt" | "taskCount" | "auditCount">
): SnapshotRecord {
  const item: SnapshotRecord = {
    id: id("snap"),
    instance: state.instance,
    createdAt: now(),
    taskCount: state.tasks.length,
    auditCount: state.audit.length,
    ...snapshot
  };
  state.snapshots.unshift(item);
  // Snapshots capture the whole instance, not a single agent's data.
  addAudit(
    state,
    {
      actor: "user",
      action: "snapshot.created",
      target: item.id,
      risk: "medium",
      evidence: { path: item.path, reason: item.reason }
    },
    { system: true }
  );
  return item;
}

export function createSubagentRecord(
  state: RuntimeState,
  subagent: Omit<SubagentRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): SubagentRecord {
  const at = now();
  const item: SubagentRecord = {
    id: id("subagent"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...subagent
  };
  state.subagents.unshift(item);
  addAudit(
    state,
    {
      actor: "agent",
      action: "subagent.created",
      target: item.id,
      risk: "medium",
      taskId: item.parentTaskId,
      evidence: { name: item.name, toolsets: item.toolsets }
    },
    item.parentTaskId
      ? { taskId: item.parentTaskId, agentId: item.agentId }
      : item.agentId
        ? { agentId: item.agentId }
        : { system: true }
  );
  return item;
}

export function createMcpServerRecord(
  state: RuntimeState,
  server: Omit<McpServerRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): McpServerRecord {
  const at = now();
  const item: McpServerRecord = {
    id: id("mcp"),
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...server
  };
  state.mcpServers.unshift(item);
  // MCP servers are configured at the instance level; tool invocations
  // later attribute to the calling task.
  addAudit(
    state,
    {
      actor: "user",
      action: "mcp.configured",
      target: item.id,
      risk: "medium",
      evidence: { name: item.name, exposedTools: item.exposedTools }
    },
    { system: true }
  );
  return item;
}

// Field-default builder shared between the runtime helper and the
// openclaw migrator. The migrator needs to pre-mint a bridge id
// before it writes the encrypted bot-token file (the secret path is
// `messaging.<bridgeId>.bot-token.json`, so the id has to be known
// up front), and it emits a richer audit row tagged with the
// migration source. Extracting the field-default shape here keeps
// the migrator from drifting when fields are added to
// MessagingBridgeRecord — both callers inherit the new defaults
// instead of one branch silently producing a record missing them.
export function buildMessagingBridgeRecord(
  state: RuntimeState,
  bridge: Omit<MessagingBridgeRecord, "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): MessagingBridgeRecord {
  const at = now();
  return {
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...bridge
  };
}

export function createMessagingBridgeRecord(
  state: RuntimeState,
  bridge: Omit<MessagingBridgeRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): MessagingBridgeRecord {
  const item = buildMessagingBridgeRecord(state, { id: id("bridge"), ...bridge });
  state.messagingBridges.unshift(item);
  // Messaging bridges live at the instance level; per-agent target
  // filtering happens at send time.
  addAudit(
    state,
    {
      actor: "user",
      action: "messaging.configured",
      target: item.id,
      risk: "medium",
      evidence: { kind: item.kind, deliveryTargets: item.deliveryTargets }
    },
    { system: true }
  );
  return item;
}

export function createMessagingMessageRecord(
  state: RuntimeState,
  message: Omit<MessagingMessageRecord, "id" | "instance" | "createdAt" | "updatedAt">
): MessagingMessageRecord {
  const at = now();
  const item: MessagingMessageRecord = {
    id: id("message"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    ...message
  };
  state.messagingMessages.unshift(item);
  appendEvent(
    state,
    {
      kind: "messaging",
      action: `messaging.${item.direction}.${item.status}`,
      target: item.bridgeId,
      taskId: item.taskId,
      risk: "low",
      summary: `${item.direction} message ${item.status}`,
      data: { messageId: item.id, target: item.target }
    },
    item.taskId ? { taskId: item.taskId } : { system: true }
  );
  return item;
}

export function createImportReport(
  state: RuntimeState,
  report: Omit<ImportReport, "id" | "instance" | "createdAt">
): ImportReport {
  const item: ImportReport = {
    id: id("import"),
    instance: state.instance,
    createdAt: now(),
    ...report
  };
  state.importReports.unshift(item);
  // Audit action mirrors the report mode so a state-mutating apply
  // doesn't pretend to be a read-only inspection in the activity feed.
  addAudit(
    state,
    {
      actor: "user",
      action: item.mode === "applied" ? "import.applied" : "import.inspected",
      target: item.id,
      risk: item.mode === "applied" ? "medium" : "low",
      evidence: {
        source: item.source,
        path: item.path,
        mode: item.mode,
        status: item.status,
        counts: item.counts
      }
    },
    { system: true }
  );
  return item;
}

export function createAgentRecord(
  state: RuntimeState,
  agent: Omit<AgentRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): AgentRecord {
  const at = now();
  const item: AgentRecord = {
    id: id("agent"),
    instance: state.instance,
    status: "inactive",
    createdAt: at,
    updatedAt: at,
    ...agent
  };
  state.agents.unshift(item);
  // The new agent IS the subject — there's no parent agent to attribute
  // this to. The agent record itself is the inbox owner from here on.
  addAudit(
    state,
    {
      actor: "user",
      action: "agent.created",
      target: item.id,
      risk: "low",
      evidence: { name: item.name, toolsets: item.toolsets }
    },
    { agentId: item.id }
  );
  return item;
}

export function createRelayRecord(
  state: RuntimeState,
  relay: Omit<RelayRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): RelayRecord {
  const at = now();
  const item: RelayRecord = {
    id: id("relay"),
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...relay
  };
  state.relays.unshift(item);
  // Relays are instance-level transport endpoints.
  addAudit(
    state,
    {
      actor: "user",
      action: "relay.configured",
      target: item.id,
      risk: "medium",
      evidence: { mode: item.mode, endpoint: item.endpoint }
    },
    { system: true }
  );
  return item;
}

export function createNotificationRecord(
  state: RuntimeState,
  notification: Omit<NotificationRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): NotificationRecord {
  const at = now();
  const item: NotificationRecord = {
    id: id("notify"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...notification
  };
  state.notifications.unshift(item);
  addAudit(
    state,
    {
      actor: "runtime",
      action: "notification.queued",
      target: item.id,
      risk: "low",
      taskId: item.taskId,
      evidence: { kind: item.kind, target: item.target }
    },
    item.taskId ? { taskId: item.taskId } : { system: true }
  );
  return item;
}

export function activateAgent(state: RuntimeState, idOrName: string): AgentRecord {
  const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
  if (!agent) throw new Error(`Agent not found: ${idOrName}`);
  for (const item of state.agents) item.status = item.id === agent.id ? "active" : "inactive";
  agent.updatedAt = now();
  state.activeAgentId = agent.id;
  // The just-activated agent owns this audit row — that's the agent the
  // operator is now switching into.
  addAudit(
    state,
    {
      actor: "user",
      action: "agent.activated",
      target: agent.id,
      risk: "low",
      evidence: { name: agent.name }
    },
    { agentId: agent.id }
  );
  return agent;
}

export function updateConnectorHealth(connector: ConnectorRecord): ConnectorRecord {
  connector.lastHealthAt = now();
  connector.health = connector.status === "configured" ? "healthy" : "unhealthy";
  connector.message = connector.provider === "demo" ? "Demo connector is available without secrets." : connector.message;
  connector.updatedAt = now();
  return connector;
}
