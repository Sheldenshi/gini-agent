# ADR: Browser Connect Sensitive-Step Handoff

## Decision

`browser_connect` has two sanctioned uses, distinguished by an optional `mode` argument on the tool call:

1. **Sign-in unblock** (`mode: "sign-in"`, the default) — the existing contract: a navigation the agent already made hit a sign-in / OAuth / auth wall; the user signs in once through a live in-chat view of the agent's browser and the agent continues with the persisted session.
2. **Sensitive-step handoff** (`mode: "handoff"`) — the task has reached a step the USER must perform themselves in the agent's browser: entering payment details, a final purchase confirmation, or because they chose via `ask_user` to finish manually. The agent hands off the live browser view at the exact page it drove the flow to; the user completes the step, clicks done, and the agent continues — re-snapshots, confirms the outcome from the page, and reports.

Same tool, same SetupRequest action (`browser.connect`), same two-stage `/open-browser` → `/complete` flow, same loop guard and navigate-first precondition. The only mode-keyed difference is the completion card's wording.

## Context

The handoff mechanism was always mechanically general: the user acts on the SAME per-instance browser/profile the agent drove, so cart, session, and half-filled form state the agent built up headlessly are all preserved. (Whether the user acts through the in-chat screencast of the headless browser — the default — or, as a fallback, a visible managed Chrome window when no spawned browser is live, the profile is the same; see [browser-stealth-identity.md](browser-stealth-identity.md).) But the tool contract and the card UI were sign-in-locked — the description forbade any non-auth use and the completion button read "I've signed in" unconditionally. That left the agent with no sanctioned way to hand the user the final step of a purchase or booking, so it refused such tasks outright instead.

Handing the user a URL for their OWN browser is not a substitute: the agent's progress lives in the gateway Chrome profile, not in the user's browser.

The handoff is one of three completion paths at the sensitive boundary (payment / PII the agent doesn't have); the others are `browser_fill_secrets` (see [browser-fill-secret.md](browser-fill-secret.md)) and step-by-step instructions. The instructions steer in `src/runtime/defaults/INSTRUCTIONS.md` tells the agent to offer the surface-appropriate subset via `ask_user`: the handoff only helps a user who is at the gateway machine, which the agent knows from the per-turn surface line (see [client-surface-context.md](client-surface-context.md)).

## Mechanics

- **Tool args**: `mode?: "sign-in" | "handoff"`, default `"sign-in"`. The dispatcher (`requestBrowserConnect` in `src/execution/tool-dispatch.ts`) stamps `mode: "handoff"` onto the SetupRequest payload only when the literal `"handoff"` was passed; any other value (including unset) produces a payload byte-identical to the pre-handoff sign-in contract, so every existing flow — including the setup skill's `headless: true` reconnect — is unchanged.
- **Card wording**: the web card (`BlockSetupRequested.tsx`, label logic in `web/src/components/chat/browser-connect-card.ts`) renders "Connect" in stage 1 for both modes; the stage-2 completion button reads "I've signed in" by default and "I'm done" when `payload.mode === "handoff"`. The agent-supplied `reason` remains the user-facing explanation of what to do in the browser view.
- **Completion**: mode-independent. `/open-browser` marks `payload.signInStarted` (the stage-1 "user is acting" marker for both modes). In the default screencast path it also stamps `payload.screencast`, and `/complete` simply stops the screencast bridge and resumes the already-headless agent (no relaunch). In the visible-window fallback, `completeBrowserConnectSetup` relaunches headless on the same profile — the user finished acting, so the window closes and the agent resumes.
- **Guards**: the navigate-first precondition and the per-host card cap apply to both modes — a handoff acts on a page the agent already reached, never a cold open.

## Acceptance Checks

- `browser_connect({ reason, mode: "handoff" })` on a live page mints a `browser.connect` SetupRequest whose payload carries `mode: "handoff"`; the same call without `mode` (or with an unrecognized value) mints a payload with no `mode` key.
- The web card renders "I'm done" as the stage-2 button for a handoff payload and "I've signed in" for every other payload, including pre-existing rows.
- Completing a handoff setup in the default screencast path stops the screencast bridge and resumes the already-headless agent with no relaunch; in the visible-window fallback it relaunches the managed browser headless — both behave exactly like the corresponding sign-in completion.
- The tool-catalog description names both sanctioned uses and keeps the sign-in steers (never a first step, never proactive) intact.
