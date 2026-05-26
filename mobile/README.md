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
