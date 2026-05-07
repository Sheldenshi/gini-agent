"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
import type { ChatMessage, ChatSession } from "@/lib/types";

export default function ChatPage() {
  const sessions = useChatSessions();
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const session = useChatSession(selected);
  const invalidate = useInvalidate();

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
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-80 flex-col gap-3">
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

        <Card className="flex flex-1 flex-col overflow-hidden">
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
                        {message.taskId ? (
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">task {message.taskId}</p>
                        ) : null}
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
