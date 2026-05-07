"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useChatSessions, useInvalidate, useState_, useTask, useTasks } from "@/lib/queries";
import type { Task, TraceRecord } from "@runtime/types";
import type { ChatSession } from "@/lib/view-types";
import { SubmitForm } from "./_components/SubmitForm";
import { TaskList, type TaskFilter } from "./_components/TaskList";
import { TaskDetail } from "./_components/TaskDetail";

const FILTERS: readonly TaskFilter[] = [
  { key: "active", label: "Active", match: (t: Task) => ["queued", "running", "waiting_approval"].includes(t.status) },
  { key: "waiting", label: "Waiting", match: (t: Task) => t.status === "waiting_approval" },
  { key: "scheduled", label: "Scheduled", match: (t: Task) => Boolean(t.jobId) && (t.status === "queued" || t.status === "running") },
  { key: "completed", label: "Completed", match: (t: Task) => t.status === "completed" },
  { key: "failed", label: "Failed", match: (t: Task) => t.status === "failed" || t.status === "cancelled" },
  { key: "all", label: "All", match: () => true }
] as const;

export default function TasksPage() {
  const params = useSearchParams();
  // Honor ?id=<task-id> so other pages (e.g. Jobs "View trace") deep-link
  // straight into a specific task. Falls back to "all" filter so the task
  // is visible in the list panel.
  const initial = params?.get("id") ?? null;
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<string>(initial ? "all" : "active");
  const [selected, setSelected] = useState<string | null>(initial);
  const tasks = useTasks();
  const detail = useTask(selected);
  const invalidate = useInvalidate();

  useEffect(() => {
    if (initial && initial !== selected) {
      setSelected(initial);
      setFilter("all");
    }
  }, [initial, selected]);

  const submit = useMutation({
    mutationFn: (text: string) => api<Task>("/tasks", { method: "POST", body: JSON.stringify({ input: text }) }),
    onSuccess: (task) => {
      toast.success(`Task submitted: ${task.id}`);
      setInput("");
      setSelected(task.id);
      invalidate(["tasks", "state", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "retry" | "cancel" }) =>
      api<Task>(`/tasks/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["tasks", "task", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader title="Tasks" description="Submit, monitor, and inspect tasks" />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-4 md:w-[420px]">
          <SubmitForm
            input={input}
            pending={submit.isPending}
            onChange={setInput}
            onSubmit={() => submit.mutate(input.trim())}
          />
          <TaskList
            tasks={tasks.data ?? []}
            filters={FILTERS}
            filter={filter}
            selected={selected}
            onFilterChange={setFilter}
            onSelect={setSelected}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!selected ? (
            <EmptyState title="Select a task" description="Pick one from the list to see details and trace." />
          ) : detail.data ? (
            <TaskDetailContainer
              data={detail.data}
              actionPending={action.isPending}
              onAction={(op) => action.mutate({ id: detail.data!.task.id, op })}
            />
          ) : (
            <EmptyState title="Loading…" />
          )}
        </div>
      </div>
    </>
  );
}

function TaskDetailContainer({
  data,
  actionPending,
  onAction
}: {
  data: { task: Task; trace: TraceRecord[] };
  actionPending: boolean;
  onAction: (op: "retry" | "cancel") => void;
}) {
  // We need chatMessages + chatSessions to find the originating conversation.
  // /state already includes both; we don't need a new endpoint. The query is
  // already polling so this is cheap.
  const state = useState_();
  const chats = useChatSessions();
  const linkedSession = useMemo<ChatSession | null>(() => {
    const messages = state.data?.chatMessages ?? [];
    const taskId = data.task.id;
    // ChatMessageRecord stores singular taskId per message — find the message
    // whose taskId matches, then resolve to its session via sessionId.
    const message = messages.find((m) => m.taskId === taskId);
    if (!message) return null;
    return (chats.data ?? []).find((s) => s.id === message.sessionId) ?? null;
  }, [state.data?.chatMessages, chats.data, data.task.id]);
  return (
    <TaskDetail
      data={data}
      actionPending={actionPending}
      onAction={onAction}
      linkedSession={linkedSession}
    />
  );
}
