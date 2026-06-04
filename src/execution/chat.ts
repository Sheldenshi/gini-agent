import { submitTask } from "../agent";
import {
  addAudit,
  appendLog,
  createChatMessage,
  createChatSession,
  deleteChatSession,
  getLatestMessagesBySession,
  insertChatBlock,
  isTerminalTaskStatus,
  listChatBlocks,
  listThreadBlocks,
  mutateState,
  publishChatSession,
  readState,
  renameChatSession
} from "../state";
import type { AssistantTextBlock, AudioAttachment, ChatBlock, ChatMessageRecord, ChatSessionRecord, ImageAttachment, Instance, RuntimeConfig, TaskStatus, UserTextBlock } from "../types";
import { readUpload, uploadStat } from "../state/uploads";
import { getSttProvider } from "../stt";
import { generateStructured, providerAuthFailureText, providerDisplayLabel, providerReauth } from "../provider";
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

// Truncation cap for the latest-message preview attached to each chat
// list row. 140 leaves enough text for a one-liner subtitle on the
// mobile list without ballooning the wire payload.
const LAST_MESSAGE_PREVIEW_CHARS = 140;

export function listChatSessions(config: RuntimeConfig) {
  const state = readState(config.instance);
  // Single SQL pass returns the most recent user_text / assistant_text
  // block per session, so clients can render a "last message" subtitle
  // without N+1 fetches. Sessions with no qualifying blocks fall back to
  // null and the client renders just the title.
  const latestByCallId = getLatestMessagesBySession(config.instance);
  // Pre-index pending gates by taskId so the per-session count below is
  // O(taskIds) instead of O(sessions × approvals). Authorizations and
  // SetupRequests are two parallel approval surfaces with the same
  // "session is awaiting the user" semantics — both contribute to the
  // sidebar indicator.
  const pendingByTaskId = new Map<string, number>();
  for (const auth of state.authorizations) {
    if (auth.status !== "pending" || !auth.taskId) continue;
    pendingByTaskId.set(auth.taskId, (pendingByTaskId.get(auth.taskId) ?? 0) + 1);
  }
  for (const setup of state.setupRequests) {
    if (setup.status !== "pending" || !setup.taskId) continue;
    pendingByTaskId.set(setup.taskId, (pendingByTaskId.get(setup.taskId) ?? 0) + 1);
  }
  return state.chatSessions.map((session) => {
    const raw = latestByCallId.get(session.id) ?? null;
    const lastMessagePreview = raw
      ? raw.length > LAST_MESSAGE_PREVIEW_CHARS
        ? `${raw.slice(0, LAST_MESSAGE_PREVIEW_CHARS).trimEnd()}…`
        : raw
      : null;
    let pendingApprovalCount = 0;
    for (const taskId of session.taskIds) {
      pendingApprovalCount += pendingByTaskId.get(taskId) ?? 0;
    }
    return {
      ...session,
      lastMessagePreview,
      pendingApprovalCount,
      messages: state.chatMessages.filter(
        (message) => message.sessionId === session.id && message.kind !== "tool_transcript"
      ),
      runs: state.runs.filter((run) => session.runIds.includes(run.id))
    };
  });
}

export function getChatSession(config: RuntimeConfig, id: string) {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);

  const stored = state.chatMessages.filter(
    (message) => message.sessionId === id && message.kind !== "tool_transcript"
  );
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
      // SetupRequest cards render their own self-describing UI (Connect /
      // credential inputs / Submit) — a generic "Waiting for approval..."
      // bubble next to that card is redundant. Skip the placeholder when
      // the pending gates for this task are all SetupRequests.
      const pendingAuthorizations = state.authorizations.filter(
        (a) => a.taskId === task.id && a.status === "pending"
      );
      const pendingSetupRequests = state.setupRequests.filter(
        (s) => s.taskId === task.id && s.status === "pending"
      );
      if (pendingAuthorizations.length === 0 && pendingSetupRequests.length > 0) {
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

// Resolves the single canonical chat for an agent in the new chats IA.
// Precedence:
//   1. The most-recently-updated session already marked `kind: "agent"`.
//   2. Otherwise the most-recently-updated non-job, non-bridge session
//      for the agent — promoted to `kind: "agent"` and persisted.
//   3. Otherwise a fresh `kind: "agent"` session is created.
// Other sessions are never merged or deleted; they simply stop being
// surfaced by the new UI. Resolution runs inside a single mutateState so
// the promote/create branches don't race a concurrent caller into two
// canonical chats.
export async function getOrCreateAgentChat(
  instance: Instance,
  agentId: string
): Promise<ChatSessionRecord> {
  return mutateState(instance, (state) => {
    const byRecency = (a: ChatSessionRecord, b: ChatSessionRecord): number =>
      b.updatedAt.localeCompare(a.updatedAt);
    const owned = state.chatSessions.filter((session) => session.agentId === agentId);

    const canonical = owned
      .filter((session) => session.kind === "agent")
      .sort(byRecency)[0];
    if (canonical) return canonical;

    const promotable = owned
      .filter((session) => session.origin !== "job" && session.source === undefined)
      .sort(byRecency)[0];
    if (promotable) {
      promotable.kind = "agent";
      return promotable;
    }

    return createChatSession(state, "New chat", undefined, agentId, undefined, "agent");
  });
}

export async function deleteChat(config: RuntimeConfig, id: string) {
  await mutateState(config.instance, (state) => deleteChatSession(state, id));
  return { ok: true };
}

export async function renameChat(config: RuntimeConfig, id: string, input: Record<string, unknown>) {
  const title = String(input.title ?? "");
  const updated = await mutateState(config.instance, (state) => renameChatSession(state, id, title));
  // Fan the rename out over /api/chat/:id/stream so open SSE
  // subscribers (mobile chat detail, web client) see the new title
  // without a refetch. Publish after mutateState resolves so the
  // disk-write commit precedes the event — matches chat-blocks
  // post-commit semantics.
  publishChatSession(config.instance, updated);
  return updated;
}

function parseAttachments(instance: string, raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;
    // Take the mimeType + size from the STORED upload metadata, not the
    // client's claim. buildAttachmentContent partitions image-vs-file on
    // mimeType, so a forged mimeType could route non-image bytes through the
    // vision image_url path (or hide an image from vision). uploadStat also
    // confirms the id is registered with this instance — a phantom id with no
    // backing bytes throws here rather than pinning a 404 in chat history.
    const stat = uploadStat(instance, id);
    if (!stat) {
      throw new Error(`Invalid input: upload not found: ${id}`);
    }
    out.push({ id, mimeType: stat.mimeType, size: stat.size });
  }
  return out;
}

// Parse the optional voice attachment on a submit. Mirrors the image-upload
// validation: reject a missing/foreign upload id so a client can't pin an
// audio bubble with no backing bytes. The mimeType + size are taken from the
// STORED upload metadata, not the client's claim, so a stray image id can't
// masquerade as a recording and persist as a playable bubble over non-audio
// bytes. The optional client-supplied durationMs is render-only metadata and
// safe to trust.
function parseAudioAttachment(instance: string, raw: unknown): AudioAttachment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
  if (!id || !mimeType) throw new Error("Invalid input: audio attachment requires id and mimeType.");
  const stat = uploadStat(instance, id);
  if (!stat) {
    throw new Error(`Invalid input: audio upload not found: ${id}`);
  }
  if (!stat.mimeType.startsWith("audio/")) {
    throw new Error(`Invalid input: audio attachment must be audio/* (got ${stat.mimeType})`);
  }
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : undefined;
  return { id, mimeType: stat.mimeType, size: stat.size, ...(durationMs !== undefined ? { durationMs } : {}) };
}

// Shared submit preparation for both the main-chat and thread-reply paths.
// Resolves content + image + audio attachments, transcribes a voice message
// when the content is empty, guards against an empty submission, and
// re-validates the session after STT (which can run long enough for the
// session to be deleted mid-flight). Returns the live session so the caller
// inherits the owning agent without re-reading state.
async function prepareChatSubmission(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>
): Promise<{
  content: string;
  images: ImageAttachment[];
  audio: AudioAttachment | undefined;
  liveSession: ChatSessionRecord;
}> {
  let content = String(input.content ?? "").trim();
  const images = parseAttachments(config.instance, input.images);
  const audio = parseAudioAttachment(config.instance, input.audio);
  // Validate the session before transcribing — STT (and, on the first voice
  // message, the one-time model download) is expensive, so a stale or deleted
  // sessionId must fail fast here rather than after the work is done.
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Chat session not found: ${sessionId}`);
  // A voice message arrives with empty content — transcribe the recording so
  // the transcript becomes the message content. The audio itself never
  // reaches the provider; only this transcript does. A transcription failure
  // surfaces as a user-facing error so the client retries rather than posting
  // a do-nothing task with no prompt.
  if (audio && !content) {
    const upload = readUpload(config.instance, audio.id);
    if (upload) {
      try {
        content = (await getSttProvider().transcribe(upload.bytes)).trim();
      } catch (error) {
        appendLog(config.instance, "chat.stt.failed", {
          sessionId,
          uploadId: audio.id,
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error("Could not transcribe the voice message. Please try again.");
      }
    }
  }
  if (!content && images.length === 0) {
    throw new Error(
      audio ? "No speech detected in the voice message." : "Chat message content is required."
    );
  }
  // Re-validate the session: transcription above can run a long time (the
  // first voice message downloads the model), and the chat may have been
  // deleted during that window. Re-read so a delete-during-transcription
  // can't create a run/task/block for a gone session or attribute work to a
  // stale record.
  const liveState = readState(config.instance);
  const liveSession = liveState.chatSessions.find((item) => item.id === sessionId);
  if (!liveSession) throw new Error(`Chat session not found: ${sessionId}`);
  return { content, images, audio, liveSession };
}

export async function submitChatMessage(config: RuntimeConfig, sessionId: string, input: Record<string, unknown>) {
  const { content, images, audio, liveSession } = await prepareChatSubmission(config, sessionId, input);
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  // Chat messages run through the tool-calling agent loop. The legacy
  // prefix-dispatch path stays available for the imperative CLI.
  // Inherit the session's owning agent so a switch between the chat's
  // creation and this message doesn't reattribute the new task.
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: sessionId,
    agentId: liveSession.agentId,
    ...(images.length > 0 ? { images } : {})
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, {
      sessionId,
      role: "user",
      content,
      taskId: task.id,
      runId: run.id,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  // Dual-publish the user_text ChatBlock alongside the legacy
  // ChatMessageRecord during the migration window (ADR
  // chat-block-protocol.md). Both writes are best-effort independent:
  // a SQLite open failure here must not roll back the user's message,
  // and a JSON state failure above must not block the chat-block row
  // (the loop's later emissions tolerate missing user_text). Errors are
  // logged via appendLog so operators can spot drift.
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId,
      text: content,
      taskId: task.id,
      runId: run.id,
      agentId: liveSession.agentId ?? null,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return { sessionId, runId: run.id, taskId: task.id, status: task.status };
}

// Posts a user reply inside an existing thread. The whole spawned task
// threads (decision E: a user reply in a thread stays in the thread
// regardless of the agent's routing directive), so threadId/parentBlockId
// are stamped on the task up front — resolveEmitContext reads them and
// every emit* block lands tagged with the same thread membership.
export async function submitThreadReply(
  config: RuntimeConfig,
  sessionId: string,
  threadId: string,
  input: Record<string, unknown>
) {
  // Resolve the thread's parent_block_id from its existing blocks. A thread
  // with no blocks doesn't exist — reject before doing any STT/run work.
  const threadBlocks = listThreadBlocks(config.instance, sessionId, threadId);
  if (threadBlocks.length === 0) throw new Error(`Thread not found: ${threadId}`);
  const parentBlockId = threadBlocks[0].parentBlockId;
  const { content, images, audio, liveSession } = await prepareChatSubmission(config, sessionId, input);
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: sessionId,
    agentId: liveSession.agentId,
    threadId,
    ...(parentBlockId ? { parentBlockId } : {}),
    ...(images.length > 0 ? { images } : {})
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, {
      sessionId,
      role: "user",
      content,
      taskId: task.id,
      runId: run.id,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  // Dual-publish the user_text ChatBlock, tagged with the thread membership
  // so it renders in the thread panel and threads the response.
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId,
      text: content,
      taskId: task.id,
      runId: run.id,
      agentId: liveSession.agentId ?? null,
      threadId,
      ...(parentBlockId ? { parentBlockId } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // When the client asks to also show the reply in the main transcript,
  // mirror only the user's message (not the agent's threaded response) into
  // the main chat as an un-threaded user_text block. Best-effort like the
  // thread block above.
  if (input.alsoToMain) {
    try {
      insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId,
        text: content,
        taskId: task.id,
        runId: run.id,
        agentId: liveSession.agentId ?? null,
        ...(images.length > 0 ? { images } : {}),
        ...(audio ? { audio } : {})
      });
    } catch (error) {
      appendLog(config.instance, "chat.user_block.insert_failed", {
        sessionId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { sessionId, threadId, runId: run.id, taskId: task.id, status: task.status };
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
    // request_connector lives alongside the eventual terminal summary,
    // and a tool-calling turn persists assistant rows tagged
    // kind:"tool_transcript" (model-facing replay state). The
    // short-circuit here is only for the *summary*, so it must ignore
    // both — otherwise the first tool_transcript assistant row would be
    // mistaken for the terminal summary and suppress the real one.
    const existing = state.chatMessages.find(
      (message) =>
        message.taskId === taskId &&
        message.role === "assistant" &&
        message.kind !== "approval_reason" &&
        message.kind !== "tool_transcript"
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
    // A provider auth failure surfaces the same actionable, provider-named
    // line the chat system note shows the web, so messaging/CLI/text-only
    // clients aren't left with a bare "token expired" (issue #205).
    const content = task.status === "completed"
      ? task.summary ?? "Task completed."
      : task.authErrorProvider
        ? providerAuthFailureText(
            providerDisplayLabel(task.authErrorProvider),
            providerReauth(task.authErrorProvider)
          )
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

export async function autoRenameChatAfterTurn(config: RuntimeConfig, sessionId: string): Promise<void> {
  const snapshot = readState(config.instance);
  const session = snapshot.chatSessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!isDefaultChatTitle(session.title)) return;
  if (isScheduledJobDeliverySession(snapshot, sessionId)) return;

  // Source of truth is chat_blocks (ADR chat-block-protocol.md). The legacy
  // chatMessages table only carries user rows for web-driven chats — assistant
  // text lives in chat_blocks — so a chatMessages-based count would never
  // cross the threshold for the primary UI path.
  const blocks = listChatBlocks(config.instance, sessionId);
  const userBlocks = blocks.filter((b): b is UserTextBlock => b.kind === "user_text");
  const assistantBlocks = blocks.filter(
    (b): b is AssistantTextBlock => b.kind === "assistant_text" && !b.streaming
  );
  if (userBlocks.length < AUTO_RENAME_USER_TURNS || assistantBlocks.length < AUTO_RENAME_ASSISTANT_TURNS) return;

  const title = await generateChatTitleFromBlocks(config, blocks);
  if (!title) return;

  let renamed = false;
  const updated = await mutateState(config.instance, (state) => {
    const live = state.chatSessions.find((item) => item.id === sessionId);
    if (!live) return undefined;
    if (!isDefaultChatTitle(live.title)) return live;
    if (isScheduledJobDeliverySession(state, sessionId)) return live;
    renamed = true;
    return renameChatSession(state, sessionId, title);
  });
  // Publish only when the title actually changed — re-emitting on
  // every turn would push redundant events to subscribers and force
  // them to re-render the header for no reason. The branches above
  // that return `live` (already-titled session, scheduled-job
  // delivery) intentionally skip the publish.
  if (renamed && updated) publishChatSession(config.instance, updated);
}

function isDefaultChatTitle(title: string): boolean {
  return DEFAULT_CHAT_TITLES.has(title.trim());
}

function isScheduledJobDeliverySession(state: ReturnType<typeof readState>, sessionId: string): boolean {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (session?.origin === "job") return true;
  return state.jobs.some((job) => job.chatSessionId === sessionId);
}

async function generateChatTitleFromBlocks(
  config: RuntimeConfig,
  blocks: ChatBlock[]
): Promise<string | undefined> {
  const turns = blocks
    .filter((b) => b.kind === "user_text" || (b.kind === "assistant_text" && !b.streaming))
    .slice(-8)
    .map((b) => {
      const text = (b as UserTextBlock | AssistantTextBlock).text ?? "";
      return `${b.kind === "user_text" ? "User" : "Assistant"}: ${text}`;
    });
  const transcript = turns.join("\n");
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
