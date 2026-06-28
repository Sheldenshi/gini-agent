/// <reference lib="dom" />

// CalendarView parses a lenient ```calendar block (optional view/date/tz header
// up to the first blank line, then pipe-delimited event lines) and renders a
// read-only day/week grid with overlap packing and status styling. These tests
// pin the parser folds (header vs no-header, view inference + override, every
// time-spec shape, status normalization, malformed-line skipping, anchor
// resolution) and the render folds (day vs week range, all-day chips, the
// proposed tag / cancel line-through, overlap columns, the hour window, and the
// no-dated-events placeholder) so the 100% coverage gate stays satisfied.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { CalendarView, parseCalendar } from "./CalendarView";

describe("parseCalendar", () => {
  test("parses a header (view/date/tz) and infers nothing when view is explicit", () => {
    const p = parseCalendar("view: week\ndate: 2026-07-02\ntz: PT\n\n2026-07-02 15:00-16:00 | Team sync | proposed");
    expect(p.view).toBe("week");
    expect(p.anchor).toBe("2026-07-02");
    expect(p.tz).toBe("PT");
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ title: "Team sync", status: "proposed", startMin: 900, endMin: 960 });
  });

  test("infers day view when every event falls on the anchor date", () => {
    const p = parseCalendar("date: 2026-07-02\n\n2026-07-02 09:00-10:00 | A\n2026-07-02 11:00-12:00 | B");
    expect(p.view).toBe("day");
  });

  test("infers week view when events span multiple dates", () => {
    const p = parseCalendar("date: 2026-07-02\n\n2026-07-02 09:00-10:00 | A\n2026-07-03 11:00-12:00 | B");
    expect(p.view).toBe("week");
  });

  test("a bare HH:MM event defaults to the anchor date", () => {
    const p = parseCalendar("date: 2026-07-02\n\n09:30-10:00 | Standup");
    expect(p.events[0]?.date).toBe("2026-07-02");
    expect(p.events[0]?.startMin).toBe(570);
  });

  test("a bare all-day event defaults to the anchor date", () => {
    const p = parseCalendar("date: 2026-07-02\n\nall-day | Holiday");
    expect(p.events[0]).toMatchObject({ date: "2026-07-02", allDay: true });
  });

  test("a dated all-day event keeps its own date", () => {
    const p = parseCalendar("date: 2026-07-02\n\n2026-07-03 all-day | Offsite");
    expect(p.events[0]).toMatchObject({ date: "2026-07-03", allDay: true });
  });

  test("no header: the very first line is an event line, anchor is the earliest event date", () => {
    const p = parseCalendar("2026-07-05 09:00-10:00 | Late\n2026-07-02 09:00-10:00 | Early");
    expect(p.anchor).toBe("2026-07-02");
    expect(p.events).toHaveLength(2);
  });

  test("leading blank lines before the header are skipped", () => {
    const p = parseCalendar("\n\ndate: 2026-07-02\n\n09:00-10:00 | A");
    expect(p.anchor).toBe("2026-07-02");
  });

  test("an unknown header-shaped line inside the header section is ignored", () => {
    const p = parseCalendar("date: 2026-07-02\nfoo: bar\n\n09:00-10:00 | A");
    expect(p.anchor).toBe("2026-07-02");
    expect(p.events).toHaveLength(1);
  });

  test("a non-ISO date: header falls back to the earliest dated event for the anchor", () => {
    const p = parseCalendar("date: tomorrow\n\n2026-07-02 09:00-10:00 | A");
    expect(p.anchor).toBe("2026-07-02");
    expect(p.events).toHaveLength(1);
  });

  test("a non-ISO date: header with no dated event leaves the anchor null", () => {
    const p = parseCalendar("date: 7/2\n\n09:00-10:00 | Floating");
    expect(p.anchor).toBeNull();
    expect(p.events).toHaveLength(0);
  });

  test("event lines immediately after the header (no blank separator) are parsed, not dropped", () => {
    const p = parseCalendar("date: 2026-07-02\n09:00-10:00 | A");
    expect(p.anchor).toBe("2026-07-02");
    expect(p.events).toHaveLength(1);
    expect(p.events[0]?.title).toBe("A");
  });

  test("status normalization: new→proposed, cancelled/removed→cancel, other→existing", () => {
    const p = parseCalendar(
      "date: 2026-07-02\n\n" +
        "08:00-09:00 | A | new\n" +
        "09:00-10:00 | B | cancelled\n" +
        "10:00-11:00 | C | removed\n" +
        "11:00-12:00 | D | busy\n" +
        "12:00-13:00 | E"
    );
    expect(p.events.map((e) => e.status)).toEqual(["proposed", "cancel", "cancel", "existing", "existing"]);
  });

  test("malformed lines are skipped: bad time spec, missing title, missing fields, end<=start, bad clock", () => {
    const p = parseCalendar(
      "date: 2026-07-02\n\n" +
        "not-a-time | X\n" + // unparseable time spec → skipped
        "09:00-10:00 |\n" + // empty title → skipped
        "09:00-10:00\n" + // no pipe at all → skipped
        "11:00-10:00 | Backwards\n" + // end <= start → skipped
        "25:00-26:00 | OutOfRange\n" + // hour > 23 → skipped
        "09:00-10:99 | BadMinutes\n" + // minute > 59 → skipped
        "13:00-14:00 | Good"
    );
    expect(p.events).toHaveLength(1);
    expect(p.events[0]?.title).toBe("Good");
  });

  test("an explicit view: day override wins even when events span multiple dates", () => {
    const p = parseCalendar("view: day\ndate: 2026-07-02\n\n2026-07-02 09:00-10:00 | A\n2026-07-03 09:00-10:00 | B");
    expect(p.view).toBe("day");
  });

  test("no anchor and no dated events → anchor null, view falls back to week", () => {
    const p = parseCalendar("09:00-10:00 | Floating");
    // With no anchor, the bare HH:MM line cannot resolve a date and is skipped.
    expect(p.anchor).toBeNull();
    expect(p.events).toHaveLength(0);
    expect(p.view).toBe("week");
  });

  test("CRLF input is normalized", () => {
    const p = parseCalendar("date: 2026-07-02\r\n\r\n09:00-10:00 | A");
    expect(p.events).toHaveLength(1);
  });
});

describe("CalendarView", () => {
  test("day view renders the header label, day range, and tz", () => {
    render(<CalendarView raw={"view: day\ndate: 2026-07-02\ntz: PT\n\n15:00-16:00 | Team sync | proposed"} />);
    expect(screen.queryByText("Calendar")).not.toBeNull();
    expect(screen.queryByText(/Thu, Jul 2 · PT/)).not.toBeNull();
  });

  test("a proposed event shows the Proposed tag", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n15:00-16:00 | Team sync | proposed"} />);
    expect(screen.queryByText("Proposed")).not.toBeNull();
    expect(screen.queryByText("Team sync")).not.toBeNull();
  });

  test("a cancel event renders its title with line-through", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n15:00-16:00 | Old meeting | cancel"} />);
    const title = screen.getByText("Old meeting");
    expect(title.className).toContain("line-through");
  });

  test("an existing event renders without the Proposed tag", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n15:00-16:00 | Lunch | existing"} />);
    expect(screen.queryByText("Proposed")).toBeNull();
    expect(screen.queryByText("Lunch")).not.toBeNull();
  });

  test("two overlapping events both render side by side (column packing)", () => {
    const { container } = render(
      <CalendarView raw={"date: 2026-07-02\n\n09:00-10:30 | A\n09:30-10:00 | B"} />
    );
    expect(screen.queryByText("A")).not.toBeNull();
    expect(screen.queryByText("B")).not.toBeNull();
    // Two clustered events get half-width columns at distinct left offsets.
    const lefts = Array.from(container.querySelectorAll("[style*='left']")).map(
      (el) => (el as HTMLElement).style.left
    );
    expect(new Set(lefts).size).toBeGreaterThan(1);
  });

  test("a later non-overlapping event starts a fresh cluster (full width)", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n09:00-10:00 | First\n11:00-12:00 | Second"} />);
    expect(screen.queryByText("First")).not.toBeNull();
    expect(screen.queryByText("Second")).not.toBeNull();
  });

  test("an early and a late event widen the hour window beyond [8,18]", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n06:00-07:00 | Early\n20:00-21:00 | Late"} />);
    expect(screen.queryByText("6 AM")).not.toBeNull();
    expect(screen.queryByText("8 PM")).not.toBeNull();
  });

  test("with no timed events the window falls back to [8,18] (8 AM to 5 PM gutter)", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\nall-day | Holiday"} />);
    expect(screen.queryByText("8 AM")).not.toBeNull();
    expect(screen.queryByText("5 PM")).not.toBeNull();
    expect(screen.queryByText("6 PM")).toBeNull();
  });

  test("day view all-day chips render under the header", () => {
    render(<CalendarView raw={"view: day\ndate: 2026-07-02\n\nall-day | Company offsite"} />);
    expect(screen.queryByText("Company offsite")).not.toBeNull();
  });

  test("week view shows day-of-week headers with the anchor day emphasized and the week range", () => {
    const { container } = render(
      <CalendarView raw={"view: week\ndate: 2026-07-02\n\n2026-07-02 15:00-16:00 | Team sync\n2026-07-03 09:00-10:00 | Standup"} />
    );
    // 2026-07-02 is a Thursday; its Sunday-started week is Jun 28 – Jul 4.
    expect(screen.queryByText("Jun 28 – Jul 4")).not.toBeNull();
    // The anchor column header is underlined/emphasized.
    const emphasized = Array.from(container.querySelectorAll(".underline")).map((el) => el.textContent);
    expect(emphasized.some((t) => t?.includes("Thu"))).toBe(true);
    expect(screen.queryByText("Team sync")).not.toBeNull();
    expect(screen.queryByText("Standup")).not.toBeNull();
  });

  test("week view renders all-day chips per day column", () => {
    render(
      <CalendarView raw={"view: week\ndate: 2026-07-02\n\n2026-07-02 all-day | Offsite\n2026-07-04 09:00-10:00 | Sync"} />
    );
    expect(screen.queryByText("Offsite")).not.toBeNull();
  });

  test("a proposed all-day chip shows the visible Proposed marker", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\nall-day | Company offsite | proposed"} />);
    expect(screen.queryByText("Proposed")).not.toBeNull();
    expect(screen.queryByText("Company offsite")).not.toBeNull();
  });

  test("a canceled timed event exposes Canceled text to screen readers", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\n15:00-16:00 | Old meeting | cancel"} />);
    expect(screen.queryByText("Canceled")).not.toBeNull();
  });

  test("a canceled all-day chip exposes Canceled text to screen readers", () => {
    render(<CalendarView raw={"date: 2026-07-02\n\nall-day | Old offsite | cancel"} />);
    expect(screen.queryByText("Canceled")).not.toBeNull();
  });

  test("a bad date: header in a week-inferred layout renders without throwing", () => {
    render(<CalendarView raw={"date: tomorrow\n\n2026-07-02 15:00-16:00 | A\n2026-07-03 09:00-10:00 | B"} />);
    expect(screen.queryByText("A")).not.toBeNull();
    expect(screen.queryByText("B")).not.toBeNull();
  });

  test("no dated events renders the placeholder card", () => {
    render(<CalendarView raw={"some prose that is not an event"} />);
    expect(screen.queryByText("Calendar")).not.toBeNull();
    expect(screen.queryByText("No events to preview.")).not.toBeNull();
  });
});
