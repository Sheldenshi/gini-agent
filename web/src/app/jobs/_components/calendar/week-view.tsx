"use client";

import React from "react";

import type { CalendarRunEntry as CronRunLogEntry } from "./types";
import { cn } from "@/lib/utils";
import type { EventColor } from "./calendar-colors";
import {
  type CalendarEvent,
  computeOverlapLayout,
  dayKey,
  getCurrentTimeTopPx,
  getEventTopPx,
  HALF_HOUR_PX,
  HOUR_LABELS,
  HOUR_PX,
  isSameDay,
  runKey,
  WEEKDAY_LABELS
} from "./calendar-utils";
import { EventChip } from "./event-chip";

interface WeekViewProps {
  days: Date[];
  today: Date;
  eventsByDay: Map<string, CalendarEvent[]>;
  jobColors: Map<string, EventColor>;
  runStatusMap: Map<string, CronRunLogEntry>;
  onEventClick: (event: CalendarEvent) => void;
}

export function WeekView({
  days,
  today,
  eventsByDay,
  jobColors,
  runStatusMap,
  onEventClick
}: WeekViewProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [currentTimePx, setCurrentTimePx] = React.useState(getCurrentTimeTopPx);
  const todayVisible = days.some((d) => isSameDay(d, today));

  // Auto-scroll to 7 AM on mount
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 7 * HOUR_PX - 20;
    }
  }, []);

  // Update current time indicator every 60s
  React.useEffect(() => {
    if (!todayVisible) return;
    const interval = setInterval(() => setCurrentTimePx(getCurrentTimeTopPx()), 60_000);
    return () => clearInterval(interval);
  }, [todayVisible]);

  // Separate all-day vs timed events per day
  const dayData = days.map((day) => {
    const key = dayKey(day);
    const events = eventsByDay.get(key) ?? [];
    const allDay = events.filter((e) => e.hour === null);
    const timed = events.filter((e) => e.hour !== null);
    return { day, key, allDay, timed, isToday: isSameDay(day, today) };
  });

  const hasAllDay = dayData.some((d) => d.allDay.length > 0);
  const totalHeight = 24 * HOUR_PX;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Day column headers */}
      <div className="sticky top-0 z-10 grid grid-cols-7 bg-card pl-[72px] shadow-sm">
        {dayData.map(({ day, isToday }) => (
          <div
            key={`wh-${dayKey(day)}`}
            className="relative flex w-full flex-col items-center justify-center gap-1 border-b border-border bg-card p-2 md:flex-row md:gap-1"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {WEEKDAY_LABELS[day.getDay()]}
            </span>
            <span
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-sm font-semibold",
                isToday ? "bg-primary text-primary-foreground" : "text-foreground"
              )}
            >
              {day.getDate()}
            </span>
          </div>
        ))}
      </div>

      {/* All-day row */}
      {hasAllDay && (
        <div className="grid grid-cols-7 border-b border-border pl-[72px]">
          {dayData.map(({ day, key, allDay }) => (
            <div key={`ad-${key}`} className="border-r border-border p-1.5">
              <div className="flex flex-col gap-1">
                {allDay.map((event) => (
                  <EventChip
                    key={`ad-${event.job.id}-${key}`}
                    event={event}
                    color={jobColors.get(event.job.id) ?? "gray"}
                    runEntry={runStatusMap.get(runKey(event.job.id, day))}
                    onClick={onEventClick}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="relative flex flex-1 overflow-y-auto">
        {/* Time labels column */}
        <div className="flex h-max w-[72px] shrink-0 flex-col border-r border-border">
          {HOUR_LABELS.map((label, i) => (
            <div
              key={label}
              className="group relative flex items-start justify-end bg-muted/40 pr-2"
              style={{ height: `${HOUR_PX}px` }}
            >
              <span
                className={cn(
                  "text-right text-xs font-medium whitespace-nowrap text-muted-foreground",
                  i === 0 ? "translate-y-1" : "-translate-y-1/2"
                )}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        <div className="grid flex-1 grid-cols-7">
          {dayData.map(({ day, key, timed, isToday }) => {
            return (
              <div key={`wc-${key}`} className="relative" style={{ height: `${totalHeight}px` }}>
                {/* Hour grid lines */}
                {HOUR_LABELS.map((label, i) => (
                  <div
                    key={label}
                    className="absolute w-full border-b border-border/50 border-r border-border"
                    style={{ top: `${i * HOUR_PX}px`, height: `${HOUR_PX}px` }}
                  />
                ))}

                {/* Events */}
                {computeOverlapLayout(timed).map(({ event, column, totalColumns }) => {
                  const top = getEventTopPx(event.hour ?? 0, event.minute ?? 0);
                  const widthPct = 100 / totalColumns;
                  const leftPct = column * widthPct;
                  return (
                    <div
                      key={`ev-${event.job.id}-${key}`}
                      className="absolute px-0.5 py-0.5"
                      style={{
                        top: `${top}px`,
                        height: `${HALF_HOUR_PX}px`,
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        zIndex: 1
                      }}
                    >
                      <EventChip
                        event={event}
                        color={jobColors.get(event.job.id) ?? "gray"}
                        runEntry={runStatusMap.get(runKey(event.job.id, day))}
                        onClick={onEventClick}
                      />
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {isToday && (
                  <div
                    className="pointer-events-none absolute right-0 left-0 z-30 flex -translate-y-1/2 items-center"
                    style={{ top: `${currentTimePx}px` }}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span className="h-px flex-1 bg-red-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
