/**
 * Expo config plugin: adds an iOS Notification Service Extension (NSE)
 * to the prebuild output. The NSE runs as a separate process when an
 * APNs payload with `mutable-content: 1` arrives, and (because we set
 * `categoryIdentifier = "APPROVAL_REQUEST"`) lets the OS surface the
 * Approve / Deny action buttons on the lock screen.
 *
 * The plugin is idempotent on `expo prebuild` — re-running prebuild
 * skips already-added targets, files, and build phases.
 *
 * Build-flow consequences (read mobile/README.md "iOS dev client + NSE"):
 *   - Managed Expo Go no longer works for this app. Use
 *     `bunx expo prebuild --platform ios --clean` then
 *     `bunx expo run:ios`, or EAS Build for distribution.
 *   - The generated `ios/` directory is gitignored; the plugin writes
 *     the NSE sources into `ios/<APP_NAME>NotificationService/` during
 *     prebuild.
 *
 * Inputs (passed as the plugin's options in app.json):
 *   - `targetName`   — defaults to "ApprovalNotificationService"
 *   - `bundleSuffix` — defaults to ".notificationservice", appended to
 *                      the host app's bundle id to produce the NSE
 *                      bundle id (e.g. "ai.lilaclabs.gini.mobile.notificationservice")
 *   - `iosDeployment` — defaults to "15.1", the NSE's minimum iOS version
 *   - `appleTeamId`  — required for EAS Build / archive signing. Sets
 *                      DEVELOPMENT_TEAM on the NSE target so automatic
 *                      signing can resolve a provisioning profile.
 *                      Without it, Xcode emits the misleading
 *                      "resource bundles are signed by default" error.
 *   - `appGroup`     — App Group id shared by the main app and the NSE so
 *                      the extension can read the gateway base URL + bearer
 *                      the app writes to the shared container. Defaults to
 *                      "group.<hostBundleId>". Both targets get the
 *                      `com.apple.security.application-groups` entitlement
 *                      with this id; the NSE fetch-and-enrich path
 *                      (NotificationService.swift) reads the creds from the
 *                      container that id resolves to. See ADR
 *                      mobile-push-notifications.md.
 *
 * Source of truth for the Swift NSE itself:
 *   mobile/ios-extensions/ApprovalNotificationService/NotificationService.swift
 *   The plugin copies that file into the generated extension target on
 *   every prebuild so the on-disk source is the canonical reference.
 */

// Resolve config-plugins through the `expo` package re-export (Expo's
// documented pattern for local plugins): under the workspace's isolated
// installs, the bare `@expo/config-plugins` package is not resolvable from
// here because it isn't a declared dependency — the re-export rides on the
// declared `expo` dependency and always matches its SDK version.
const {
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");
const plist = require("plist");

const DEFAULT_TARGET_NAME = "ApprovalNotificationService";
const DEFAULT_BUNDLE_SUFFIX = ".notificationservice";
const DEFAULT_IOS_DEPLOYMENT = "15.1";
// The entitlement key both targets need to share an App Group container.
const APP_GROUPS_ENTITLEMENT = "com.apple.security.application-groups";

// Returns the absolute path to the canonical NSE source bundled in the
// repo. The plugin reads from here and writes into the prebuild output
// so a future Swift edit only has to happen in one place.
function getCanonicalSourceDir() {
  return path.join(__dirname, "..", "ios-extensions", "ApprovalNotificationService");
}

// Reads the canonical Swift source. Exported as a helper so the unit
// test can assert that the on-disk file matches what the plugin would
// write into the prebuild output.
function readCanonicalSwiftSource() {
  const sourcePath = path.join(getCanonicalSourceDir(), "NotificationService.swift");
  return fs.readFileSync(sourcePath, "utf8");
}

// Builds the NSE's Info.plist contents. The two iOS-required keys are
// NSExtensionPointIdentifier (always
// `com.apple.usernotifications.service` for an NSE) and
// NSExtensionPrincipalClass (the Swift class name, prefixed with the
// target name so Objective-C can resolve it).
//
// App Transport Security: an app extension is a separate bundle and does
// NOT inherit the host app's ATS exception, so we must repeat it here.
// The host app sets NSAllowsArbitraryLoads (mobile/app.json) so it can
// reach local http:// gateways (loopback / RFC1918 / CGNAT / *.local —
// see mobile/src/auth.ts isLocalGatewayHost). Without the same exception
// on the NSE, the on-device preview fetch (NotificationService.swift)
// would be blocked by ATS for those gateways and silently fall back to
// the generic banner. Mirror the host app's posture so the rich preview
// works for the same gateway set the app already talks to.
//
// Version strings: Apple requires an extension's CFBundleShortVersionString
// + CFBundleVersion to equal its containing app's, or archive validation
// fails. We write CONCRETE LITERALS into this physical Info.plist (not
// $(BUILD_SETTING) references) because:
//   - CFBundleShortVersionString = the app's marketing version (app.json
//     `version`), so the NSE matches the app for both local and EAS builds.
//   - CFBundleVersion = "1" literal. On EAS production builds with
//     `appVersionSource: remote` + `autoIncrement`, EAS computes one build
//     number from the app target and rewrites the CFBundleVersion *in every
//     target's physical INFOPLIST_FILE* server-side (build-tools
//     updateVersionsAsync) — so this NSE plist's "1" is overwritten to the
//     synced number, matching the app. For local `expo run:ios` the app's
//     build number is also "1", so they match there too.
// This is why the target must keep a real INFOPLIST_FILE and must NOT set
// GENERATE_INFOPLIST_FILE=YES (which would synthesize CFBundleVersion from
// CURRENT_PROJECT_VERSION and defeat the server-side rewrite). A $(...)
// reference here would resolve EMPTY locally (no project-level value under
// remote versioning) and isn't a literal EAS overwrites — hence literals.
function buildExtensionInfoPlist(opts) {
  return {
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleDisplayName: opts.targetName,
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: opts.marketingVersion,
    CFBundleVersion: "1",
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: true
    },
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.usernotifications.service",
      // The principal class is `<TargetName>.NotificationService` —
      // Swift mangles the bare class name with the module (target)
      // name when exposing to Objective-C.
      NSExtensionPrincipalClass: `$(PRODUCT_MODULE_NAME).NotificationService`
    }
  };
}

// Writes the NSE source files into the prebuild output. Called from a
// dangerous mod so we get access to the resolved iOS project root path.
// Idempotent — overwrites the files on every prebuild so the canonical
// repo source stays the source of truth.
function writeExtensionSources(projectRoot, opts) {
  const targetDir = path.join(projectRoot, "ios", opts.targetName);
  fs.mkdirSync(targetDir, { recursive: true });

  const swiftSource = readCanonicalSwiftSource();
  fs.writeFileSync(path.join(targetDir, "NotificationService.swift"), swiftSource, "utf8");

  const infoPlistContents = plist.build(buildExtensionInfoPlist(opts));
  fs.writeFileSync(path.join(targetDir, `${opts.targetName}-Info.plist`), infoPlistContents, "utf8");

  // The NSE's own .entitlements carries the App Group membership so the
  // extension process can resolve the shared container. withEntitlementsPlist
  // only reaches the MAIN app target, so the extension needs its own file
  // written here and linked via CODE_SIGN_ENTITLEMENTS below.
  const entitlementsContents = plist.build(buildExtensionEntitlements(opts));
  fs.writeFileSync(
    path.join(targetDir, `${opts.targetName}.entitlements`),
    entitlementsContents,
    "utf8"
  );
}

// Adds (or no-ops if already present) the NSE target inside the
// Xcode project. The xcode npm package's PBX surface is the canonical
// way to mutate `.pbxproj`; this is the same path used by
// community plugins like `@bacons/apple-targets`.
//
// Returns the modified XcodeProject. Idempotent — if a native target
// with `opts.targetName` already exists, we return early.
function addExtensionTarget(xcodeProject, opts, hostBundleId) {
  const targetName = opts.targetName;
  const productBundleId = hostBundleId + opts.bundleSuffix;

  // xcode exposes targets by hash; iterate to find one by name.
  const existingTargets = xcodeProject.pbxNativeTargetSection();
  for (const key of Object.keys(existingTargets)) {
    const entry = existingTargets[key];
    if (entry && typeof entry === "object" && entry.name === targetName) {
      // Already added on a prior prebuild — nothing to do.
      return xcodeProject;
    }
  }

  // 1) Create the target itself. addTarget signature:
  //    addTarget(name, type, subfolder, bundleId)
  //    The `app_extension` type makes Xcode treat the target as an NSE.
  const target = xcodeProject.addTarget(
    targetName,
    "app_extension",
    targetName,
    productBundleId
  );

  // 2) Add the build phases the NSE needs (sources + resources +
  //    framework linking). Xcode requires each native target to have
  //    its own phases; addBuildPhase returns a phase object the file
  //    refs can attach to.
  xcodeProject.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target.uuid);
  xcodeProject.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  xcodeProject.addBuildPhase(
    ["UserNotifications.framework"],
    "PBXFrameworksBuildPhase",
    "Frameworks",
    target.uuid
  );

  // 3) Create an EMPTY PBXGroup at <SRCROOT>/<targetName>/. We
  //    deliberately do not pass file names here.
  //
  //    Why: xcode-cli's addPbxGroup eagerly creates BOTH a
  //    PBXFileReference and a PBXBuildFile for every file in its
  //    input array (see node_modules/xcode/lib/pbxProject.js:528–
  //    534). It never attaches the PBXBuildFile to a build phase, so
  //    that build file is orphaned in the pbxproj.
  //
  //    Then when we later call addSourceFile for the swift file,
  //    xcode-cli's addFile (called internally) runs `hasFile(path)`
  //    against the already-created PBXFileReference and returns
  //    null — its "null is better for early errors" guard. That
  //    bubbles up as `file = null` in addSourceFile, which silently
  //    bails before reaching addToPbxSourcesBuildPhase. The Swift
  //    source is therefore never added to the NSE's Sources phase,
  //    Xcode compiles nothing for the NSE target, and the .appex
  //    ships with no executable — which crashes the App Store
  //    Connect upload (CFBundleExecutable points at a missing
  //    binary).
  //
  //    Passing [] lets addSourceFile below own the entire
  //    file-ref + build-file + Sources-phase creation chain end to
  //    end.
  const pbxGroup = xcodeProject.addPbxGroup([], targetName, targetName);

  // 4) Attach that group to the project's root group so it shows up in
  //    Xcode's navigator (otherwise the files exist on disk but aren't
  //    visible in the IDE).
  const groups = xcodeProject.hash.project.objects["PBXGroup"];
  for (const key of Object.keys(groups)) {
    if (
      typeof groups[key] === "object" &&
      groups[key].name === undefined &&
      groups[key].path === undefined &&
      groups[key].children !== undefined
    ) {
      xcodeProject.addToPbxGroup(pbxGroup.uuid, key);
      break;
    }
  }

  // 5) Add the Swift source. Now that the group has no pre-existing
  //    file ref for "NotificationService.swift", addSourceFile takes
  //    the full path: addFile creates a PBXFileReference inside
  //    pbxGroup, stamps file.target = target.uuid, registers a
  //    PBXBuildFile, and pushes that PBXBuildFile into THIS target's
  //    PBXSourcesBuildPhase. The path is the basename only — the
  //    parent group already carries `path = targetName`, so xcodebuild
  //    resolves the build input as
  //    `<SRCROOT>/<group.path>/NotificationService.swift`.
  xcodeProject.addSourceFile(
    "NotificationService.swift",
    { target: target.uuid },
    pbxGroup.uuid
  );

  // 5a) Register the NSE's Info.plist as a plain file reference inside
  //     the group. xcodebuild consumes it via the INFOPLIST_FILE build
  //     setting (configured below) — it does not need to be in a
  //     PBXResourcesBuildPhase, and listing it there would actually
  //     bundle a stray copy of the plist into the .appex's Resources
  //     directory. addFile creates only the PBXFileReference (no
  //     PBXBuildFile), which is what we want.
  xcodeProject.addFile(`${targetName}-Info.plist`, pbxGroup.uuid);

  // 5b) Register the NSE's .entitlements the same way — a plain file
  //     reference consumed via the CODE_SIGN_ENTITLEMENTS build setting
  //     (configured below). Like the Info.plist it must NOT land in a
  //     resources build phase; addFile creates only the PBXFileReference.
  xcodeProject.addFile(`${targetName}.entitlements`, pbxGroup.uuid);

  // 6) Configure per-build-config settings the NSE needs:
  //    - Info.plist path
  //    - Bundle id
  //    - iOS deployment target (must be >= 10.0 for NSE; we pin 15.1
  //      to match what RN templates ship with)
  //    - Swift version
  //    - SKIP_INSTALL=NO so archive builds include the extension
  //    - LD_RUNPATH_SEARCH_PATHS for embedded frameworks
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const config = configurations[key];
    if (config && typeof config === "object" && config.buildSettings) {
      const buildSettings = config.buildSettings;
      if (buildSettings.PRODUCT_NAME && buildSettings.PRODUCT_NAME.replace(/"/g, "") === targetName) {
        buildSettings.INFOPLIST_FILE = `"${targetName}/${targetName}-Info.plist"`;
        // Links the NSE's .entitlements (App Group membership) so the
        // extension is signed with access to the shared container.
        buildSettings.CODE_SIGN_ENTITLEMENTS = `"${targetName}/${targetName}.entitlements"`;
        buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${productBundleId}"`;
        // Versions are NOT set as build settings here: they live as
        // concrete literals in the physical Info.plist (buildExtensionInfoPlist),
        // and the target keeps a real INFOPLIST_FILE with no
        // GENERATE_INFOPLIST_FILE=YES. That's what lets EAS's server-side
        // version sync rewrite the NSE's CFBundleVersion to match the
        // app's autoIncremented build number. Setting MARKETING_VERSION /
        // CURRENT_PROJECT_VERSION build settings here would be redundant
        // at best and, paired with GENERATE_INFOPLIST_FILE, would
        // synthesize over the plist and break the sync — so we leave them
        // off and let the plist literals stand.
        buildSettings.IPHONEOS_DEPLOYMENT_TARGET = opts.iosDeployment;
        buildSettings.SWIFT_VERSION = "5.0";
        buildSettings.SKIP_INSTALL = "NO";
        buildSettings.TARGETED_DEVICE_FAMILY = `"1,2"`;
        buildSettings.LD_RUNPATH_SEARCH_PATHS = `"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"`;
        // CODE_SIGN_STYLE = Automatic mirrors what Xcode does when a
        // human adds an extension via the GUI. DEVELOPMENT_TEAM must be
        // set explicitly: EAS injects the team into the main app target
        // via the distribution cert, but the NSE target is created
        // here, after that injection, so it has to carry its own team.
        buildSettings.CODE_SIGN_STYLE = "Automatic";
        if (opts.appleTeamId) {
          buildSettings.DEVELOPMENT_TEAM = opts.appleTeamId;
        }
      }
    }
  }

  return xcodeProject;
}

// Resolves the plugin's options against a partial input. Exported so
// the unit test can verify defaults without invoking the full plugin
// chain. `hostBundleId` lets the App Group default derive from the app's
// bundle id when the caller didn't pin one explicitly; `hostVersion` is
// the app's marketing version (app.json `version`) so the NSE can be
// stamped to match — Apple requires an extension's version to equal its
// containing app's, or archive validation fails.
function resolveOptions(rawOpts, hostBundleId, hostVersion) {
  const opts = rawOpts || {};
  const bundleId = hostBundleId || "ai.lilaclabs.gini.mobile";
  return {
    targetName: opts.targetName || DEFAULT_TARGET_NAME,
    bundleSuffix: opts.bundleSuffix || DEFAULT_BUNDLE_SUFFIX,
    iosDeployment: opts.iosDeployment || DEFAULT_IOS_DEPLOYMENT,
    appleTeamId: opts.appleTeamId,
    appGroup: opts.appGroup || `group.${bundleId}`,
    // Default 1.0 only when no app version is resolvable (keeps the
    // standalone unit test deterministic); the entry point passes the
    // real app.json version in the prebuild path.
    marketingVersion: opts.marketingVersion || hostVersion || "1.0"
  };
}

// Builds the NSE target's .entitlements contents. The only key is the
// App Group membership so the extension's FileManager can resolve the
// same shared container the main app writes credentials into. Exported so
// the unit test can assert the shape.
function buildExtensionEntitlements(opts) {
  return {
    [APP_GROUPS_ENTITLEMENT]: [opts.appGroup]
  };
}

/**
 * The plugin entry point. Composes three mods:
 *   1. withEntitlementsPlist — add the App Group to the MAIN app target so
 *      the JS layer can write credentials into the shared container.
 *   2. withDangerousMod — write the NSE source + Info.plist + .entitlements
 *      into the prebuild output (runs before the Xcode mod so the file
 *      references it adds resolve to real on-disk files).
 *   3. withXcodeProject — register the NSE as a target and link its
 *      .entitlements.
 */
const withApprovalNotificationService = (config, rawOpts) => {
  const hostBundleId =
    config.ios && config.ios.bundleIdentifier
      ? config.ios.bundleIdentifier
      : "ai.lilaclabs.gini.mobile";
  // app.json `version` is the marketing version prebuild stamps onto the
  // main app; pass it through so the NSE is stamped to match (Apple
  // requires the versions to be equal).
  const hostVersion = config.version;
  const opts = resolveOptions(rawOpts, hostBundleId, hostVersion);

  // Mod 1: add the App Group entitlement to the MAIN app target. This is
  // the half withEntitlementsPlist can reach; the NSE target's entitlements
  // are written separately in Mod 2 (withEntitlementsPlist edits only the
  // app). Merge into any existing array so we don't clobber other groups.
  config = withEntitlementsPlist(config, (cfg) => {
    const existing = cfg.modResults[APP_GROUPS_ENTITLEMENT];
    const groups = Array.isArray(existing) ? existing.slice() : [];
    if (!groups.includes(opts.appGroup)) groups.push(opts.appGroup);
    cfg.modResults[APP_GROUPS_ENTITLEMENT] = groups;
    return cfg;
  });

  // Mod 2: write the NSE source + Info.plist + .entitlements to disk.
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      writeExtensionSources(cfg.modRequest.projectRoot, opts);
      return cfg;
    }
  ]);

  // Mod 3: register the NSE target inside the Xcode project.
  config = withXcodeProject(config, (cfg) => {
    cfg.modResults = addExtensionTarget(cfg.modResults, opts, hostBundleId);
    return cfg;
  });

  return config;
};

module.exports = withApprovalNotificationService;
// Test-only exports (require()-only — Expo's plugin loader looks at the
// default export above, not these named ones).
module.exports.resolveOptions = resolveOptions;
module.exports.buildExtensionInfoPlist = buildExtensionInfoPlist;
module.exports.buildExtensionEntitlements = buildExtensionEntitlements;
module.exports.readCanonicalSwiftSource = readCanonicalSwiftSource;
module.exports.addExtensionTarget = addExtensionTarget;
module.exports.writeExtensionSources = writeExtensionSources;
module.exports.APP_GROUPS_ENTITLEMENT = APP_GROUPS_ENTITLEMENT;
