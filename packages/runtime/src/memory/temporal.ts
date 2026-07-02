// Hindsight phase 2/3 — rule-based temporal parser.
//
// Hand-rolled to avoid a runtime dep. The paper's temporal channel only needs
// "given a piece of text + a reference time, return zero or one (start, end)
// ISO range". We cover the patterns the retain prompt routinely produces:
//
//   - Absolute: "2025-04-01", "April 1 2025", "Apr 1, 2025", "Saturday, June 9, 2024"
//   - Relative: "today", "yesterday", "tomorrow"
//   - Relative offsets: "N days ago", "N weeks ago", "in N days", "last week",
//     "next week", "last month", "next month", "this week", "this month".
//
// Failure mode: return null. Retain stores null occurred_start/end and the
// link layer treats those units as having no temporal scope. That's the
// paper's recommended degraded mode; flan-t5 fallback is explicitly out.

export interface TemporalRange {
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

export function parseTemporal(text: string, reference: Date = new Date()): TemporalRange | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ISO date / datetime first.
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (iso.test(trimmed)) {
    const start = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00.000Z` : trimmed);
    if (!isNaN(start.getTime())) {
      const end = trimmed.length === 10 ? endOfDay(start) : start;
      return iso10ToRange(trimmed, start, end);
    }
  }

  const lower = trimmed.toLowerCase();
  const refUtc = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));

  if (lower === "today") return dayRange(refUtc);
  if (lower === "yesterday") return dayRange(addDays(refUtc, -1));
  if (lower === "tomorrow") return dayRange(addDays(refUtc, 1));
  if (lower === "this week") return weekRange(refUtc);
  if (lower === "last week") return weekRange(addDays(refUtc, -7));
  if (lower === "next week") return weekRange(addDays(refUtc, 7));
  if (lower === "this month") return monthRange(refUtc);
  if (lower === "last month") return monthRange(addMonths(refUtc, -1));
  if (lower === "next month") return monthRange(addMonths(refUtc, 1));

  // "N days ago" / "in N days" / "N weeks ago" / "in N weeks"
  const ago = /^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/.exec(lower);
  if (ago) {
    const n = Number(ago[1]);
    return shifted(refUtc, ago[2]!, -n);
  }
  const inN = /^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/.exec(lower);
  if (inN) {
    const n = Number(inN[1]);
    return shifted(refUtc, inN[2]!, n);
  }

  // "Saturday, June 9, 2024" or "June 9 2024" or "Apr 1, 2025" — strip leading
  // weekday + comma, then parse as month-day-year.
  const stripped = trimmed.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*,?\s*/i, "");
  const monthDayYear = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(stripped);
  if (monthDayYear) {
    const monthIdx = MONTHS[monthDayYear[1]!.toLowerCase()];
    const day = Number(monthDayYear[2]);
    const year = Number(monthDayYear[3]);
    if (monthIdx !== undefined && day >= 1 && day <= 31 && year > 1900) {
      const start = new Date(Date.UTC(year, monthIdx, day));
      return dayRange(start);
    }
  }

  return null;
}

function dayRange(start: Date): TemporalRange {
  return {
    start: start.toISOString(),
    end: endOfDay(start).toISOString()
  };
}

function weekRange(anyDayInWeek: Date): TemporalRange {
  // ISO weeks start on Monday. Compute the Monday on or before the day.
  const dow = anyDayInWeek.getUTCDay(); // 0=Sun..6=Sat
  const monday = addDays(anyDayInWeek, dow === 0 ? -6 : 1 - dow);
  const sunday = addDays(monday, 6);
  return {
    start: monday.toISOString(),
    end: endOfDay(sunday).toISOString()
  };
}

function monthRange(anyDayInMonth: Date): TemporalRange {
  const start = new Date(Date.UTC(anyDayInMonth.getUTCFullYear(), anyDayInMonth.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anyDayInMonth.getUTCFullYear(), anyDayInMonth.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { start: start.toISOString(), end: end.toISOString() };
}

function shifted(reference: Date, unit: string, delta: number): TemporalRange {
  if (unit.startsWith("day")) return dayRange(addDays(reference, delta));
  if (unit.startsWith("week")) return weekRange(addDays(reference, delta * 7));
  if (unit.startsWith("month")) return monthRange(addMonths(reference, delta));
  if (unit.startsWith("year")) {
    const start = new Date(Date.UTC(reference.getUTCFullYear() + delta, 0, 1));
    const end = new Date(Date.UTC(reference.getUTCFullYear() + delta, 11, 31, 23, 59, 59, 999));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return dayRange(reference);
}

function endOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400_000);
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function iso10ToRange(input: string, start: Date, end: Date): TemporalRange {
  if (input.length === 10) return { start: start.toISOString(), end: end.toISOString() };
  return { start: start.toISOString(), end: end.toISOString() };
}
