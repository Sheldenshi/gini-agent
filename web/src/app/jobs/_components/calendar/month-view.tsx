"use client";

import type { CalendarRunEntry as CronRunLogEntry } from "./types";
import { cn } from "@/lib/utils";
import type { EventColor } from "./calendar-colors";
import {
  type CalendarEvent,
  dayKey,
  isSameDay,
  isSameMonth,
  runKey,
  WEEKDAY_LABELS
} from "./calendar-utils";
import { EventChip } from "./event-chip";

interface MonthViewProps {
  days: Date[];
  focusDate: Date;
  today: Date;
  eventsByDay: Map<string, CalendarEvent[]>;
  jobColors: Map<string, EventColor>;
  runStatusMap: Map<string, CronRunLogEntry>;
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (date: Date) => void;
}

export function MonthView({
  days,
  focusDate,
  today,
  eventsByDay,
  jobColors,
  runStatusMap,
  onEventClick,
  onDayClick
}: MonthViewProps) {
  const rows = Math.ceil(days.length / 7);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="flex items-center justify-center border-b border-border bg-muted/40 px-1 py-2.5 md:justify-start md:px-4"
          >
            <span className="text-xs font-semibold text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div
        className="grid flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {days.map((day) => {
          const key = dayKey(day);
          const dayEvents = eventsByDay.get(key) ?? [];
          const overflowCount = Math.max(0, dayEvents.length - 4);
          const outsideMonth = !isSameMonth(day, focusDate);
          const isToday = isSameDay(day, today);

          return (
            <div
              key={key}
              className={cn(
                "group relative flex flex-col gap-1 bg-card p-1.5 transition-colors hover:bg-muted/50 md:gap-1 md:p-2",
                "before:pointer-events-none before:absolute before:inset-0 before:border-r before:border-b before:border-border",
                outsideMonth && "opacity-40"
              )}
            >
              {/* Day number */}
              <button type="button" className="mb-0.5 self-start" onClick={() => onDayClick(day)}>
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                    isToday ? "bg-primary text-primary-foreground" : "text-foreground"
                  )}
                >
                  {day.getDate()}
                </span>
              </button>

              {/* Events */}
              <div className="flex w-full flex-col gap-1">
                {dayEvents.slice(0, 4).map((event) => (
                  <EventChip
                    key={`${event.job.id}-${key}`}
                    event={event}
                    color={jobColors.get(event.job.id) ?? "gray"}
                    runEntry={runStatusMap.get(runKey(event.job.id, day))}
                    onClick={onEventClick}
                  />
                ))}
                {overflowCount > 0 && (
                  <button
                    type="button"
                    className="px-1 text-left text-xs font-semibold text-primary hover:underline"
                    onClick={() => onDayClick(day)}
                  >
                    {overflowCount} more&hellip;
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
