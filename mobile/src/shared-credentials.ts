// App Group credential bridge for the iOS Notification Service Extension.
//
// The NSE runs in its own process and cannot read the app's AsyncStorage.
// To fetch-and-enrich a push on-device it needs the gateway base URL, the
// bearer token, and the device's APNs token (for the X-Device-Token
// header). We hand those across the process boundary by writing a small
// JSON file into the shared App Group container that both the app and the
// NSE are members of (see plugins/with-approval-notification-service.js).
//
// The NSE reads the same file via FileManager.containerURL(
// forSecurityApplicationGroupIdentifier:) — expo-file-system's
// Paths.appleSharedContainers[group] resolves to that exact directory.
//
// Privacy: this file holds the gateway bearer, never any chat content. It
// lives only in the app's own sandboxed App Group container, readable
// solely by the app and its own extensions. The enriched message text the
// NSE later fetches with these creds travels over the device's own
// authenticated connection to the gateway — it never transits Apple.
//
// All writes are best-effort and synchronous-but-guarded: a failure here
// must never break sign-in or push registration. The worst case of a
// missing/stale file is that the NSE falls back to the generic "Tap to
// read" banner, exactly as it behaves today.

// Must match the App Group id the config plugin grants to both targets:
// `group.<hostBundleId>`. Hardcoding the resolved value keeps this module
// free of an expo-constants dependency on the hot path; the plugin default
// derives the same string from the bundle id.
export const APP_GROUP_ID = "group.ai.lilaclabs.gini.mobile";

// Filename inside the shared container. The NSE reads this exact name.
export const SHARED_CREDS_FILENAME = "gini-push-creds.json";

// The credential shape the NSE expects. `deviceToken` may be absent until
// push registration completes; the NSE sends X-Device-Token only when
// present (the gateway's preview route doesn't require it, but supplying
// it keeps per-device scoping accurate).
export interface SharedCredentials {
  baseUrl: string;
  token: string;
  deviceToken?: string;
}

// Resolve the shared-container File handle, or null when unavailable
// (non-iOS, the App Group key not present because entitlements haven't
// been signed in, or the native modules not loadable in a test/web
// bundle). Both react-native and expo-file-system are lazy-required so
// importing this module never pulls the native surface at load time —
// non-RN test/web bundles that touch auth.ts stay clean.
function resolveSharedFile(): { write: (s: string) => void; delete: () => void } | null {
  try {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    if (Platform.OS !== "ios") return null;
    const { File, Paths } = require("expo-file-system") as {
      File: new (dir: unknown, name: string) => { write: (s: string) => void; delete: () => void };
      Paths: { appleSharedContainers: Record<string, unknown> };
    };
    const dir = Paths.appleSharedContainers[APP_GROUP_ID];
    // The group key only appears when the app's signed entitlements
    // include it. Absent ⇒ entitlements not in this build; skip silently.
    if (!dir) return null;
    return new File(dir, SHARED_CREDS_FILENAME);
  } catch {
    return null;
  }
}

// Write the credentials the NSE needs into the shared container. Called
// on credential save and after push registration so the file always
// reflects the live gateway + token. Best-effort: any failure is
// swallowed so it can never block the auth/registration flow.
export function writeSharedCredentials(creds: SharedCredentials): void {
  const file = resolveSharedFile();
  if (!file) return;
  try {
    // write() creates the file if absent and overwrites otherwise (v56
    // semantics, synchronous). The payload is small (a URL + two tokens).
    file.write(JSON.stringify(creds));
  } catch {
    // A full disk or a transient native error must not surface here —
    // the NSE simply falls back to the generic banner.
  }
}

// Remove the shared credentials on sign-out so a backgrounded NSE can't
// keep fetching with a stale bearer after the user logs out. Best-effort
// like the write — a missing file or delete failure is harmless.
export function clearSharedCredentials(): void {
  const file = resolveSharedFile();
  if (!file) return;
  try {
    file.delete();
  } catch {
    // Already gone or undeletable — nothing to do; the next sign-in
    // overwrites it anyway.
  }
}
