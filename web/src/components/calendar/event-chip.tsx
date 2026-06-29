"use client";

import { cn } from "@/lib/utils";
import { COLOR_CLASSES, type EventColor } from "./calendar-colors";
import { type CalendarEvent, getHistoryDotTone } from "./calendar-utils";

interface EventChipProps {
  event: CalendarEvent;
}

export function EventChip({ event }: EventChipProps) {
  const classes = COLOR_CLASSES[event.color];
  const historyDotTone = getHistoryDotTone(event.runStatus);

  const className = cn(
    "flex w-full items-center gap-1 rounded-md px-2 py-1 text-left ring-1 ring-inset transition-colors",
    classes.bg,
    classes.hover,
    classes.ring,
    event.dimmed && "opacity-50",
    event.status === "proposed" && "ring-primary",
    event.onClick && "cursor-pointer"
  );
  const title = `${event.title} · ${event.timeLabel}`;

  const inner = (
    <div className="flex w-full items-center gap-1 overflow-hidden">
      {historyDotTone ? (
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", historyDotTone)}
          aria-hidden="true"
        />
      ) : null}
      {event.status === "proposed" ? (
        <span className="shrink-0 rounded bg-primary px-1 text-[9px] font-semibold uppercase text-primary-foreground">
          Proposed
        </span>
      ) : null}
      <span
        className={cn(
          "truncate text-xs font-semibold",
          classes.title,
          event.status === "cancel" && "line-through"
        )}
      >
        {event.title}
      </span>
      {event.status === "cancel" ? <span className="sr-only">Canceled</span> : null}
    </div>
  );

  if (event.onClick) {
    return (
      <button type="button" className={className} onClick={event.onClick} title={title}>
        {inner}
      </button>
    );
  }

  return (
    <div className={className} title={title}>
      {inner}
    </div>
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
