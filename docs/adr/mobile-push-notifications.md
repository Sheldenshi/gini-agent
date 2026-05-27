# ADR: Mobile Push Notifications (APNs + NSE + Inline Actions)

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
The notification body is a generic string (`"Tap to review"` for
approvals; silent payload for completions). The mobile client fetches
full content via the existing `/api/*` surface on tap, action, or
foreground refresh.

Lock-screen Approve / Deny action buttons on approval pushes are
implemented as an iOS **Notification Service Extension** (NSE) plus a
`UNNotificationCategory` registered by the main app. The NSE attaches
the category id on incoming `approval_requested` payloads; the OS
renders the action buttons; tapping an action posts directly to
`/api/approvals/:id/approve` or `/deny` without opening the app.

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
- **APNs** for wake-ups: `approval_requested` (always) and
  `phase: Completed | Failed` (only when no active SSE subscription
  for the credential). Completions fire as `content-available: 1`
  silent pushes that update the badge count without surfacing an
  alert; approvals fire as visible alerts with inline action buttons.

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
  approvalId, event }` and a fixed `{ title: "Gini needs your
  approval", body: "Tap to review" }`. No chat text, no tool name, no
  approval summary. Silent payloads carry the same routing fields and
  `content-available: 1`. The exhaustive privacy assertion is pinned
  in `src/integrations/apns/dispatcher.test.ts` — any future regression
  that adds user content to the wire surface fails the suite.
- **Apple sees**: sessionId-shaped opaque strings, app bundle id, and
  the generic title. Apple does not see the chat content, the agent
  name, or any user-authored text.

## Trigger policy

| Event | Push | Rationale |
| ----- | ---- | --------- |
| `approval_requested` | Always (alert + inline actions) | The runtime can't make progress without user input; the user may not be in the app. |
| `phase: Completed` | Silent, only if no active SSE subscription for the credential | If the user is on the chat detail, SSE delivers the block directly; the wake-up is redundant. |
| `phase: Failed` | Silent, only if no active SSE subscription | Same as Completed. |
| `phase: Cancelled` | Never | User-initiated terminal state; the user is already in the app. |
| `assistant_text` deltas | Never | Streaming text is for the SSE path only — APNs is the wrong tool. |
| All other block kinds | Never | Out of scope; the next foreground reconciliation picks them up. |

The "no active subscription" check is per-device, not per-credential:
two iOS installs of the same human can be in different app states
(one watching, one backgrounded). The backgrounded install still gets
the silent wake to update its badge.

## NSE + category model

- The NSE target (`mobile/ios-extensions/ApprovalNotificationService/`)
  is registered by the Expo config plugin during `expo prebuild`.
  Without the NSE, an APNs payload with `mutable-content: 1` cannot
  be mutated before display, and the category id never attaches.
- The main app calls `Notifications.setNotificationCategoryAsync` on
  every push registration, registering the `APPROVAL_REQUEST` category
  with two actions:
  - `APPROVE` — `opensAppToForeground: false`, `isAuthenticationRequired: false`
  - `DENY` — `opensAppToForeground: false`, `isDestructive: true`
- When the user taps an action, `mobile/src/push-dispatch.ts` extracts
  `approvalId` from the payload and POSTs to the existing
  `/api/approvals/:id/approve|deny` route. The app never foregrounds.
  Failures schedule a follow-up local notification ("Failed to approve
  — open the app to retry") so a network blip doesn't silently lose
  the action.
- iOS only invokes the response listener if the app is at least
  suspended. If the user has killed the app from the app switcher,
  iOS doesn't run JS — the user must open the app and approve from
  there. The approval remains pending in the runtime until acted on
  (the runtime has no retry loop that re-emits approval requests).

## Action endpoints

The action handler reuses the **existing** approval routes:

- `POST /api/approvals/:id/approve` — pre-dates the push surface.
- `POST /api/approvals/:id/deny` — pre-dates the push surface.

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
- **De-registration on logout**: future work. The DELETE endpoint
  exists (`DELETE /api/push/devices/:token`) but the mobile setup-flow
  doesn't currently fire it. A user who hard-resets the app continues
  to receive pushes until the next install does so via NSE delivery
  failure or until the 410 path triggers.

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
