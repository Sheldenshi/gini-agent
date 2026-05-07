"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useChatSession, useChatSessions, useInvalidate } from "@/lib/queries";
import type { Task } from "@runtime/types";
import type { ChatMessage, ChatSession } from "@/lib/view-types";

export default function ChatPage() {
  const sessions = useChatSessions();
  const params = useSearchParams();
  // Honor ?session=<id> so other pages (e.g. Tasks "Originated from chat")
  // can deep-link to a specific conversation.
  const initial = params?.get("session") ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const session = useChatSession(selected);
  const invalidate = useInvalidate();

  // If the URL changes to point at a different session, follow it.
  useEffect(() => {
    if (initial && initial !== selected) setSelected(initial);
  }, [initial, selected]);

  useEffect(() => {
    if (!selected && sessions.data && sessions.data.length > 0) setSelected(sessions.data[0].id);
  }, [selected, sessions.data]);

  const create = useMutation({
    mutationFn: (titleValue: string) =>
      api<ChatSession>("/chat", { method: "POST", body: JSON.stringify({ title: titleValue || "New chat" }) }),
    onSuccess: (s) => {
      setTitle("");
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
      invalidate(["chat", "tasks"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const sync = useMutation({
    mutationFn: (taskId: string) => api<ChatMessage>(`/chat/${selected}/tasks/${taskId}/sync`, { method: "POST" }),
    onSuccess: () => invalidate(["chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader title="Chat" description="Local chat sessions backed by tasks" />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-3 md:w-80">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">New session</CardTitle>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
              />
              <Button size="sm" disabled={!title.trim() || create.isPending} onClick={() => create.mutate(title.trim())}>
                Create
              </Button>
            </CardContent>
          </Card>
          <ScrollArea className="flex-1">
            {(sessions.data ?? []).length === 0 ? (
              <EmptyState title="No sessions" description="Create one to start chatting." />
            ) : (
              <ul className="space-y-2">
                {(sessions.data ?? []).slice().reverse().map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelected(s.id)}
                      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                        selected === s.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                      }`}
                    >
                      <div className="line-clamp-1 text-sm font-medium">{s.title}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{s.id}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!selected ? (
            <CardContent className="flex flex-1 items-center justify-center">
              <EmptyState title="No session selected" />
            </CardContent>
          ) : session.data ? (
            <>
              <CardHeader className="border-b border-border">
                <CardTitle className="text-sm">{session.data.title}</CardTitle>
                <CardDescription className="font-mono text-[11px]">{session.data.id}</CardDescription>
              </CardHeader>
              <ScrollArea className="flex-1 p-4">
                {session.data.messages.length === 0 ? (
                  <EmptyState title="No messages yet" description="Send a message to begin." />
                ) : (
                  <ul className="space-y-3">
                    {session.data.messages.map((message) => (
                      <li
                        key={message.id}
                        className={`rounded-md border px-3 py-2 ${
                          message.role === "user" ? "border-primary/40 bg-primary/5" : "border-border bg-card"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <StatusPill value={message.role} />
                          {message.taskId ? (
                            <Button size="sm" variant="ghost" onClick={() => sync.mutate(message.taskId!)} disabled={sync.isPending}>
                              Sync result
                            </Button>
                          ) : null}
                        </div>
                        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                        {message.taskId ? <InlineTaskCard taskId={message.taskId} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
              <div className="border-t border-border p-3">
                <Textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Send a message…"
                  className="mb-2 min-h-20"
                />
                <Button disabled={!text.trim() || send.isPending} onClick={() => send.mutate(text.trim())}>
                  {send.isPending ? "Sending…" : "Send (creates task)"}
                </Button>
              </div>
            </>
          ) : (
            <CardContent className="flex flex-1 items-center justify-center">
              <EmptyState title="Loading…" />
            </CardContent>
          )}
        </Card>
      </div>
    </>
  );
}

function InlineTaskCard({ taskId }: { taskId: string }) {
  // Minimal structured card for chat: surfaces the linked task's status,
  // summary, and approval/cost hints inline without leaving the conversation.
  // The runtime returns full task records via /tasks/:id; we render selectively
  // to keep the chat dense.
  const detail = useQuery({
    queryKey: ["chat-task", taskId],
    queryFn: () => api<{ task: Task }>(`/tasks/${taskId}`),
    refetchInterval: 4000
  });
  if (!detail.data) {
    return <p className="mt-1 font-mono text-[10px] text-muted-foreground">task {taskId} · loading…</p>;
  }
  const task = detail.data.task;
  return (
    <div className="mt-2 rounded-md border border-border bg-card/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill value={task.status} />
        <span className="font-mono text-[10px] text-muted-foreground">task {task.id}</span>
        {task.approvalIds.length > 0 ? (
          <span className="font-mono text-[10px] text-amber-400">{task.approvalIds.length} approval{task.approvalIds.length === 1 ? "" : "s"}</span>
        ) : null}
        {task.cost?.estimatedUsd ? (
          <span className="font-mono text-[10px] text-muted-foreground">${task.cost.estimatedUsd.toFixed(4)}</span>
        ) : null}
      </div>
      {task.summary ? <p className="mt-1 text-xs">{task.summary}</p> : null}
      {task.error ? <p className="mt-1 text-xs text-red-400">{task.error}</p> : null}
    </div>
  );
}
