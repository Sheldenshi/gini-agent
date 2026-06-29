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
import { ChatActionsProvider } from "./ChatActionsContext";

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

  // Without the ChatActions context (doc viewer / file preview / skills page)
  // the card stays read-only — no Send affordance.
  test("renders no Send button outside a chat surface", () => {
    render(<EmailDraftCard raw={"To: a@b.c\nSubject: Hi\n\nbody"} />);
    expect(screen.queryByText("Send")).toBeNull();
  });

  // Inside a chat surface the Send button posts a precise instruction composed
  // from the headers, then disables itself so it can't double-fire.
  test("inside a chat surface, Send posts the composed instruction and then disables", () => {
    const sendUserMessage = mock((_: string) => {});
    render(
      <ChatActionsProvider value={{ sessionId: "s1", sendUserMessage }}>
        <EmailDraftCard raw={"To: a@b.c\nCc: d@e.f\nSubject: Quarterly sync\n\nbody"} />
      </ChatActionsProvider>
    );
    const button = screen.getByRole("button", { name: /Send/ });
    fireEvent.click(button);
    expect(sendUserMessage).toHaveBeenCalledWith(
      'Send the draft to a@b.c, cc d@e.f — subject "Quarterly sync". Send it now.'
    );
    // After the click the label flips to "Sent" and the button is disabled, so
    // a second click can't re-fire.
    const sentButton = screen.getByRole("button", { name: /Sent/ }) as HTMLButtonElement;
    expect(sentButton.disabled).toBe(true);
    fireEvent.click(sentButton);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  // A draft with no Cc omits the ", cc …" clause from the composed instruction.
  test("the composed instruction omits the cc clause when there is no Cc", () => {
    const sendUserMessage = mock((_: string) => {});
    render(
      <ChatActionsProvider value={{ sessionId: "s1", sendUserMessage }}>
        <EmailDraftCard raw={"To: a@b.c\nSubject: Solo\n\nbody"} />
      </ChatActionsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(sendUserMessage).toHaveBeenCalledWith('Send the draft to a@b.c — subject "Solo". Send it now.');
  });
});
