import { submitTask } from "../agent";
import {
  addAudit,
  createChatMessage,
  createChatSession,
  deleteChatSession,
  isTerminalTaskStatus,
  mutateState,
  readState,
  renameChatSession
} from "../state";
import type { ChatMessageRecord, RuntimeConfig, TaskStatus } from "../types";
import { createConversationRun, linkRunToTask } from "./runs";
import { resolveEffectiveContext } from "./effective-context";

const AUTO_RENAME_USER_TURN_THRESHOLD = 2;
const MAX_AUTO_RENAME_TITLE_LENGTH = 80;
const DEFAULT_RENAMEABLE_TITLES = new Set(["", "new chat", "untitled chat"]);

// Statuses where a task is no longer producing partial text. Once a task
// reaches one of these, the synthesized streaming message is dropped in
// favor of the synced assistant message (or task error).
//
// waiting_approval is intentionally NOT in this set. Persisting a real
// ChatMessageRecord for that state would make syncChatTaskResult's existing
// message guard freeze the placeholder even after the task completes.
// Treat it as in-flight and synthesize the placeholder ephemerally instead.
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

function isDefaultRenameableTitle(title: string): boolean {
  return DEFAULT_RENAMEABLE_TITLES.has(title.trim().toLowerCase());
}

function stripTitleLeadIn(text: string): string {
  let title = text;
  for (const pattern of [
    /^(please|hey|hi|hello)[,\s]+/i,
    /^(can|could|would) you\s+/i,
    /^help me\s+/i
  ]) {
    title = title.replace(pattern, "");
  }
  return title.trim();
}

function truncateTitle(title: string): string {
  const trimmed = title.trim().replace(/[.!?,;:]+$/g, "");
  if (trimmed.length <= MAX_AUTO_RENAME_TITLE_LENGTH) return trimmed;

  const clipped = trimmed.slice(0, MAX_AUTO_RENAME_TITLE_LENGTH - 3);
  const boundary = clipped.lastIndexOf(" ");
  const safe = boundary >= 24 ? clipped.slice(0, boundary) : clipped;
  return `${safe.trimEnd()}...`;
}

function deriveAutoTitle(messages: ChatMessageRecord[]): string | undefined {
  const cleaned = messages
    .map((message) => message.content)
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const candidate = stripTitleLeadIn(cleaned) || cleaned;
  const title = truncateTitle(candidate);
  if (!title) return undefined;
  return `${title[0]!.toUpperCase()}${title.slice(1)}`;
}

function maybeAutoRenameChatSession(config: RuntimeConfig, sessionId: string) {
  return mutateState(config.instance, (state) => {
    const session = state.chatSessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (!isDefaultRenameableTitle(session.title)) return;
    if (state.jobs.some((job) => job.chatSessionId === session.id)) return;

    const userMessages = state.chatMessages
      .filter((message) => message.sessionId === session.id && message.role === "user")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (userMessages.length < AUTO_RENAME_USER_TURN_THRESHOLD) return;

    const title = deriveAutoTitle(userMessages);
    if (!title || title === session.title) return;
    renameChatSession(state, session.id, title);
  });
}

export function listChatSessions(config: RuntimeConfig) {
  const state = readState(config.instance);
  return state.chatSessions.map((session) => ({
    ...session,
    messages: state.chatMessages.filter((message) => message.sessionId === session.id),
    runs: state.runs.filter((run) => session.runIds.includes(run.id))
  }));
}

export function getChatSession(config: RuntimeConfig, id: string) {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);

  const stored = state.chatMessages.filter((message) => message.sessionId === id);
  const tasks = state.tasks.filter((task) => session.taskIds.includes(task.id));

  // Synthesize transient streaming assistant messages: any in-flight task
  // with partialSummary or in waiting_approval that doesn't yet have a
  // synced assistant message gets a virtual ChatMessageRecord so the chat
  // UI sees text mid-flight (or the "Waiting for approval" placeholder).
  // Once the real synced message arrives, this branch is skipped and the
  // synthesized one disappears — the caller never sees both for the same
  // task.
  //
  // waiting_approval is included here so the placeholder updates
  // automatically when approval grants and the task completes; persisting
  // a real message before terminal sync would freeze the UI at the earlier
  // "Waiting for approval" text.
  const syncedAssistantTaskIds = new Set(
    stored.filter((m) => m.role === "assistant" && m.taskId).map((m) => m.taskId as string)
  );
  const synthetic: ChatMessageRecord[] = [];
  for (const task of tasks) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (syncedAssistantTaskIds.has(task.id)) continue;
    let content: string | undefined;
    if (task.status === "waiting_approval") {
      content = task.currentStep || "Waiting for approval...";
    } else if (task.partialSummary) {
      content = task.partialSummary;
    }
    if (!content) continue;
    synthetic.push({
      // Stable id so React's keying stays consistent across polls; switches
      // to the real msg_* id once the task completes and sync runs.
      id: `${task.id}-streaming`,
      instance: state.instance,
      sessionId: id,
      role: "assistant",
      content,
      taskId: task.id,
      runId: task.runId,
      createdAt: task.updatedAt
    });
  }

  const messages = synthetic.length === 0
    ? stored
    : [...stored, ...synthetic].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    ...session,
    messages,
    tasks,
    runs: state.runs.filter((run) => session.runIds.includes(run.id)).map((run) => ({
      ...run,
      planSteps: state.planSteps.filter((step) => step.runId === run.id)
    }))
  };
}

export async function createChat(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => {
    const effective = resolveEffectiveContext(state, config);
    return createChatSession(state, String(input.title ?? "New chat"), undefined, effective.agentId);
  });
}

export async function deleteChat(config: RuntimeConfig, id: string) {
  await mutateState(config.instance, (state) => deleteChatSession(state, id));
  return { ok: true };
}

export async function renameChat(config: RuntimeConfig, id: string, input: Record<string, unknown>) {
  const title = String(input.title ?? "");
  return mutateState(config.instance, (state) => renameChatSession(state, id, title));
}

export async function submitChatMessage(config: RuntimeConfig, sessionId: string, input: Record<string, unknown>) {
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("Chat message content is required.");
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Chat session not found: ${sessionId}`);
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  // Chat messages run through the tool-calling agent loop. The legacy
  // prefix-dispatch path stays available for the imperative CLI.
  // Inherit the session's owning agent so a switch between the chat's
  // creation and this message doesn't reattribute the new task.
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: sessionId,
    agentId: session.agentId
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, { sessionId, role: "user", content, taskId: task.id, runId: run.id });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  await maybeAutoRenameChatSession(config, sessionId);
  return { sessionId, runId: run.id, taskId: task.id, status: task.status };
}

export async function syncChatTaskResult(config: RuntimeConfig, sessionId: string, taskId: string) {
  return mutateState(config.instance, (state) => {
    // Reject a missing session INSIDE the same mutateState so a
    // concurrent chat-session delete can't race past a pre-check
    // (the finalize-job hook does its own pre-check as a fast-path
    // optimization, but the atomic invariant lives here).
    // createChatMessage previously silently skipped the session-
    // linkage step on a missing session — that would have landed an
    // orphan ChatMessageRecord with no session pointing at it.
    const session = state.chatSessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Chat session not found: ${sessionId}`);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const existing = state.chatMessages.find((message) => message.taskId === taskId && message.role === "assistant");
    if (existing) return existing;
    // Only sync truly terminal task results into a real ChatMessageRecord.
    // waiting_approval is in-flight: the synthetic placeholder rendered by
    // getChatSession swaps out automatically once approval grants and the
    // task finishes.
    if (!isTerminalTaskStatus(task.status)) {
      throw new Error(`Task is not ready for chat sync: ${task.status}`);
    }
    // [SILENT] sentinel — emitted by scheduled jobs that have nothing
    // new to report (e.g. a watcher run that found no change). The
    // cron-execution hint instructs the LLM to respond with exactly
    // "[SILENT]" to suppress delivery. We only honor the literal token
    // (trim trailing whitespace tolerantly but reject any other content,
    // including lowercase variants), and only for successfully completed
    // tasks — a failure should still surface in chat.
    if (
      task.status === "completed" &&
      typeof task.summary === "string" &&
      task.summary.trim() === "[SILENT]"
    ) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "chat.message.suppressed_silent",
          target: sessionId,
          taskId,
          risk: "low",
          evidence: { runId: task.runId }
        },
        { taskId }
      );
      return null;
    }
    const content = task.status === "completed"
      ? task.summary ?? "Task completed."
      : task.error ?? task.currentStep ?? `Task is ${task.status}.`;
    const message = createChatMessage(state, { sessionId, role: "assistant", content, taskId, runId: task.runId });
    if (task.runId) {
      const run = state.runs.find((item) => item.id === task.runId);
      if (run) {
        run.assistantMessageId = message.id;
        run.updatedAt = message.createdAt;
      }
    }
    return message;
  });
}
