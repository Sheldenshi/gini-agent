"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useMemories, useStatus } from "@/lib/queries";
import type { MemoryRecord } from "@runtime/types";
import { HindsightPanel } from "./_components/HindsightPanel";

const SCOPES = ["all", "user", "project", "device", "temporary"] as const;

export default function MemoryPage() {
  const memories = useMemories();
  const status = useStatus();
  const activeAgentName = status.data?.activeAgent?.name;
  const [scope, setScope] = useState<typeof SCOPES[number]>("all");
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const invalidate = useInvalidate();

  const create = useMutation({
    mutationFn: (text: string) =>
      api<MemoryRecord>("/memory", { method: "POST", body: JSON.stringify({ content: text, status: "active" }) }),
    onSuccess: () => {
      setContent("");
      toast.success("Memory added");
      invalidate(["memory", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "reject" }) =>
      api<MemoryRecord>(`/memory/${id}/${op}`, { method: "POST" }),
    onSuccess: () => invalidate(["memory", "state", "audit"])
  });

  const archive = useMutation({
    mutationFn: (id: string) => api<MemoryRecord>(`/memory/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(["memory", "state"])
  });

  const edit = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api<MemoryRecord>(`/memory/${id}`, { method: "PATCH", body: JSON.stringify({ content }) }),
    onSuccess: () => {
      setEditing(null);
      toast.success("Memory updated");
      invalidate(["memory", "state", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const filtered = (memories.data ?? []).filter((m) => scope === "all" || m.scope === scope);

  // Phase 6: hide the legacy panel once every migratable record carries the
  // `migratedToUnitId` breadcrumb. Proposed/rejected rows still bring the
  // legacy panel back so users can curate them in place.
  const allMemories = memories.data ?? [];
  const eligibleForMigration = allMemories.filter((m) => m.status === "active" || m.status === "archived");
  const allMigrated = eligibleForMigration.length > 0 && eligibleForMigration.every((m) => Boolean((m as { metadata?: { migratedToUnitId?: string } }).metadata?.migratedToUnitId));
  const showLegacy = !allMigrated || allMemories.some((m) => m.status === "proposed" || m.status === "rejected");

  return (
    <>
      <PageHeader
        title="Memory"
        description={activeAgentName
          ? `Approve, reject, archive memories with provenance — agent: ${activeAgentName}`
          : "Approve, reject, archive memories with provenance"}
      />
      <div className="flex-1 space-y-6 overflow-auto p-6">
        <HindsightPanel />

        {showLegacy ? (
          <>
            <header>
              <h2 className="text-lg font-semibold">Legacy memories</h2>
              <p className="text-xs text-muted-foreground">
                User-curated MemoryRecord rows. Once every active row is migrated to the Hindsight store this panel hides itself.
              </p>
            </header>

            <Card>
          <CardHeader>
            <CardTitle className="text-sm">Add memory</CardTitle>
            <CardDescription>Active by default. Use proposals from tasks for governed flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="What should Gini remember?" className="min-h-20" />
            <Button disabled={!content.trim() || create.isPending} onClick={() => create.mutate(content.trim())}>
              {create.isPending ? "Adding…" : "Add memory"}
            </Button>
          </CardContent>
        </Card>

        <Tabs value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
          <TabsList>
            {SCOPES.map((value) => (
              <TabsTrigger key={value} value={value} className="capitalize text-xs">
                {value}
              </TabsTrigger>
            ))}
          </TabsList>
          {SCOPES.map((value) => (
            <TabsContent key={value} value={value} className="mt-4">
              {filtered.length === 0 ? (
                <EmptyState title="No memories" />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {filtered.map((memory) => (
                    <Card key={memory.id}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-sm font-medium">{memory.scope}</CardTitle>
                          <StatusPill value={memory.status} />
                        </div>
                        <CardDescription className="font-mono text-[11px]">{memory.id}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {editing?.id === memory.id ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editing.draft}
                              onChange={(event) => setEditing({ id: memory.id, draft: event.target.value })}
                              className="min-h-20"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={!editing.draft.trim() || edit.isPending}
                                onClick={() => edit.mutate({ id: memory.id, content: editing.draft.trim() })}
                              >
                                {edit.isPending ? "Saving…" : "Save"}
                              </Button>
                              <Button size="sm" variant="outline" disabled={edit.isPending} onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm">{memory.content}</p>
                        )}
                        <p className="font-mono text-[10px] text-muted-foreground">
                          conf {memory.confidence.toFixed(2)} · {memory.provenance}
                          {memory.lastUsedAt ? ` · last used ${new Date(memory.lastUsedAt).toLocaleString()}` : ""}
                          {memory.sourceTaskId ? ` · task ${memory.sourceTaskId}` : ""}
                        </p>
                        {editing?.id !== memory.id ? (
                          <div className="flex flex-wrap gap-2">
                            {memory.status === "proposed" ? (
                              <>
                                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: memory.id, op: "approve" })}>Approve</Button>
                                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: memory.id, op: "reject" })}>Reject</Button>
                              </>
                            ) : null}
                            {memory.status !== "archived" && memory.status !== "rejected" ? (
                              <Button size="sm" variant="outline" onClick={() => setEditing({ id: memory.id, draft: memory.content })}>
                                Edit
                              </Button>
                            ) : null}
                            {memory.status === "active" ? (
                              <Button size="sm" variant="outline" disabled={archive.isPending} onClick={() => archive.mutate(memory.id)}>Archive</Button>
                            ) : null}
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
          </>
        ) : null}
      </div>
    </>
  );
}
