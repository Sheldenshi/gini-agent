# Gini mobile

Expo + TypeScript client for the Gini runtime. The runtime gateway is the
source of truth; this app is a thin chat / agent-picker UI on top of the
existing `/api/*` HTTP contract — same surface the web client uses, except
the mobile app holds its own bearer token rather than relying on a BFF.

## Run

From the repo root:

```bash
bun run mobile        # forwards to `cd mobile && bun run start`
```

Or from `mobile/`:

```bash
bun install
bun run start         # Metro + Expo Dev Tools (universal)
bun run ios           # iOS simulator
bun run android       # Android emulator
bun run web           # Web preview
```

Typecheck (kept separate from the root `typecheck` script so the web/runtime
flow stays fast):

```bash
cd mobile && bunx tsc --noEmit
```

## First-run setup

The mobile app does not embed the gateway URL or token; the first launch
shows a setup screen where you paste them.

- **Base URL**: the runtime gateway. Defaults to `http://localhost:7421`.
  For a real device on the same network, use your machine's LAN IP (e.g.
  `http://192.168.1.42:7421`); the simulator/emulator can keep `localhost`.
- **Bearer token**: copy it from `~/.gini/instances/<instance>/config.json`
  (the `token` field) or run `gini status` and look for the token line.

The setup screen calls `GET /api/status` once to validate; if it returns
JSON, the credentials are persisted with `AsyncStorage` and you're routed
to the agent picker.

## Behavior

- **Agents** is the home screen. Tapping an agent activates it on the
  gateway via `POST /api/agents/:id/use` and opens that agent's chat
  list. The active agent shows a checkmark.
- **Chats** lists `GET /api/chat?agentId=<id>` sorted by `updatedAt`.
  The `+` header button creates a new chat (`POST /api/chat`) and opens
  it immediately.
- **Chat detail** seeds with one `GET /api/chat/:id/blocks` fetch and
  then subscribes to `GET /api/chat/:id/stream` (Server-Sent Events via
  `react-native-sse`) for live block updates. Reconnects carry a
  `Last-Event-ID` header so the gateway only replays what was missed.
  Messages render bottom-aligned; the assistant placeholder shows the
  task's `currentStep` ("Thinking" / "Working" / …) until the task
  reaches a terminal state, at which point the client calls
  `POST /api/chat/:id/tasks/:taskId/sync` if no paired assistant block
  materialised on its own.

## Fork & re-skin

Gini is open source — the iOS app is yours to fork, rebrand, and ship under
your own Apple developer account. Three layers to touch:

**1. Branding constants in `app.config.ts`** (committed):

- `IOS_BUNDLE_ID` / `ANDROID_PACKAGE` — your reverse-DNS bundle id.
- `APP_NAME` — what users see on the home screen.
- `APP_SLUG` — the EAS slug (lowercase, hyphenated).
- `APP_SCHEME` — your deep-link scheme (e.g. `myagent://`).

The NSE bundle id and OTA updates URL are derived, so you only edit
one place.

**2. Org credentials in `mobile/.env`** (gitignored). Copy `.env.example`
and fill in. These live outside the repo because no fork shares
permission to use them:

| Var               | Where to get it                                      |
|-------------------|------------------------------------------------------|
| `EAS_PROJECT_ID`  | `eas init` in `mobile/`. The OTA URL derives from it. |
| `EXPO_OWNER`      | `expo whoami` — your Expo account or org.            |
| `APPLE_TEAM_ID`   | developer.apple.com → Membership → Team ID.          |

The config loads `.env` via `dotenv/config`, so every Expo / EAS command
(`expo start`, `expo prebuild`, `eas init`, `eas build`, `eas update`)
sees the values without extra setup.

**3. `eas.json` submit profile** (committed) — replace `appleTeamId` and
`ascAppId` under `submit.production.ios` with your own before running
`eas submit`.

After editing, regenerate the native project:

```bash
cd mobile && bunx expo prebuild --platform ios --clean
```

## iOS dev client + Notification Service Extension

Lock-screen Approve / Deny buttons on approval pushes are implemented
as an iOS Notification Service Extension (NSE), added by the Expo
config plugin in `plugins/with-approval-notification-service.js`. This
moves the app from a purely managed Expo workflow to a **dev client +
prebuild** workflow on iOS.

**Managed Expo Go no longer works for this app** because Expo Go
cannot load custom NSE targets. Use the dev client locally and EAS
Build (or `expo run:ios`) for distribution.

### One-time setup

```bash
cd mobile
bun install
bunx expo prebuild --platform ios --clean   # generates ios/ from app.json
bunx expo run:ios                            # builds + boots the simulator
```

`bunx expo prebuild` writes the NSE source from
`mobile/ios-extensions/ApprovalNotificationService/NotificationService.swift`
into `ios/ApprovalNotificationService/` and registers it as an Xcode
target. The generated `ios/` directory is `.gitignore`'d — the
canonical source of truth is the plugin + the Swift file under
`ios-extensions/`. Re-running `expo prebuild --clean` is the safe
way to pick up plugin changes.

### Day-to-day

After the first prebuild, normal Metro / Hot Reload works:

```bash
bun run start          # Metro
bun run ios            # boots the previously-built dev client
```

You only need to re-run `prebuild` when the plugin, the NSE Swift
source, or `app.json`'s plugin list changes.

### Distribution

EAS Build picks the plugin up automatically — `eas build --platform ios`
runs prebuild under the hood and includes the NSE target.

### What the NSE does

When an APNs payload arrives with `mutable-content: 1` (set by the
server-side dispatcher in `src/integrations/apns/dispatcher.ts` for
`approval_requested` blocks), the OS spawns the NSE for up to 30s
before showing the notification. The NSE attaches
`categoryIdentifier = "APPROVAL_REQUEST"`, which pairs with the
category the main app registers on launch via
`Notifications.setNotificationCategoryAsync` — and that's what makes
the Approve / Deny buttons appear on the lock screen / banner /
notification center.

When the user taps an action button, `mobile/src/push-dispatch.ts`
posts directly to `/api/approvals/:id/approve` or `/deny` without
foregrounding the app. The user can act without unlocking the device.

The action handler runs only if the app is at least suspended; if the
user has fully killed the app from the app switcher, iOS records the
action but our JS never runs. The user must open the app and approve
from there. The approval remains pending in the runtime until acted
on — the runtime does not have a retry loop that re-emits approval
requests.

## Known limitations (v1)

- No pairing-code flow (yet). The setup screen takes a base URL +
  token directly. The runtime exposes `POST /api/pairing/claim` for
  the proper short-code flow; adding a "Claim with pairing code"
  button is a small follow-up.
- The chat list (`useChats`) still polls `GET /api/chat?agentId=…`
  every 3s. There's no per-agent SSE endpoint yet; chat detail uses
  SSE but the sidebar's "Chats" list does not.
- No tool / approval UI. If a task lands on `waiting_approval`, the
  chat just sticks on "Working…" — resolve the approval from the web
  client.
- No markdown rendering, no images, no file attachments. Plain text
  bubbles only.
