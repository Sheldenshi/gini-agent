// Plugin unit tests. These exercise the pure-JS helpers exported from
// the plugin without invoking the full Expo config-plugin loader chain
// (which would require an Xcode project on disk). The expensive bits —
// actually merging the NSE target into a real .pbxproj — are validated
// by the user running `bunx expo prebuild --platform ios --clean` and
// opening the generated `ios/<App>.xcworkspace` in Xcode.
//
// Tests are written as plain bun:test specs so `bun test` from repo
// root picks them up alongside the rest of the suite.

const { test, expect, describe } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const plist = require("plist");

const plugin = require("./with-approval-notification-service.js");

describe("with-approval-notification-service", () => {
  test("resolveOptions fills sensible iOS defaults", () => {
    const opts = plugin.resolveOptions({});
    expect(opts.targetName).toBe("ApprovalNotificationService");
    expect(opts.bundleSuffix).toBe(".notificationservice");
    expect(opts.iosDeployment).toBe("15.1");
  });

  test("resolveOptions respects user overrides", () => {
    const opts = plugin.resolveOptions({
      targetName: "CustomNSE",
      bundleSuffix: ".pushext",
      iosDeployment: "16.0"
    });
    expect(opts.targetName).toBe("CustomNSE");
    expect(opts.bundleSuffix).toBe(".pushext");
    expect(opts.iosDeployment).toBe("16.0");
  });

  test("resolveOptions derives the App Group from the host bundle id", () => {
    const opts = plugin.resolveOptions({}, "ai.lilaclabs.gini.mobile");
    expect(opts.appGroup).toBe("group.ai.lilaclabs.gini.mobile");
  });

  test("resolveOptions falls back to the default bundle id when none is passed", () => {
    const opts = plugin.resolveOptions({});
    expect(opts.appGroup).toBe("group.ai.lilaclabs.gini.mobile");
  });

  test("resolveOptions respects an explicit appGroup override", () => {
    const opts = plugin.resolveOptions({ appGroup: "group.custom.id" }, "ai.lilaclabs.gini.mobile");
    expect(opts.appGroup).toBe("group.custom.id");
  });

  test("buildExtensionEntitlements carries the App Group membership", () => {
    const opts = plugin.resolveOptions({}, "ai.lilaclabs.gini.mobile");
    const ent = plugin.buildExtensionEntitlements(opts);
    expect(ent[plugin.APP_GROUPS_ENTITLEMENT]).toEqual(["group.ai.lilaclabs.gini.mobile"]);
  });

  test("buildExtensionInfoPlist sets the two required NSE keys", () => {
    const info = plugin.buildExtensionInfoPlist(plugin.resolveOptions({}));
    expect(info.NSExtension.NSExtensionPointIdentifier).toBe(
      "com.apple.usernotifications.service"
    );
    // NSExtensionPrincipalClass must resolve to a Swift class the OS
    // can construct; the plugin uses $(PRODUCT_MODULE_NAME) so a
    // future targetName change doesn't drift from the source.
    expect(info.NSExtension.NSExtensionPrincipalClass).toBe(
      "$(PRODUCT_MODULE_NAME).NotificationService"
    );
  });

  test("readCanonicalSwiftSource returns the on-disk NSE source", () => {
    const source = plugin.readCanonicalSwiftSource();
    // Sanity-check the class + override the OS calls into. If a
    // future refactor renames either, the plugin's pbxproj wiring
    // would fall out of sync and we want a loud test failure.
    expect(source).toContain("class NotificationService");
    expect(source).toContain("didReceive");
    // Category id must match the dispatcher's payload (server-side
    // src/integrations/apns/dispatcher.ts) so the OS shows the
    // Approve / Deny buttons we register on the mobile side.
    expect(source).toContain("APPROVAL_REQUEST");
  });

  test("writeExtensionSources copies the Swift + plist into the prebuild output", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nse-plugin-"));
    try {
      const opts = plugin.resolveOptions({});
      plugin.writeExtensionSources(tempRoot, opts);

      const swiftPath = path.join(tempRoot, "ios", opts.targetName, "NotificationService.swift");
      const plistPath = path.join(tempRoot, "ios", opts.targetName, `${opts.targetName}-Info.plist`);
      const entitlementsPath = path.join(tempRoot, "ios", opts.targetName, `${opts.targetName}.entitlements`);

      expect(fs.existsSync(swiftPath)).toBe(true);
      expect(fs.existsSync(plistPath)).toBe(true);
      expect(fs.existsSync(entitlementsPath)).toBe(true);

      // The written Swift must match the canonical source byte-for-byte —
      // no munging during the copy, so an Xcode-side debug session
      // shows the same file the repo holds.
      expect(fs.readFileSync(swiftPath, "utf8")).toBe(plugin.readCanonicalSwiftSource());

      // Plist round-trips through `plist.parse` cleanly and carries the
      // NSE keys.
      const parsed = plist.parse(fs.readFileSync(plistPath, "utf8"));
      expect(parsed.NSExtension.NSExtensionPointIdentifier).toBe(
        "com.apple.usernotifications.service"
      );

      // The NSE entitlements carry the shared App Group so the extension
      // can reach the container the app writes credentials into.
      const entitlements = plist.parse(fs.readFileSync(entitlementsPath, "utf8"));
      expect(entitlements[plugin.APP_GROUPS_ENTITLEMENT]).toEqual([
        "group.ai.lilaclabs.gini.mobile"
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("writeExtensionSources is idempotent (safe to call twice on the same root)", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nse-plugin-"));
    try {
      const opts = plugin.resolveOptions({});
      plugin.writeExtensionSources(tempRoot, opts);
      // Second call should not throw — re-running prebuild is a
      // common workflow and the plugin must survive it.
      expect(() => plugin.writeExtensionSources(tempRoot, opts)).not.toThrow();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
