/// <reference lib="dom" />

// BlockThinking renders one pre-tool narration step as a collapsible row:
// the label "Thinking" plus the message's first line as a one-line preview,
// expanding on click to reveal the full settled message. These tests pin the
// preview-vs-full split and the click-to-expand toggle.

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AssistantTextBlock } from "@runtime/types";
import { BlockThinking } from "./BlockThinking";

function narration(text: string): AssistantTextBlock {
  return {
    kind: "assistant_text",
    id: "a1",
    sessionId: "s",
    instance: "test",
    ordinal: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    text,
    streaming: false
  };
}

describe("BlockThinking", () => {
  test("collapsed shows the 'Thinking' label and the first-line preview only", () => {
    render(<BlockThinking block={narration("Let me check the console\nThen I'll snapshot the page")} />);
    expect(screen.getByText("Thinking")).not.toBeNull();
    expect(screen.getByText("Let me check the console")).not.toBeNull();
    // The later line is hidden until the row is expanded.
    expect(screen.queryByText(/Then I'll snapshot the page/)).toBeNull();
  });

  test("clicking the row reveals the full message", () => {
    render(<BlockThinking block={narration("Let me check the console\nThen I'll snapshot the page")} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/Then I'll snapshot the page/)).not.toBeNull();
  });
});
