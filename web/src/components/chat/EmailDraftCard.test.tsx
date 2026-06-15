/// <reference lib="dom" />

// EmailDraftCard parses an RFC-ish plain-text draft (header lines up to the
// first blank line, then the body) and renders it read-only with a copy
// affordance. These tests pin the parser folds — recognized headers, the
// non-header line that ends the header section, CRLF input, the no-header
// case — and both copy outcomes (success flips to "Copied" and back; an
// unavailable clipboard silently no-ops).

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailDraftCard } from "./EmailDraftCard";

const writeText = mock((_: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
});

// The copy test enables fake timers; always restore real timers so a failure
// can't leak the fake clock into the next test.
afterEach(() => {
  jest.useRealTimers();
});

describe("EmailDraftCard", () => {
  test("renders recognized headers (Subject bold) and the body", () => {
    render(<EmailDraftCard raw={"To: a@b.c\r\nCc: d@e.f\nSubject: Quarterly sync\n\nSee you Tuesday.\nBring notes."} />);
    expect(screen.queryByText("To:")).not.toBeNull();
    expect(screen.queryByText("Cc:")).not.toBeNull();
    const subject = screen.getByText("Quarterly sync");
    expect(subject.className).toContain("font-semibold");
    expect(screen.queryByText(/See you Tuesday\./)).not.toBeNull();
  });

  test("a non-header first line means no header section — body only", () => {
    render(<EmailDraftCard raw={"just a body line\nDate: not-a-recognized-header"} />);
    expect(screen.queryByText("To:")).toBeNull();
    expect(screen.queryByText(/just a body line/)).not.toBeNull();
  });

  test("an unrecognized header-shaped line ends the headers and joins the body", () => {
    render(<EmailDraftCard raw={"To: a@b.c\nDate: 2026-06-11\n\nactual body"} />);
    expect(screen.queryByText("To:")).not.toBeNull();
    expect(screen.queryByText(/Date: 2026-06-11/)).not.toBeNull();
  });

  // fireEvent (not userEvent) for the copy tests: userEvent.setup() installs
  // its own navigator.clipboard stub, which would shadow the mock under test.
  test("copy writes the trimmed raw draft and flips to Copied, then back", async () => {
    jest.useFakeTimers();
    render(<EmailDraftCard raw={"To: a@b.c\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    // Flush onCopy's continuation (await writeText -> setCopied(true)).
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("To: a@b.c\n\nbody");
    expect(screen.queryByText("Copied")).not.toBeNull();
    // Fire the setTimeout(1500) revert on the fake clock instead of burning
    // real wall-clock.
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Copy")).not.toBeNull();
  });

  test("an unavailable clipboard is a silent no-op", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    render(<EmailDraftCard raw={"body only"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.queryByText(/body only/)).not.toBeNull();
  });
});
