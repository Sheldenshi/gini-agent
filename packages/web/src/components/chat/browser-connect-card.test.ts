// Pins the browser.connect card's completion-button wording per payload
// mode. The default (no mode — every sign-in flow, including pre-existing
// rows) must keep the historical "Connect" → "I've signed in" labels
// byte-for-byte; only an explicit mode:"handoff" generalizes the
// completion label to "I'm done" (ADR browser-connect-handoff.md).

import { describe, expect, test } from "bun:test";
import { browserConnectButtonLabel } from "./browser-connect-card";

describe("browserConnectButtonLabel", () => {
  test("sign-in default: 'Connect' before the window opens, 'I've signed in' after", () => {
    const payload = { reason: "Sign in to Google", toolCallId: "call_1", headless: false };
    expect(browserConnectButtonLabel(payload, false)).toBe("Connect");
    expect(browserConnectButtonLabel(payload, true)).toBe("I've signed in");
  });

  test("handoff mode: 'Connect' before the window opens, 'I'm done' after", () => {
    const payload = { reason: "Enter your payment details", mode: "handoff" };
    expect(browserConnectButtonLabel(payload, false)).toBe("Connect");
    expect(browserConnectButtonLabel(payload, true)).toBe("I'm done");
  });

  test("missing payload or unrecognized mode falls back to the sign-in wording", () => {
    expect(browserConnectButtonLabel(undefined, true)).toBe("I've signed in");
    expect(browserConnectButtonLabel(null, true)).toBe("I've signed in");
    expect(browserConnectButtonLabel({ mode: "something-else" }, true)).toBe("I've signed in");
  });
});
