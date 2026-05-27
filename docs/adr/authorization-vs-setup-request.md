# ADR: Authorization vs SetupRequest

## Decision

Split the legacy single-`Approval` concept into two first-class types differentiated by the *actor* at resolution:

| Type | Actor at resolution | Resolution means |
|---|---|---|
| `Authorization` | Agent | User clicks approve/deny; the agent then performs the risk-classified action. |
| `SetupRequest` | User | User performs a setup step (with optional input body); the agent waits, then resumes. |

`Approval` is retired as a named type. `state.approvals` is partitioned into `state.authorizations` and `state.setupRequests` on first read. Clients hit `/api/authorizations*` and `/api/setup-requests*` directly — no `/api/approvals*` alias is exposed.

## Context

The pre-split model treated every paused state as an "approval" with a `risk` field. That conflated two structurally different things:

- **Genuine authorization gates** — `file.write`, `terminal.exec`, `browser.upload_file`, etc. The agent has decided to do something; the user is the gatekeeper. Risk classification is load-bearing.
- **User-action prompts** — `browser.connect`, `connector.request`, `browser.fill_secret`. The agent is asking the user to *do* a setup step. The user is the actor, not the gatekeeper.

The mismatch leaked through the UI: every user-action prompt accumulated special-cases (`isBrowserConnect`, `isConnectorRequest`, `isBrowserFillSecret`, the per-card `shouldHideRiskBadge` rule, custom Connect/Submit button text, the `/approve` endpoint rejecting `browser.fill_secret`). The same accretion would have continued for the next setup-shaped tool.

The split makes the line structural: the type discriminates how a row is created, resolved, audited, and rendered.

## Action -> Type Mapping

`Authorization` (agent-actor):
- `file.write`, `file.patch`
- `terminal.exec`
- `browser.upload_file`
- `messaging.send`
- `memory.activate`, `skill.enable`, `connector.enable`

`SetupRequest` (user-actor):
- `browser.connect` — user opens a managed browser to sign in.
- `connector.request` — user enters provider credentials via the connect dialog.
- `browser.fill_secret` — user types a credential into a form field. Even though the underlying action is high-risk credential routing, the user is the actor (they type), the trust anchor is a non-spoofable page URL, and `/approve` always rejected this action because the credential value must arrive in a request body. Structurally identical to `connector.request`.

A new tool author chooses by asking: when this row resolves, who pushed the button — the agent (after user consent) or the user (after performing the step)?

## Audit Verbs

`authorization.requested`, `authorization.approved`, `authorization.denied`, `authorization.in_flight_aborted`, `authorization.cancelled_task_terminal`, `authorization.cancelled_task_cancelled`.

`setup.requested`, `setup.completed`, `setup.cancelled`, `setup.cancelled_task_cancelled`.

The per-action audit rows (`browser.connect`, `connector.request`, `browser.fill_secret`, etc.) keep their existing classifications. Audit fidelity (including the `risk: "high"` on `browser.fill_secret`) is unchanged.

## HTTP Surface

- `GET  /api/authorizations`
- `POST /api/authorizations/:id/approve`
- `POST /api/authorizations/:id/deny`

- `GET  /api/setup-requests`
- `POST /api/setup-requests/:id/complete` (body carries credentials / scopes / etc., per action)
- `POST /api/setup-requests/:id/cancel`
- `POST /api/setup-requests/:id/open-browser` (stage 1 of the two-stage `browser.connect` flow)

No `/api/approvals*` alias is exposed; the legacy endpoint family is removed and clients must call `/api/authorizations*` or `/api/setup-requests*` directly.

## Chat Blocks

`approval_requested` splits into `authorization_requested` and `setup_requested`. Renderers in `web/src/components/chat/` and `mobile/src/components/chat/` are split accordingly. The setup renderer never shows a risk pill — the rule is structural now, not a per-action suppression list.

## Side-Effect Ownership

`resolveAuthorization` keeps the executor pattern: mark approved, run the per-action side effect via `executeApprovedAction`, write the per-action audit row, resume the chat-task loop.

`resolveSetupRequest` only flips status and resumes the chat loop. Per-action side effects (visible Chrome launch, connector creation, credential routing) run inside the `/complete` handler. The `browser.connect` flow uses `completeBrowserConnectSetup` in `src/capabilities/browser-connect.ts` so the HTTP path and the test path share one implementation.

## Consequences

- Three Web UI surfaces (home pending list, `/permissions`, in-chat card) render two sections backed by two queries.
- `shouldHideRiskBadge` is gone.
- The `isBrowserConnect` flag survives only as a layout discriminator inside the `BlockSetupRequested` renderer (Connect button vs credential dialog vs inline credential inputs).
- Old state.json files migrate on first read; a unit test pins the partition.
- The legacy `/api/approvals*` alias is gone — callers must migrate to `/api/authorizations*` and `/api/setup-requests*`.

## Forward-Looking Notes

Future setup-shaped actions (e.g. user-initiated OAuth handshake, "approve this notification preference") go through `createSetupRequest` and the `/api/setup-requests/*` family. Future risk-gated tool actions (e.g. new browser actions that need policy gating) go through `createAuthorization` and `/api/authorizations/*`.

If a third actor class emerges (e.g. a "system" mint that neither user nor agent owns), add another sibling type rather than re-overloading either of these.
