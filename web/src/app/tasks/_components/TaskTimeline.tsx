"use client";

import type { TraceRecord } from "@runtime/types";

export function TaskTimeline({ trace }: { trace: TraceRecord[] }) {
  if (trace.length === 0) {
    return <p className="text-xs text-muted-foreground">No trace records yet.</p>;
  }
  return (
    <ol className="space-y-1">
      {trace.map((record) => (
        <TimelineRow key={record.id} record={record} />
      ))}
    </ol>
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

export function traceTarget(record: TraceRecord): string | null {
  const data = record.data ?? {};
  // Pull the most-meaningful identifier from the trace data, depending on the
  // tool that recorded it. Mirrors what src/agent.ts puts in `data`.
  const candidates: Array<unknown> = [data.path, data.url, data.command, data.target, data.pattern, data.dir];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
