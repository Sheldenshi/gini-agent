"use client";

import { cn } from "@/lib/utils";
import { COLOR_CLASSES, type EventColor } from "./calendar-colors";
import { type CalendarEvent, getHistoryDotTone } from "./calendar-utils";

interface EventChipProps {
  event: CalendarEvent;
  // Dense renders the inline chat preview's macOS-Calendar look — a filled block
  // with a solid left accent bar and a smaller font that fills the event's
  // duration height — instead of the Jobs tab's ring-outlined chip. The accent is
  // keyed off the event's status (proposed = brand accent, cancel = muted,
  // otherwise a calm teal), not the per-id palette.
  dense?: boolean;
}

// macOS-style accent classes for the dense chip. Each pairs a translucent fill, a
// solid left bar, and a title tone that reads in both light and dark mode.
const DENSE_ACCENT = {
  proposed: {
    bar: "border-l-primary",
    fill: "bg-primary/10 dark:bg-primary/20",
    title: "text-foreground"
  },
  cancel: {
    bar: "border-l-muted-foreground/40",
    fill: "bg-muted/50",
    title: "text-muted-foreground"
  },
  existing: {
    bar: "border-l-teal-500 dark:border-l-teal-400",
    fill: "bg-teal-500/10 dark:bg-teal-500/15",
    title: "text-teal-900 dark:text-teal-100"
  }
} as const;

function denseAccent(status: CalendarEvent["status"]) {
  if (status === "proposed") return DENSE_ACCENT.proposed;
  if (status === "cancel") return DENSE_ACCENT.cancel;
  return DENSE_ACCENT.existing;
}

export function EventChip({ event, dense }: EventChipProps) {
  const classes = COLOR_CLASSES[event.color];
  const historyDotTone = getHistoryDotTone(event.runStatus);
  const accent = denseAccent(event.status);

  const className = dense
    ? cn(
        "flex h-full w-full items-start gap-1 overflow-hidden rounded-[3px] border-l-[3px] px-1.5 py-0.5 text-left",
        accent.fill,
        accent.bar,
        event.dimmed && "opacity-50",
        event.onClick && "cursor-pointer"
      )
    : cn(
        "flex w-full items-center gap-1 rounded-md px-2 py-1 text-left ring-1 ring-inset transition-colors",
        classes.bg,
        classes.hover,
        classes.ring,
        event.dimmed && "opacity-50",
        event.status === "proposed" && "ring-primary",
        event.onClick && "cursor-pointer"
      );
  const title = `${event.title} · ${event.timeLabel}`;

  const inner = dense ? (
    <div className="flex w-full items-center gap-1 overflow-hidden">
      {event.status === "proposed" ? (
        <span className="shrink-0 rounded-[2px] bg-primary px-1 text-[8px] font-semibold tracking-wide uppercase text-primary-foreground">
          Proposed
        </span>
      ) : null}
      <span
        className={cn(
          "truncate text-[11px] leading-tight font-medium",
          accent.title,
          event.status === "cancel" && "line-through"
        )}
      >
        {event.title}
      </span>
      {event.status === "cancel" ? <span className="sr-only">Canceled</span> : null}
    </div>
  ) : (
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
