import { describe, expect, test } from "bun:test";
import { isLaunchdManaged } from "./launchd";
import type { PlistKind } from "./launchd";

// isLaunchdManaged decides on the TARGET instance's launchd state — any of its
// services loaded OR any of its plists on disk — never the calling process's
// env. Inject fakes so no real launchctl runs and no real plist is read.
describe("isLaunchdManaged (target instance launchd state)", () => {
  const noPlist = () => false;
  const plistFor = (instance: string, kind?: PlistKind) => `/fake/${instance}.${kind}.plist`;

  test("any service loaded -> managed (short-circuits on first loaded kind)", () => {
    const probed: Array<PlistKind | undefined> = [];
    const decision = isLaunchdManaged("inst", {
      isLoaded: (_inst, kind) => {
        probed.push(kind);
        return kind === "gateway";
      },
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
    expect(probed).toEqual(["gateway"]);
  });

  test("a plist on disk (registered but stopped) -> managed", () => {
    const decision = isLaunchdManaged("inst", {
      isLoaded: () => false,
      plistExists: (path: string) => path.includes("web"),
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
  });

  test("nothing loaded and no plist on disk -> not managed", () => {
    const decision = isLaunchdManaged("inst", {
      isLoaded: () => false,
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(false);
  });
});
