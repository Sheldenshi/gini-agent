"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useChatSessions, useInvalidate, useState_, useTask, useTasks } from "@/lib/queries";
import type { Task, TraceRecord } from "@runtime/types";
import type { ChatSession } from "@/lib/view-types";

const FILTERS = [
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
  const [filter, setFilter] = useState<typeof FILTERS[number]["key"]>(initial ? "all" : "active");
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

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!.match;
    return (tasks.data ?? []).filter(f).slice().reverse();
  }, [tasks.data, filter]);

  return (
    <>
      <PageHeader title="Tasks" description="Submit, monitor, and inspect tasks" />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-4 md:w-[420px]">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">New task</CardTitle>
              <CardDescription>e.g. read README.md, write x.txt :: hello</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask Gini to do something"
                className="min-h-24"
              />
              <Button
                disabled={submit.isPending || !input.trim()}
                onClick={() => submit.mutate(input.trim())}
                className="w-full"
              >
                {submit.isPending ? "Submitting…" : "Submit task"}
              </Button>
            </CardContent>
          </Card>

          <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
            <TabsList className="w-full">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.key} value={f.key} className="text-xs">
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {FILTERS.map((f) => (
              <TabsContent key={f.key} value={f.key} className="mt-3">
                <ScrollArea className="h-[calc(100vh-360px)]">
                  {filtered.length === 0 ? (
                    <EmptyState title={`No ${f.label.toLowerCase()} tasks`} />
                  ) : (
                    <ul className="space-y-2">
                      {filtered.map((task) => (
                        <li key={task.id}>
                          <button
                            onClick={() => setSelected(task.id)}
                            className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors ${
                              selected === task.id
                                ? "border-primary bg-accent"
                                : "border-border bg-card hover:bg-accent/50"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="line-clamp-1 text-sm font-medium">{task.title}</span>
                              <StatusPill value={task.status} />
                            </div>
                            <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </TabsContent>
            ))}
          </Tabs>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
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

function TaskDetail({
  data,
  actionPending,
  onAction,
  linkedSession
}: {
  data: { task: Task; trace: TraceRecord[] };
  actionPending: boolean;
  onAction: (op: "retry" | "cancel") => void;
  linkedSession: ChatSession | null;
}) {
  const task = data.task;
  const trace = data.trace;
  const filesChanged = useMemo(() => extractFilesChanged(trace), [trace]);
  const toolsUsed = useMemo(() => extractToolsUsed(trace), [trace]);
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{task.title}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{task.id}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={task.status} />
            <Button size="sm" variant="outline" disabled={actionPending} onClick={() => onAction("retry")}>Retry</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending || ["completed", "cancelled"].includes(task.status)}
              onClick={() => onAction("cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="related">Related</TabsTrigger>
            <TabsTrigger value="trace">Trace</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <Field label="Status" value={task.status} mono />
                  <Field label="Lane" value={task.lane} mono />
                  <Field label="Created" value={new Date(task.createdAt).toLocaleString()} />
                  <Field label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
                  {task.currentStep ? <Field label="Current step" value={task.currentStep} mono /> : null}
                  {task.jobId ? <Field label="Job" value={task.jobId} mono /> : null}
                  {task.parentTaskId ? <Field label="Parent task" value={task.parentTaskId} mono /> : null}
                  {task.subagentId ? <Field label="Subagent" value={task.subagentId} mono /> : null}
                </div>
                <Section title="Input">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{task.input}</pre>
                </Section>
                {task.summary ? (
                  <Section title="Summary">
                    <pre className="whitespace-pre-wrap text-xs">{task.summary}</pre>
                  </Section>
                ) : null}
                {task.error ? (
                  <Section title="Error">
                    <pre className="whitespace-pre-wrap text-xs text-red-400">{task.error}</pre>
                  </Section>
                ) : null}
                {task.cost ? (
                  <Section title="Cost">
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      <Field label="Provider" value={task.cost.provider} mono />
                      <Field label="Model" value={task.cost.model} mono />
                      {typeof task.cost.inputTokens === "number" ? (
                        <Field label="Input tokens" value={task.cost.inputTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.outputTokens === "number" ? (
                        <Field label="Output tokens" value={task.cost.outputTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.totalTokens === "number" ? (
                        <Field label="Total tokens" value={task.cost.totalTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.estimatedUsd === "number" ? (
                        <Field label="Estimated USD" value={`$${task.cost.estimatedUsd.toFixed(4)}`} mono />
                      ) : null}
                    </div>
                  </Section>
                ) : null}
                {linkedSession ? (
                  <Section title="Originated from chat">
                    <Link
                      href={`/chat?session=${linkedSession.id}`}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1 text-xs hover:bg-accent/50"
                    >
                      <span className="truncate">{linkedSession.title || "Untitled session"}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{linkedSession.id}</span>
                    </Link>
                  </Section>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="timeline" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2 pb-6">
                {trace.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No trace records yet.</p>
                ) : (
                  <ol className="space-y-1">
                    {trace.map((record) => (
                      <TimelineRow key={record.id} record={record} />
                    ))}
                  </ol>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="files" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-3 pb-6">
                <Section title={`Files changed (${filesChanged.length})`}>
                  {filesChanged.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No file writes or patches recorded.</p>
                  ) : (
                    <ul className="space-y-1">
                      {filesChanged.map((entry, index) => (
                        <li
                          key={`${entry.path}-${index}`}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[11px]"
                        >
                          <span className="truncate">{entry.path}</span>
                          <span className={entry.kind === "patch" ? "text-amber-400" : "text-emerald-400"}>
                            {entry.kind === "patch" ? "± patch" : "+ write"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={`Tools used (${toolsUsed.length})`}>
                  {toolsUsed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tools recorded.</p>
                  ) : (
                    <ul className="space-y-1">
                      {toolsUsed.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1 text-[11px]"
                        >
                          <span className="truncate">{entry.message}</span>
                          {entry.target ? (
                            <span className="font-mono text-[10px] text-muted-foreground truncate">{entry.target}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title="Artifacts produced">
                  {/* No artifact-typed trace records exist in the current runtime
                      (TraceRecord.type does not include "artifact"). Surface as
                      empty-state rather than fake data; v2 can add an artifact
                      record type and this will populate. */}
                  <p className="text-xs text-muted-foreground">No artifacts recorded.</p>
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="related" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <Section title={`Approvals (${task.approvalIds.length})`}>
                  <IdList ids={task.approvalIds} hint="Open Permissions to act on these." />
                </Section>
                <Section title={`Memory changes (${task.memoryIds.length})`}>
                  <IdList ids={task.memoryIds} hint="Review on the Memory page." />
                </Section>
                <Section title={`Skills used (${task.skillIds.length})`}>
                  <IdList ids={task.skillIds} hint="Inspect on the Skills page." />
                </Section>
                <Section title={`Audit (${task.auditIds.length})`}>
                  <IdList ids={task.auditIds} hint="Cross-reference on the Activity page." />
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="trace" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2 pb-6">
                <p className="text-[11px] text-muted-foreground">{data.trace.length} entries · {task.tracePath}</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(data.trace, null, 2)}
                </pre>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function TimelineRow({ record }: { record: TraceRecord }) {
  // Tone the bullet by record type so the timeline is scannable. Tools are
  // green-ish (work happened), errors red, approvals amber, model/task neutral.
  const tone =
    record.type === "error"
      ? "bg-red-500"
      : record.type === "tool"
        ? "bg-emerald-500"
        : record.type === "approval"
          ? "bg-amber-500"
          : record.type === "memory"
            ? "bg-blue-500"
            : "bg-zinc-500";
  const target = traceTarget(record);
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-card/40 px-2 py-1.5">
      <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs">
            <span className="text-muted-foreground">[{record.type}]</span> {record.message}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground shrink-0">
            {new Date(record.at).toLocaleTimeString()}
          </span>
        </div>
        {target ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">{target}</p>
        ) : null}
      </div>
    </li>
  );
}

function traceTarget(record: TraceRecord): string | null {
  const data = record.data ?? {};
  // Pull the most-meaningful identifier from the trace data, depending on the
  // tool that recorded it. Mirrors what src/agent.ts puts in `data`.
  const candidates: Array<unknown> = [data.path, data.url, data.command, data.target, data.pattern, data.dir];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function extractFilesChanged(trace: TraceRecord[]): Array<{ path: string; kind: "write" | "patch" }> {
  // The agent emits trace.type === "tool" with messages "File written" / "File
  // patched" when an approval is granted (see src/agent.ts:438/462). We pick
  // those out by message rather than tool-name (which isn't in `data`) — the
  // path lives on `data.path`. De-dupe by path+kind to avoid double counting.
  const seen = new Set<string>();
  const out: Array<{ path: string; kind: "write" | "patch" }> = [];
  for (const record of trace) {
    if (record.type !== "tool") continue;
    const path = typeof record.data?.path === "string" ? record.data.path : null;
    if (!path) continue;
    let kind: "write" | "patch" | null = null;
    if (record.message === "File written") kind = "write";
    else if (record.message === "File patched") kind = "patch";
    if (!kind) continue;
    const key = `${kind}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, kind });
  }
  return out;
}

function extractToolsUsed(trace: TraceRecord[]): Array<{ id: string; message: string; target: string | null }> {
  // All trace records with type "tool" represent tool invocations the agent
  // made. We surface message + first useful identifier so the user can see
  // what happened without diving into raw JSON.
  return trace
    .filter((record) => record.type === "tool")
    .map((record) => ({ id: record.id, message: record.message, target: traceTarget(record) }));
}

function IdList({ ids, hint }: { ids: string[]; hint: string }) {
  if (ids.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <>
      <ul className="space-y-1">
        {ids.map((id) => (
          <li key={id} className="rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {id}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </>
  );
}
