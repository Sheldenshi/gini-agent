import type { ExpoConfig } from "expo/config";

// Fork-friendly fields. Forkers edit the constants below (bundle ids, app
// name, scheme) and put the rest in mobile/.env. See "Fork & re-skin" in
// the README.

const IOS_BUNDLE_ID = "ai.lilaclabs.gini.mobile";
const ANDROID_PACKAGE = "ai.lilaclabs.gini.mobile";
const NSE_BUNDLE_ID = `${IOS_BUNDLE_ID}.notificationservice`;
const APP_NAME = "Gini";
const APP_SLUG = "gini-mobile";
const APP_SCHEME = "gini";

const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID;
const EXPO_OWNER = process.env.EXPO_OWNER;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;

// EAS-hosted OTA URL is deterministic from the project id. Self-hosters
// who point at their own server can replace this with a constant or a
// new env var when that comes up.
const EXPO_UPDATES_URL = EAS_PROJECT_ID
  ? `https://u.expo.dev/${EAS_PROJECT_ID}`
  : undefined;

const config: ExpoConfig = {
  name: APP_NAME,
  slug: APP_SLUG,
  version: "0.0.2",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: APP_SCHEME,
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },
  ...(EXPO_UPDATES_URL
    ? { updates: { url: EXPO_UPDATES_URL, fallbackToCacheTimeout: 0 } }
    : {}),
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
      { appleTeamId: APPLE_TEAM_ID ?? "" },
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
      ...(EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : {}),
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
  ...(EXPO_OWNER ? { owner: EXPO_OWNER } : {}),
};

export default config;
