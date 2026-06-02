# ADR: Chat-Driven Credential Provisioning

## Decision

Credential provisioning is agent-driven and happens in the chat, on demand or
at skill-install time — there is no manual "add a credential" detour the user
must take before the agent can proceed. The agent calls `request_connector`,
the user enters the secret in the secure inline card, and the task resumes. The
flow reuses the `connector.request` SetupRequest substrate, so the secret
follows the same `user keyboard → chat UI → BFF → gateway → encrypted store`
path the substrate already guarantees and never reaches the model
(ADR browser-fill-secret.md).

`request_connector` takes two shapes:

- **Registered provider** — `{ provider, reason }` for a service whose setup is
  modeled by a provider module (e.g. `linear`). The minted card renders the
  module's fields; `/complete` types the record via the module's
  `credentialTemplate`.
- **Templateless typed credential** — `{ name, type: "api-key", label?,
  mcpUrl?, skillId?, reason }` for a brand-new service with no provider module.
  Templateless requests are **api-key only**: the `name` IS the env var
  (validated `^[A-Z][A-Z0-9_]*$`) and a single secret is stored under it. An
  oauth2 credential needs a provider module / setup skill to model its env vars
  and OAuth flow, so it cannot be requested templatelessly — the dispatcher
  rejects a no-provider `type: "oauth2"` with a recoverable error. The card
  renders a read-only credential name (pinned from the trusted setup payload)
  plus a password secret input (and an optional read-only MCP URL); `/complete`
  stamps a TYPED record from that payload (ADR typed-named-credentials.md).

Both shapes accept an optional `skillId`. When set, completing the card both
stores the credential AND grants it to that skill, enabling the skill once it
has no remaining ungranted credentials — one card, no second consent card. The
user entering a secret for a named skill IS the consent (ADR
skill-connector-consent.md): the model cannot forge it because it never sees the
secret value. The card states which skill receives the grant from the
**server-resolved** skill identity: the model supplies only `skillId`, the
dispatcher resolves that id to the skill's name from state and stamps it into
the setup payload as `credentialSkillName`, and the card renders consent ("Grant
&lt;credential&gt; to &lt;skill&gt;") from that field — not from the
model-authored reason or title. So the consent the user acts on names the skill
the gateway will actually grant, even if the model's prose claimed otherwise.

## Context

The typed-named-credential model (ADR typed-named-credentials.md) and the
per-skill consent grant (ADR skill-connector-consent.md) established *what* a
credential is and *who* may use it, but acquiring one still meant the user
visiting a settings page. Two moments need a credential the runtime may not yet
hold:

- **On demand.** A task discovers mid-run that a skill it wants is inactive
  because a required credential is missing.
- **At install time.** The `install-skill` meta-skill inspects a new skill's
  `requires.credentials` and finds one the user has never connected.

Routing the user to a page in either case breaks the conversation and invites
the worst failure mode: the agent asking the user to paste a key as a chat
message, which lands the secret in the model's context, the transcript, and the
audit trail. The substrate to avoid that already exists — `connector.request`
and its secure card — so provisioning becomes "the agent asks via
`request_connector`; the card captures the value server-side."

## Considered alternatives

- **Keep credential capture on the settings page.** Rejected: it breaks the
  in-chat flow and is the friction this ADR removes. The `/skills` page remains
  a fallback for when the secure card cannot render (non-web surfaces).

- **Let the agent collect the secret in chat and POST it to `/api/connectors`.**
  Rejected — this is the one path that leaks the secret to the model. A value on
  a shell command line or in a tool argument enters the model's context, the
  audit trail, and process listings. `install-skill`'s rules now forbid it
  explicitly; `request_connector` is the only sanctioned capture path.

- **A new card / endpoint for templateless capture.** Rejected for Simplicity
  First. `connector.request` already models "user supplies a secret, the side
  effect runs in `/complete`, the chat-task loop resumes." The templateless
  api-key shape is a payload variant on the same action, distinguished by
  `credentialType` present with no `provider`.

- **Allow templateless oauth2.** Rejected. An oauth2 credential's env vars and
  OAuth flow are provider-specific knowledge the model does not hold for a
  brand-new service, and modeling them would require the browser to supply the
  env-var map alongside the secret — a trust seam where a compromised client
  shapes the stored record. oauth2 credentials therefore stay behind a provider
  module / setup skill that derives the structure server-side. Templateless
  request_connector is api-key only (the api-key `name` IS its single env var,
  so no map is needed).

- **A second consent card after capture.** Rejected. For a credential captured
  *for* a named skill, the human entering the secret is already the consent, so
  the `skillId`-carrying card grants on completion. The standalone
  `skill.grant_connector` card (ADR skill-connector-consent.md) still covers the
  case where a credential already exists and a different skill later wants it.

## Consequences

### Required

- `request_connector` accepts the templateless `{name, type: "api-key"}` shape
  alongside a registered `provider`; either one is required. The dispatcher
  validates the api-key name synchronously, keys the existing-healthy fast path
  on the credential name when templateless, and bypasses the setup-skill gate
  (no provider means no setup skill). A no-provider `type: "oauth2"` is rejected
  synchronously with a recoverable error.

- The card renders only in an interactive web chat. `request_connector` carries
  the same surface guard as `requestSkillConnectorGrant` and
  `browser_fill_secrets`: a task on a messaging bridge, a headless subagent, or
  an `origin: "job"` session fails synchronously with an "open the web chat"
  message rather than parking on a card no one can complete.

- `/complete` claims the setup request (atomic pending→completed) BEFORE any
  side effect — mirroring `skill.grant_connector`. The losing side of a
  double-submit, and any complete that races a cancel, throws
  `ApprovalRaceLostError` and performs zero mutations: only the winning claim
  creates the connector, grants, and enables. A probe failure after the claim
  drops the orphaned record and resumes the chat-task with the failure.

- Auto-grant fires only when the named skill actually declares the credential in
  its `requiredCredentials`. The model supplies `skillId`, so this check keeps
  the credential model's "a skill only gets credentials it declared + the user
  granted" invariant — a skill cannot be granted a credential it never declared.
  The skill is enabled only when it is fully satisfiable: every required
  credential resolves to a configured + healthy connector AND is granted
  (`isSkillActive` + `firstUngrantedCredential`). A multi-credential skill stays
  disabled until the next missing credential is requested separately.

- The card displays consent against the server-resolved skill identity. The
  dispatcher resolves `skillId` to the skill's name and stamps it into the setup
  payload as `credentialSkillName`; the web card renders "Grant &lt;credential&gt;
  to &lt;skill&gt;" from that field and shows a non-spoofable "Grants to skill"
  band, so what the user consents to is the gateway's grant target, not the
  model's prose. Because the row is claimed at completion, a completed
  `connector.request` is terminal: the card renders the resolved connect outcome
  (a persisted `ok:false` failure resumes the agent to re-request; otherwise
  "Connected") rather than offering a resubmit that would be Gone.

- The needs-setup system block tells the agent exactly how to request each
  missing credential: a registered provider id, or the templateless
  `{name, type: "api-key", skillId}` shape (grouped by the credential NAME, not
  by a generic connector row that happens to share the name). The `read_skill`
  inactive-skill error points at `request_connector`, never at pasting the
  credential.

- `install-skill` and `create-skill` prompt for each missing credential in chat
  via `request_connector` with the skill's id as `skillId`, so completion stores
  the typed record AND grants it — no `/skills` trip, no separate grant step.

### Trust boundary

The secret value reaches the gateway only through the card → `/complete` POST
and is encrypted at rest (ADR connector-secret-storage.md). Name, type,
credential metadata, and the displayed skill name (`credentialSkillName`) are
derived from the trusted setup payload the dispatcher minted, not from the
browser body, so a compromised client cannot retype a credential as a different
name or provider, nor can the model misstate which skill the consent is for: the
card's skill identity is resolved server-side from `skillId`, not from the
model-authored reason or title. The model authors the `request_connector`
arguments and the user-visible reason, but never sees the secret — exactly the
secret-never-in-model invariant the `connector.request` substrate already
enforces.

## Related

- ADR `browser-fill-secret.md` — the secure-input substrate this reuses; the
  secret follows the same never-to-the-model path.
- ADR `typed-named-credentials.md` — the typed, name-based credential record a
  templateless request lands.
- ADR `skill-connector-consent.md` — the per-(skill, credential) grant the
  `skillId`-carrying card auto-records on completion.
- ADR `authorization-vs-setup-request.md` — the SetupRequest substrate
  `connector.request` is built on.
- ADR `connector-secret-storage.md` — how the captured secret is encrypted at
  rest.
