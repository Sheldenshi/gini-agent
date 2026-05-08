"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useChatSession, useChatSessions, useInvalidate } from "@/lib/queries";
import type { ChatMessage, ChatSession } from "@/lib/view-types";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "waiting_approval"]);

export default function ChatPage() {
  const sessions = useChatSessions();
  const params = useSearchParams();
  const initial = params?.get("session") ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const [text, setText] = useState("");
  const session = useChatSession(selected);
  const invalidate = useInvalidate();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Tracks taskIds that have already been auto-synced (or are in flight) for
  // the current session view, so the polling effect doesn't refire sync on
  // every 3s tick once the task hits a terminal state.
  const syncedTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (initial && initial !== selected) setSelected(initial);
  }, [initial, selected]);

  useEffect(() => {
    if (!selected && sessions.data && sessions.data.length > 0) setSelected(sessions.data[0].id);
  }, [selected, sessions.data]);

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
      api<{ taskId: string }>(`/chat/${selected}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    onSuccess: () => {
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      invalidate(["chat", "tasks"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const sync = useMutation({
    mutationFn: (taskId: string) => api<ChatMessage>(`/chat/${selected}/tasks/${taskId}/sync`, { method: "POST" }),
    onSuccess: () => invalidate(["chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

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

  const handleTextareaInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    const el = event.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending || !selected) return;
    send.mutate(trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const sortedSessions = (sessions.data ?? [])
    .slice()
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col border-b border-border md:w-[260px] md:border-r md:border-b-0">
        <div className="p-2">
          <button
            className="flex h-9 w-full items-center gap-1.5 rounded-[10px] px-2.5 text-sm font-normal hover:bg-accent disabled:opacity-50"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="size-4" /> New chat
          </button>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 pb-3">
            {sortedSessions.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">No chats yet</p>
            ) : (
              <ul className="space-y-0.5">
                {sortedSessions.map((s) => {
                  const isActive = selected === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => setSelected(s.id)}
                        className={`flex h-9 w-full items-center truncate rounded-[10px] px-2.5 text-sm font-normal transition-colors ${
                          isActive
                            ? "bg-accent text-foreground"
                            : "text-foreground/80 hover:bg-accent/60"
                        }`}
                      >
                        {s.title || "New chat"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {sortedSessions.length === 0 ? "No chats yet — start a new one" : "Select a chat"}
          </div>
        ) : !session.data ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 bg-background px-4 py-3">
              <h1 className="truncate text-base font-semibold">{session.data.title || "New chat"}</h1>
            </header>

            <ScrollArea className="flex-1">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {!messages || messages.length === 0 ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  <ul className="space-y-6">
                    {messages.map((message, index) => {
                      const isUser = message.role === "user";
                      const nextMessage = messages[index + 1];
                      const hasPairedAssistant =
                        isUser &&
                        message.taskId &&
                        messages.some((m) => m.role === "assistant" && m.taskId === message.taskId);
                      const linkedTask =
                        isUser && message.taskId ? tasks?.find((t) => t.id === message.taskId) : undefined;
                      const showPending =
                        isUser &&
                        message.taskId &&
                        !hasPairedAssistant &&
                        (!linkedTask || !TERMINAL_TASK_STATUSES.has(linkedTask.status)) &&
                        (!nextMessage || nextMessage.role !== "assistant");
                      return (
                        <li key={message.id} className="space-y-2">
                          {isUser ? (
                            <div className="flex justify-end">
                              <div className="max-w-[80%] whitespace-pre-wrap rounded-3xl bg-muted px-5 py-2.5 text-base leading-7">
                                {message.content}
                              </div>
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap text-base leading-7 text-foreground">
                              {message.content}
                            </div>
                          )}
                          {showPending ? (
                            <div className="flex items-center gap-1.5 py-2">
                              <span className="size-2 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
                              <span className="size-2 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
                              <span className="size-2 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <div className="px-4 pb-4 pt-2">
              <div className="mx-auto w-full max-w-3xl">
                <div className="relative flex items-end rounded-[28px] bg-background p-2.5 shadow-[0_3px_6px_rgba(0,0,0,0.04),0_4px_80px_8px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[0_3px_6px_rgba(0,0,0,0.2),0_4px_80px_8px_rgba(0,0,0,0.2),0_0_0_1px_rgba(255,255,255,0.08)]">
                  <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={handleTextareaInput}
                    onKeyDown={handleKeyDown}
                    placeholder="Send a message…"
                    rows={1}
                    className="max-h-[200px] flex-1 resize-none bg-transparent px-3 py-2 text-base leading-7 outline-none placeholder:text-muted-foreground"
                  />
                  <Button
                    size="icon-sm"
                    className="m-2 rounded-full"
                    disabled={!text.trim() || send.isPending}
                    onClick={submit}
                    aria-label="Send"
                  >
                    <Send className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
