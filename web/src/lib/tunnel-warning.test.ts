import { describe, expect, test } from "bun:test";
import { shouldShowEphemeralWarning } from "./tunnel-warning";

describe("shouldShowEphemeralWarning", () => {
  test("tunnel enabled, notes disabled — band visible (rotation case unhandled)", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: true, notesEnabled: false })).toBe(true);
  });

  test("tunnel enabled, notes enabled — band hidden (mirror covers rotation)", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: true, notesEnabled: true })).toBe(false);
  });

  test("tunnel disabled — band hidden regardless of notes setting", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: false, notesEnabled: false })).toBe(false);
    expect(shouldShowEphemeralWarning({ tunnelEnabled: false, notesEnabled: true })).toBe(false);
  });
});
