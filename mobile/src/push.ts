// APNs push registration + tap-handling for the iOS app. This module
// is iOS-only — Android/web call sites must gate on Platform.OS first.
//
// Lifecycle:
//   1. The chat detail screen calls `registerForPushAsync()` the first
//      time it mounts. Asking permission at the first chat moment
//      gets noticeably higher grant rates than asking on app launch.
//   2. We request notification permission (idempotent — iOS only
//      shows the prompt once).
//   3. On grant, fetch the raw APNs device token via
//      `Notifications.getDevicePushTokenAsync()`. This is the
//      hex-encoded APNs token, NOT the Expo Push token — we send
//      directly to APNs from the gateway.
//   4. POST the token to `/api/push/devices` so the gateway can fan
//      `approval_requested` notifications out to it.
//   5. Subscribe to `addPushTokenListener` so a rotated token
//      (rare, but happens on restore-from-backup) re-registers.
//   6. Subscribe to `addNotificationResponseReceivedListener` for tap
//      handling: the payload carries `sessionId`, so a tap deep-links
//      straight into the chat that needs the approval.
//
// Idempotency: the gateway's POST handler is an upsert. Calling
// register multiple times (e.g. across screen mounts) is safe — the
// row's `last_seen_at` is bumped and nothing else changes.

import { Platform } from "react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { api } from "./api";

// Tracks whether we've already started the registration flow this
// process. The chat detail screen mounts on every navigation; we
// don't want to spam permission requests / token fetches on every
// remount. iOS will short-circuit duplicate permission requests
// internally, but the network round-trip is wasteful and the token
// listener subscription would leak.
let registrationStarted = false;

// Subscription handles — kept module-scoped so a hot reload doesn't
// double-subscribe (the listeners would otherwise pile up and call
// `router.push` twice for every notification tap).
let tokenSub: Notifications.Subscription | null = null;
let responseSub: Notifications.Subscription | null = null;

export interface RegisterPushOptions {
  // Override the bundle id reported to the gateway — useful for
  // dev builds whose bundle differs from production. Falls back to
  // `expo-constants`' resolved bundleIdentifier; the gateway uses
  // it as the APNs topic header so prod/TestFlight builds can
  // coexist behind one set of APNs creds.
  bundleId?: string;
}

export async function registerForPushAsync(opts: RegisterPushOptions = {}): Promise<void> {
  // Step 2/3/4 are iOS-only this round. Gate hard so Android and web
  // never reach the Notifications API surface that doesn't apply.
  if (Platform.OS !== "ios") return;
  if (registrationStarted) return;
  registrationStarted = true;

  try {
    // The library's typings re-export `PermissionResponse` from 'expo'
    // for the base shape, but the 'expo' package only exports it
    // structurally — TS resolves the inherited `status` field
    // inconsistently across SDK versions. Treat the response as a
    // loose record and read `granted`, which is the convenience flag
    // documented as the authoritative grant check.
    const existing = (await Notifications.getPermissionsAsync()) as unknown as { granted?: boolean };
    let granted = Boolean(existing.granted);
    if (!granted) {
      const requested = (await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true }
      })) as unknown as { granted?: boolean };
      granted = Boolean(requested.granted);
    }
    if (!granted) {
      // User declined. Reset the flag so a subsequent screen-mount
      // can retry — they may have changed their mind in Settings.
      registrationStarted = false;
      return;
    }

    const bundleId = opts.bundleId ?? resolveBundleId();
    if (!bundleId) {
      // Can't register without a bundle id (the gateway requires it).
      registrationStarted = false;
      return;
    }

    // getDevicePushTokenAsync returns the raw APNs token — what we
    // want for direct-to-Apple delivery. getExpoPushTokenAsync would
    // route through Expo's push service, which is the wrong fit
    // because the gateway is the push provider and uses its own .p8.
    const token = await Notifications.getDevicePushTokenAsync();
    if (token.type === "ios") {
      await postDevice(token.data, bundleId);
    }

    // Listen for token rotations. The library debounces internally,
    // so we just forward every emission straight to the gateway.
    if (!tokenSub) {
      tokenSub = Notifications.addPushTokenListener((event) => {
        if (event.type !== "ios") return;
        // Fire-and-forget — if the network is down the next mount's
        // initial registration will catch up.
        void postDevice(event.data, bundleId).catch(() => { /* swallow */ });
      });
    }

    // Tap handler: navigate to the chat that owns the approval.
    if (!responseSub) {
      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        const sessionId = typeof data?.sessionId === "string" ? data.sessionId : null;
        if (sessionId) {
          // expo-router uses dynamic segments via the bracketed path.
          router.push(`/chat/${sessionId}`);
        }
      });
    }
  } catch {
    // Permission/token retrieval can fail on first launch in
    // unusual states (e.g. iOS Simulator without a Apple ID). Allow
    // retry on next mount.
    registrationStarted = false;
  }
}

// POST the token to /api/push/devices. The gateway's handler is an
// upsert, so calling this multiple times with the same token is a
// no-op aside from the row's last_seen_at bump.
async function postDevice(token: string, bundleId: string): Promise<void> {
  await api("/push/devices", {
    method: "POST",
    body: JSON.stringify({ token, platform: "ios", bundleId })
  });
}

// Reads the bundle id from expo-constants. Falls back to null when
// running in contexts where constants aren't available (e.g. unit
// tests imported directly). The chat detail screen treats null as
// "skip registration for this mount".
function resolveBundleId(): string | null {
  try {
    // Dynamic import so test environments without expo-constants
    // don't crash at module load. Returns null on any failure.
    const Constants = require("expo-constants").default as { expoConfig?: { ios?: { bundleIdentifier?: string } } };
    return Constants.expoConfig?.ios?.bundleIdentifier ?? null;
  } catch {
    return null;
  }
}

// Test-only entry — clears the in-process gates so the next call to
// registerForPushAsync runs the full flow again. Used by tests that
// drive multiple registration attempts.
export function __resetForTests(): void {
  registrationStarted = false;
  if (tokenSub) { tokenSub.remove(); tokenSub = null; }
  if (responseSub) { responseSub.remove(); responseSub = null; }
}
