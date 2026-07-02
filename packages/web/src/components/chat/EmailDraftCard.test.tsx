/// <reference lib="dom" />

// EmailDraftCard parses an RFC-ish plain-text draft (header lines up to the
// first blank line, then the body), renders it with a copy affordance, and
// ALWAYS shows a Send button that sends the SAVED Gmail draft directly
// server-side (no agent turn) using the fence's DraftId. Whether the draft is
// already sent comes from SentDraftsContext (primed eagerly by ChatSurface), so
// the disabled "Sent" renders on first paint with no "Send" flash on refresh.
// These tests pin the parser folds (recognized headers, the non-header line that
// ends headers, CRLF, no-header), both copy outcomes, the DraftId/Account
// metadata extraction (never shown as recipients), the always-rendered Send
// footer, the context-driven Sent/Send/checking states, and the click → POST →
// Sent/Sending/error branches.

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { SentDraftsProvider } from "./SentDraftsContext";

// Controllable api() mock: each test sets `apiImpl` to drive the send POST.
// Installed before importing the component so the card picks up the stub. The
// card no longer queries on mount — only the send click hits api now.
type ApiCall = { path: string; init?: RequestInit };
let apiCalls: ApiCall[] = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({ ok: true });
const api = mock((path: string, init?: RequestInit) => {
  apiCalls.push({ path, init });
  return apiImpl(path, init);
});
mock.module("@/lib/api", () => ({ api }));

const { EmailDraftCard } = await import("./EmailDraftCard");

const writeText = mock((_: string) => Promise.resolve());

// Render the card inside a SentDraftsProvider so it can resolve its "Sent"
// state from context. Defaults to a settled, empty set (the steady state for a
// not-yet-sent draft once the eager query has loaded).
function renderCard(
  element: ReactElement,
  ctx: { sentIds?: Set<string>; loaded?: boolean } = {}
) {
  return render(
    <SentDraftsProvider value={{ sentIds: ctx.sentIds ?? new Set(), loaded: ctx.loaded ?? true }}>
      {element}
    </SentDraftsProvider>
  );
}

beforeEach(() => {
  writeText.mockClear();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
  apiCalls = [];
  apiImpl = async () => ({ ok: true });
  api.mockClear();
});

// The copy test enables fake timers; always restore real timers so a failure
// can't leak the fake clock into the next test.
afterEach(() => {
  jest.useRealTimers();
});

describe("EmailDraftCard", () => {
  test("renders recognized headers (Subject bold) and the body", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\r\nCc: d@e.f\nSubject: Quarterly sync\n\nSee you Tuesday.\nBring notes."} />);
    expect(screen.queryByText("To:")).not.toBeNull();
    expect(screen.queryByText("Cc:")).not.toBeNull();
    const subject = screen.getByText("Quarterly sync");
    expect(subject.className).toContain("font-semibold");
    expect(screen.queryByText(/See you Tuesday\./)).not.toBeNull();
  });

  test("a non-header first line means no header section — body only", () => {
    renderCard(<EmailDraftCard raw={"just a body line\nDate: not-a-recognized-header"} />);
    expect(screen.queryByText("To:")).toBeNull();
    expect(screen.queryByText(/just a body line/)).not.toBeNull();
  });

  test("an unrecognized header-shaped line ends the headers and joins the body", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDate: 2026-06-11\n\nactual body"} />);
    expect(screen.queryByText("To:")).not.toBeNull();
    expect(screen.queryByText(/Date: 2026-06-11/)).not.toBeNull();
  });

  // fireEvent (not userEvent) for the copy tests: userEvent.setup() installs
  // its own navigator.clipboard stub, which would shadow the mock under test.
  test("copy writes the trimmed raw draft and flips to Copied, then back", async () => {
    jest.useFakeTimers();
    renderCard(<EmailDraftCard raw={"To: a@b.c\n\nbody"} />);
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
    renderCard(<EmailDraftCard raw={"body only"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.queryByText(/body only/)).not.toBeNull();
  });

  // The Send footer always renders. Without a DraftId the button is still shown
  // (every real emitter tags a DraftId now), but the onSend guard makes a click a
  // no-op so it never POSTs without an id to send.
  test("renders the Send button and a click is a no-op without a DraftId", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nSubject: Hi\n\nbody"} />);
    expect(screen.queryByText("Send")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(api).not.toHaveBeenCalled();
  });

  // DraftId/Account are metadata: extracted (drive the Send), never shown as To/
  // Cc/recipient rows. With a settled context, no mount api call fires.
  test("extracts DraftId/Account as metadata and does not render them as rows", () => {
    renderCard(
      <EmailDraftCard
        raw={"To: a@b.c\nSubject: Hi\nDraftId: r123\nAccount: me@x.com\n\nbody"}
      />
    );
    // Neither metadata key appears as a header row.
    expect(screen.queryByText("DraftId:")).toBeNull();
    expect(screen.queryByText("Account:")).toBeNull();
    expect(screen.queryByText(/r123/)).toBeNull();
    expect(screen.queryByText(/me@x\.com/)).toBeNull();
    // The recognized header still renders.
    expect(screen.queryByText("To:")).not.toBeNull();
    // No mount fetch — the card reads sent-state from context, never queries.
    expect(api).not.toHaveBeenCalled();
  });

  // A draft already in the (settled) context's sent set renders the disabled
  // "Sent" on first paint, with no "Send" flash and no api call. This is the
  // refresh path the fix targets.
  test("a draft in the context sent set renders a disabled Sent with no Send flash", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />, {
      sentIds: new Set(["r123"]),
      loaded: true
    });
    expect(screen.queryByText("Sent")).not.toBeNull();
    // The active "Send" text never appears for a sent draft.
    expect(screen.queryByText("Send")).toBeNull();
    const button = screen.getByRole("button", { name: /Sent/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });

  // A draft NOT in the settled context's set shows a clickable "Send".
  test("a not-sent draft with the context loaded shows a clickable Send", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />, {
      sentIds: new Set(),
      loaded: true
    });
    const button = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // Before the eager context settles, the card shows a disabled spinner —
  // never the active "Send" text — so a sent draft can't flash "Send".
  test("an unloaded context renders a disabled spinner, not Send", () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />, {
      sentIds: new Set(),
      loaded: false
    });
    expect(screen.queryByText("Send")).toBeNull();
    const button = screen.getByRole("button", { name: "Checking draft status" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  // Click → POST /email/drafts/send with the draftId + account; success flips to
  // a disabled "Sent".
  test("Send posts the draft directly and flips to Sent on success", async () => {
    let resolveSend: (v: { ok: boolean }) => void = () => {};
    apiImpl = async (_path, init) =>
      new Promise((resolve) => {
        resolveSend = resolve;
        void init;
      });
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\nAccount: me@x.com\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    // In-flight label + disabled.
    await waitFor(() => expect(screen.queryByText("Sending…")).not.toBeNull());
    expect((screen.getByRole("button", { name: /Sending/ }) as HTMLButtonElement).disabled).toBe(true);
    // The POST carried the draftId + account.
    const post = apiCalls.find((c) => c.path === "/email/drafts/send");
    expect(post).toBeDefined();
    expect(post!.init?.method).toBe("POST");
    expect(JSON.parse(post!.init!.body as string)).toEqual({ draftId: "r123", account: "me@x.com" });
    // Resolve the send → "Sent", disabled, and a second click is a no-op.
    await act(async () => {
      resolveSend({ ok: true });
    });
    await waitFor(() => expect(screen.queryByText("Sent")).not.toBeNull());
    const sentButton = screen.getByRole("button", { name: /Sent/ }) as HTMLButtonElement;
    expect(sentButton.disabled).toBe(true);
    fireEvent.click(sentButton);
    expect(apiCalls.filter((c) => c.path === "/email/drafts/send").length).toBe(1);
  });

  // A draft with no Account omits it from the POST body.
  test("the send POST omits account when the fence has none", async () => {
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/email/drafts/send")).toBe(true));
    const post = apiCalls.find((c) => c.path === "/email/drafts/send")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ draftId: "r123" });
  });

  // A server-side {ok:false} re-enables Send and surfaces the message.
  test("a failed send re-enables Send and shows the error message", async () => {
    apiImpl = async () => ({ ok: false, message: "Invalid draft" });
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("Invalid draft")).not.toBeNull());
    const button = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // A {ok:false} with no message falls back to the generic copy.
  test("a failed send with no message shows the generic error copy", async () => {
    apiImpl = async () => ({ ok: false });
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("Couldn't send the draft.")).not.toBeNull());
  });

  // A thrown api() Error (network / gateway down) surfaces its message and
  // re-enables Send.
  test("a thrown send error surfaces the message and re-enables Send", async () => {
    apiImpl = async () => {
      throw new Error("gateway down");
    };
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("gateway down")).not.toBeNull());
    expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // A thrown non-Error rejection falls back to the generic error copy.
  test("a thrown non-Error rejection shows the generic error copy", async () => {
    apiImpl = async () => {
      throw "boom";
    };
    renderCard(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("Couldn't send the draft.")).not.toBeNull());
  });
});
