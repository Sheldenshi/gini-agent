// Chat-block emission helpers.
//
// The chat-task agent loop in chat-task.ts and the approval-resume path in
// agent.ts both need to land ChatBlock rows (user_text, assistant_text
// streaming deltas, tool_call, tool_result, phase, approval_requested,
// system_note) into the SQLite chat_blocks table that backs the
// `/api/chat/:id/blocks` and `/api/chat/:id/stream` endpoints (see ADR
// chat-block-protocol.md).
//
// This module:
//
//   1. Resolves the (sessionId, agentId, runId) for a given task by
//      walking taskId → task.chatSessionId → ChatSessionRecord. Tasks
//      with no chatSessionId (subagent children, imperative CLI runs)
//      get a no-op shim so the chat-task call sites stay flat.
//   2. Wraps insertChatBlock / upsertAssistantTextBlock /
//      updateToolCallBlock so callers pass the kind-specific fields
//      and don't repeat the resolution boilerplate.
//   3. Wraps the tool-catalog helpers (chatBlockLabelFor /
//      chatBlockArgsPreviewFor) so tool_call emission is one call.
//
// The emit functions are intentionally tolerant of missing context:
// when readState can't find the session (e.g. it was deleted between
// task spawn and emission), they no-op and append a trace line. That
// behavior matches deleteChatSession's cascade delete — clients that
// fetched the block list at the right moment may see partial state,
// but the runtime never crashes mid-loop on a missing session.

import {
  appendTrace,
  insertChatBlock,
  readState,
  updateToolCallBlock,
  upsertAssistantTextBlock,
  type InsertChatBlockInput
} from "../state";
import type {
  AssistantTextBlock,
  AuthorizationAction,
  ChatBlock,
  Instance,
  RiskLevel,
  RuntimeConfig,
  SetupRequestAction,
  SystemNoteAuthError,
  Task,
  ToolCallStatus
} from "../types";
import { chatBlockArgsPreviewFor, chatBlockLabelFor } from "./tool-catalog";
import { redactSensitiveToolArgs } from "./tool-args-redact";

// Resolved chat-task emission context. Callers pass this through every
// per-iteration emission so we don't re-read state on each row.
export interface ChatEmitContext {
  instance: Instance;
  sessionId: string;
  agentId?: string;
  runId?: string;
  taskId: string;
}

// Resolve the emission context for a task. Returns undefined when the
// task has no chatSessionId — e.g. subagent children (per ADR
// chat-block-protocol.md the parent's spawn_subagent tool_call is the
// only visible row from a subagent run) and imperative CLI tasks.
//
// Also returns undefined when the chat session has been deleted since
// task spawn; the emit helpers below treat both cases identically
// (silent no-op + trace line) so call sites don't branch.
export function resolveEmitContext(
  config: RuntimeConfig,
  taskId: string
): ChatEmitContext | undefined {
  const state = readState(config.instance);
  const task: Task | undefined = state.tasks.find((t) => t.id === taskId);
  if (!task?.chatSessionId) return undefined;
  const session = state.chatSessions.find((s) => s.id === task.chatSessionId);
  if (!session) return undefined;
  return {
    instance: config.instance,
    sessionId: task.chatSessionId,
    agentId: task.agentId ?? session.agentId,
    runId: task.runId,
    taskId
  };
}

// Common bookkeeping fields shared by every emit helper. Callers omit
// the kind-specific narrowing fields and we fill in sessionId, taskId,
// runId, agentId from the ChatEmitContext.
type EmitBookkeeping = Pick<ChatEmitContext, "sessionId" | "taskId" | "runId"> & {
  agentId?: string | null;
};

function bookkeepingFor(ctx: ChatEmitContext): EmitBookkeeping {
  return {
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId
  };
}

// Emit a phase block. Used for the "Thinking", "Working: <toolName>",
// "Completed", "Cancelled" markers the chat UI renders between
// substantive blocks. Returns the inserted block (or undefined for
// no-context tasks).
export function emitPhase(
  ctx: ChatEmitContext | undefined,
  label: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "phase",
    label,
    ...bookkeepingFor(ctx)
  });
}

// Emit a system_note block. Used for terminal-bail-out markers
// (cancellation, iteration-cap exhaustion, dispatch error before any
// tool ran) — anything that's runtime-level rather than user- or
// assistant-authored. Pass `authError` for a provider-credential failure
// so the client can name the provider and offer a re-auth CTA (issue #205).
export function emitSystemNote(
  ctx: ChatEmitContext | undefined,
  text: string,
  authError?: SystemNoteAuthError
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "system_note",
    text,
    ...(authError ? { authError } : {}),
    ...bookkeepingFor(ctx)
  });
}

// Emit a user_text block. Called by submitChatMessage right after
// createChatMessage(role:"user", …) — the legacy ChatMessageRecord and
// the new ChatBlock are dual-published during the migration window
// (ADR chat-block-protocol.md migration sequencing).
export function emitUserText(
  ctx: ChatEmitContext | undefined,
  text: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "user_text",
    text,
    ...bookkeepingFor(ctx)
  });
}

// Insert an assistant_text block in `streaming: true` mode on the first
// provider-text delta. Subsequent deltas flow through
// updateAssistantTextDelta with the same id. The terminal flip to
// `streaming: false` flows through finalizeAssistantText, which keeps
// the accreted text intact.
export function emitAssistantTextStart(
  ctx: ChatEmitContext | undefined,
  text: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "assistant_text",
    text,
    streaming: true,
    ...bookkeepingFor(ctx)
  });
  return block.kind === "assistant_text" ? block : undefined;
}

// Update an in-flight assistant_text block. The wire contract is "full
// accreted text on every delta", so callers pass the running total
// rather than the increment — clients merge by id and reconnects are
// idempotent.
export function updateAssistantTextDelta(
  ctx: ChatEmitContext | undefined,
  blockId: string,
  fullText: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const updated = upsertAssistantTextBlock(ctx.instance, blockId, {
    text: fullText,
    streaming: true
  });
  return updated?.kind === "assistant_text" ? updated : undefined;
}

// Flip a streaming assistant_text block to its terminal state with the
// final text. Used both on natural completion (the model's final
// no-tool-call turn) and on cancellation (where the partial text is
// preserved per ADR chat-block-protocol.md risks §4).
export function finalizeAssistantText(
  ctx: ChatEmitContext | undefined,
  blockId: string,
  finalText: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const updated = upsertAssistantTextBlock(ctx.instance, blockId, {
    text: finalText,
    streaming: false
  });
  return updated?.kind === "assistant_text" ? updated : undefined;
}

// Insert a tool_call block in `running` status right before dispatch.
// `argsFull` carries the parsed JSON args with credential-bearing values
// scrubbed via redactSensitiveToolArgs (clients expand to it for the
// "show full args" affordance, so a secret arg — apiKey / token /
// Authorization header — must not land here); `argsPreview` is the inline
// headline (file path / URL / command), capped to 80 chars by
// chatBlockArgsPreviewFor. argsFull is DISPLAY-only — dispatch parses the
// raw tool args independently, so redacting here does not affect execution.
export function emitToolCallRunning(
  ctx: ChatEmitContext | undefined,
  params: {
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "tool_call",
    toolName: params.toolName,
    displayLabel: chatBlockLabelFor(params.toolName),
    argsPreview: chatBlockArgsPreviewFor(params.toolName, params.args),
    argsFull: redactSensitiveToolArgs(params.args),
    status: "running",
    callId: params.callId,
    ...bookkeepingFor(ctx)
  });
}

// Attach a `runningHint` to a tool_call block that's already mounted in
// `running` status. The hint is advisory context a tool emits to explain
// why it's parked — currently only used by tools that block on an
// external event the agent can't drive (e.g. wait_for_messaging_pair
// blocking on an inbound Telegram DM). Clients may render the row more
// prominently when the hint is set; the wire contract is advisory, not a
// new block kind. The hint is cleared automatically when the tool's
// status leaves "running" (see updateToolCallBlock); a no-op when there's
// no emit context (subagent children with no session) or when the block
// can't be found.
export function setToolCallRunningHint(
  ctx: ChatEmitContext | undefined,
  callId: string,
  hint: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const updated = updateToolCallBlock(ctx.instance, callId, ctx.sessionId, { runningHint: hint });
  return updated ?? undefined;
}

// Flip a tool_call row's status (running → ok | error | denied). The
// lookup is by (sessionId, callId) so callers don't need to remember
// the block id — the chat-task loop and the approval-resume path both
// know the call id.
export function emitToolCallStatus(
  ctx: ChatEmitContext | undefined,
  params: {
    callId: string;
    status: ToolCallStatus;
    errorMessage?: string;
    errorSeverity?: "info" | "error";
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const updated = updateToolCallBlock(ctx.instance, params.callId, ctx.sessionId, {
    status: params.status,
    errorMessage: params.errorMessage,
    errorSeverity: params.errorSeverity
  });
  return updated ?? undefined;
}

// Insert a tool_result block. `preview` is the truncated 80-char
// headline of the tool's result string (clients can show an expand
// hint when `truncated` is true). The full transcript continues to
// live on the legacy ChatMessageRecord during the migration window
// and on the task's audit chain.
export function emitToolResult(
  ctx: ChatEmitContext | undefined,
  params: {
    callId: string;
    result: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const MAX = 80;
  const trimmed = params.result.length > MAX
    ? params.result.slice(0, MAX - 1) + "…"
    : params.result;
  return insertChatBlock(ctx.instance, {
    kind: "tool_result",
    callId: params.callId,
    preview: trimmed,
    truncated: params.result.length > MAX,
    ...bookkeepingFor(ctx)
  });
}

// Insert an authorization_requested block when a tool call is gated
// pending user approval/denial (agent-actor flow).
export function emitAuthorizationRequested(
  ctx: ChatEmitContext | undefined,
  params: {
    authorizationId: string;
    action: AuthorizationAction;
    risk: RiskLevel;
    summary: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "authorization_requested",
    authorizationId: params.authorizationId,
    action: params.action,
    risk: params.risk,
    summary: params.summary,
    ...bookkeepingFor(ctx)
  });
}

// Insert a setup_requested block when a tool call needs the user to
// perform a setup step (browser.connect, connector.request, or
// browser.fill_secret). No risk pill is rendered — the rule is
// structural per docs/adr/authorization-vs-setup-request.md.
export function emitSetupRequested(
  ctx: ChatEmitContext | undefined,
  params: {
    setupRequestId: string;
    action: SetupRequestAction;
    summary: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "setup_requested",
    setupRequestId: params.setupRequestId,
    action: params.action,
    summary: params.summary,
    ...bookkeepingFor(ctx)
  });
}

// Trace helper for the no-context branch. Useful when a higher-level
// caller wants to record that a block was suppressed (e.g. a subagent
// child finishing) so the trace has a breadcrumb without the noise of
// a real block emission.
export function traceMissingEmitContext(
  config: RuntimeConfig,
  taskId: string,
  intent: string
): void {
  appendTrace(config.instance, taskId, {
    type: "task",
    message: `Chat block emission skipped: no chat session bound (${intent})`,
    data: { intent }
  });
}

// Helper kept in this module so the type stays adjacent to the helpers
// that consume it. Re-exported for tests that want to construct a
// known-good context without going through resolveEmitContext.
export type { InsertChatBlockInput };
