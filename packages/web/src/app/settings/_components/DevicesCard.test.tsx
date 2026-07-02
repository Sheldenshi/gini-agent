// effectiveStatus is pure display logic: a relay session stored as "active" but
// past its expiresAt should read as "expired" (the gateway enforces expiry lazily
// at token-resolution time, never flipping the stored status), while devices with
// no expiresAt (mobile/code-claimed) and non-active rows are reported verbatim.
//
// Imports the pure deviceStatus module directly — NOT DevicesCard — so the
// component's UI imports (StatusPill, PageHeader) aren't pulled into the
// component coverage gate by this logic test.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { effectiveStatus, isExpired, isListedSession } from "./deviceStatus";

describe("effectiveStatus", () => {
  afterEach(() => setSystemTime());

  test("an active session past expiresAt reads as expired", () => {
    setSystemTime(new Date("2025-06-01T00:00:00.000Z"));
    expect(effectiveStatus({ status: "active", expiresAt: "2025-05-01T00:00:00.000Z" })).toBe("expired");
  });

  test("an active session before expiresAt stays active", () => {
    setSystemTime(new Date("2025-06-01T00:00:00.000Z"));
    expect(effectiveStatus({ status: "active", expiresAt: "2025-07-01T00:00:00.000Z" })).toBe("active");
  });

  test("an active session with no expiresAt (mobile/code-claimed) stays active", () => {
    expect(effectiveStatus({ status: "active" })).toBe("active");
    expect(isExpired({ status: "active" })).toBe(false);
  });

  test("a non-active status is reported verbatim regardless of expiry", () => {
    setSystemTime(new Date("2025-06-01T00:00:00.000Z"));
    expect(effectiveStatus({ status: "revoked", expiresAt: "2025-05-01T00:00:00.000Z" })).toBe("revoked");
  });
});

// isListedSession is the Active sessions list filter: a revoked device drops out
// (it can never become active again; the row survives in durable state for audit),
// while active/pending/expired devices stay listed.
describe("isListedSession", () => {
  afterEach(() => setSystemTime());

  test("a revoked device is excluded from the list", () => {
    expect(isListedSession({ status: "revoked" })).toBe(false);
  });

  test("active, pending, and expired devices stay listed", () => {
    setSystemTime(new Date("2025-06-01T00:00:00.000Z"));
    expect(isListedSession({ status: "active" })).toBe(true);
    expect(isListedSession({ status: "pending" })).toBe(true);
    // an active row past its expiresAt reads as expired — still shown, not revoked
    expect(isListedSession({ status: "active", expiresAt: "2025-05-01T00:00:00.000Z" })).toBe(true);
  });
});
