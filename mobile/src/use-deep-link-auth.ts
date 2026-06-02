import * as Linking from "expo-linking";
import { useEffect } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";
import { saveCredentials, tryDeregisterCachedDevice } from "@/src/auth";
import { resetRegistrationForCredentialSwap } from "@/src/push";

// Handles `gini://connect?api=<base-url>&token=<bearer>` deep links by
// prompting the user, then persisting the credentials and navigating
// into the app on approval. The connect interstitial page on the web
// side constructs the URL; this hook consumes it.
//
// Triggered for both cold starts (app launched by tapping the deep link
// while not running) and warm hand-offs (app already running in
// background, then iOS routes the URL to it). `Linking.useURL()` covers
// both cases — it returns the launch URL on cold start, then updates
// whenever a new URL is dispatched to the app.
//
// Security: ANY app or web page can construct a `gini://connect?...` URL
// (the scheme is registered on the device, not gated by ownership). A
// phishing SMS or pasteboard contents containing a crafted link would
// otherwise silently pivot the device to attacker-controlled gateway +
// bearer. Defense: show an `Alert` with the destination host and require
// explicit Connect approval before `saveCredentials` runs. The fuller
// nonce / PKCE-style challenge protocol (the web /connect page mints a
// short-lived challenge that the mobile app verifies against state it
// already holds) is tracked as a follow-up; this confirmation closes
// the silent-overwrite vector today.

const CONNECT_PATH = "connect";

interface ParsedCredentials {
  baseUrl: string;
  token: string;
}

// Three-state result so the hook can tell apart:
//   - "not a connect URL"             → ignore entirely
//   - "connect URL but missing creds" → user is stranded on /connect
//                                       placeholder; show recovery
//   - "complete connect URL"          → prompt + saveCredentials
type ParsedConnect =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "complete"; creds: ParsedCredentials };

function parseConnectUrl(url: string | null): ParsedConnect {
  if (!url) return { kind: "none" };
  const parsed = Linking.parse(url);
  // Expo's parser drops the `gini://` scheme; the host portion of
  // `gini://connect?api=...` lands in `hostname`, the rest in
  // `queryParams`. Some iOS handlers route as `gini://connect` (path
  // empty, hostname=connect), others as `gini:///connect`
  // (hostname empty, path=connect). Accept both shapes.
  const route = parsed.hostname ?? parsed.path?.replace(/^\//, "") ?? "";
  if (route !== CONNECT_PATH) return { kind: "none" };

  const apiParam = parsed.queryParams?.api;
  const tokenParam = parsed.queryParams?.token;
  const api = typeof apiParam === "string" ? apiParam : null;
  const token = typeof tokenParam === "string" ? tokenParam : null;
  if (!api || !token) return { kind: "incomplete" };

  return { kind: "complete", creds: { baseUrl: api, token } };
}

export function useDeepLinkAuth(): void {
  // `useURL` returns the current launch URL on cold start AND subsequent
  // URLs delivered while the app is running.
  const url = Linking.useURL();

  useEffect(() => {
    let active = true;
    const result = parseConnectUrl(url);
    if (result.kind === "none") return;
    if (result.kind === "incomplete") {
      // The URL was for the /connect flow but `api` or `token` was
      // missing/empty. The /connect placeholder renders a spinner with
      // no fallback navigation of its own, so without recovery here
      // the user is stranded forever staring at an ActivityIndicator.
      // Surface a single-button Alert that routes back to `/` (the auth
      // gate then forwards to /agents or /setup based on persisted
      // credentials). Routing the recovery through the hook — rather
      // than connect.tsx itself — covers warm hand-offs from any
      // landing screen that happens to be mounted when iOS dispatches
      // the malformed URL.
      Alert.alert(
        "Couldn't connect",
        "The link was missing the API URL or token.",
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => {
              if (!active) return;
              router.replace("/");
            }
          }
        ],
        {
          cancelable: true,
          onDismiss: () => {
            if (!active) return;
            router.replace("/");
          }
        }
      );
      return () => {
        active = false;
      };
    }
    const { creds } = result;
    // Surface the destination host (not the raw URL — Alert lines wrap
    // unpredictably on long strings, and the host is the actually
    // load-bearing thing for the user's decision). Fall back to the raw
    // base URL if `new URL` can't parse for any reason.
    let displayHost: string;
    try {
      displayHost = new URL(creds.baseUrl).host;
    } catch {
      displayHost = creds.baseUrl;
    }
    Alert.alert(
      "Connect to Gini gateway?",
      `Switch this device to use:\n\n${displayHost}\n\nDo not approve if you didn't expect this link.`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => {
            // Move the user OFF the /connect placeholder so they don't sit
            // on a spinner forever after dismissing the prompt. The auth
            // gate at app/index.tsx routes based on persisted credentials:
            // existing-auth → /agents, no-auth → /setup. Either is fine —
            // both are reachable surfaces with their own navigation.
            if (!active) return;
            router.replace("/");
          }
        },
        {
          text: "Connect",
          onPress: () => {
            if (!active) return;
            // Sequence is load-bearing:
            //   1. tryDeregisterCachedDevice() — issues DELETE
            //      /push/devices/<token> against the OLD gateway using
            //      the still-valid OLD bearer. Must run BEFORE step 2
            //      (which drops the in-process cached token) and BEFORE
            //      step 3 (which overwrites the bearer with the new
            //      one). Without this the old device row outlives the
            //      swap on the previous gateway, and the next push
            //      against the old credential still wakes this device.
            //      Failures are swallowed inside the helper so the
            //      swap still proceeds when the OLD gateway is
            //      unreachable.
            //   2. resetRegistrationForCredentialSwap() — clears the
            //      in-process registration short-circuits so the next
            //      registerForPushAsync runs the full POST + listener
            //      install against the new gateway.
            //   3. saveCredentials(creds) — overwrites the persisted
            //      bearer and broadcasts to every mounted useAuth
            //      listener; the auth gate in app/index.tsx notices
            //      the new identity and routes to /agents on the next
            //      render tick. We still call router.replace explicitly
            //      so a user who tapped the deep link while sitting on
            //      /setup is moved off it immediately instead of
            //      waiting for state propagation.
            void (async () => {
              await tryDeregisterCachedDevice();
              resetRegistrationForCredentialSwap();
              try {
                await saveCredentials(creds);
                if (!active) return;
                router.replace("/agents");
              } catch {
                // Saving can fail if the base URL fails normalization.
                // The setup screen is the right recovery surface —
                // bounce the user there so they can paste/correct by
                // hand.
                if (!active) return;
                router.replace("/setup");
              }
            })();
          }
        }
      ],
      { cancelable: true }
    );
    return () => {
      active = false;
    };
  }, [url]);
}

export const __test = { parseConnectUrl };
