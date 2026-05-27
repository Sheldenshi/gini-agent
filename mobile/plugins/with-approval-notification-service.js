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
 *
 * Source of truth for the Swift NSE itself:
 *   mobile/ios-extensions/ApprovalNotificationService/NotificationService.swift
 *   The plugin copies that file into the generated extension target on
 *   every prebuild so the on-disk source is the canonical reference.
 */

const { withDangerousMod, withXcodeProject } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");
const plist = require("plist");

const DEFAULT_TARGET_NAME = "ApprovalNotificationService";
const DEFAULT_BUNDLE_SUFFIX = ".notificationservice";
const DEFAULT_IOS_DEPLOYMENT = "15.1";

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
function buildExtensionInfoPlist(opts) {
  return {
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleDisplayName: opts.targetName,
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: "1.0",
    CFBundleVersion: "1",
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

  // 3) Create a PBXGroup that holds the NSE's source files. Mirrors
  //    the on-disk layout `ios/<TargetName>/` so opening the project
  //    in Xcode shows the same hierarchy the prebuild laid down.
  const pbxGroup = xcodeProject.addPbxGroup(
    [
      "NotificationService.swift",
      `${targetName}-Info.plist`
    ],
    targetName,
    targetName
  );

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

  // 5) Add the Swift source to the Sources build phase. The
  //    {target: target.uuid} option is the part that wires the file
  //    reference to *this* target (without it, Xcode adds the file to
  //    the host app's Sources phase by accident). The path is the
  //    basename only: the parent PBXGroup already carries
  //    `path = targetName`, so xcodebuild resolves the build input as
  //    `<SRCROOT>/<group.path>/NotificationService.swift`. Prefixing
  //    the target name here would double it
  //    (`<targetName>/<targetName>/…`).
  xcodeProject.addSourceFile(
    "NotificationService.swift",
    { target: target.uuid },
    pbxGroup.uuid
  );

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
        buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${productBundleId}"`;
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
// chain.
function resolveOptions(rawOpts) {
  const opts = rawOpts || {};
  return {
    targetName: opts.targetName || DEFAULT_TARGET_NAME,
    bundleSuffix: opts.bundleSuffix || DEFAULT_BUNDLE_SUFFIX,
    iosDeployment: opts.iosDeployment || DEFAULT_IOS_DEPLOYMENT,
    appleTeamId: opts.appleTeamId
  };
}

/**
 * The plugin entry point. Composes two mods:
 *   1. A dangerous mod that writes the NSE source files into the
 *      prebuild output (runs before the Xcode mod so the file
 *      references it adds resolve to real on-disk files).
 *   2. An Xcode-project mod that registers the NSE as a target.
 */
const withApprovalNotificationService = (config, rawOpts) => {
  const opts = resolveOptions(rawOpts);

  // Mod 1: write the NSE source + Info.plist to disk.
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      writeExtensionSources(cfg.modRequest.projectRoot, opts);
      return cfg;
    }
  ]);

  // Mod 2: register the NSE target inside the Xcode project.
  config = withXcodeProject(config, (cfg) => {
    const hostBundleId =
      cfg.ios && cfg.ios.bundleIdentifier
        ? cfg.ios.bundleIdentifier
        : "ai.lilaclabs.gini.mobile";
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
module.exports.readCanonicalSwiftSource = readCanonicalSwiftSource;
module.exports.addExtensionTarget = addExtensionTarget;
module.exports.writeExtensionSources = writeExtensionSources;
