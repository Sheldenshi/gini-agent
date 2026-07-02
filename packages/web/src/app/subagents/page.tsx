"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useSubagents } from "@/lib/queries";
import type { SubagentRecord } from "@runtime/types";

export default function SubagentsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const subagents = useSubagents();
  const invalidate = useInvalidate();

  const cancel = useMutation({
    mutationFn: (id: string) => api<SubagentRecord>(`/subagents/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: (record) => {
      toast.success(`Cancelled ${record.name}`);
      invalidate(["subagents", "tasks", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const items = subagents.data ?? [];
  const detail = items.find((s) => s.id === selected) ?? items[0];
  const detailActive = detail && (detail.status === "queued" || detail.status === "running");

  return (
    <>
      <PageHeader
        title="Subagents"
        description="Constrained child agents spawned by the runtime"
      />
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-80 flex-col gap-3">
          {items.length === 0 ? (
            <EmptyState title="No subagents" description="Subagents appear here once the agent delegates work." />
          ) : (
            <ul className="space-y-2 overflow-auto">
              {items.map((sub) => (
                <li key={sub.id}>
                  <button
                    onClick={() => setSelected(sub.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      detail?.id === sub.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-sm font-medium">{sub.name}</span>
                      <StatusPill value={sub.status} />
                    </div>
                    <span className="line-clamp-1 font-mono text-[10px] text-muted-foreground">{sub.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!detail ? (
            <EmptyState title="No subagent selected" />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{detail.name}</CardTitle>
                    <CardDescription className="font-mono text-[11px]">
                      {detail.id}
                      {detail.parentTaskId ? ` · parent ${detail.parentTaskId}` : ""}
                      {detail.taskId ? ` · child ${detail.taskId}` : ""}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill value={detail.status} />
                    {detailActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(detail.id)}
                      >
                        {cancel.isPending ? "Cancelling…" : "Cancel"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt</h4>
                  <p className="whitespace-pre-wrap text-sm">{detail.prompt || "(empty)"}</p>
                </div>
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Constraints</h4>
                  <ul className="space-y-1 text-sm">
                    <li>
                      <span className="text-muted-foreground">toolsets: </span>
                      <span className="font-mono text-[12px]">
                        {detail.toolsetIds && detail.toolsetIds.length > 0
                          ? detail.toolsetIds.join(", ")
                          : detail.toolsets.length > 0
                            ? `${detail.toolsets.join(", ")} (advertised)`
                            : "(inherit)"}
                      </span>
                    </li>
                    <li>
                      <span className="text-muted-foreground">skills: </span>
                      <span className="font-mono text-[12px]">
                        {detail.skillNames && detail.skillNames.length > 0 ? detail.skillNames.join(", ") : "(inherit)"}
                      </span>
                    </li>
                  </ul>
                </div>
                {detail.systemPrompt ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowSystemPrompt((v) => !v)}
                      className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    >
                      {showSystemPrompt ? "▼" : "▶"} System prompt
                    </button>
                    {showSystemPrompt ? (
                      <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] whitespace-pre-wrap">
                        {detail.systemPrompt}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
                {detail.resultSummary || detail.summary ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result summary</h4>
                    <p className="whitespace-pre-wrap text-sm">{detail.resultSummary ?? detail.summary}</p>
                  </div>
                ) : null}
                {detail.resultError || detail.error ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Error</h4>
                    <p className="whitespace-pre-wrap text-sm text-red-400">{detail.resultError ?? detail.error}</p>
                  </div>
                ) : null}
                <p className="font-mono text-[10px] text-muted-foreground">
                  created {new Date(detail.createdAt).toLocaleString()}
                  {detail.completedAt ? ` · completed ${new Date(detail.completedAt).toLocaleString()}` : ""}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
