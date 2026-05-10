"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ApprovalActions } from "@/components/chat/ApprovalActions";
import { Avatar } from "@/components/chat/Avatar";
import { Composer } from "@/components/chat/Composer";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PhaseIndicator, type PhaseIndicatorPhase } from "@/components/chat/PhaseIndicator";
import { SessionItem } from "@/components/chat/SessionItem";
import { api } from "@/lib/api";
import {
  useCancelTask,
  useChatSession,
  useChatSessions,
  useDeleteChatSession,
  useInvalidate,
  useRenameChatSession
} from "@/lib/queries";
import type { ChatMessage, ChatSession } from "@/lib/view-types";

// Review P1 #3: waiting_approval is intentionally NOT terminal here. It's
// in-flight from the chat UI's perspective — getChatSession synthesizes
// an ephemeral assistant placeholder for it, and the runtime only persists
// a real synced ChatMessageRecord once the task hits completed / failed /
// cancelled. Triggering auto-sync on waiting_approval would (a) blow up
// because syncChatTaskResult now rejects that status, and (b) freeze the
// placeholder text on the previous "Waiting for approval" string.
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled"
]);

export default function ChatPage() {
  const sessions = useChatSessions();
  const params = useSearchParams();
  const router = useRouter();
  const initial = params?.get("session") ?? null;
  const [selected, setSelectedState] = useState<string | null>(initial);
  const [text, setText] = useState("");
  const session = useChatSession(selected);
  const invalidate = useInvalidate();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Tracks taskIds that have already been auto-synced (or are in flight) for
  // the current session view, so the polling effect doesn't refire sync on
  // every 3s tick once the task hits a terminal state.
  const syncedTaskIdsRef = useRef<Set<string>>(new Set());
  // Apply the URL ?session= param ONCE on mount (and again only if the URL
  // itself changes). Using `selected` as a dep would force the user back to
  // the URL session every time they switch chats.
  const appliedInitialRef = useRef(false);

  // setSelected wrapper: also syncs ?session= via router.replace so the URL
  // stays deep-linkable. Use replace (no history entry per click).
  const setSelected = useCallback(
    (id: string | null) => {
      setSelectedState(id);
      if (id) router.replace(`/chat?session=${id}`);
      else router.replace("/chat");
    },
    [router]
  );

  useEffect(() => {
    if (!appliedInitialRef.current && initial) {
      appliedInitialRef.current = true;
      setSelectedState(initial);
    }
  }, [initial]);

  const orderedSessions = useMemo<ChatSession[]>(() => {
    const all = sessions.data ?? [];
    return [...all].sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
    );
  }, [sessions.data]);

  useEffect(() => {
    if (!selected && orderedSessions.length > 0) setSelected(orderedSessions[0]!.id);
  }, [selected, orderedSessions, setSelected]);

  useEffect(() => {
    syncedTaskIdsRef.current = new Set();
  }, [selected]);

  const create = useMutation({
    mutationFn: () =>
      api<ChatSession>("/chat", { method: "POST", body: JSON.stringify({ title: "" }) }),
    onSuccess: (s) => {
      setSelected(s.id);
      invalidate(["chat"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const send = useMutation({
    mutationFn: (content: string) =>
      api<{ taskId: string }>(`/chat/${selected}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    onSuccess: () => {
      setText("");
      invalidate(["chat", "tasks"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const sync = useMutation({
    mutationFn: (taskId: string) =>
      api<ChatMessage>(`/chat/${selected}/tasks/${taskId}/sync`, { method: "POST" }),
    onSuccess: () => invalidate(["chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  const deleteSession = useDeleteChatSession();
  const renameSession = useRenameChatSession();
  const cancel = useCancelTask();

  const messages = session.data?.messages;
  const tasks = session.data?.tasks;

  useEffect(() => {
    if (!messages || !tasks) return;
    const assistantTaskIds = new Set(
      messages.filter((m) => m.role === "assistant" && m.taskId).map((m) => m.taskId as string)
    );
    for (const message of messages) {
      if (message.role !== "user" || !message.taskId) continue;
      if (assistantTaskIds.has(message.taskId)) continue;
      if (syncedTaskIdsRef.current.has(message.taskId)) continue;
      const task = tasks.find((t) => t.id === message.taskId);
      if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) continue;
      syncedTaskIdsRef.current.add(message.taskId);
      sync.mutate(message.taskId);
    }
  }, [messages, tasks, sync]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages?.length, selected]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending || !selected) return;
    send.mutate(trimmed);
  };

  const tasksById = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id, t])),
    [tasks]
  );

  // The "in-flight task" is the latest user message's task whose status is
  // non-terminal. It stays set even once a paired assistant message appears,
  // so streaming/cursor + busy state remain wired until the task is terminal.
  const inflightTaskId: string | null = useMemo(() => {
    if (!messages) return null;
    let userTaskId: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user" && m.taskId) {
        userTaskId = m.taskId;
        break;
      }
    }
    if (!userTaskId) return null;
    const task = tasksById.get(userTaskId);
    if (task && TERMINAL_TASK_STATUSES.has(task.status)) return null;
    return userTaskId;
  }, [messages, tasksById]);

  // Determine the pending assistant phase from the in-flight task. We prefer
  // `currentStep` (which the runtime flips to "Working" before tool dispatch)
  // because plain text generation and tool execution both have status
  // "running"; only currentStep distinguishes them.
  const pendingPhase: PhaseIndicatorPhase | null = useMemo(() => {
    if (!inflightTaskId) return null;
    const task = tasksById.get(inflightTaskId);
    if (!task) return "thinking";
    if (task.currentStep === "Thinking") return "thinking";
    if (task.currentStep === "Working") return "working";
    if (task.currentStep === "Waiting for approval") return "working";
    if (task.status === "queued") return "thinking";
    // Any other tool-specific currentStep ("Reading file", "Executing", …)
    // counts as working.
    return "working";
  }, [inflightTaskId, tasksById]);

  // The assistant message (if any) belonging to the in-flight task — its
  // bubble shows the streaming cursor.
  const streamingAssistantMessageId: string | null = useMemo(() => {
    if (!inflightTaskId || !messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.taskId === inflightTaskId) return m.id;
    }
    return null;
  }, [messages, inflightTaskId]);

  const handleDelete = (id: string) => {
    deleteSession.mutate(id, {
      onSuccess: () => {
        if (selected === id) {
          const next = orderedSessions.find((s) => s.id !== id);
          setSelected(next?.id ?? null);
        }
      },
      onError: (error) => toast.error(error.message)
    });
  };

  const handleRename = (id: string, title: string) => {
    renameSession.mutate(
      { id, title },
      { onError: (error) => toast.error(error.message) }
    );
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col border-b border-border md:w-[260px] md:border-r md:border-b-0">
        <div className="p-2">
          <button
            className="flex h-9 w-full items-center gap-1.5 rounded-lg px-2.5 text-sm font-normal hover:bg-accent disabled:opacity-50"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="size-4" /> New chat
          </button>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 pb-3">
            {orderedSessions.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">No chats yet</p>
            ) : (
              <ul className="space-y-0.5">
                {orderedSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={selected === s.id}
                    onSelect={() => setSelected(s.id)}
                    onDelete={() => handleDelete(s.id)}
                    onRename={(title) => handleRename(s.id, title)}
                  />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {orderedSessions.length === 0 ? "No chats yet — start a new one" : "Select a chat"}
          </div>
        ) : !session.data ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 bg-background px-4 py-3">
              <h1 className="truncate text-base font-semibold">
                {session.data.title || "New chat"}
              </h1>
            </header>

            <ScrollArea className="flex-1">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {!messages || messages.length === 0 ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  <ul className="space-y-5">
                    {messages.map((message) => {
                      // Render inline Approve / Deny on the synthetic
                      // "Waiting for approval..." placeholder — when the
                      // message's task is in waiting_approval state, the user
                      // can resolve the approval without leaving the chat.
                      const messageTask = message.taskId
                        ? tasksById.get(message.taskId)
                        : undefined;
                      const showApprovalActions =
                        message.role === "assistant" &&
                        messageTask?.status === "waiting_approval";
                      return (
                        <li key={message.id}>
                          <MessageBubble
                            message={message}
                            isStreaming={message.id === streamingAssistantMessageId}
                          />
                          {showApprovalActions && message.taskId ? (
                            <div className="ml-[46px] mt-1 max-w-[90%]">
                              <ApprovalActions taskId={message.taskId} />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                    {pendingPhase && !streamingAssistantMessageId ? (
                      <li>
                        <div className="flex items-start gap-2.5">
                          <Avatar />
                          <PhaseIndicator phase={pendingPhase} />
                        </div>
                      </li>
                    ) : null}
                  </ul>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <div className="px-4 pb-4 pt-2">
              <div className="mx-auto w-full max-w-3xl">
                <Composer
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  busy={Boolean(inflightTaskId) || send.isPending}
                  onStop={() => {
                    if (inflightTaskId) {
                      cancel.mutate(inflightTaskId, {
                        onError: (error) => toast.error(error.message)
                      });
                    }
                  }}
                  disabled={!selected}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
