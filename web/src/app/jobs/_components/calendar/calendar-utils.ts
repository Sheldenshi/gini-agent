import type { CalendarJob as CronJob, CalendarRunEntry as CronRunLogEntry } from "./types";

export type CalendarViewMode = "month" | "week" | "day";

export interface CalendarEvent {
  day: Date;
  job: CronJob;
  sortKey: number;
  timeLabel: string;
  hour: number | null;
  minute: number | null;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const HOUR_LABELS = [
  "12 AM",
  "1 AM",
  "2 AM",
  "3 AM",
  "4 AM",
  "5 AM",
  "6 AM",
  "7 AM",
  "8 AM",
  "9 AM",
  "10 AM",
  "11 AM",
  "12 PM",
  "1 PM",
  "2 PM",
  "3 PM",
  "4 PM",
  "5 PM",
  "6 PM",
  "7 PM",
  "8 PM",
  "9 PM",
  "10 PM",
  "11 PM"
];

export const HOUR_PX = 96;
export const HALF_HOUR_PX = 48;

// ─── Date helpers ──────────────────────────────────────────

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function addDays(date: Date, by: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + by);
  return d;
}

export function addMonths(date: Date, by: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + by, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── Week number ───────────────────────────────────────────

export function getWeekNumber(date: Date): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// ─── Grid builders ─────────────────────────────────────────

export function buildMonthDays(monthAnchor: Date): Date[] {
  const firstOfMonth = startOfMonth(monthAnchor);
  const firstGridDay = addDays(firstOfMonth, -firstOfMonth.getDay());
  const lastOfMonth = endOfMonth(monthAnchor);
  const lastGridDay = addDays(lastOfMonth, 6 - lastOfMonth.getDay());

  const days: Date[] = [];
  const cursor = new Date(firstGridDay);
  while (cursor <= lastGridDay) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function buildWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

// ─── Formatting ────────────────────────────────────────────

export function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function formatRange(start: Date, end: Date): string {
  const startLabel = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const endLabel = end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return `${startLabel} – ${endLabel}`;
}

export function formatWeekdayWithDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

export function formatTimeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

export function formatTimestamp(ms?: number | null): string {
  if (!(ms && Number.isFinite(ms))) return "—";
  return new Date(ms).toLocaleString();
}

export function formatMonthAbbrev(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short" }).toUpperCase();
}

// ─── Task content ──────────────────────────────────────────

export function getTaskContent(job: CronJob): string {
  // Gini jobs may carry a script (preferred display when present) or a prompt
  // string. Babyclaw split this on payload kind; we just pick whichever exists.
  if (job.script && job.script.trim()) return job.script.trim();
  return job.prompt.trim() || "—";
}

// ─── History dots ──────────────────────────────────────────

export function getHistoryDotTone(status?: "ok" | "error" | "skipped"): string | null {
  if (status === "ok") return "bg-[#16a34a]";
  if (status === "error") return "bg-[#dc2626]";
  return null;
}

// ─── Run history lookup ───────────────────────────────────

export function runKey(jobId: string, date: Date): string {
  return `${jobId}:${dayKey(date)}`;
}

export function buildRunStatusMap(runs: CronRunLogEntry[]): Map<string, CronRunLogEntry> {
  const map = new Map<string, CronRunLogEntry>();
  for (const run of runs) {
    if (!(run.jobId && Number.isFinite(run.ts))) continue;
    const key = runKey(run.jobId, new Date(run.ts));
    const existing = map.get(key);
    if (!existing || run.ts > existing.ts) {
      map.set(key, run);
    }
  }
  return map;
}

// ─── Schedule resolution (interval-only for gini) ──────────

function isMsOnDate(ms: number | undefined, date: Date): boolean {
  if (!(ms && Number.isFinite(ms))) return false;
  return isSameDay(new Date(ms), date);
}

function everyRunsOnDate(job: CronJob, date: Date): boolean {
  if (job.schedule.kind !== "every") return false;
  const everyMs = job.schedule.everyMs;
  if (!Number.isFinite(everyMs) || everyMs <= 0) return false;

  const anchorMs = job.schedule.anchorMs ?? job.createdAtMs;
  if (!(anchorMs && Number.isFinite(anchorMs))) return true;

  const dayStartMs = startOfDay(date).getTime();
  const dayEndMs = endOfDay(date).getTime();
  if (dayEndMs < anchorMs) return false;

  const firstStep = Math.max(0, Math.ceil((dayStartMs - anchorMs) / everyMs));
  return anchorMs + firstStep * everyMs <= dayEndMs;
}

export function jobRunsOnDate(job: CronJob, date: Date): boolean {
  // Don't backfill — jobs only appear from their creation date onward
  if (job.createdAtMs && Number.isFinite(job.createdAtMs)) {
    if (endOfDay(date).getTime() < job.createdAtMs) return false;
  }

  if (job.schedule.kind === "every") return everyRunsOnDate(job, date);

  // Schedule shapes other than "every" are not supported by gini today.
  return isMsOnDate(job.state?.nextRunAtMs, date);
}

// ─── Event time extraction ─────────────────────────────────

function getEveryFirstRunMsForDate(job: CronJob, date: Date): number | null {
  if (job.schedule.kind !== "every") return null;
  const everyMs = job.schedule.everyMs;
  if (!Number.isFinite(everyMs) || everyMs <= 0) return null;

  const anchorMs = job.schedule.anchorMs ?? job.createdAtMs;
  if (!(anchorMs && Number.isFinite(anchorMs))) return null;

  const dayStartMs = startOfDay(date).getTime();
  const dayEndMs = endOfDay(date).getTime();
  if (dayEndMs < anchorMs) return null;

  const firstStep = Math.max(0, Math.ceil((dayStartMs - anchorMs) / everyMs));
  const firstRunMs = anchorMs + firstStep * everyMs;
  return firstRunMs <= dayEndMs ? firstRunMs : null;
}

export function getEventTimeMs(job: CronJob, date: Date): number | null {
  if (job.schedule.kind === "every") {
    const everyRunMs = getEveryFirstRunMsForDate(job, date);
    if (everyRunMs != null) return everyRunMs;
  }

  if (isMsOnDate(job.state?.nextRunAtMs, date)) return job.state?.nextRunAtMs ?? null;
  if (isMsOnDate(job.state?.lastRunAtMs, date)) return job.state?.lastRunAtMs ?? null;
  return null;
}

// ─── Schedule description ──────────────────────────────────

export function getScheduleDescription(job: CronJob): string {
  if (job.schedule.kind !== "every") return "";
  const ms = job.schedule.everyMs;
  if (ms >= 86400000) {
    const n = Math.round(ms / 86400000);
    return n === 1 ? "Every day" : `Every ${n} days`;
  }
  if (ms >= 3600000) {
    const n = Math.round(ms / 3600000);
    return n === 1 ? "Every hour" : `Every ${n} hours`;
  }
  if (ms >= 60000) {
    const n = Math.round(ms / 60000);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  const n = Math.round(ms / 1000);
  return n === 1 ? "Every second" : `Every ${n} seconds`;
}

// ─── Event builder ─────────────────────────────────────────

export function buildEventsForDays(days: Date[], jobs: CronJob[]): Map<string, CalendarEvent[]> {
  const sortedJobs = [...jobs].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aName = (a.name || a.id).toLowerCase();
    const bName = (b.name || b.id).toLowerCase();
    return aName.localeCompare(bName);
  });

  const map = new Map<string, CalendarEvent[]>();
  for (const day of days) {
    const dayEvents = sortedJobs
      .filter((job) => jobRunsOnDate(job, day))
      .map((job) => {
        const eventTimeMs = getEventTimeMs(job, day);
        const hour = eventTimeMs != null ? new Date(eventTimeMs).getHours() : null;
        const minute = eventTimeMs != null ? new Date(eventTimeMs).getMinutes() : null;
        const sortKey =
          eventTimeMs == null
            ? Number.POSITIVE_INFINITY
            : new Date(eventTimeMs).getHours() * 60 + new Date(eventTimeMs).getMinutes();
        return {
          day,
          job,
          sortKey,
          timeLabel: eventTimeMs == null ? "Any time" : formatTimeLabel(eventTimeMs),
          hour,
          minute
        };
      })
      .sort((a, b) => {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        const aName = (a.job.name || a.job.id).toLowerCase();
        const bName = (b.job.name || b.job.id).toLowerCase();
        return aName.localeCompare(bName);
      });

    if (dayEvents.length > 0) map.set(dayKey(day), dayEvents);
  }
  return map;
}

// ─── Header helpers ────────────────────────────────────────

export function getHeaderTitle(viewMode: CalendarViewMode, focusDate: Date): string {
  if (viewMode === "month") return formatMonthLabel(focusDate);
  if (viewMode === "week") return formatMonthLabel(focusDate);
  return focusDate.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

export function getHeaderSubtitle(viewMode: CalendarViewMode, focusDate: Date): string {
  if (viewMode === "month") return formatRange(startOfMonth(focusDate), endOfMonth(focusDate));
  if (viewMode === "week") {
    const weekStart = startOfWeek(focusDate);
    return formatRange(weekStart, addDays(weekStart, 6));
  }
  return focusDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

// ─── Overlap layout (Google Calendar–style columns) ────────

export interface OverlapLayout {
  event: CalendarEvent;
  column: number;
  totalColumns: number;
}

const EVENT_DURATION_MINUTES = 30;

/**
 * Given a list of timed events for one day, compute column positions so
 * overlapping events sit side-by-side instead of stacking.
 */
export function computeOverlapLayout(events: CalendarEvent[]): OverlapLayout[] {
  if (events.length === 0) return [];

  // Build start/end in minutes
  const items = events.map((event) => {
    const start = (event.hour ?? 0) * 60 + (event.minute ?? 0);
    return { event, start, end: start + EVENT_DURATION_MINUTES };
  });

  // Sort by start time, then by job name for stability
  items.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const aName = (a.event.job.name || a.event.job.id).toLowerCase();
    const bName = (b.event.job.name || b.event.job.id).toLowerCase();
    return aName.localeCompare(bName);
  });

  // Find connected overlap groups
  const groups: (typeof items)[] = [];
  let currentGroup = [items[0]];
  let groupEnd = items[0].end;

  for (let i = 1; i < items.length; i++) {
    if (items[i].start < groupEnd) {
      // Overlaps with current group
      currentGroup.push(items[i]);
      groupEnd = Math.max(groupEnd, items[i].end);
    } else {
      groups.push(currentGroup);
      currentGroup = [items[i]];
      groupEnd = items[i].end;
    }
  }
  groups.push(currentGroup);

  // Assign columns within each group
  const result: OverlapLayout[] = [];
  for (const group of groups) {
    // Track end time per column to do first-fit placement
    const columnEnds: number[] = [];
    const assignments: { item: (typeof group)[0]; column: number }[] = [];

    for (const item of group) {
      let placed = false;
      for (let col = 0; col < columnEnds.length; col++) {
        if (columnEnds[col] <= item.start) {
          columnEnds[col] = item.end;
          assignments.push({ item, column: col });
          placed = true;
          break;
        }
      }
      if (!placed) {
        assignments.push({ item, column: columnEnds.length });
        columnEnds.push(item.end);
      }
    }

    const totalColumns = columnEnds.length;
    for (const { item, column } of assignments) {
      result.push({ event: item.event, column, totalColumns });
    }
  }

  return result;
}

// ─── Time grid positioning ─────────────────────────────────

export function getEventTopPx(hour: number, minute: number): number {
  return (hour + minute / 60) * HOUR_PX;
}

export function getCurrentTimeTopPx(): number {
  const now = new Date();
  return getEventTopPx(now.getHours(), now.getMinutes());
}
