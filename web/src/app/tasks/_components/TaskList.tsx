"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import type { Task } from "@runtime/types";

export interface TaskFilter {
  key: string;
  label: string;
  match: (task: Task) => boolean;
}

export function TaskList({
  tasks,
  filters,
  filter,
  selected,
  onFilterChange,
  onSelect
}: {
  tasks: Task[];
  filters: readonly TaskFilter[];
  filter: string;
  selected: string | null;
  onFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const matcher = filters.find((f) => f.key === filter)?.match ?? (() => true);
  const filtered = tasks.filter(matcher).slice().reverse();
  const activeLabel = filters.find((f) => f.key === filter)?.label ?? filter;
  return (
    <Tabs value={filter} onValueChange={onFilterChange}>
      <TabsList className="w-full">
        {filters.map((f) => (
          <TabsTrigger key={f.key} value={f.key} className="text-xs">
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {filters.map((f) => (
        <TabsContent key={f.key} value={f.key} className="mt-3">
          <ScrollArea className="h-[calc(100vh-360px)]">
            {filtered.length === 0 ? (
              <EmptyState title={`No ${activeLabel.toLowerCase()} tasks`} />
            ) : (
              <ul className="space-y-2">
                {filtered.map((task) => (
                  <li key={task.id}>
                    <button
                      onClick={() => onSelect(task.id)}
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
  );
}
