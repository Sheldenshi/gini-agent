"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import React from "react";

import type { CalendarJob as CronJob, CalendarRunEntry as CronRunLogEntry } from "./types";
import { cn } from "@/lib/utils";
import type { EventColor } from "./calendar-colors";
import {
  addMonths,
  buildMonthDays,
  type CalendarEvent,
  computeOverlapLayout,
  dayKey,
  getCurrentTimeTopPx,
  getEventTopPx,
  HALF_HOUR_PX,
  HOUR_LABELS,
  HOUR_PX,
  isSameDay,
  isSameMonth,
  jobRunsOnDate,
  runKey,
  startOfMonth,
  WEEKDAY_LABELS
} from "./calendar-utils";
import { EventChip } from "./event-chip";

interface DayViewProps {
  day: Date;
  today: Date;
  jobs: CronJob[];
  eventsByDay: Map<string, CalendarEvent[]>;
  jobColors: Map<string, EventColor>;
  runStatusMap: Map<string, CronRunLogEntry>;
  onEventClick: (event: CalendarEvent) => void;
  onDayChange: (date: Date) => void;
}

export function DayView({
  day,
  today,
  jobs,
  eventsByDay,
  jobColors,
  runStatusMap,
  onEventClick,
  onDayChange
}: DayViewProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [currentTimePx, setCurrentTimePx] = React.useState(getCurrentTimeTopPx);
  const [miniMonth, setMiniMonth] = React.useState(() => startOfMonth(day));
  const isToday = isSameDay(day, today);
  const key = dayKey(day);
  const events = eventsByDay.get(key) ?? [];
  const allDay = events.filter((e) => e.hour === null);
  const timed = events.filter((e) => e.hour !== null);
  const totalHeight = 24 * HOUR_PX;

  // Keep mini calendar in sync when day prop changes
  React.useEffect(() => {
    if (!isSameMonth(day, miniMonth)) {
      setMiniMonth(startOfMonth(day));
    }
  }, [day, miniMonth]);

  // Auto-scroll to 7 AM on mount
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 7 * HOUR_PX - 20;
    }
  }, []);

  // Update current time indicator every 60s
  React.useEffect(() => {
    if (!isToday) return;
    const interval = setInterval(() => setCurrentTimePx(getCurrentTimeTopPx()), 60_000);
    return () => clearInterval(interval);
  }, [isToday]);

  const miniDays = buildMonthDays(miniMonth);

  // Compute which mini calendar days have events
  const miniDaysWithEvents = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of miniDays) {
      if (jobs.some((job) => jobRunsOnDate(job, d))) {
        set.add(dayKey(d));
      }
    }
    return set;
  }, [miniDays, jobs]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: Time grid */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* All-day section */}
        {allDay.length > 0 && (
          <div className="border-b border-border px-6 py-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">All day</div>
            <div className="flex flex-col gap-1">
              {allDay.map((event) => (
                <EventChip
                  key={`ad-${event.job.id}`}
                  event={event}
                  color={jobColors.get(event.job.id) ?? "gray"}
                  runEntry={runStatusMap.get(runKey(event.job.id, day))}
                  onClick={onEventClick}
                />
              ))}
            </div>
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

          {/* Single day column */}
          <div className="relative flex-1" style={{ height: `${totalHeight}px` }}>
            {/* Hour grid lines */}
            {HOUR_LABELS.map((label, i) => (
              <div
                key={label}
                className="absolute w-full border-b border-border/50"
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
                  key={`ev-${event.job.id}`}
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
        </div>
      </div>

      {/* Right: Mini calendar sidebar */}
      <div className="hidden w-72 shrink-0 flex-col border-l border-border lg:flex">
        <div className="px-5 py-5">
          {/* Month navigation */}
          <header className="mb-3 flex items-center justify-between">
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              onClick={() => setMiniMonth(addMonths(miniMonth, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-foreground">
              {miniMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              onClick={() => setMiniMonth(addMonths(miniMonth, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </header>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 text-center">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="py-1 text-xs font-medium text-muted-foreground">
                {label.charAt(0) + label.charAt(1)}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 text-center">
            {miniDays.map((d) => {
              const dk = dayKey(d);
              const isSelected = isSameDay(d, day);
              const isTodayCell = isSameDay(d, today);
              const outsideMonth = !isSameMonth(d, miniMonth);
              const hasEvents = miniDaysWithEvents.has(dk);

              return (
                <button
                  key={dk}
                  type="button"
                  className="flex flex-col items-center py-0.5"
                  onClick={() => onDayChange(d)}
                >
                  <span
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full text-sm transition-colors",
                      outsideMonth && "text-muted-foreground/50",
                      !(outsideMonth || isSelected || isTodayCell) &&
                        "text-foreground hover:bg-muted/50",
                      isTodayCell && !isSelected && "font-semibold text-primary",
                      isSelected && "bg-primary font-semibold text-primary-foreground"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {hasEvents && !outsideMonth && (
                    <span className="size-1 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
