"use client";

import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

// Inline calendar preview. The agent emits a ```calendar fenced block when it
// proposes, reschedules, or cancels a timed event (most often while drafting an
// email about a meeting); MarkdownContent routes that block here so the user can
// SEE the proposed slot against their existing agenda for the day/week and spot
// any conflict, instead of being handed a wall of text.
//
// The block is plain text: optional `view:` / `date:` / `tz:` header lines up to
// the first blank line, then pipe-delimited event lines. Everything renders
// read-only — there is no Apply affordance; the real calendar write still goes
// through Gini's normal flow. Mirrors the read-only EmailDraftCard.

type Status = "proposed" | "cancel" | "existing";

type CalEvent = {
  date: string; // YYYY-MM-DD
  allDay: boolean;
  startMin: number; // minutes from midnight (0 for all-day)
  endMin: number;
  title: string;
  status: Status;
};

export type ParsedCalendar = {
  view: "day" | "week";
  anchor: string | null; // YYYY-MM-DD, or null when no dated events exist
  tz?: string;
  events: CalEvent[];
};

const HEADER_KEYS = ["view", "date", "tz"] as const;

function normalizeStatus(raw: string | undefined): Status {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "proposed" || s === "new") return "proposed";
  if (s === "cancel" || s === "canceled" || s === "cancelled" || s === "removed") return "cancel";
  return "existing";
}

// minutes from midnight, or null if not a valid HH:MM
function parseHM(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Parse the time-spec field (field 0). Returns null when it doesn't match any
// recognized shape, so the caller can skip the whole line (lenient parsing).
function parseTimeSpec(
  spec: string,
  anchor: string | null
): { date: string; allDay: boolean; startMin: number; endMin: number } | null {
  const dateMatch = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(spec);
  const date = dateMatch ? dateMatch[1]! : anchor;
  const rest = dateMatch ? dateMatch[2]!.trim() : spec;
  if (!date) return null; // no explicit date and no anchor to default to
  if (rest.toLowerCase() === "all-day") {
    return { date, allDay: true, startMin: 0, endMin: 0 };
  }
  const range = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(rest);
  if (!range) return null;
  const startMin = parseHM(range[1]!);
  const endMin = parseHM(range[2]!);
  if (startMin === null || endMin === null || endMin <= startMin) return null;
  return { date, allDay: false, startMin, endMin };
}

export function parseCalendar(raw: string): ParsedCalendar {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const header: Partial<Record<(typeof HEADER_KEYS)[number], string>> = {};

  // Header section: leading `key: value` lines until the first blank line. Only
  // consumed when the very first non-empty line is a recognized header — else the
  // whole block is treated as event lines (no header).
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++; // skip leading blanks
  const firstMatch = i < lines.length ? /^([A-Za-z]+):\s*(.*)$/.exec(lines[i]!) : null;
  const firstKey = firstMatch?.[1]?.toLowerCase();
  const hasHeader = !!firstKey && (HEADER_KEYS as readonly string[]).includes(firstKey);
  if (hasHeader) {
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        i++; // consume the blank separator
        break;
      }
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      const key = m?.[1]?.toLowerCase();
      if (m && key && (HEADER_KEYS as readonly string[]).includes(key)) {
        header[key as (typeof HEADER_KEYS)[number]] = m[2]!.trim();
        continue;
      }
      // The first non-recognized-header line ends the header. Leave i pointing at
      // it (don't consume) so it's parsed as an event line — agents often emit
      // event lines straight after the header with no blank separator.
      break;
    }
  } else {
    i = 0; // no header — every line is an event line
  }

  // First pass: pull the raw fields so the anchor can be resolved before times
  // that default to it are finalized.
  const rawEvents: Array<{ spec: string; title: string; status: string }> = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || parts[1] === "") continue; // needs a time spec + title
    rawEvents.push({ spec: parts[0]!, title: parts[1]!, status: parts[2] ?? "" });
  }

  // Anchor: explicit `date:` header, else the earliest explicitly-dated event,
  // else null (the no-dated-events placeholder branch).
  const datedDates = rawEvents
    .map((e) => /^(\d{4}-\d{2}-\d{2})\b/.exec(e.spec)?.[1])
    .filter((d): d is string => !!d)
    .sort();
  const headerDate = header.date && /^\d{4}-\d{2}-\d{2}$/.test(header.date) ? header.date : undefined;
  const anchor = headerDate ?? datedDates[0] ?? null;

  const events: CalEvent[] = [];
  for (const e of rawEvents) {
    const ts = parseTimeSpec(e.spec, anchor);
    if (!ts) continue; // a line that doesn't parse is skipped
    events.push({ ...ts, title: e.title, status: normalizeStatus(e.status) });
  }

  const headerView = header.view?.toLowerCase();
  const view: "day" | "week" =
    headerView === "day" || headerView === "week"
      ? headerView
      : anchor && events.every((e) => e.date === anchor)
        ? "day"
        : "week";

  return { view, anchor, tz: header.tz, events };
}

// ── Date helpers (string YYYY-MM-DD math, no Date timezone surprises) ──────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ymdToUTC(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function utcToYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const dt = ymdToUTC(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return utcToYmd(dt);
}

// Sunday-started week containing the anchor.
function weekDays(anchor: string): string[] {
  const start = addDays(anchor, -ymdToUTC(anchor).getUTCDay());
  return Array.from({ length: 7 }, (_, k) => addDays(start, k));
}

function fmtDayLabel(ymd: string): string {
  const dt = ymdToUTC(ymd);
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function fmtShort(ymd: string): string {
  const dt = ymdToUTC(ymd);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function fmtHourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// ── Overlap column packing (interval-graph greedy coloring per day) ────────────

type Placed = CalEvent & { col: number; cols: number };

function packDay(dayEvents: CalEvent[]): Placed[] {
  const sorted = [...dayEvents].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const placed: Placed[] = [];
  // Cluster = a maximal run of events where each overlaps the running cluster
  // span; within a cluster, assign each event the lowest free column.
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = cluster.reduce((mx, e) => Math.max(mx, e.col + 1), 0);
    for (const e of cluster) {
      e.cols = cols;
      placed.push(e);
    }
    cluster = [];
    clusterEnd = -1;
  };
  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) flush();
    const taken = new Set(cluster.filter((e) => e.endMin > ev.startMin).map((e) => e.col));
    let col = 0;
    while (taken.has(col)) col++;
    cluster.push({ ...ev, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  if (cluster.length > 0) flush();
  return placed;
}

const PX_PER_HOUR = 44;
const MIN_EVENT_HEIGHT = 16;

const STATUS_CLASS: Record<Status, string> = {
  proposed: "border-primary bg-primary/15 text-foreground",
  cancel: "border-dashed border-border bg-muted text-muted-foreground",
  existing: "border-border bg-secondary text-secondary-foreground"
};

function EventBlock({ ev, windowStart }: { ev: Placed; windowStart: number }) {
  const top = ((ev.startMin - windowStart * 60) / 60) * PX_PER_HOUR;
  const height = Math.max(MIN_EVENT_HEIGHT, ((ev.endMin - ev.startMin) / 60) * PX_PER_HOUR);
  const width = 100 / ev.cols;
  return (
    <div
      className={cn(
        "absolute overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] leading-tight",
        STATUS_CLASS[ev.status]
      )}
      style={{ top, height, left: `${ev.col * width}%`, width: `calc(${width}% - 2px)` }}
    >
      {ev.status === "proposed" ? (
        <span className="mb-0.5 inline-block rounded bg-primary px-1 text-[9px] font-semibold uppercase text-primary-foreground">
          Proposed
        </span>
      ) : null}
      <div className={cn("truncate font-medium", ev.status === "cancel" && "line-through")}>{ev.title}</div>
      {ev.status === "cancel" ? <span className="sr-only">Canceled</span> : null}
      <div className="truncate opacity-70">{fmtTime(ev.startMin)}</div>
    </div>
  );
}

function DayColumn({
  events,
  startHour,
  endHour
}: {
  events: CalEvent[];
  startHour: number;
  endHour: number;
}) {
  const placed = packDay(events);
  return (
    <div className="relative flex-1 overflow-hidden" style={{ height: (endHour - startHour) * PX_PER_HOUR }}>
      {Array.from({ length: endHour - startHour }, (_, k) => (
        <div key={k} className="border-b border-border/60" style={{ height: PX_PER_HOUR }} />
      ))}
      {placed.map((ev, k) => (
        <EventBlock key={k} ev={ev} windowStart={startHour} />
      ))}
    </div>
  );
}

const ALLDAY_CHIP_CLASS: Record<Status, string> = {
  proposed: "border-primary bg-primary/15 text-foreground",
  cancel: "border-dashed border-border bg-muted text-muted-foreground line-through",
  existing: "border-border bg-secondary text-secondary-foreground"
};

function AllDayChip({ ev }: { ev: CalEvent }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium",
        ALLDAY_CHIP_CLASS[ev.status]
      )}
    >
      {ev.status === "proposed" ? (
        <span className="rounded bg-primary px-1 text-[9px] font-semibold uppercase text-primary-foreground">
          Proposed
        </span>
      ) : null}
      <span className="truncate">{ev.title}</span>
      {ev.status === "cancel" ? <span className="sr-only">Canceled</span> : null}
    </span>
  );
}

export function CalendarView({ raw }: { raw: string }) {
  const parsed = parseCalendar(raw.trim());
  const { view, anchor, tz, events } = parsed;

  const days = view === "week" && anchor ? weekDays(anchor) : anchor ? [anchor] : [];

  // No dated events at all → placeholder. Keep this branch minimal.
  if (!anchor) {
    return (
      <div className="my-2 overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
          <CalendarClock className="size-[15px] shrink-0" aria-hidden="true" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Calendar</span>
        </div>
        <div className="px-3 py-3 text-[13px] text-muted-foreground">No events to preview.</div>
      </div>
    );
  }

  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);

  // Hour window from the timed events (default [8, 18]); always shows business
  // hours so a single early/late event doesn't collapse the grid.
  const startHour =
    timed.length > 0
      ? Math.max(0, Math.min(8, Math.floor(Math.min(...timed.map((e) => e.startMin)) / 60)))
      : 8;
  const endHour =
    timed.length > 0
      ? Math.min(24, Math.max(18, Math.ceil(Math.max(...timed.map((e) => e.endMin)) / 60)))
      : 18;

  const range =
    view === "week"
      ? `${fmtShort(days[0]!)} – ${fmtShort(days[6]!)}`
      : fmtDayLabel(anchor);

  return (
    <div className="my-2 overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
        <CalendarClock className="size-[15px] shrink-0" aria-hidden="true" />
        <span className="text-[12px] font-semibold uppercase tracking-wide">Calendar</span>
        <span className="ml-auto text-[12px] font-medium text-foreground">
          {range}
          {tz ? ` · ${tz}` : ""}
        </span>
      </div>

      {allDay.length > 0 ? (
        <div className="flex gap-1 border-b px-3 py-2">
          <div className="w-9 shrink-0" />
          {view === "week" ? (
            <div className="flex flex-1 gap-1">
              {days.map((d) => (
                <div key={d} className="flex min-w-0 flex-1 flex-col gap-1">
                  {allDay
                    .filter((e) => e.date === d)
                    .map((e, k) => (
                      <AllDayChip key={k} ev={e} />
                    ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {allDay.map((e, k) => (
                <AllDayChip key={k} ev={e} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {view === "week" ? (
        <div className="flex border-b px-3 pt-2 text-[11px] font-medium text-muted-foreground">
          <div className="w-9 shrink-0" />
          <div className="flex flex-1 gap-1">
            {days.map((d) => (
              <div
                key={d}
                className={cn(
                  "flex-1 text-center",
                  d === anchor && "text-foreground underline underline-offset-2"
                )}
              >
                {WEEKDAYS[ymdToUTC(d).getUTCDay()]} {ymdToUTC(d).getUTCDate()}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex px-3 py-2">
        <div className="w-9 shrink-0">
          {Array.from({ length: endHour - startHour }, (_, k) => (
            <div
              key={k}
              className="pr-1 text-right text-[10px] text-muted-foreground"
              style={{ height: PX_PER_HOUR }}
            >
              {fmtHourLabel(startHour + k)}
            </div>
          ))}
        </div>
        <div className="flex flex-1 gap-1">
          {days.map((d) => (
            <DayColumn
              key={d}
              events={timed.filter((e) => e.date === d)}
              startHour={startHour}
              endHour={endHour}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
