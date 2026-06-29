/// <reference lib="dom" />

// EmailDraftCard parses an RFC-ish plain-text draft (header lines up to the
// first blank line, then the body) and renders it read-only with a copy
// affordance. When the fence carries a DraftId, it also shows a Send button
// that sends the SAVED Gmail draft directly server-side (no agent turn) and
// renders a persistent "Sent" across refresh. These tests pin the parser folds
// (recognized headers, the non-header line that ends headers, CRLF, no-header),
// both copy outcomes, the DraftId/Account metadata extraction (never shown as
// recipients), the Send-only-with-DraftId rule, the sent-marker mount query,
// and the click → POST → Sent/Sending/error branches.

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Controllable api() mock: each test sets `apiImpl` to drive the sent-marker
// query and the send POST. Installed before importing the component so the card
// picks up the stub.
type ApiCall = { path: string; init?: RequestInit };
let apiCalls: ApiCall[] = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({ sent: [] });
const api = mock((path: string, init?: RequestInit) => {
  apiCalls.push({ path, init });
  return apiImpl(path, init);
});
mock.module("@/lib/api", () => ({ api }));

const { EmailDraftCard } = await import("./EmailDraftCard");

const writeText = mock((_: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
  apiCalls = [];
  apiImpl = async () => ({ sent: [] });
  api.mockClear();
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

  // Without a DraftId (doc viewer / file preview / skills page, or a draft the
  // agent didn't tag) the card stays read-only — no Send affordance, no query.
  test("renders no Send button without a DraftId", () => {
    render(<EmailDraftCard raw={"To: a@b.c\nSubject: Hi\n\nbody"} />);
    expect(screen.queryByText("Send")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  // DraftId/Account are metadata: extracted (drive the Send), never shown as To/
  // Cc/recipient rows.
  test("extracts DraftId/Account as metadata and does not render them as rows", async () => {
    render(
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
    // The mount sent-marker query fired with the draft id.
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(apiCalls[0]!.path).toBe("/email/drafts/sent?ids=r123");
  });

  // On mount the card asks whether the draft was already sent; if so it renders
  // the disabled "Sent" state (this is what persists across a page refresh).
  test("a draft already sent renders a disabled Sent on mount", async () => {
    apiImpl = async (path) => (path.startsWith("/email/drafts/sent") ? { sent: ["r123"] } : { ok: true });
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(screen.queryByText("Sent")).not.toBeNull());
    const button = screen.getByRole("button", { name: /Sent/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  // A draft NOT yet sent shows a clickable Send even when the mount query runs.
  test("a not-yet-sent draft shows a clickable Send", async () => {
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // Click → POST /email/drafts/send with the draftId + account; success flips to
  // a disabled "Sent".
  test("Send posts the draft directly and flips to Sent on success", async () => {
    let resolveSend: (v: { ok: boolean }) => void = () => {};
    apiImpl = async (path, init) => {
      if (path.startsWith("/email/drafts/sent")) return { sent: [] };
      // /email/drafts/send — hold so the in-flight "Sending…" is observable.
      return new Promise((resolve) => {
        resolveSend = resolve;
        void init;
      });
    };
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\nAccount: me@x.com\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
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
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/email/drafts/send")).toBe(true));
    const post = apiCalls.find((c) => c.path === "/email/drafts/send")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ draftId: "r123" });
  });

  // A server-side {ok:false} re-enables Send and surfaces the message.
  test("a failed send re-enables Send and shows the error message", async () => {
    apiImpl = async (path) =>
      path.startsWith("/email/drafts/sent") ? { sent: [] } : { ok: false, message: "Invalid draft" };
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("Invalid draft")).not.toBeNull());
    const button = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  // A thrown api() error (network / gateway down) surfaces the error and
  // re-enables Send.
  test("a thrown send error surfaces the message and re-enables Send", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/email/drafts/sent")) return { sent: [] };
      throw new Error("gateway down");
    };
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByText("gateway down")).not.toBeNull());
    expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // A failed mount sent-marker query leaves the button clickable (best-effort).
  test("a failed sent-marker query leaves Send clickable", async () => {
    apiImpl = async () => {
      throw new Error("query failed");
    };
    render(<EmailDraftCard raw={"To: a@b.c\nDraftId: r123\n\nbody"} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    // Give the rejected promise a tick to settle.
    await act(async () => {});
    const button = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
