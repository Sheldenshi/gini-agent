// Unit tests for the notification-preview builder. Pins:
//   - message_completed → latest assistant reply, session title, generic
//     title fallback, null when no message yet
//   - authorization_requested → risk-prefixed body, title with chat name,
//     null when approval resolved / id missing
//   - setup_requested → setup ask, null when resolved / id missing
//   - condense() whitespace flattening + length cap + whole-word ellipsis

import { describe, expect, test } from "bun:test";
import { buildNotificationPreview, condense, type PreviewDeps } from "./preview";
import type { Authorization, Instance, SetupRequest } from "../../types";

const INST = "test-inst" as Instance;

function buildAuth(overrides?: Partial<Authorization>): Authorization {
  return {
    id: "appr_1",
    instance: INST,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    action: "terminal.exec",
    target: "rm -rf foo",
    risk: "high",
    reason: "Delete the build cache",
    payload: {},
    ...overrides
  };
}

function buildSetup(overrides?: Partial<SetupRequest>): SetupRequest {
  return {
    id: "setup_1",
    instance: INST,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    action: "browser.connect",
    target: "https://example.com/login",
    reason: "Sign in to your account",
    payload: {},
    ...overrides
  };
}

// Default deps: every lookup returns null. Each test overrides the one(s)
// it exercises so an unexpected lookup surfaces as a null/absent result
// rather than silently passing.
function deps(overrides?: Partial<PreviewDeps>): PreviewDeps {
  return {
    latestAssistantText: () => null,
    sessionTitle: () => null,
    authorization: () => null,
    setupRequest: () => null,
    ...overrides
  };
}

describe("condense", () => {
  test("flattens internal whitespace and trims", () => {
    expect(condense("  hello\n\nworld\t  again  ")).toBe("hello world again");
  });

  test("returns short text unchanged", () => {
    expect(condense("short")).toBe("short");
  });

  test("caps at the max and appends an ellipsis at a word boundary", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const out = condense(text, 20);
    expect(out.endsWith("…")).toBe(true);
    // No trailing partial word before the ellipsis.
    expect(out).toBe("alpha beta gamma…");
    expect(out.length).toBeLessThanOrEqual(21); // 20 + the ellipsis char
  });

  test("hard-clips when there is no late word boundary to break on", () => {
    // A single very long token (no spaces past the 60% mark) must still
    // be capped rather than returned whole.
    const text = "x".repeat(50);
    const out = condense(text, 20);
    expect(out).toBe(`${"x".repeat(20)}…`);
  });

  test("uses the default cap when none is passed", () => {
    const long = "word ".repeat(100).trim();
    const out = condense(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(179); // 178 default + ellipsis
  });

  test("breaks mid-string only when the last space sits past 60% of the cap", () => {
    // The only space is early (before 60% of cap=20 → 12), so we hard-clip
    // instead of breaking on it, exercising the `head = clipped` branch.
    const text = "ab cdefghijklmnopqrstuvwxyz";
    const out = condense(text, 20);
    expect(out).toBe(`${text.slice(0, 20)}…`);
  });
});

describe("buildNotificationPreview — message_completed", () => {
  test("returns the latest assistant text with the session title", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "message_completed", sessionId: "chat_x" },
      deps({
        latestAssistantText: () => "Here is your summary of the news.",
        sessionTitle: () => "Morning briefing"
      })
    );
    expect(preview).toEqual({
      title: "Morning briefing",
      body: "Here is your summary of the news."
    });
  });

  test("falls back to the generic title when the session is untitled", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "message_completed", sessionId: "chat_x" },
      deps({
        latestAssistantText: () => "Done.",
        sessionTitle: () => "   "
      })
    );
    expect(preview?.title).toBe("Gini");
    expect(preview?.body).toBe("Done.");
  });

  test("returns null when the session has no assistant message yet", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "message_completed", sessionId: "chat_x" },
      deps({ latestAssistantText: () => null })
    );
    expect(preview).toBeNull();
  });

  test("returns null when the latest assistant text is whitespace-only", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "message_completed", sessionId: "chat_x" },
      deps({ latestAssistantText: () => "   \n  " })
    );
    expect(preview).toBeNull();
  });

  test("condenses a multi-line reply into a single banner line", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "message_completed", sessionId: "chat_x" },
      deps({
        latestAssistantText: () => "Line one.\nLine two.\n\nLine three.",
        sessionTitle: () => "Chat"
      })
    );
    expect(preview?.body).toBe("Line one. Line two. Line three.");
  });
});

describe("buildNotificationPreview — authorization_requested", () => {
  test("returns a risk-prefixed body and a title naming the chat", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x", approvalId: "appr_1" },
      deps({
        sessionTitle: () => "Deploy bot",
        authorization: () => buildAuth()
      })
    );
    expect(preview).toEqual({
      title: "Approve in Deploy bot?",
      body: "[high] Delete the build cache"
    });
  });

  test("falls back to the generic approval title when untitled", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x", approvalId: "appr_1" },
      deps({ authorization: () => buildAuth() })
    );
    expect(preview?.title).toBe("Gini needs your approval");
  });

  test("uses target when reason is empty, and omits risk prefix when blank", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x", approvalId: "appr_1" },
      deps({
        authorization: () => buildAuth({ reason: "", risk: "" as Authorization["risk"] })
      })
    );
    expect(preview?.body).toBe("rm -rf foo");
  });

  test("falls back to the action verb when reason and target are both empty", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x", approvalId: "appr_1" },
      deps({
        authorization: () =>
          buildAuth({ reason: "", target: "", risk: "" as Authorization["risk"] })
      })
    );
    expect(preview?.body).toBe("terminal.exec");
  });

  test("returns null when approvalId is missing", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x" },
      deps({ authorization: () => buildAuth() })
    );
    expect(preview).toBeNull();
  });

  test("returns null when the approval is gone (resolved)", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "authorization_requested", sessionId: "chat_x", approvalId: "appr_1" },
      deps({ authorization: () => null })
    );
    expect(preview).toBeNull();
  });
});

describe("buildNotificationPreview — setup_requested", () => {
  test("returns the setup ask with a title naming the chat", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x", approvalId: "setup_1" },
      deps({
        sessionTitle: () => "Email watch",
        setupRequest: () => buildSetup()
      })
    );
    expect(preview).toEqual({
      title: "Finish a step in Email watch",
      body: "Sign in to your account"
    });
  });

  test("falls back to the generic setup title when untitled", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x", approvalId: "setup_1" },
      deps({ setupRequest: () => buildSetup() })
    );
    expect(preview?.title).toBe("Gini needs you to finish a step");
  });

  test("uses target when reason is empty", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x", approvalId: "setup_1" },
      deps({ setupRequest: () => buildSetup({ reason: "" }) })
    );
    expect(preview?.body).toBe("https://example.com/login");
  });

  test("falls back to the action when reason and target are empty", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x", approvalId: "setup_1" },
      deps({ setupRequest: () => buildSetup({ reason: "", target: "" }) })
    );
    expect(preview?.body).toBe("browser.connect");
  });

  test("returns null when approvalId is missing", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x" },
      deps({ setupRequest: () => buildSetup() })
    );
    expect(preview).toBeNull();
  });

  test("returns null when the setup request is gone", () => {
    const preview = buildNotificationPreview(
      INST,
      { event: "setup_requested", sessionId: "chat_x", approvalId: "setup_1" },
      deps({ setupRequest: () => null })
    );
    expect(preview).toBeNull();
  });
});
