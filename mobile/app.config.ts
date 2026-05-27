import "dotenv/config";
import type { ExpoConfig } from "expo/config";

// Fork-friendly mobile config. The committed defaults are blank for
// org-specific fields so a fresh fork can't accidentally build against
// Lilac Labs' EAS project / Apple team — values come from `mobile/.env`
// (gitignored). See "Fork & re-skin" in the README.
//
// `dotenv/config` is loaded at the top of this file because EAS CLI
// (e.g. `eas init`, `eas build`) does not auto-load .env before reading
// app.config.ts. Without it, projectId / owner would be undefined and
// EAS would fall through to "project not configured".

const IOS_BUNDLE_ID = "ai.lilaclabs.gini.mobile";
const ANDROID_PACKAGE = "ai.lilaclabs.gini.mobile";
const NSE_BUNDLE_ID = `${IOS_BUNDLE_ID}.notificationservice`;
const APP_NAME = "Gini";
const APP_SLUG = "gini-mobile";
const APP_SCHEME = "gini";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in mobile/.env — see mobile/.env.example. ` +
        `Forks need their own EAS project (run \`eas init\` in mobile/).`,
    );
  }
  return value;
}

const EAS_PROJECT_ID = requireEnv("EAS_PROJECT_ID");
const EXPO_OWNER = requireEnv("EXPO_OWNER");
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID ?? "";

// EAS-hosted OTA URL is deterministic from the project id. Self-hosters
// can replace this with a constant.
const EXPO_UPDATES_URL = `https://u.expo.dev/${EAS_PROJECT_ID}`;

const config: ExpoConfig = {
  name: APP_NAME,
  slug: APP_SLUG,
  version: "0.0.2",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: APP_SCHEME,
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },
  updates: { url: EXPO_UPDATES_URL, fallbackToCacheTimeout: 0 },
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_ID,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    adaptiveIcon: {
      foregroundImage: "./assets/icon.png",
      backgroundColor: "#ffffff",
    },
  },
  web: { bundler: "metro" },
  plugins: [
    "expo-router",
    [
      "expo-notifications",
      { enableBackgroundRemoteNotifications: true },
    ],
    [
      "./plugins/with-approval-notification-service.js",
      { appleTeamId: APPLE_TEAM_ID },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "Gini uses your photo library to attach images to chat messages.",
        cameraPermission:
          "Gini uses the camera to capture images to attach to chat messages.",
      },
    ],
    "expo-updates",
  ],
  experiments: { typedRoutes: true },
  extra: {
    router: {},
    eas: {
      projectId: EAS_PROJECT_ID,
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: "ApprovalNotificationService",
                bundleIdentifier: NSE_BUNDLE_ID,
              },
            ],
          },
        },
      },
    },
  },
  owner: EXPO_OWNER,
};

export default config;
