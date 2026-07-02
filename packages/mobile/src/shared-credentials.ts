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

// Minimal handle onto the shared-container file. Just the write + delete
// surface the bridge needs.
export interface SharedFile {
  write: (contents: string) => void;
  delete: () => void;
}

// Resolves the shared-container file, or null when unavailable. Injected
// so tests can substitute a stub WITHOUT globally mocking `react-native`
// (a process-wide `mock.module("react-native")` leaks into sibling test
// files that need the real module and breaks them). The production
// default lazy-requires the native modules so importing this module never
// pulls the native surface at load time — non-RN test/web bundles that
// touch auth.ts stay clean.
export type SharedFileResolver = () => SharedFile | null;

// The native surface the resolver depends on, factored out so the
// resolver's branching logic is unit-testable without loading the real
// react-native / expo-file-system modules. Production injects the lazy
// requires below; tests pass fakes.
export interface NativeBridge {
  platformOS: string;
  // The expo-file-system File constructor and the appleSharedContainers
  // record (keyed by app group id). Pulling them through this seam means
  // the resolver never statically imports the native modules.
  File: new (dir: unknown, name: string) => SharedFile;
  appleSharedContainers: Record<string, unknown>;
}

// Shapes the native modules into a NativeBridge. The two requires MUST be
// literal `require("react-native")` / `require("expo-file-system")` calls:
// Metro bundles a module only when its static analysis sees a literal
// require on the real `require` identifier. An aliased/injected requirer
// (e.g. `req("react-native")`) is invisible to Metro, so the module is
// never registered and throws "Requiring unknown module" at runtime —
// which silently breaks the whole App Group write. Tests don't need to
// run this function; they exercise defaultResolveSharedFile with a fake
// bridge instead, so there's no reason to make the requires injectable.
// Throws in non-RN bundles (caught by the resolver).
export function loadNativeBridge(): NativeBridge {
  const { Platform } = require("react-native") as { Platform: { OS: string } };
  const { File, Paths } = require("expo-file-system") as {
    File: new (dir: unknown, name: string) => SharedFile;
    Paths: { appleSharedContainers: Record<string, unknown> };
  };
  return { platformOS: Platform.OS, File, appleSharedContainers: Paths.appleSharedContainers };
}

// Resolves the App Group container file from a native bridge: returns the
// file on iOS with the group entitlement present, else null. Pure given
// the bridge, so tests exercise every branch with a fake. `loadBridge`
// defaults to the lazy require; tests pass a fake (or a thrower).
export function defaultResolveSharedFile(loadBridge: () => NativeBridge = loadNativeBridge): SharedFile | null {
  let bridge: NativeBridge;
  try {
    bridge = loadBridge();
  } catch {
    // Native modules not loadable (non-RN test/web bundle) — no-op.
    return null;
  }
  if (bridge.platformOS !== "ios") return null;
  const dir = bridge.appleSharedContainers[APP_GROUP_ID];
  // The group key only appears when the app's signed entitlements
  // include it. Absent ⇒ entitlements not in this build; skip silently.
  if (!dir) return null;
  return new bridge.File(dir, SHARED_CREDS_FILENAME);
}

// The active resolver. Swapped by tests via __setSharedFileResolverForTests
// and restored afterward; production code never touches it.
let resolveSharedFile: SharedFileResolver = defaultResolveSharedFile;

// Write the credentials the NSE needs into the shared container. Called
// on credential save and after push registration so the file always
// reflects the live gateway + token. Best-effort: any failure is
// swallowed so it can never block the auth/registration flow.
export function writeSharedCredentials(creds: SharedCredentials): void {
  let file: SharedFile | null;
  try {
    file = resolveSharedFile();
  } catch {
    return;
  }
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
  let file: SharedFile | null;
  try {
    file = resolveSharedFile();
  } catch {
    return;
  }
  if (!file) return;
  try {
    file.delete();
  } catch {
    // Already gone or undeletable — nothing to do; the next sign-in
    // overwrites it anyway.
  }
}

// Test seam: swap the resolver (and restore it) so the bridge can be
// exercised without a global react-native / expo-file-system mock.
export function __setSharedFileResolverForTests(resolver: SharedFileResolver): void {
  resolveSharedFile = resolver;
}

export function __resetSharedFileResolverForTests(): void {
  resolveSharedFile = defaultResolveSharedFile;
}
