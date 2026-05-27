// APNs push registration + tap / action handling for the iOS app.
// This module is iOS-only — Android/web call sites must gate on
// Platform.OS first.
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
//   6. Subscribe to `addNotificationResponseReceivedListener` for tap +
//      action handling. The category registered below pairs with the
//      NSE attached on the server-side `approval_requested` payload —
//      the OS shows Approve / Deny buttons on the lock screen, and
//      this listener routes each action to the right /api/approvals
//      endpoint without forcing the app to foreground.
//
// Action handling caveat: `opensAppToForeground: false` means the OS
// only invokes the response listener if the app is backgrounded
// (suspended). If the user has fully killed the app from the app
// switcher, the action button still posts the response, but our
// listener never runs because there's no JS to run. Apple does not
// expose a way around this for non-foregrounding actions. The user
// must open the app and approve from there. The approval remains
// pending in the runtime until acted on — the runtime does not have
// a retry loop that re-emits approval requests.
//
// Idempotency: the gateway's POST handler is an upsert. Calling
// register multiple times (e.g. across screen mounts) is safe — the
// row's `last_seen_at` is bumped and nothing else changes.

import { Platform } from "react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { api, ApiError } from "./api";
import {
  APPROVAL_CATEGORY,
  APPROVE_ACTION,
  DENY_ACTION,
  dispatchNotificationResponse
} from "./push-dispatch";

// Re-export the dispatch identifiers so existing call-sites that
// imported from `./push` continue to compile. The pure dispatcher
// lives in `./push-dispatch` so unit tests can exercise it without
// loading react-native / expo-notifications.
export { APPROVAL_CATEGORY, APPROVE_ACTION, DENY_ACTION, dispatchNotificationResponse };
export type {
  NotificationDispatchOutcome,
  DispatchDeps,
  ResponseLike
} from "./push-dispatch";

// Foreground presentation rule. Silent (content-available) pushes
// must never surface a banner or play a sound — the badge update is
// what they're for, and we manage that explicitly via refreshBadge
// rather than letting APS set it. Alert payloads (currently the
// approval_requested flow) keep their banner so the user notices the
// prompt without unlocking the device. Setting this once at module
// load means every received notification is classified at delivery.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // expo-notifications surfaces the remote `userInfo["body"]` object
    // as `content.data` — top-level userInfo keys (including `aps`) are
    // dropped before reaching JS. The server-side dispatcher writes a
    // boolean `silent` discriminator inside `body` so the client can
    // classify without depending on aps internals.
    const data = notification.request.content.data as { silent?: unknown } | undefined;
    const isSilent = data?.silent === true;
    if (isSilent) {
      return {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        // SDK 54's NotificationBehavior added the banner / list flags
        // alongside shouldShowAlert; the older field is preserved for
        // back-compat but the new ones are what iOS actually reads.
        shouldShowBanner: false,
        shouldShowList: false
      };
    }
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true
    };
  }
});

// Registers the APPROVAL_REQUEST notification category so the OS
// renders inline Approve / Deny actions on lock screen and banner.
// Both actions are non-foregrounding (`opensAppToForeground: false`)
// — the listener below dispatches them straight to the gateway. iOS
// caches categories per-install; calling this idempotently on app
// launch is the documented pattern.
//
// Exported for tests; production callers go through the implicit
// invocation in `registerForPushAsync`.
export async function registerApprovalCategoryAsync(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
      {
        identifier: APPROVE_ACTION,
        buttonTitle: "Approve",
        options: {
          opensAppToForeground: false,
          isAuthenticationRequired: false,
          isDestructive: false
        }
      },
      {
        identifier: DENY_ACTION,
        buttonTitle: "Deny",
        options: {
          opensAppToForeground: false,
          isAuthenticationRequired: false,
          // Deny is the destructive choice — iOS highlights it red.
          isDestructive: true
        }
      }
    ]);
  } catch {
    // setNotificationCategoryAsync can throw on the very first launch
    // before the native module is ready; the next mount will retry.
  }
}

// Schedules an immediate local notification so the user gets a visible
// signal when an action button failed (e.g. network down at the moment
// of the tap). The body deliberately stays generic for privacy.
async function notifyActionFailure(verb: "approve" | "deny"): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Failed to ${verb}`,
        body: "Open the app to retry.",
        sound: "default"
      },
      // `null` trigger means "fire immediately".
      trigger: null
    });
  } catch {
    // Local notifications can fail in unusual states (permission
    // revoked between original push and this callback). The /api
    // call already failed, so there's nothing more we can do here.
  }
}

// Fetch the latest unread total from the gateway and apply it as the
// app icon's badge count. Used as the side-effect of a silent push and
// once on initial mount (so a cold launch picks up everything that
// landed while the app was killed).
export async function refreshBadge(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const { unread } = await api<{ unread: number }>("/badge");
    await Notifications.setBadgeCountAsync(unread);
  } catch (error) {
    // 401 means we lost auth — leave the badge alone (the next /chat
    // navigation will route to setup). Other errors are transient
    // network blips; the next event-driven refresh will catch up.
    if (error instanceof ApiError && error.status === 401) return;
    // swallow — badge accuracy is best-effort
  }
}

// Tracks whether we've already started the registration flow this
// process. The chat detail screen mounts on every navigation; we
// don't want to spam permission requests / token fetches on every
// remount. iOS will short-circuit duplicate permission requests
// internally, but the network round-trip is wasteful and the token
// listener subscription would leak.
let registrationStarted = false;

// Cached APNs device token after a successful registration. The mobile
// runtime needs this on every /read, /badge, and SSE open so the
// gateway can scope reads + watch-state to this specific device
// (rather than to the credential, which collapses iPhone A and
// iPhone B onto one row). Module-scoped so the api helper can
// import it without prop-drilling through every hook.
let cachedDeviceToken: string | null = null;

// Read-only accessor. Returns null until the device has registered
// successfully — callers should tolerate that (mobile-only endpoints
// like /badge can no-op when the token isn't set yet, since the
// badge will refresh on the next mount once registration completes).
export function getCachedDeviceToken(): string | null {
  return cachedDeviceToken;
}

// Subscription handles — kept module-scoped so a hot reload doesn't
// double-subscribe (the listeners would otherwise pile up and call
// `router.push` twice for every notification tap).
let tokenSub: Notifications.Subscription | null = null;
let responseSub: Notifications.Subscription | null = null;
let receivedSub: Notifications.Subscription | null = null;

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

  // Always register the approval category up-front, before any
  // permission prompt. If the user has previously granted permission,
  // the next incoming approval push needs the category in place
  // immediately. If they reject permission below, the category
  // registration is harmless (no notifications will arrive to use it).
  void registerApprovalCategoryAsync();

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
      // Cache after the POST succeeds so callers downstream (api
      // helper, SSE resolver) get the same token the gateway just
      // accepted. On POST failure cachedDeviceToken stays null and
      // those callers no-op until the next mount's retry.
      cachedDeviceToken = token.data;
    }

    // Listen for token rotations. The library debounces internally,
    // so we just forward every emission straight to the gateway.
    if (!tokenSub) {
      tokenSub = Notifications.addPushTokenListener((event) => {
        if (event.type !== "ios") return;
        // Fire-and-forget — if the network is down the next mount's
        // initial registration will catch up.
        void postDevice(event.data, bundleId).then(() => {
          cachedDeviceToken = event.data;
        }).catch(() => { /* swallow */ });
      });
    }

    // Response listener: handles three cases via dispatchNotificationResponse.
    //   - Default tap (no actionIdentifier set, or
    //     UNNotificationDefaultActionIdentifier) → deep-link to chat.
    //   - APPROVE action → POST /api/approvals/:id/approve.
    //   - DENY action → POST /api/approvals/:id/deny.
    // Both action endpoints are existing routes (src/http.ts:201-202)
    // — they pre-date the push surface and already enforce auth +
    // ownership. The action handler runs in the background while the
    // app is suspended; iOS gives ~30s of JS time which is plenty for
    // a single POST round-trip.
    if (!responseSub) {
      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        void dispatchNotificationResponse(response, {
          apiCall: (path, init) => api(path, init),
          navigate: (sessionId) => {
            // expo-router uses dynamic segments via the bracketed path.
            router.push(`/chat/${sessionId}`);
          },
          notifyFailure: notifyActionFailure
        });
      });
    }

    // Foreground delivery listener — fires for every received push,
    // including silent ones (where `setNotificationHandler` returned
    // shouldShow=false). We branch on the event discriminator from the
    // payload's data block: `phase_completed` / `phase_failed` are the
    // silent wakes the gateway fires when a task finishes and the user
    // isn't actively watching. The badge refetch is the side-effect.
    // If the relevant chat detail is already mounted, its SSE stream
    // will deliver the same block — no imperative refetch needed from
    // here.
    if (!receivedSub) {
      receivedSub = Notifications.addNotificationReceivedListener((notification) => {
        // Per the wire shape from the server-side dispatcher, all
        // routing fields are inside `userInfo["body"]`, which expo
        // surfaces as `content.data`. The `silent` boolean
        // discriminator pins whether to treat this as a background
        // wake — keying off it (rather than the now-dropped aps
        // sub-object) avoids depending on iOS internals.
        const data = notification.request.content.data as
          | { event?: string; sessionId?: string; silent?: unknown }
          | undefined;
        if (!data) return;
        if (data.silent !== true) return;
        if (data.event === "phase_completed" || data.event === "phase_failed") {
          void refreshBadge();
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

// Called from auth.ts after a successful sign-out so the next
// sign-in re-runs the full registration flow (permission, token
// fetch, POST /push/devices, listener re-subscription). The cached
// token is cleared too — the new credential's gateway has a
// different devices table and we must not reuse a stale token under
// the wrong credential. Subscription handles are removed so they
// don't double up on the next register.
export function __resetRegistrationForSignOut(): void {
  registrationStarted = false;
  cachedDeviceToken = null;
  if (tokenSub) { tokenSub.remove(); tokenSub = null; }
  if (responseSub) { responseSub.remove(); responseSub = null; }
  if (receivedSub) { receivedSub.remove(); receivedSub = null; }
}

// Test-only entry — clears the in-process gates so the next call to
// registerForPushAsync runs the full flow again. Used by tests that
// drive multiple registration attempts.
export function __resetForTests(): void {
  registrationStarted = false;
  cachedDeviceToken = null;
  if (tokenSub) { tokenSub.remove(); tokenSub = null; }
  if (responseSub) { responseSub.remove(); responseSub = null; }
  if (receivedSub) { receivedSub.remove(); receivedSub = null; }
}
