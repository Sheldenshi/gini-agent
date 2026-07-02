"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import { useRuntimeStream } from "@/lib/useRuntimeStream";
import type { AuditEvent, RiskLevel, RuntimeEvent, RuntimeEventKind } from "@runtime/types";
import type { AgentRow } from "@/lib/view-types";

const KIND_OPTIONS: RuntimeEventKind[] = [
  "task",
  "approval",
  "job",
  "memory",
  "skill",
  "connector",
  "mcp",
  "messaging",
  "provider",
  "runtime",
  "notification"
];
const RISK_OPTIONS: RiskLevel[] = ["low", "medium", "high"];

// Sentinel for the "show events from every agent (and unattributable rows)"
// option in the agent dropdown. "active" follows the runtime's active agent;
// any concrete agent id pins the filter to that agent.
const AGENT_FILTER_ALL = "__all__";
const AGENT_FILTER_ACTIVE = "__active__";

export default function ActivityPage() {
  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const [agentFilter, setAgentFilter] = useState<string>(AGENT_FILTER_ACTIVE);
  const effectiveAgentId =
    agentFilter === AGENT_FILTER_ALL
      ? undefined
      : agentFilter === AGENT_FILTER_ACTIVE
        ? activeAgentId
        : agentFilter;
  const eventsPath = effectiveAgentId
    ? `/events?agentId=${encodeURIComponent(effectiveAgentId)}`
    : "/events";
  const auditPath = effectiveAgentId
    ? `/audit?agentId=${encodeURIComponent(effectiveAgentId)}`
    : "/audit";
  // In "Active agent" mode the filter depends on /status resolving the
  // active agent. Defer the fetch in that case so the unfiltered payload
  // doesn't briefly appear on first paint. "All agents" and pinned-agent
  // modes fire immediately because their target is known up-front.
  const ready =
    agentFilter !== AGENT_FILTER_ACTIVE || activeAgentId !== undefined;
  // Keep the filter mode in the cache key so the "All agents" slot (mode
  // ALL, effectiveAgentId=undefined) doesn't share storage with the
  // brief unresolved-active-agent state (mode ACTIVE,
  // effectiveAgentId=undefined). Without the mode segment React Query
  // would serve the all-agents payload to a user who'd selected
  // "Active agent" during the first paint window.
  const events = useQuery<RuntimeEvent[]>({
    queryKey: ["events", agentFilter, effectiveAgentId ?? null],
    queryFn: () => api<RuntimeEvent[]>(eventsPath),
    refetchInterval: 60_000,
    enabled: ready
  });
  const audit = useQuery<AuditEvent[]>({
    queryKey: ["audit", agentFilter, effectiveAgentId ?? null],
    queryFn: () => api<AuditEvent[]>(auditPath),
    refetchInterval: 60_000,
    enabled: ready
  });
  const [search, setSearch] = useState("");
  const [liveCount, setLiveCount] = useState(0);
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());
  const [riskFilter, setRiskFilter] = useState<Set<string>>(new Set());
  const [actorFilter, setActorFilter] = useState<Set<string>>(new Set());

  // Bump the live-tail counter on every event. Query invalidation is handled
  // globally by RuntimeStreamBridge — we share its EventSource via the
  // module-level singleton in useRuntimeStream.
  useRuntimeStream(useCallback(() => {
    setLiveCount((value) => value + 1);
  }, []));

  // Actor filter values are derived from the data (audit log) since there's a
  // small fixed set in practice (user/runtime/agent/system) and we want the
  // chips to reflect what's actually present rather than every theoretical
  // value.
  const actorOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const a of audit.data ?? []) seen.add(a.actor);
    return Array.from(seen).sort();
  }, [audit.data]);

  const filteredEvents = useMemo(() => {
    return (events.data ?? [])
      .filter((event) => {
        if (kindFilter.size > 0 && !kindFilter.has(event.kind)) return false;
        if (riskFilter.size > 0 && !riskFilter.has(event.risk)) return false;
        if (search && !JSON.stringify(event).toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .slice()
      .reverse();
  }, [events.data, kindFilter, riskFilter, search]);

  const filteredAudit = useMemo(() => {
    return (audit.data ?? [])
      .filter((event) => {
        if (actorFilter.size > 0 && !actorFilter.has(event.actor)) return false;
        if (riskFilter.size > 0 && !riskFilter.has(event.risk)) return false;
        if (search && !JSON.stringify(event).toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .slice()
      .reverse();
  }, [audit.data, actorFilter, riskFilter, search]);

  const clearAll = () => {
    setKindFilter(new Set());
    setRiskFilter(new Set());
    setActorFilter(new Set());
    setSearch("");
  };

  const anyActive = kindFilter.size + riskFilter.size + actorFilter.size > 0 || search.length > 0;

  return (
    <>
      <PageHeader
        title="Activity"
        description="Runtime events and audit log with live SSE tail"
        actions={<span className="font-mono text-[11px] text-muted-foreground">{liveCount} live</span>}
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4 md:p-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger aria-label="Filter by agent" size="sm" className="min-w-[10rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AGENT_FILTER_ACTIVE}>Active agent</SelectItem>
                <SelectItem value={AGENT_FILTER_ALL}>All agents</SelectItem>
                {(agentsQuery.data?.agents ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by action, target, summary…"
              className="max-w-md"
            />
            {anyActive ? (
              <Button size="sm" variant="ghost" onClick={clearAll}>
                Clear filters
              </Button>
            ) : null}
          </div>
          <FilterRow label="Kind" options={KIND_OPTIONS} value={kindFilter} onChange={setKindFilter} />
          <FilterRow label="Risk" options={RISK_OPTIONS} value={riskFilter} onChange={setRiskFilter} />
          {actorOptions.length > 0 ? (
            <FilterRow label="Actor" options={actorOptions} value={actorFilter} onChange={setActorFilter} />
          ) : null}
        </div>
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

function FilterRow({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: readonly string[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = (option: string) => {
    const next = new Set(value);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {options.map((option) => {
        const active = value.has(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(option)}
            className={cn(
              "rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
              active
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/40"
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
