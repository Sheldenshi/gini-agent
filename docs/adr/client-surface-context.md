# ADR: Client Surface in Per-Turn Model Context

## Decision

Every inbound chat message resolves to an optional **client surface** — `"web" | "mobile" | "cli" | "telegram" | "discord" | "openclaw"` (`ChatClientSurface` in `packages/runtime/src/types.ts`) — and the chat-task loop injects a one-line description of the CURRENT turn's surface into the per-turn model context. UI clients claim their surface with an optional `client` field on the message POST body; messaging bridges never send the field — their surface derives from the chat session's `source.kind`. An unknown surface injects nothing: the prompt makes no claim rather than guessing.

## Context

The agent's browser is a headless spawned Chrome on the gateway machine. A sign-in or sensitive-step handoff surfaces it as a LIVE IN-CHAT SCREENCAST that only the web app renders, so a browser handoff only works for a user on the web app (or one at the gateway machine who can open it), while other completion paths work from anywhere (secure value fill, step-by-step instructions). Before this decision the runtime knew the bridge kind for Telegram/Discord sessions but never told the model, and web/mobile/CLI messages were indistinguishable — so the model could not tailor sensitive-step completion choices to where the user actually is.

## Per-message, not per-session

The surface is a property of each inbound MESSAGE, not of the session. The same chat session is routinely used from a phone and a desktop alternately, so caching a surface on the session record would go stale the moment the user switches devices. Resolution happens on every submit:

1. If the POST body carries `client` with a value in the claimable enum (`"web" | "mobile" | "cli"`), that wins. Bridge kinds are NOT claimable through the body field.
2. Otherwise, the session's `source.kind` (`"telegram" | "discord" | "openclaw"`) supplies the surface for bridge-routed messages.
3. Otherwise the surface is unknown (`undefined`).

Validation is deliberately lenient: an unrecognized `client` value resolves to unknown, never a 400, so clients that predate (or postdate) the enum keep working.

## Storage: stamped on the Task

`resolveClientSurface` in `packages/runtime/src/execution/chat.ts` runs inside the shared submit-preparation path (both main-chat messages and thread replies), and the resolved value is threaded through `submitTask` onto `Task.clientSurface`. The Task is the right per-message carrier for the same reason `Task.images` lives there: the agent loop reads a single record stamped at submission instead of racing the asynchronous chat-message write. Chat tasks are one-per-inbound-message, so Task storage IS per-message storage.

## Prompt injection shape

`buildClientSurfaceBlock` (`packages/runtime/src/system-prompt.ts`) renders the line; `runChatTask` passes it to `renderEphemeralContext`, so it rides in the ephemeral `role:"user"` tail placed immediately before the real user message — NOT in the byte-stable system prefix, which must stay byte-identical across turns for prompt caching (see [stable-system-prefix.md](stable-system-prefix.md)). Because the tail is rebuilt fresh each turn and never replayed from durable history, each turn carries exactly its own surface.

The rendered lines:

- `web` — messaging from the web app on a computer; the in-chat sign-in / handoff screencast of the agent's headless browser renders here, so a browser handoff can reach them.
- `cli` — messaging from the CLI on the gateway machine; they can open the web app there to use the in-chat screencast, so a browser handoff can reach them.
- `mobile` — messaging from the mobile app on their phone; the in-chat browser screencast isn't available there, so a browser handoff can't reach them.
- `telegram` / `discord` / `openclaw` — names the bridge; same screencast-unavailable caveat as mobile.
- unknown — no line at all.

Subagents are excluded (they keep their single override prompt and don't drive user-facing surface choices).

## Clients

- Web app: chat send, thread reply, and the skills-page "set up via chat" seed messages send `client: "web"`.
- Mobile app: chat send and thread reply send `client: "mobile"`.
- CLI: `gini chat send` sends `client: "cli"`.
- Bridges: send nothing; derivation from `source.kind` covers them.

## Acceptance checks

- POST `/api/chat/<id>/messages` with `client: "mobile"` stamps `clientSurface: "mobile"` on the spawned task; `client: "fridge"` and an absent field both leave it undefined without rejecting the message (`packages/runtime/src/http.test.ts`, `packages/runtime/src/execution/chat.test.ts`).
- A message on a telegram/discord/openclaw-sourced session resolves its surface with no body field (`packages/runtime/src/execution/chat.test.ts`).
- For each known surface, the expected line appears in the ephemeral tail immediately before the current user message and never in the system prefix; alternating web→mobile turns in one session each carry only their own line; an unknown surface injects no line anywhere in the turn (`packages/runtime/src/execution/chat-task.test.ts`, `packages/runtime/src/system-prompt.test.ts`).
