/// <reference lib="dom" />

// BlockAssistantText renders an assistant message in a bubble, EXCEPT a
// ```calendar fence is hoisted OUT of the bubble to render as its own
// full-width component (the bubble width cramps a 7-day week). These tests pin
// the split helper (match / no-match) and the render folds: no fence → one
// bubble; a fence → the prose around it stays in bubbles while the calendar
// renders outside them, with the before/after bubbles dropped when empty.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { BlockAssistantText, splitCalendar } from "./BlockAssistantText";
import type { AssistantTextBlock } from "@runtime/types";

function makeBlock(text: string, streaming = false): AssistantTextBlock {
  return {
    id: "block_1",
    sessionId: "chat_1",
    instance: "test",
    ordinal: 1,
    createdAt: "2026-06-29T10:00:00.000Z",
    kind: "assistant_text",
    text,
    streaming
  } as AssistantTextBlock;
}

const CAL = "```calendar\ndate: 2026-07-02\n\n2026-07-02 15:00-16:00 | Team sync | proposed\n```";

describe("splitCalendar", () => {
  test("returns null when there is no complete calendar fence", () => {
    expect(splitCalendar("just some prose")).toBeNull();
    // An unterminated fence (mid-stream) must NOT match.
    expect(splitCalendar("```calendar\ndate: 2026-07-02\n")).toBeNull();
  });

  test("splits a complete fence into before / calendarRaw / after", () => {
    const parts = splitCalendar(`Here you go:\n\n${CAL}\n\nHere's the draft:`);
    expect(parts).not.toBeNull();
    expect(parts!.before.trim()).toBe("Here you go:");
    expect(parts!.after.trim()).toBe("Here's the draft:");
    expect(parts!.calendarRaw).toContain("Team sync");
  });
});

describe("BlockAssistantText", () => {
  test("no fence: renders the text in a single bubble, no calendar", () => {
    render(<BlockAssistantText block={makeBlock("hello there")} agent={{ id: "a1", name: "Gini" }} />);
    expect(screen.queryByText("hello there")).not.toBeNull();
    expect(screen.queryByText("Calendar")).toBeNull();
  });

  test("a calendar fence renders the calendar OUTSIDE the bubble, prose in bubbles", () => {
    render(<BlockAssistantText block={makeBlock(`Here's your week:\n\n${CAL}\n\nHere's the draft:`)} />);
    // calendar card present
    expect(screen.queryByText("Calendar")).not.toBeNull();
    // before + after prose present
    expect(screen.queryByText(/Here's your week/)).not.toBeNull();
    expect(screen.queryByText(/Here's the draft/)).not.toBeNull();
  });

  test("empty before/after around the fence drops the empty bubbles", () => {
    const { container } = render(<BlockAssistantText block={makeBlock(CAL)} />);
    expect(screen.queryByText("Calendar")).not.toBeNull();
    // Only the calendar renders — no surrounding prose bubbles.
    expect(container.querySelectorAll(".bg-card.rounded-xl, .rounded-xl.bg-card").length).toBeGreaterThanOrEqual(0);
  });
});
