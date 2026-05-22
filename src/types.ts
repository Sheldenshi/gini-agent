// `default` is the production end-user install (set by ~/.local/bin/gini).
// Anything else is a developer worktree (auto-derived from the repo dir
// basename) or a named test/smoke instance.
export type Instance = "default" | string;

export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type RiskLevel = "low" | "medium" | "high";

export type SkillStatus = "enabled" | "disabled" | "archived";

export type JobStatus = "active" | "paused" | "failed";

export type ProviderName = "echo" | "openai" | "codex" | "openrouter" | "local";

export type ImprovementStatus = "proposed" | "approved" | "rejected" | "applied";

export type ImprovementKind = "skill" | "job";

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

// Headed-browser connection mode. `managed` means the runtime spawned the
// Chrome process and owns its lifecycle (PID + dedicated user-data-dir).
// `cdp` means the user pointed us at an existing CDP endpoint (e.g. their
// own already-running Chrome) and we never touch the process. The two modes
// share most of the same record so the API stays uniform.
export type BrowserConnectionMode = "managed" | "cdp";

export interface BrowserConnectionRecord {
  mode: BrowserConnectionMode;
  // ws:// CDP debugger URL. For `managed` we discover it by polling the
  // launched Chrome's /json/version endpoint; for `cdp` it's the value the
  // user supplied. Stored normalized (no credentials in the path).
  cdpUrl: string;
  // PID of the Chrome we spawned. Null when mode === "cdp" because we
  // don't own that process and must not signal it on disconnect.
  pid: number | null;
  // Profile directory passed to Chrome via --user-data-dir. Null for
  // mode: "cdp". Survives disconnect so the user's signed-in state stays
  // intact across reconnects.
  dataDir: string | null;
  // Absolute path of the Chrome binary the runtime launched. Null for cdp
  // mode (we never resolved a binary). Useful for surfacing in the UI so
  // users can confirm which install is being driven.
  chromePath: string | null;
  // ISO timestamp of when the connection record was created/updated.
  startedAt: string;
  // True when the managed Chrome was launched with headless: true (no
  // window). Defaults to false / absent for visible managed launches and
  // for cdp mode. Tracked on the record so an idempotent reconnect can
  // detect a headed/headless visibility mismatch and tear down + relaunch
  // when the caller asks for a different visibility than the current
  // record has.
  headless?: boolean;
}

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
  // Provider-specific request fields merged into chat-completions request
  // bodies (tool-calling, structured JSON, vision, and the chat-completions
  // branch of generateTaskSummary). The local and openrouter providers route
  // every call through chat-completions, so extraBody applies everywhere for
  // them. The openai provider uses /responses for generateTaskSummary, so
  // extraBody only applies on its tool-calling, structured, and vision
  // calls. Codex uses /responses with its own shape and ignores extraBody;
  // echo bypasses HTTP entirely.
  //
  // Reserved keys are stripped at send time so extraBody can never override
  // runtime-controlled fields. The base denylist covers fields the runtime
  // unconditionally owns: model, messages, stream, tools, tool_choice,
  // response_format, functions, function_call, store, plus prototype-pollution
  // payloads (__proto__, constructor, prototype) and the JSON.stringify
  // hijack vector (toJSON). Token-budget fields (max_tokens,
  // max_completion_tokens) are allowed in extraBody for
  // chat/structured/tool-calling calls — vision adds them to its own
  // per-call denylist so the runtime's vision budget always wins.
  //
  // Used to push fields like `chat_template_kwargs` for oMLX-served Gemma
  // models that need server-side reasoning toggles
  // (`{enable_thinking: true, preserve_thinking: false}`).
  //
  // extraBody flows through providerHealth/status/trace records — treat it
  // as non-secret transport config. Bearer tokens belong in env vars
  // referenced by `apiKeyEnv`, never in extraBody. Caller is responsible
  // for keeping values JSON-serializable.
  extraBody?: Record<string, unknown>;
}

// Approval policy mode for the per-instance runtime and per-job overlay.
//
// - "strict" — every approval-eligible action creates a pending approval
//   row and pauses the task for a human decision. Matches the legacy
//   pre-flip default.
// - "auto" — the new default. Auto-approve `file.write`, `file.patch`,
//   and `browser.upload_file` unconditionally. For `terminal.exec` and
//   `code_exec`, auto-approve unless the command (or, for `code_exec`,
//   either the shell wrapper OR the raw source — see
//   `matchDangerousSource`) matches a dangerous-pattern entry (see
//   `dangerousTerminalPatterns` + `DEFAULT_DANGEROUS_TERMINAL_PATTERNS`
//   in src/execution/auto-approve.ts). `autoApproveCommands` allowlist
//   always short-circuits any blocklist match — explicit operator opt-in
//   beats a heuristic blocklist hit.
// - "yolo" — full bypass for every approval-gated tool. Same audit
//   contract as the legacy `dangerouslyAutoApprove: true`: each call
//   still produces an approval row (status="approved") and matching
//   audit rows stamped `evidence.autoApproved=true` plus
//   `evidence.autoApprovedReason="approval-mode-yolo"`.
//
// See ADR approval-mode.md for the full audit contract and the
// migration shim that aliases legacy `dangerouslyAutoApprove: true` to
// `approvalMode: "yolo"` on load.
export type ApprovalMode = "strict" | "auto" | "yolo";

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
  // The allowlist always short-circuits the `auto`-mode dangerous-pattern
  // blocklist below — explicit operator opt-in wins over the heuristic.
  autoApproveCommands?: string[];
  // Approval-policy mode. Drives `resolveApprovalPolicy`. Fresh instances
  // default to "auto" via `defaultConfig`. Legacy config files that carry
  // `dangerouslyAutoApprove: true` without an `approvalMode` set are
  // migrated to "yolo" at load time and emit a one-time `config.migrated`
  // audit row. See ADR approval-mode.md.
  approvalMode?: ApprovalMode;
  // Optional operator-supplied list of substring patterns that should
  // GATE a `terminal.exec` call even under `approvalMode: "auto"`. Each
  // entry is matched as a literal substring against the full command
  // string (see `userDangerousPatterns` in
  // `src/execution/auto-approve.ts`). When omitted, only the built-in
  // `DEFAULT_DANGEROUS_TERMINAL_PATTERNS` apply. The
  // `autoApproveCommands` allowlist still short-circuits this list — an
  // explicit allow beats the blocklist.
  dangerousTerminalPatterns?: string[];
  // Deprecated alias for `approvalMode === "yolo"`. Kept on the config
  // shape because (a) older `config.json` files on disk reference it,
  // (b) tests and the `create_job` tool spec accept it, and (c) the
  // `/api/settings/auto-approve` GET response surfaces it as a derived
  // boolean so legacy clients still work. Writes via PATCH are accepted
  // as an alias for `approvalMode: "yolo"`. New code should read
  // `approvalMode` instead. Will be removed in a future release.
  dangerouslyAutoApprove?: boolean;
  // Power-user agent budget knobs. Lives under a nested `agent` namespace so
  // future budgets (token cap, wall-clock cap, etc.) can hang off the same
  // object without further config-shape churn. Validated leniently at the
  // call site — an invalid value falls back to the built-in default.
  agent?: {
    // Hard cap on chat-task loop iterations (model -> tool -> model cycles).
    // When the cap is hit the loop gracefully produces a tool-less final
    // summary instead of failing outright. Must be a positive integer; any
    // non-conforming value falls back to the built-in default.
    maxIterations?: number;
  };
}

export interface RuntimeState {
  version: 1;
  instance: Instance;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  approvals: Approval[];
  audit: AuditEvent[];
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
  // Optional headed-browser connection. Populated by the browser-connect
  // capability and consumed by the session manager in src/tools/browser.ts
  // to switch from headless `chromium.launch()` to `chromium.connectOverCDP()`
  // so authenticated state lives in the user's Chrome profile, not the
  // ephemeral test context. Purely opt-in; legacy state files omit it.
  browser?: BrowserConnectionRecord | null;
  // Per-conversation snapshot of the runtime identity last shown to the
  // agent (instance, port, agent, provider, toolsets, namespace). Drives
  // tell-once-plus-delta system-prompt injection in runChatTask:
  // the first turn emits the full identity, subsequent turns emit only
  // changed fields, and every IDENTITY_FULL_REFRESH_INTERVAL turns the
  // full block is re-emitted to bound the delta-reconstruction depth.
  // Optional so legacy state files don't need a schema migration.
  identitySnapshots?: Record<string, IdentitySnapshotRecord>;
}

// Captured agent-runtime identity surfaced into the system prompt so
// the model can answer self-introspection questions without a tool call.
// Stored on RuntimeState.identitySnapshots so subsequent turns can render
// just the diff instead of the full block on every turn.
export interface AgentIdentity {
  instance: string;
  runtimePort: number;
  agentName: string;
  agentId: string;
  provider: string;
  toolsets: string[];
  memoryNamespace: string;
}

// Per-conversation snapshot of the last-emitted identity plus the turn
// index when the full block was last sent. The full block re-emits when
// (currentTurn - lastFullTurn) >= IDENTITY_FULL_REFRESH_INTERVAL.
export interface IdentitySnapshotRecord {
  identity: AgentIdentity;
  lastFullTurn: number;
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

// Lightweight per-tool-call record surfaced to the chat UI so the user sees
// what the agent is doing while a task is in-flight. This is purely a
// display payload — execution truth still lives in audit/trace/messages.
// Capped on the producing side (~20) so long-running loops don't bloat
// state. Cleared/ignored once the task reaches a terminal status.
export interface ToolCallSummary {
  id: string;          // tool_call_id
  name: string;        // tool name as known to the model
  argsPreview: string; // single-line, truncated args
  status: "running" | "done" | "error";
  startedAt: string;
  completedAt?: string;
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
  // Per-agent isolation key, mirroring MemoryRecord.agentId. Optional because
  // legacy state files predate this field; normalizeState backfills it by
  // stamping the active agent at migration time. Stays undefined for tasks
  // created with no active agent (system-driven flows).
  agentId?: string;
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
  skillIds: string[];
  jobId?: string;
  parentTaskId?: string;
  subagentId?: string;
  runId?: string;
  // Originating chat session, when the task was submitted from a chat
  // message (web UI or messaging bridge). Lets clients link a task back to
  // its conversation without fetching the unscoped chatMessages list to
  // resolve the join. Optional because imperative/CLI tasks don't have a
  // session. normalizeState backfills missing values from chatMessages
  // for state files predating this field.
  chatSessionId?: string;
  cost?: CostRecord;
  // Execution mode. "chat" routes through the tool-calling agent loop in
  // src/execution/chat-task.ts. "imperative" preserves the legacy CLI
  // prefix-dispatch behavior. Defaults to "imperative" for back-compat.
  mode?: TaskMode;
  // Resume state for the chat-task loop while waiting on an approval. Cleared
  // once the loop finishes (completed/failed) so completed tasks don't retain
  // long-lived conversation snapshots in state.
  toolCallState?: TaskToolCallState;
  // Recent tool calls dispatched by the chat-task loop, surfaced to the chat
  // UI as inline rows above the "Working…" indicator. Capped at ~20 entries
  // (oldest dropped). Not persisted as audit truth — these are a display
  // convenience only.
  recentToolCalls?: ToolCallSummary[];
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
  // Originating agent. Optional and meaningful: when undefined, the
  // event is "system-attributed" (instance boot, instance-level config,
  // legacy rows from before agent stamping). Events are never
  // back-filled — missing agentId is preserved as a first-class signal
  // that the row is system-attributed.
  agentId?: string;
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
  // Owning agent (same shape as MemoryRecord.agentId). Optional for legacy
  // sessions; normalizeState backfills with the migration-time active agent.
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  runIds: string[];
  summary?: string;
  // Origin descriptor when the session was created by a non-UI surface.
  // The web chat omits this; messaging bridges (Telegram, Discord) set
  // `kind` to the bridge kind ("telegram" | "discord") with the
  // owning bridge id in a separate `bridgeId` field, so the runtime
  // can mirror assistant replies back out to the chat / channel the
  // user started in. `target` is the bridge-specific addressing
  // string passed back to sendMessagingOutput.
  //
  // `source` doubles as the routing key for inbound: the poller's
  // findOrCreate*ChatSession helpers match on (kind, bridgeId,
  // chatId|channelId), so setting `source` on a session that should
  // NOT receive inbound (e.g., a dedicated job-spawned session that
  // only mirrors OUTBOUND back to the originating chat) would cause
  // the live channel's next inbound to land in the job thread. Use
  // `outboundMirror` for the outbound-only case.
  source?: ChatSessionSource;
  // Outbound-only mirror descriptor. Populated on dedicated job
  // sessions so a scheduled "remind me in 20s" task can dispatch its
  // reply back through the originating bridge without competing with
  // the live channel session for inbound routing. finalize.ts reads
  // `outboundMirror ?? source` so live sessions (where the two are
  // the same) continue to work unchanged.
  outboundMirror?: ChatSessionSource;
  // Marks how the session was created. `"job"` indicates a dedicated
  // session spawned by a scheduled/cron job; the UI uses this to
  // render a job indicator and to keep these chats unread until a
  // human opens them.
  origin?: "job";
}

// `lastInboundMessageId` is the most recent originating-message id the
// chat session received from the bridge — Telegram's numeric
// `message_id` (the per-chat id used by `reply_to_message_id`, NOT
// the update id) or Discord's message snowflake string (used by
// `message_reference.message_id`). It's what scheduled-job replies
// use to thread their delayed dispatch onto the original user
// message. The field is updated by the poller every time a new
// inbound lands so a long-running session always threads onto the
// most recent prompt.
export type ChatSessionSource =
  | { kind: "telegram"; bridgeId: string; chatId: number; target: string; lastInboundMessageId?: number }
  | { kind: "discord"; bridgeId: string; channelId: string; target: string; lastInboundMessageId?: string }
  // Openclaw migration provenance. The poller-side
  // findOrCreate*ChatSession helpers only match on the telegram and
  // discord kinds, so an "openclaw"-sourced session never receives
  // live inbound — it just carries the original openclaw session id
  // so the openclaw migrator can dedup re-apply against the
  // structured field instead of string-matching the title (which the
  // operator can rename via `gini chat rename`).
  | { kind: "openclaw"; openclawSessionId: string; openclawAgentId: string };

export interface ChatMessageRecord {
  id: string;
  instance: Instance;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
  // Optional tag used to distinguish multiple assistant messages emitted by
  // the same task. Today only "approval_reason" is set — when an approval
  // (e.g. connector.request) is created, the runtime persists its `reason`
  // as a durable assistant bubble before the task pauses, so the user can
  // scroll back and see what they were asked. Without this tag, the
  // single-assistant-message-per-task assumption in syncChatTaskResult and
  // getChatSession would either drop the reason or block the final summary
  // from landing. Untagged assistant messages (the default) are the
  // task's terminal summary.
  kind?: string;
}

export interface TraceRecord {
  id: string;
  taskId: string;
  instance: Instance;
  at: string;
  type: "task" | "model" | "tool" | "approval" | "memory" | "job" | "connector" | "error" | "warning";
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
  // Owning agent. Optional for legacy records; backfilled by normalizeState.
  agentId?: string;
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
  // Enabled skill name whitelist. When omitted/empty, the child sees every
  // enabled skill the parent could see. When set, the "Available skills:"
  // block in the system prompt is filtered down to this subset.
  skillNames?: string[];
  // Convenience mirror of the populated child task's summary/error so the
  // parent (or UI) can read terminal results off the subagent record without
  // joining against the task table.
  resultSummary?: string;
  resultError?: string;
}

// Cached `tools/list` entry from an HTTP MCP server. Populated on the
// health probe so the agent loop and the /mcp page can surface what tools
// each server exposes without re-querying on every call.
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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
  // Transport selector. Defaults to "stdio" when omitted to keep the
  // pre-existing CLI-spawn behavior intact for older records. "http"
  // routes invocations through src/integrations/mcp-http.ts.
  transport?: "stdio" | "http";
  // Required when transport === "http". The server's MCP streamable-HTTP
  // endpoint (e.g. https://mcp.linear.app/mcp).
  url?: string;
  // Static or `${ENV}`-placeholder header map applied to each HTTP MCP
  // request. Placeholders are resolved at invoke time against the
  // active-skill env binding map so connector tokens stay encrypted at rest.
  headers?: Record<string, string>;
  // Cached tools/list result from the last successful health probe. Empty
  // until the server has been health-checked.
  tools?: McpToolSpec[];
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
  // Per-bridge encrypted secret refs (Telegram + Discord both store
  // their bot token here). Stored via the same AES-GCM box as
  // connectorSecrets — the connectorId namespace we use is
  // `messaging.<bridgeId>` so a bridge delete cleans up its files.
  secretRefs?: ConnectorSecretRef[];
  // Bridge-kind-specific non-secret state. Kept as a free-form record
  // so each kind can evolve without forcing a schema migration on the
  // others. Current shapes:
  //   telegram: {
  //     botUsername, botId, lastOffset,
  //     allowedChatIds: number[],           // per-chat allowlist (no TOFU)
  //     ownerChatId?: number,               // first-enrolled chat for audit history
  //     recentDeniedChats?: DeniedChatAttempt[],
  //     pairingCode?: string,               // one-shot enroll-via-DM code
  //     pairingCodeExpiresAt?: string       // ISO timestamp; 15-minute TTL
  //   }
  //   discord: {
  //     botUsername, botId, globalName?,
  //     lastInboundExternalIds: Record<channelId, snowflake>  // per-channel watermark
  //   }
  metadata?: Record<string, unknown>;
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
  // Optional media attachment. For outbound: the user-supplied source
  // (url/fileId/path) the bridge dispatched. For inbound: the captured
  // file on disk plus the originating Telegram file_id so the caller can
  // re-download if needed. `text` carries the caption in both directions.
  media?: MessagingMessageMedia;
}

export interface MessagingMessageMedia {
  kind: "photo";
  url?: string;
  fileId?: string;
  path?: string;
}

export interface ImportReport {
  id: string;
  instance: Instance;
  source: ImportSource;
  path: string;
  // `inspect` reports walk a source path without touching it (the historical
  // `gini import inspect` surface). `applied` reports record a migration
  // that actually mutated gini state — produced by `gini import apply
  // openclaw`. The two share storage so the activity feed and audit trail
  // surface every import attempt uniformly.
  mode: "inspect" | "applied";
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
  // Originating agent. Optional and meaningful: when undefined, the
  // audit is "system-attributed" (instance-level config, integration
  // health, legacy entries). Audits are never back-filled — missing
  // agentId is preserved as a first-class signal that the row is
  // system-attributed.
  agentId?: string;
}

export interface Approval {
  id: string;
  instance: Instance;
  // Requesting agent. Optional — backfilled by normalizeState; system-driven
  // approvals without an active agent leave it undefined.
  agentId?: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  action: "file.write" | "file.patch" | "terminal.exec" | "memory.activate" | "skill.enable" | "connector.enable" | "connector.request" | "browser.upload_file" | "browser.connect" | "messaging.send";
  target: string;
  risk: RiskLevel;
  reason: string;
  payload: Record<string, unknown>;
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
  // Frontmatter `metadata.gini.requires.connectors` — declares which provider
  // ids (and optionally scopes) the skill needs to function. The runtime
  // gates the skill out of the agent loop's available-skills set until every
  // entry matches a healthy ConnectorRecord. Defaults to [].
  requiredConnectors?: Array<{ provider: string; scopes?: string[] }>;
  // Spec-compliant top-level `allowed-tools` declaration (space-separated in
  // the source frontmatter, normalized to the original string here). Stored
  // so the UI and install-skill flow can surface it; not enforced yet.
  allowedTools?: string;
  // Spec-compliant top-level `license` and `compatibility` fields.
  license?: string;
  compatibility?: string;
  // Author-declared semver from SKILL.md frontmatter (`metadata.gini.version`,
  // legacy top-level `version`). Distinct from `SkillRecord.version` which is
  // an internal monotonic counter incremented on every detected change. UIs
  // should display this field; the runtime counter is for change detection
  // and `previousVersions` history.
  manifestVersion?: string;
  // Set when the skill fails frontmatter or spec validation (unknown
  // provider, bad name format, etc.). When present, the skill never reaches
  // the activation gate.
  validationStatus?: "ok" | "unsupported";
  validationMessage?: string;
  // Origin of the loaded skill: "bundled" for vendored repo skills (under
  // <repo>/skills/), "user" for skills under ~/.gini/instances/<inst>/skills/.
  // Used by the loader to keep bundled and user records separate. Defaults
  // to "user" for legacy records via normalizeState so older state files keep
  // loading.
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
  // Owning agent. Optional — legacy state files predate this field;
  // normalizeState backfills it on load.
  agentId?: string;
  name: string;
  prompt: string;
  script?: string;
  // Interval-driven schedule. Optional — cron-driven jobs (cronExpression
  // set) carry no intervalSeconds at all. Exactly one of (intervalSeconds,
  // cronExpression) is the active driver per job. The pair is validated
  // at create/update time; the scheduler picks the appropriate advance
  // helper based on which field is set.
  intervalSeconds?: number;
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
  // Per-job auto-approve envelope (see ADR approval-mode.md, "Per-job
  // scope"). When the agent's `create_job` tool schedules an unattended
  // job, it can opt into approval-bypass for just that job's spawned
  // tasks without touching the operator's global RuntimeConfig. All
  // three fields are optional; absent means the job inherits the
  // per-instance RuntimeConfig behavior at fire-time.
  //
  // - `autoApproveCommands` are merged onto the cloned RuntimeConfig at
  //   job-fire time and matched against terminal commands via the same
  //   `matchAutoApprove` allowlist path. Each match produces an audit
  //   row with `evidence.autoApproved=true, autoApprovedReason=<matched
  //   pattern>`.
  // - `approvalMode`, when set, replaces the cloned config's mode for
  //   this job's spawned task only. `"yolo"` is the equivalent of the
  //   legacy `dangerouslyAutoApprove: true`.
  // - `dangerouslyAutoApprove`, when true, is a deprecated alias for
  //   `approvalMode: "yolo"`. Accepted on both create and at fire-time
  //   for back-compat with persisted job records and the `create_job`
  //   tool spec.
  // - `dangerousTerminalPatterns`, when set, overlays onto the cloned
  //   config's blocklist for this job's spawned task only.
  autoApproveCommands?: string[];
  approvalMode?: ApprovalMode;
  dangerousTerminalPatterns?: string[];
  dangerouslyAutoApprove?: boolean;
  // Wall-clock scheduling: when set, this 5-field Unix cron expression
  // drives the job's nextRunAt instead of `intervalSeconds`. Exactly one
  // of (intervalSeconds, cronExpression) is the active driver per job;
  // `createScheduledJob` rejects payloads that supply both explicitly.
  // Cron-driven jobs leave `intervalSeconds` undefined (no sentinel).
  // Legacy state files with `{intervalSeconds: 0, cronExpression: "..."}`
  // are normalized on load (see store.ts normalizer).
  cronExpression?: string;
  // IANA timezone identifier (e.g. "America/Los_Angeles", "Europe/Berlin").
  // Resolved at create time — defaults to "UTC" when `cronExpression` is
  // set but `cronTimezone` is omitted. Croner validates the identifier on
  // construction; an unknown TZ surfaces as `Invalid input: cronTimezone …`.
  cronTimezone?: string;
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
  // Owning agent. Optional — inherits from the parent job at creation time;
  // backfilled by normalizeState for legacy state files.
  agentId?: string;
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

export interface ConnectorSecretRef {
  purpose: string;
  path: string;
}

export interface ConnectorRecord {
  id: string;
  instance: Instance;
  name: string;
  // Discriminator: identifies which provider module handles this connector
  // ("demo", "linear", "claude-code", "codex", "generic", or any module id
  // in the registry). Renamed from `kind` in ADR connector-provider-spec-compliance.md.
  provider: string;
  status: "configured" | "disabled" | "error";
  scopes: string[];
  secretRefs: ConnectorSecretRef[];
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  health: "unknown" | "healthy" | "unhealthy";
  message?: string;
  // Free-form per-record metadata. The `generic` provider uses this to
  // persist non-secret dynamic fields (base URLs, account ids, …) that the
  // user supplies in the Add Connector dialog. Provider-specific keys live
  // under a nested namespace (e.g. `metadata.fields`) by convention.
  metadata?: Record<string, unknown>;
  // Origin marker: "auto" for connectors materialized by the startup
  // detection job (claude-code, codex on PATH); "user" for connectors
  // created via the Add Connector dialog or `gini connector add`. Drives
  // delete semantics — auto records tombstone (status: "disabled") so the
  // detection job won't immediately re-create them, while user records
  // physically delete. Defaults to "user" via normalizeState for legacy
  // records that pre-date this field.
  source?: "auto" | "user";
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
  version?: GiniVersionInfo;
  provider?: ProviderHealth;
  activeAgent?: ActiveAgentSnapshot;
}

export interface GiniVersionInfo {
  packageVersion: string;
  runtimeDir: string;
  git: {
    sha: string | null;
    shortSha: string | null;
    branch: string | null;
    origin: string | null;
    upstreamSha: string | null;
    updateAvailable: boolean;
  };
  installedRuntimePresent: boolean;
  update: {
    supported: boolean;
    reason?: string;
  };
}

export interface GiniUpdateResult {
  beforeSha: string;
  afterSha: string;
  commitCount: string;
  upToDate: boolean;
  runtimeDir: string;
  version: GiniVersionInfo;
  restart?: {
    requested: boolean;
  };
}

export interface ProviderResult {
  provider: ProviderConfig;
  text: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}
