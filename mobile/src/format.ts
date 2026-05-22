// Time formatters for chat row timestamps. We avoid date-fns to keep
// the mobile bundle slim — the web client uses it, but the formats we
// need here are easy enough to express directly.

// Compact "n ago" style — kept around for any caller that still wants
// the old delta format (settings, debug screens). Chat row rendering
// uses `chatListTime` instead.
export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
] as const;

// iOS-style chat-row timestamp:
//   - same calendar day  → "5:52 PM"
//   - same week          → "Monday" / "Tuesday" / …
//   - older              → "May 5"
// Falls back to empty string on an unparseable ISO date so the row UI
// gets the same "no time" treatment a missing updatedAt would yield.
export function chatListTime(iso: string, now: number = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const then = new Date(ts);
  const today = new Date(now);

  if (isSameCalendarDay(then, today)) {
    return formatClockTime(then);
  }

  // Within the previous six days (excluding today). We compare against
  // the local midnight of `today` so any time on a weekday up to six
  // days back still shows that weekday name.
  const todayMidnight = startOfDay(today).getTime();
  const sixDaysBack = todayMidnight - 6 * 24 * 60 * 60 * 1000;
  if (ts >= sixDaysBack && ts < todayMidnight) {
    return WEEKDAYS[then.getDay()]!;
  }

  return `${MONTHS_SHORT[then.getMonth()]} ${then.getDate()}`;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function formatClockTime(d: Date): string {
  // Locale-independent rendering — the design's "5:52 PM" / "10:46 AM"
  // shape is the same on every device, and toLocaleTimeString varies
  // wildly between locales/simulators in ways that surprise QA.
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const am = hours < 12;
  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;
  const mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
  return `${hours}:${mm} ${am ? "AM" : "PM"}`;
}
