import { describe, expect, test } from "bun:test";
import { shouldShowEphemeralWarning } from "@/lib/tunnel-warning";

// Coverage for the ephemeral-warning band rendered inside TunnelCard. The
// component itself depends on next/react-query/lucide modules that won't
// resolve in a plain bun:test runner; the band's visibility is driven by
// the pure `shouldShowEphemeralWarning` predicate the component imports,
// so pinning the predicate's three cases pins the band's three cases too.
describe("TunnelCard ephemeral warning band", () => {
  test("tunnel ENABLED + notes OFF → band visible", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: true, notesEnabled: false })).toBe(true);
  });

  test("tunnel ENABLED + notes ON → band hidden", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: true, notesEnabled: true })).toBe(false);
  });

  test("tunnel DISABLED → band hidden", () => {
    expect(shouldShowEphemeralWarning({ tunnelEnabled: false, notesEnabled: false })).toBe(false);
    expect(shouldShowEphemeralWarning({ tunnelEnabled: false, notesEnabled: true })).toBe(false);
  });
});
