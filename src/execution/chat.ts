import { submitTask } from "../agent";
import {
  addAudit,
  appendLog,
  createChatMessage,
  createChatSession,
  deleteChatSession,
  isTerminalTaskStatus,
  mutateState,
  readState,
  renameChatSession
} from "../state";
import type { ChatMessageRecord, RuntimeConfig, TaskStatus } from "../types";
import { generateStructured } from "../provider";
import { providerOverrideForRuntime, resolveEffectiveContext } from "./effective-context";
import { createConversationRun, linkRunToTask } from "./runs";

// Statuses where a task is no longer producing partial text. Once a task
// reaches one of these, the synthesized streaming message is dropped in
// favor of the synced assistant message (or task error).
//
// waiting_approval is intentionally NOT in this set. Earlier, we persisted
// a real ChatMessageRecord for waiting_approval and
// the syncChatTaskResult short-circuit (`if (existing) return existing`)
// meant the placeholder text never updated even after the task completed.
// We now treat waiting_approval as in-flight and synthesize the placeholder
// ephemerally so it auto-replaces with the real summary on completion.
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

const DEFAULT_CHAT_TITLES: ReadonlySet<string> = new Set([
  "Untitled chat",
  "New chat"
]);

const AUTO_RENAME_USER_TURNS = 2;
const AUTO_RENAME_ASSISTANT_TURNS = 2;

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
  // automatically when approval grants and the task completes;
  // previously we persisted a real ChatMessageRecord for waiting_approval
  // and the sync short-circuit froze the UI at "Waiting for approval".
  //
  // Approval-reason messages (kind: "approval_reason") are durable history
  // bubbles persisted at request_connector time so the user can scroll
  // back and see what they were asked. They are intentionally excluded
  // from this "task already has its summary" check — otherwise the
  // partial-summary streaming bubble for the same task (gws install,
  // gws auth login, etc.) would be suppressed after the approval
  // resolves and the user would see no progress until task completion.
  const syncedAssistantTaskIds = new Set(
    stored
      .filter((m) => m.role === "assistant" && m.taskId && m.kind !== "approval_reason")
      .map((m) => m.taskId as string)
  );
  const synthetic: ChatMessageRecord[] = [];
  for (const task of tasks) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (syncedAssistantTaskIds.has(task.id)) continue;
    let content: string | undefined;
    if (task.status === "waiting_approval") {
      // connector.request approvals now persist their `reason` as a durable
      // assistant message at request_connector time (kind:"approval_reason"),
      // so no placeholder is needed for that case — the real message is in
      // `stored` already.
      const hasPersistedApprovalReason = stored.some(
        (m) => m.role === "assistant" && m.taskId === task.id && m.kind === "approval_reason"
      );
      if (hasPersistedApprovalReason) continue;
      // browser.connect approvals render their own self-describing card in
      // chat ("Connect to agent's browser" + the reason + Connect/Cancel). A
      // generic "Waiting for approval..." bubble next to that card is
      // redundant noise — the card already conveys what's pending. Skip the
      // placeholder when the pending approval(s) for this task are all
      // browser.connect.
      const pendingApprovals = state.approvals.filter(
        (a) => a.taskId === task.id && a.status === "pending"
      );
      if (
        pendingApprovals.length > 0 &&
        pendingApprovals.every((a) => a.action === "browser.connect")
      ) {
        continue;
      }
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
  return { sessionId, runId: run.id, taskId: task.id, status: task.status };
}

export async function syncChatTaskResult(config: RuntimeConfig, sessionId: string, taskId: string) {
  const message = await mutateState(config.instance, (state) => {
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
    // Tasks can have multiple assistant messages — the durable
    // approval-reason bubble (kind: "approval_reason") emitted from
    // request_connector lives alongside the eventual terminal summary.
    // The short-circuit here is only for the *summary*, so it must
    // ignore approval_reason rows.
    const existing = state.chatMessages.find(
      (message) =>
        message.taskId === taskId &&
        message.role === "assistant" &&
        message.kind !== "approval_reason"
    );
    if (existing) return existing;
    // Only sync truly terminal task results into a real ChatMessageRecord.
    // waiting_approval is in-flight — the synthetic
    // placeholder rendered by getChatSession swaps out automatically once
    // approval grants and the task finishes.
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
  if (message) {
    await autoRenameChatAfterTurn(config, sessionId).catch((error) => {
      appendLog(config.instance, "chat.auto_title.failed", {
        sessionId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return message;
}

async function autoRenameChatAfterTurn(config: RuntimeConfig, sessionId: string): Promise<void> {
  const snapshot = readState(config.instance);
  const session = snapshot.chatSessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!isDefaultChatTitle(session.title)) return;
  if (isScheduledJobDeliverySession(snapshot, sessionId)) return;

  const messages = snapshot.chatMessages
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const userTurns = messages.filter((message) => message.role === "user").length;
  const assistantTurns = messages.filter((message) => message.role === "assistant").length;
  if (userTurns < AUTO_RENAME_USER_TURNS || assistantTurns < AUTO_RENAME_ASSISTANT_TURNS) return;

  const title = await generateChatTitle(config, messages);
  if (!title) return;

  await mutateState(config.instance, (state) => {
    const live = state.chatSessions.find((item) => item.id === sessionId);
    if (!live) return undefined;
    if (!isDefaultChatTitle(live.title)) return live;
    if (isScheduledJobDeliverySession(state, sessionId)) return live;
    return renameChatSession(state, sessionId, title);
  });
}

function isDefaultChatTitle(title: string): boolean {
  return DEFAULT_CHAT_TITLES.has(title.trim());
}

function isScheduledJobDeliverySession(state: ReturnType<typeof readState>, sessionId: string): boolean {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (session?.origin === "job") return true;
  return state.jobs.some((job) => job.chatSessionId === sessionId);
}

async function generateChatTitle(
  config: RuntimeConfig,
  messages: ChatMessageRecord[]
): Promise<string | undefined> {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
  if (!transcript) return undefined;

  const result = await generateStructured(
    config,
    {
      schemaName: "ChatTitle",
      echoTag: "chat-title",
      system: [
        "You write concise sidebar titles for chat conversations.",
        "Choose the title from the conversation's actual topic and intent.",
        "Return JSON with one field: title.",
        "Use 2 to 7 words. No quotes, emojis, markdown, punctuation padding, or prefixes like \"Chat about\"."
      ].join(" "),
      user: `Conversation transcript:\n${transcript}`,
      validator: {
        parse(value: unknown) {
          if (!value || typeof value !== "object") return { title: "" };
          const title = (value as { title?: unknown }).title;
          return { title: sanitizeGeneratedChatTitle(title) ?? "" };
        }
      }
    },
    providerOverrideForRuntime(config)
  );
  return result.data.title || undefined;
}

function sanitizeGeneratedChatTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^["'`*_#\s.?!:;,-]+|["'`*_#\s.?!:;,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  if (isDefaultChatTitle(title)) return undefined;
  return title;
}
