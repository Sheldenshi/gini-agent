"use client";

import type { CalendarRunEntry as CronRunLogEntry } from "./types";
import { cn } from "@/lib/utils";
import { COLOR_CLASSES, type EventColor } from "./calendar-colors";
import { type CalendarEvent, getHistoryDotTone } from "./calendar-utils";

interface EventChipProps {
  event: CalendarEvent;
  color: EventColor;
  runEntry?: CronRunLogEntry;
  onClick: (event: CalendarEvent) => void;
}

export function EventChip({ event, color, runEntry, onClick }: EventChipProps) {
  const job = event.job;
  const classes = COLOR_CLASSES[color];
  const historyDotTone = runEntry ? getHistoryDotTone(runEntry.status) : null;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left ring-1 ring-inset transition-colors",
        classes.bg,
        classes.hover,
        classes.ring,
        !job.enabled && "opacity-50"
      )}
      onClick={() => onClick(event)}
      title={`${job.name || job.id} · ${event.timeLabel}`}
    >
      <div className="flex w-full items-center gap-1 overflow-hidden">
        {historyDotTone ? (
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", historyDotTone)}
            aria-hidden="true"
          />
        ) : null}
        <span className={cn("truncate text-xs font-semibold", classes.title)}>
          {job.name || job.id}
        </span>
      </div>
    </button>
  );
}

interface EventDotProps {
  color: EventColor;
}

export function EventDot({ color }: EventDotProps) {
  return (
    <span
      className={cn("inline-block size-1.5 rounded-full", COLOR_CLASSES[color].dot)}
      aria-hidden="true"
    />
  );
}
