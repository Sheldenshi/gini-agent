# ADR: Mobile Push Notifications (APNs + NSE Enrichment + Inline Actions)

- **Status:** Accepted
- **Date:** 2026-05-26
- **See also:** [Chat Block Protocol](./chat-block-protocol.md), [Approval And Audit Substrate](./approval-and-audit-substrate.md), [BFF Trust Boundary For Privileged POSTs](./bff-trust-boundary.md)

## Decision

The iOS mobile client receives real-time approval and completion signals
through Apple Push Notification service (APNs), delivered directly from
the Gini runtime gateway. There is no Expo Push server or other
intermediate relay — the gateway holds the `.p8` signing key and posts
straight to `api.push.apple.com`.

Pushes carry **ids only** (sessionId, blockId, approvalId, event tag).
The APNs wire body is a generic string (`"Tap to review"` for approvals,
`"Tap to read"` for completions; silent payload for badge-only
completions) — Apple's servers never see chat content.

The lock-screen banner is then **enriched on-device** by the iOS
**Notification Service Extension** (NSE). On a `mutable-content: 1` push,
the NSE fetches the real preview from the gateway's
`GET /api/push/preview` over the device's own authenticated connection
and rewrites the title + body before display. The message text reaches
the device out-of-band; it never transits Apple. On any failure (no
shared creds, network error, non-200, timeout) the NSE falls back to the
generic as-sent banner, so the user always sees a notification.

Lock-screen Approve / Deny action buttons are also implemented by the NSE
plus a `UNNotificationCategory` registered by the main app. The category
is attached only to `authorization_requested` pushes (the dispatcher sets
it server-side; the NSE re-asserts it); the OS renders the action buttons;
tapping an action posts directly to `/api/authorizations/:id/approve` or
`/deny` without opening the app. Setup requests need the app (open a
browser, fill a form), so they carry no action buttons and deep-link on
tap instead.

The mobile build moves from purely managed Expo to a **dev client +
`expo prebuild`** workflow on iOS to host the NSE. The plugin
(`mobile/plugins/with-approval-notification-service.js`) is idempotent
and runs as part of the standard Expo config-plugin pipeline.

## Context

The original mobile chat surface polled `GET /api/chat?agentId=` every
3s and `GET /api/chat/:id` every 800ms. Polling drained battery, missed
the streaming UX bar, and required the app to be in the foreground to
notice that an approval was pending. The goal: real-time updates while
the chat is open, real-time wake-ups when it isn't, and zero
information leak to APNs servers along the way.

The chosen design uses two transports in concert:

- **SSE** (`/api/chat/:id/stream`) for the in-app chat detail screen.
  Streaming `assistant_text` upserts, tool-call status flips, and phase
  transitions arrive frame-by-frame with `Last-Event-ID` resume on
  reconnect. This is the canonical streaming path while the user is
  watching a chat. See ADR [Chat Block Protocol](./chat-block-protocol.md).
- **APNs** for wake-ups: `authorization_requested` / `setup_requested`
  (always) and `phase: Completed | Failed` (only when no active SSE
  subscription for the device — see the per-device suppression note under
  Trigger policy). A `Completed` turn that produced a
  user-visible message fires a visible alert; a `Completed` with no
  message and `Failed` fire as `content-available: 1` silent pushes that
  update the badge without surfacing a banner. Authorization pushes carry
  inline Approve/Deny action buttons.

## Trust + privacy

- **Token storage**: each iOS install POSTs its raw APNs device token
  (`Notifications.getDevicePushTokenAsync()`, not Expo Push token) to
  `/api/push/devices`. The row is scoped to the calling credential
  (either the owner config token or a paired device's deviceId).
  Cross-credential delete is forbidden; cross-credential register
  rebinds the token to the new credential.
- **`.p8` key**: the runtime reads `APNS_KEY_ID`, `APNS_TEAM_ID`, and
  `APNS_KEY_P8_PATH` from env. The key never leaves the gateway
  process. ES256 JWT is cached for 50 minutes and rotated on demand.
- **Payload scope**: APNs alert payloads contain `{ sessionId, blockId,
  approvalId, event }` — plus `threadId` when the completed block belongs
  to a thread — and a fixed `{ title, body }` generic string. No chat
  text, no tool name, no approval summary. The routing ids (including
  `threadId`) are opaque identifiers, not user content. Silent payloads
  carry the same routing fields and `content-available: 1`. The
  exhaustive privacy assertion is pinned in
  `src/integrations/apns/dispatcher.test.ts` — any future regression that
  adds user content to the **wire** surface fails the suite. The rich
  preview the user sees is fetched on-device by the NSE (see "NSE
  enrichment" below), never placed on the wire.
- **Apple sees**: sessionId-shaped opaque strings, app bundle id, and
  the generic title. Apple does not see the chat content, the agent
  name, or any user-authored text — even though the user reads a rich
  preview on their lock screen.

## Trigger policy

| Event | Push | Rationale |
| ----- | ---- | --------- |
| `authorization_requested` | Always (alert + inline Approve/Deny actions) | The runtime can't make progress without user input; the user may not be in the app. |
| `setup_requested` | Always (alert, no action buttons — deep-links on tap) | The user must complete a step (sign in, fill a form) in the app; surface it but don't offer approve/deny. |
| `phase: Completed` AND the task emitted ≥1 non-empty `assistant_text` | Alert ("Gini has a new message" / "Tap to read"), only if no active SSE subscription for the device | Background and scheduled work that produces a real reply is exactly what the user wants to know about. |
| `phase: Completed` with no `assistant_text` (only tool calls / system notes) | Silent (badge tick), only if no active SSE subscription | Nothing for the user to read — bump the badge so the chat list is accurate, but don't surface a banner. |
| `phase: Failed` | Silent (badge tick), only if no active SSE subscription | Failure noise shouldn't yell at the user; tapping the chat surfaces the error. |
| `phase: Cancelled` | Never | User-initiated terminal state; the user is already in the app. |
| `assistant_text` deltas | Never | Streaming text is for the SSE path only — APNs is the wrong tool. |
| All other block kinds | Never | Out of scope; the next foreground reconciliation picks them up. |

The `message_completed` alert payload carries the same routing fields
as the silent variant (`sessionId`, `blockId`, `event: "message_completed"`,
`silent: false`, and `threadId` when the completed block is threaded) plus
a generic `aps.alert` envelope. The `threadId` lets the NSE ask the
gateway for the **thread's** own latest reply instead of the main chat's,
so a notification fired by threaded work previews the right text. No
`category` is attached — the only action is the default tap, which
deep-links to the chat detail via the existing response listener.

The "no active subscription" check is per-device, not per-credential:
two iOS installs of the same human can be in different app states
(one watching, one backgrounded). The backgrounded install still gets
the wake-up (alert or silent) so its badge and visible state stay in
sync.

## NSE enrichment (rich previews without leaking text to Apple)

The default banner is intentionally content-free on the wire. To let the
user read a notification without tapping in — while keeping chat text off
Apple's servers — the NSE fetches the real preview on-device after the
push arrives:

1. **Server**: `GET /api/push/preview?sessionId=&event=&approvalId=&threadId=`
   (`src/http.ts`) returns a notification-ready `{ title, body }` built by
   `src/integrations/apns/preview.ts`. The optional `threadId` is forwarded
   from the push payload by the NSE. Three event kinds resolve:
   - `message_completed` → the **latest** non-empty `assistant_text` in
     the session (`latestAssistantTextForSession`), or in the thread when
     `threadId` is present (`latestAssistantTextForThread`) so a threaded
     completion previews the thread's own reply rather than stale main-chat
     text. Reading the newest block — not a specific one — is what makes a
     banner collapsed onto a single session entry track the last message
     across multiple agent turns.
   - `authorization_requested` → the approval's risk + reason
     (`[high] <reason>`), titled `Approve in <chat>?`.
   - `setup_requested` → the setup ask, titled `Finish a step in <chat>`.
   The route is bearer-gated like every other `/api/*` route; a resolved
   approval, deleted session, or not-yet-persisted message returns 404 so
   the NSE keeps the generic banner.

2. **Credential bridge**: the NSE runs in its own process and cannot read
   the app's AsyncStorage. The main app mirrors `{ baseUrl, token,
   deviceToken }` into an **App Group** shared container
   (`group.<bundleId>`) via `expo-file-system`'s
   `Paths.appleSharedContainers` (`mobile/src/shared-credentials.ts`),
   written on credential save and after push registration, cleared on
   sign-out. The NSE reads the same file via
   `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)` —
   the two APIs resolve to the same on-disk container. The config plugin
   grants the App Group entitlement to both the app target
   (`withEntitlementsPlist`) and the NSE target (a dedicated
   `.entitlements` linked via `CODE_SIGN_ENTITLEMENTS`).

3. **NSE** (`NotificationService.swift`): reads the shared creds, reads
   the routing fields from `userInfo["body"]`, calls the preview endpoint
   (20s budget, under Apple's 30s NSE ceiling), and rewrites `title` /
   `body`. On any failure it hands back the original generic content via
   `contentHandler` / `serviceExtensionTimeWillExpire`.

**Privacy invariant preserved**: the enriched text travels gateway →
device over the device's own authenticated connection. APNs still only
ever carries ids + the generic string. The credential file holds the
gateway bearer (never chat content) in the app's own sandboxed App Group
container.

**Update-across-turns**: completion pushes collapse by `sessionId`
(`apns-collapse-id`), so a later push **replaces** the earlier banner
rather than stacking; combined with the latest-message lookup, the single
lock-screen entry always reflects the newest assistant reply.

## NSE + category model

- The NSE target (`mobile/ios-extensions/ApprovalNotificationService/`)
  is registered by the Expo config plugin during `expo prebuild`.
  Without the NSE, an APNs payload with `mutable-content: 1` cannot
  be mutated before display, and the category id never attaches.
- The main app calls `Notifications.setNotificationCategoryAsync` on
  every push registration, registering the `APPROVAL_REQUEST` category
  with two actions (specs live in `mobile/src/push-dispatch.ts` as
  `APPROVAL_CATEGORY_ACTIONS` so the invariant below is unit-testable):
  - `APPROVE` — `opensAppToForeground: false`, `isAuthenticationRequired: true`.
    Approving grants the high-risk action the agent paused on, so iOS must
    require Face ID / Touch ID / passcode (an unlock) before the handler
    runs — otherwise anyone holding the locked phone could authorize a
    dangerous operation from the lock screen. The unlock requirement does
    not foreground the app; the gateway POST still runs in the background.
  - `DENY` — `opensAppToForeground: false`, `isDestructive: true`. No auth
    gate: denying is fail-safe (it cancels the pending action, never
    grants), and the destructive flag gives it the red lock-screen styling.
- When the user taps an action, `mobile/src/push-dispatch.ts` extracts
  `approvalId` (the authorization id) from the payload and POSTs to the
  existing `/api/authorizations/:id/approve|deny` route. The app never
  foregrounds (Approve runs only after the OS-required unlock). Failures
  schedule a follow-up local notification ("Failed to approve — open the
  app to retry") so a network blip doesn't silently lose the action.
- iOS only invokes the response listener if the app is at least
  suspended. If the user has killed the app from the app switcher,
  iOS doesn't run JS — the user must open the app and approve from
  there. The approval remains pending in the runtime until acted on
  (the runtime has no retry loop that re-emits approval requests).

## Action endpoints

The action handler reuses the **existing** authorization routes:

- `POST /api/authorizations/:id/approve` — pre-dates the push surface.
- `POST /api/authorizations/:id/deny` — pre-dates the push surface.

Both already enforce authentication, idempotency, and the audit-trail
semantics from [Approval And Audit Substrate](./approval-and-audit-substrate.md).
Adding push as a new caller required zero changes to the action
endpoints themselves — the new surface is purely a delivery layer.

## Token lifecycle

- **Registration**: at the "first chat detail mount" moment (higher
  permission grant rate than asking on app launch). Idempotent —
  upserts on the token row, bumping `last_seen_at`.
- **Rotation**: `addPushTokenListener` re-registers any rotated token
  immediately. The rotated token replaces the old row by primary key.
- **Cleanup**: a 410 Unregistered response from APNs (user uninstalled
  or revoked notifications) deletes the row so subsequent fan-outs
  skip the dead token. Other non-2xx statuses are logged but the row
  stays — they may recover or require human intervention.
- **De-registration on logout**: sign-out (and credential swap) fires a
  best-effort `DELETE /api/push/devices/:token` via `clearCredentials` →
  `tryDeregisterCachedDevice` (`mobile/src/auth.ts`), draining any
  in-flight registration first (bounded wait) so the delete can't race a
  late register. Sign-out also clears the shared App Group credentials so
  a backgrounded NSE can't keep fetching previews with the signed-out
  bearer. The remaining gap is a hard app-reset (process killed without an
  in-app logout), which never runs the JS path; that token is pruned
  reactively by the 410 Unregistered cleanup above on the next fan-out.

## Build flow consequences

- **No more Expo Go on iOS.** The NSE is a custom native target that
  Expo Go cannot host. Developers use `bunx expo prebuild --platform
  ios --clean` then `bunx expo run:ios` (or EAS Build for
  distribution). Android still works in Expo Go because the NSE is
  iOS-only.
- The generated `ios/` directory is `.gitignore`'d. The source of truth
  is the plugin + the Swift file under
  `mobile/ios-extensions/ApprovalNotificationService/`. Re-run
  `prebuild --clean` to pick up plugin changes.

## Alternatives considered

- **Expo Push Service**: rejected. Adds a third-party hop, makes the
  runtime depend on Expo's availability, and Expo's payload shape
  strips fields we need for the NSE / category flow. Direct APNs is
  one TLS-pinned HTTP/2 connection to Apple per gateway, and the .p8
  + ES256 JWT plumbing is ~200 lines of Node `crypto` + `http2`.
- **Web push fallback**: rejected for this iteration. iOS Safari only
  recently shipped Web Push and the integration surface is different.
  When the Android client lands, it gets its own ADR (FCM, likely).
- **Always-on background polling**: rejected. iOS aggressively throttles
  background fetch on real devices; nothing short of APNs reliably
  wakes the app within seconds of an approval landing.
- **Foregrounding action buttons**: rejected. Forcing the app to
  foreground for every Approve / Deny would defeat the lock-screen UX
  goal. The killed-app edge case (where the action button doesn't run
  our JS) is mitigated by the runtime re-emitting approval requests.

## Consequences

- The gateway is now the canonical APNs sender for every paired iOS
  install. Multi-tenant deployments will need to refactor the
  dispatcher's `listAllDevices` broadcast into a per-credential
  fan-out — the helper (`listDevicesForCredential`) already exists.
- The mobile build flow is two-step: `bunx expo prebuild` once, then
  the normal Metro loop. Documented in `mobile/README.md`.
- A future "Resolve approval directly from the watch face" or "macOS
  notification mirror" feature can reuse the category + NSE plumbing —
  the action identifiers are already public-facing.
