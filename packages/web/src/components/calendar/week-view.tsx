"use client";

import React from "react";

import { cn } from "@/lib/utils";
import {
  type CalendarEvent,
  computeOverlapLayout,
  dayKey,
  getCurrentTimeTopPx,
  getEventHeightPx,
  getEventTopPx,
  HOUR_LABELS,
  HOUR_PX,
  isSameDay,
  WEEKDAY_LABELS
} from "./calendar-utils";
import { EventChip } from "./event-chip";

interface WeekViewProps {
  days: Date[];
  today: Date;
  eventsByDay: Map<string, CalendarEvent[]>;
  // Hour the time grid auto-scrolls to on mount (jobs default 7; inline 8).
  scrollToHour?: number;
  // Pixel height of one hour row. Jobs use the full-width default (96); the
  // compact inline chat preview passes a smaller value so 8 AM–8 PM fits the card.
  hourPx?: number;
  // Dense applies the inline chat preview's macOS-Calendar styling: smaller
  // header/hour-label fonts, "Noon" + small-meridiem labels, and bar-style event
  // chips. Jobs omit it, keeping the original ring style.
  dense?: boolean;
}

// macOS-style hour label for the dense preview: the meridiem rides small after
// the hour, and 12 PM reads "Noon". The Jobs grid keeps the plain label.
function HourLabel({ label, dense }: { label: string; dense?: boolean }) {
  if (!dense) return <>{label}</>;
  const [hour, meridiem] = label.split(" ");
  if (hour === "12" && meridiem === "PM") return <>Noon</>;
  return (
    <>
      {hour}
      <span className="ml-0.5 text-[8px] font-normal">{meridiem}</span>
    </>
  );
}

export function WeekView({
  days,
  today,
  eventsByDay,
  scrollToHour = 7,
  hourPx = HOUR_PX,
  dense = false
}: WeekViewProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [currentTimePx, setCurrentTimePx] = React.useState(() => getCurrentTimeTopPx(hourPx));
  const todayVisible = days.some((d) => isSameDay(d, today));

  // Auto-scroll to the configured hour on mount
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollToHour * hourPx - 20;
    }
  }, [scrollToHour, hourPx]);

  // Update current time indicator every 60s
  React.useEffect(() => {
    if (!todayVisible) return;
    const interval = setInterval(() => setCurrentTimePx(getCurrentTimeTopPx(hourPx)), 60_000);
    return () => clearInterval(interval);
  }, [todayVisible, hourPx]);

  // Separate all-day vs timed events per day
  const dayData = days.map((day) => {
    const key = dayKey(day);
    const events = eventsByDay.get(key) ?? [];
    const allDay = events.filter((e) => e.hour === null);
    const timed = events.filter((e) => e.hour !== null);
    return { day, key, allDay, timed, isToday: isSameDay(day, today) };
  });

  const hasAllDay = dayData.some((d) => d.allDay.length > 0);
  const totalHeight = 24 * hourPx;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Day column headers */}
      <div className="sticky top-0 z-10 grid grid-cols-7 bg-card pl-[72px] shadow-sm">
        {dayData.map(({ day, isToday }) => (
          <div
            key={`wh-${dayKey(day)}`}
            className={cn(
              "relative flex w-full flex-col items-center justify-center gap-1 border-b border-border bg-card md:flex-row md:gap-1",
              dense ? "p-1.5" : "p-2"
            )}
          >
            <span
              className={cn(
                "font-medium whitespace-nowrap text-muted-foreground",
                dense ? "text-[10px]" : "text-xs"
              )}
            >
              {WEEKDAY_LABELS[day.getDay()]}
            </span>
            <span
              className={cn(
                "flex items-center justify-center rounded-full font-semibold",
                dense ? "size-6 text-xs" : "size-8 text-sm",
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
          {dayData.map(({ key, allDay }) => (
            <div key={`ad-${key}`} className="border-r border-border p-1.5">
              <div className="flex flex-col gap-1">
                {allDay.map((event) => (
                  <EventChip key={`ad-${event.key}-${key}`} event={event} dense={dense} />
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
              style={{ height: `${hourPx}px` }}
            >
              <span
                className={cn(
                  "text-right font-medium whitespace-nowrap text-muted-foreground",
                  dense ? "text-[10px]" : "text-xs",
                  i === 0 ? "translate-y-1" : "-translate-y-1/2"
                )}
              >
                <HourLabel label={label} dense={dense} />
              </span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        <div className="grid flex-1 grid-cols-7">
          {dayData.map(({ key, timed, isToday }) => {
            return (
              <div
                key={`wc-${key}`}
                className={cn("relative", dense && isToday && "bg-muted/30")}
                style={{ height: `${totalHeight}px` }}
              >
                {/* Hour grid lines */}
                {HOUR_LABELS.map((label, i) => (
                  <div
                    key={label}
                    className="absolute w-full border-b border-border/50 border-r border-border"
                    style={{ top: `${i * hourPx}px`, height: `${hourPx}px` }}
                  />
                ))}

                {/* Events */}
                {computeOverlapLayout(timed).map(({ event, column, totalColumns }) => {
                  const top = getEventTopPx(event.hour ?? 0, event.minute ?? 0, hourPx);
                  const widthPct = 100 / totalColumns;
                  const leftPct = column * widthPct;
                  return (
                    <div
                      key={`ev-${event.key}-${key}`}
                      className="absolute px-0.5 py-0.5"
                      style={{
                        top: `${top}px`,
                        height: `${getEventHeightPx(event, hourPx)}px`,
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        zIndex: 1
                      }}
                    >
                      <EventChip event={event} dense={dense} />
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
