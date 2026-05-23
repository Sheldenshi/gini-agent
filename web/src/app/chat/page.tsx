"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { BlockRenderer } from "@/components/chat/BlockRenderer";
import { Composer } from "@/components/chat/Composer";
import { SessionItem } from "@/components/chat/SessionItem";
import { api } from "@/lib/api";
import {
  useCancelTask,
  useChatBlocks,
  useChatSessions,
  useDeleteChatSession,
  useInvalidate,
  useRenameChatSession
} from "@/lib/queries";
import { useChatReadState } from "@/lib/use-chat-read-state";
import type { ChatSession } from "@/lib/view-types";

// Terminal phase labels. The runtime emits `phase("Completed" | "Cancelled"
// | "Failed")` as the final block on a task, so the in-flight check below
// can use the latest phase block to decide whether the cancel button is
// active. Keeping the set local (rather than importing TaskStatus) keeps
// the page free of legacy Task derivations — the block stream is the only
// signal we care about.
const TERMINAL_PHASE_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

export default function ChatPage() {
  const sessions = useChatSessions();
  const params = useSearchParams();
  const router = useRouter();
  const initial = params?.get("session") ?? null;
  const [selected, setSelectedState] = useState<string | null>(initial);
  const [text, setText] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const { blocks, isLoading: blocksLoading } = useChatBlocks(selected);
  const invalidate = useInvalidate();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
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

  // Pass the raw query data — `undefined` lets the read-state hook
  // distinguish "list not loaded yet" from "list loaded with zero
  // sessions", which matters for the one-time first-run seeding.
  const { isUnread, markRead, activityAt } = useChatReadState(sessions.data);

  // Whenever the selected session's activity advances (new message or
  // a task on the session finishes while we're viewing it), mark it
  // read so the indicator clears without requiring re-selection.
  const selectedSession = useMemo(
    () => orderedSessions.find((s) => s.id === selected) ?? null,
    [orderedSessions, selected]
  );
  const selectedActivityAt = selectedSession ? activityAt(selectedSession) : null;
  useEffect(() => {
    if (selectedSession) markRead(selectedSession);
  }, [selectedSession?.id, selectedActivityAt, selectedSession, markRead]);

  useEffect(() => {
    if (selected || orderedSessions.length === 0) return;
    // Prefer the newest non-job session so opening the chat page doesn't
    // immediately auto-mark a freshly-spawned job chat as read. Fall back
    // to the newest job session only if that's all that exists.
    const target = orderedSessions.find((s) => s.origin !== "job") ?? orderedSessions[0]!;
    setSelected(target.id);
  }, [selected, orderedSessions, setSelected]);

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

  const deleteSession = useDeleteChatSession();
  const renameSession = useRenameChatSession();
  const cancel = useCancelTask();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [blocks.length, selected]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending || !selected) return;
    send.mutate(trimmed);
  };

  // The in-flight task id is derived from the block stream: scan from the
  // end for the latest phase block — if its label is non-terminal, that
  // task is in flight. Falls back to scanning tool_call blocks in case
  // the loop emitted a tool_call but the next phase hasn't landed yet.
  // The runtime emits a terminal phase("Completed"/"Cancelled"/"Failed")
  // on every task end, so a non-terminal latest phase is a reliable
  // signal that a task is still in motion.
  const inflightTaskId: string | null = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "phase") {
        if (TERMINAL_PHASE_LABELS.has(b.label)) return null;
        return b.taskId ?? null;
      }
      if (b.kind === "tool_call" && b.status === "running") {
        return b.taskId ?? null;
      }
    }
    return null;
  }, [blocks]);

  const confirmDelete = () => {
    const id = pendingDeleteId;
    if (!id) return;
    deleteSession.mutate(id, {
      onSuccess: () => {
        if (selected === id) {
          const next = orderedSessions.find((s) => s.id !== id);
          setSelected(next?.id ?? null);
        }
        setPendingDeleteId(null);
      },
      onError: (error) => {
        toast.error(error.message);
        setPendingDeleteId(null);
      }
    });
  };

  const pendingDeleteSession = pendingDeleteId
    ? orderedSessions.find((s) => s.id === pendingDeleteId) ?? null
    : null;

  const handleRename = (id: string, title: string) => {
    renameSession.mutate(
      { id, title },
      { onError: (error) => toast.error(error.message) }
    );
  };

  // Phase blocks are transient indicators — only render the latest one,
  // and only while it's still active (non-terminal). Historical phase
  // markers ("Thinking" mid-conversation, "Completed" at the end) are
  // internal state transitions; surfacing them in the transcript turns
  // them into permanent noise. Non-phase blocks always render.
  const visibleBlocks = useMemo(() => {
    return blocks.filter((b, i) => {
      if (b.kind !== "phase") return true;
      const isLast = i === blocks.length - 1;
      return isLast && !TERMINAL_PHASE_LABELS.has(b.label);
    });
  }, [blocks]);

  // Map each tool_call's callId to its paired tool_result block so the
  // BlockToolCall renderer can expand-on-click without re-walking the
  // list per row. Tool results don't render as standalone blocks.
  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, (typeof blocks)[number] & { kind: "tool_result" }>();
    for (const b of blocks) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [blocks]);

  const sessionTitle = selectedSession?.title || "New chat";
  const hasBlocks = visibleBlocks.length > 0;

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex min-h-0 w-full shrink-0 flex-col border-b border-border md:w-[260px] md:border-r md:border-b-0">
        <div className="p-2">
          <button
            className="flex h-9 w-full items-center gap-1.5 rounded-lg px-2.5 text-sm font-normal hover:bg-accent disabled:opacity-50"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="size-4" /> New chat
          </button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
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
                    isUnread={selected !== s.id && isUnread(s)}
                    onSelect={() => setSelected(s.id)}
                    onDelete={() => setPendingDeleteId(s.id)}
                    onRename={(title) => handleRename(s.id, title)}
                  />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {orderedSessions.length === 0 ? "No chats yet — start a new one" : "Select a chat"}
          </div>
        ) : blocksLoading && !hasBlocks ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 bg-background px-4 py-3">
              <h1 className="truncate text-base font-semibold">{sessionTitle}</h1>
            </header>

            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {!hasBlocks ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  <ul className="space-y-5">
                    {visibleBlocks.map((block) => (
                      <li key={block.id}>
                        <BlockRenderer
                          block={block}
                          toolResult={
                            block.kind === "tool_call"
                              ? toolResultsByCallId.get(block.callId)
                              : undefined
                          }
                        />
                      </li>
                    ))}
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

      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              {pendingDeleteSession?.title?.trim()
                ? `"${pendingDeleteSession.title}" will be permanently deleted. This cannot be undone.`
                : "This chat will be permanently deleted. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDeleteId(null)}
              disabled={deleteSession.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteSession.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
