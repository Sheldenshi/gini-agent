"use client";

import { useCallback, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { useAudit, useEvents, useInvalidate } from "@/lib/queries";
import { useRuntimeStream } from "@/lib/useRuntimeStream";

export default function ActivityPage() {
  const audit = useAudit();
  const events = useEvents();
  const invalidate = useInvalidate();
  const [search, setSearch] = useState("");
  const [liveCount, setLiveCount] = useState(0);

  useRuntimeStream(useCallback(() => {
    setLiveCount((value) => value + 1);
    invalidate(["events", "audit", "state", "tasks", "approvals", "jobs", "memory", "skills"]);
  }, [invalidate]));

  const filteredAudit = useMemo(
    () => (audit.data ?? []).filter((event) => !search || JSON.stringify(event).toLowerCase().includes(search.toLowerCase())).slice().reverse(),
    [audit.data, search]
  );

  const filteredEvents = useMemo(
    () => (events.data ?? []).filter((event) => !search || JSON.stringify(event).toLowerCase().includes(search.toLowerCase())).slice().reverse(),
    [events.data, search]
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Runtime events and audit log with live SSE tail"
        actions={<span className="font-mono text-[11px] text-muted-foreground">{liveCount} live</span>}
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-6">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by action, target, actor, risk…" className="max-w-md" />
        <Tabs defaultValue="events" className="flex flex-1 flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>
          <TabsContent value="events" className="flex-1 overflow-hidden">
            <Card className="flex h-full flex-col overflow-hidden">
              <CardHeader>
                <CardTitle className="text-sm">Runtime events</CardTitle>
                <CardDescription>Streamed via /api/events/stream</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden">
                <ScrollArea className="h-full pr-3">
                  {filteredEvents.length === 0 ? (
                    <EmptyState title="No events match" />
                  ) : (
                    <ul className="space-y-1.5">
                      {filteredEvents.map((event) => (
                        <li key={event.id} className="flex items-start gap-3 rounded-md border border-border bg-card/50 px-3 py-2">
                          <StatusPill value={event.kind} />
                          <RiskPill value={event.risk} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{event.summary || event.action}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {event.action} · {event.target}
                              {event.taskId ? ` · task ${event.taskId}` : ""}
                              {event.jobId ? ` · job ${event.jobId}` : ""}
                            </p>
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">{new Date(event.at).toLocaleTimeString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="audit" className="flex-1 overflow-hidden">
            <Card className="flex h-full flex-col overflow-hidden">
              <CardHeader>
                <CardTitle className="text-sm">Audit log</CardTitle>
                <CardDescription>Authoritative record of decisions and side effects</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden">
                <ScrollArea className="h-full pr-3">
                  {filteredAudit.length === 0 ? (
                    <EmptyState title="No audit entries match" />
                  ) : (
                    <ul className="space-y-1.5">
                      {filteredAudit.map((event) => (
                        <li key={event.id} className="flex items-start gap-3 rounded-md border border-border bg-card/50 px-3 py-2">
                          <StatusPill value={event.actor} />
                          <RiskPill value={event.risk} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-mono text-sm">{event.action}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {event.target}
                              {event.taskId ? ` · task ${event.taskId}` : ""}
                              {event.approvalId ? ` · approval ${event.approvalId}` : ""}
                            </p>
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">{new Date(event.at).toLocaleTimeString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
