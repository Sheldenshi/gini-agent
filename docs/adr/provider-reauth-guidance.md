# ADR: Provider Re-Authentication Guidance

## Decision

When a chat turn fails because a provider's credential is expired, invalid, or
rejected, the runtime surfaces an actionable, provider-named note with a CTA
whose destination depends on how that provider authenticates. The split is read
from the provider catalog's `auth` field — re-auth instructions are not encoded
in code or duplicated across surfaces:

| Provider class | `auth` | CTA destination | Where instructions live |
|---|---|---|---|
| OAuth / CLI (codex) | `codex-oauth` | The `#re-authentication` section of `https://gini.lilaclabs.ai/docs/providers/<id>`, rendered **inline** in a slide-over (with an Open full docs ↗ escape hatch) | A docs page per such provider |
| AWS-signed (bedrock) | `aws` | In-app **Settings → Providers** (`/settings`), CTA worded "Update Amazon Bedrock credentials" — opens the Edit dialog to re-enter the AWS access key + secret (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) | The provider's own 401/403 message (shown as the note's detail) — no doc |
| API-key (openai, anthropic, openrouter, deepseek, azure, local) | `env` | In-app **Settings → Providers** key form (`/settings`) | The provider's own 401/403 message (shown as the note's detail) — no doc |

The runtime classifies the failure, tags it with the provider that served the
turn, and stamps the chat block so every client renders the same thing:

- `ProviderAuthError` originates in two places:
  - The provider layer (`src/provider.ts`) throws it directly, with the
    provider name fixed at the throw site, for credential failures detected
    before or without a backend rejection: anthropic's missing env key
    (`readAnthropicKey`), bedrock's unresolved AWS credentials
    (`bedrockAuthHeaders`), and codex steady-state local credential absence —
    a missing or wrong-shape `~/.codex/auth.json` — in `readCodexBearer`.
    Codex additionally converts a **second** consecutive `CodexAuthRaceError`
    after `withCodexSessionRetry`'s single retry into
    `ProviderAuthError("codex")`: a persistent auth.json read failure is
    classified as a credential problem, not a mid-write race.
  - The provider-call sites (`src/execution/chat-task.ts` — both the main
    loop call and the iteration-cap summary call) wrap a backend-rejected
    credential only when the error is not already a `ProviderAuthError` and
    `isAuthExpiredError` matches its message, carrying the provider from the
    effective context — accurate even if the active agent changed while the
    call was in flight.
- Enrichment is keyed on that typed error, not on message-sniffing. `failTask`
  (`src/agent.ts`) and the iteration-cap path enrich a failure **only** when the
  error is a `ProviderAuthError`, so a tool/browser/terminal failure whose text
  merely mentions "401" is never misread as a provider re-auth. They persist
  `task.authErrorProvider` and emit a `system_note` whose `authError` carries
  `{ provider, providerLabel, detail, reauthKind, reauthUrl }` (see
  `SystemNoteAuthError`). `isAuthExpiredError` therefore runs only at the
  provider-call sites, where a match definitively means the credential failed.
- The raw provider message is run through `redactSecrets` before it is stored
  (`task.error`, audit) or rendered (`detail`), since some providers echo a
  partial key in their error.
- `providerReauth(name)` (`src/provider.ts`) derives `reauthKind`/`reauthUrl`
  from the catalog `auth` field — the single place the routing lives.
- The web `BlockSystemNote` renders the alert card + CTA (and falls back to the
  Settings form if a legacy row lacks the routing fields; `rowToBlock` also
  backfills them on read). For `reauthKind: "docs"` the CTA opens the referenced
  doc section inline via `DocReference` (ADR in-app-doc-references.md) rather
  than a new tab; the hosted URL it carries remains the source of the prose and
  the Open full docs ↗ target. Text-only clients (CLI, messaging) get the same
  actionable line via `syncChatTaskResult` (`src/execution/chat.ts`), which
  reads `task.authErrorProvider`.

### Persistent needs-reauth state (issue #233)

The chat note alone is transient and per-session; without a durable record,
every persistent surface (Settings → Providers, connector health, setup
Verify) keeps reporting "Connected" against a dead credential. The runtime
therefore also persists a per-provider auth-failure record:

- **Shape.** `RuntimeState.providerAuthFailures` maps provider name → `{
  provider, detail, at, taskId? }` (`ProviderAuthFailureRecord`). Only
  failures are stored — absence of a record means OK. `detail` is the
  provider's error after `redactSecrets`; `at` is the ISO failure time;
  `taskId` is the task whose provider call observed it. The field is optional
  on `RuntimeState`, so legacy state files need no migration.
- **Write seams.** The same two places that stamp `task.authErrorProvider`
  write the record via `recordProviderAuthFailure`
  (`src/state/provider-auth.ts`): `failTask` (`src/agent.ts`) and the
  chat-task summary-failure path (`src/execution/chat-task.ts`, which settles
  the task itself rather than routing through `failTask`). Repeated failures
  refresh the record's detail/timestamp; the `provider.auth.needs_reauth`
  audit/event fires only on the ok→needs_reauth transition.
- **Clear seams.** The record drops (with a `provider.auth.cleared`
  audit/event) at the seams that prove the credential works again:
  1. a successful provider call in the chat-task loop (main loop AND the
     iteration-cap summary call) — guarded by a lock-free existence check
     (`clearProviderAuthFailureIfPresent`), so the common healthy path writes
     no state, and by an evidence-recency check: the call site passes the
     timestamp at which the successful call *started* (`evidenceFrom`), and
     a record written at or after that moment survives the clear, since a
     long call that authenticated before the token expired proves nothing
     about the credential's current state;
  2. a credential-carrying provider-config write through the setup API
     (`setSetupProvider`) for that provider — this covers the Add Provider
     key form, key rotation via the Settings Edit dialog, `set_provider`
     self-tool writes that carry an `apiKey`, the bedrock re-save ONLY when a new
     access key + secret pair is entered (gated on `hasNewPair`, mirroring the
     env-keyed `&& apiKey`: a keyless model/region edit proves nothing about the
     credential, since `hasUsableAwsCredentials` checks presence not validity),
     and the codex setup **Verify**, which requires credentials to be present AND not
     provably expired (the locally-decoded JWT `exp`; api_key-shaped and
     exp-unknown credentials stay presence-only). Writes that carry no
     credential evidence never clear: for env-keyed providers a keyless
     model/baseUrl-only save (the Edit dialog with the key field left blank)
     leaves the record, the default-model selection endpoint
     (`setDefaultModel`) always opts out (`clearAuthFailureOnSuccess:
     false`), and the `set_provider` self-tool opts out whenever its payload
     carries no `apiKey` — a model/transport-only write proves nothing about
     the credential;
  3. provider removal (`removeSetupProvider`) — a removed provider must not
     resurface a stale record when re-added.
- **Exposure.** `GET /api/providers/catalog` enriches each row with
  `authStatus: "ok" | "needs_reauth"` plus, when flagged, a `reauth` payload
  `{ detail, at, reauthKind, reauthUrl }` (`withProviderAuthStatus`,
  `src/provider.ts`) — the same `providerReauth` routing the chat note
  carries, derived at read time. Settings → Providers renders needs-reauth
  rows with an amber "Needs re-authentication" status, the redacted detail,
  and a kind-routed CTA (docs slide-over for `docs`, the row's key-edit
  dialog for `settings`, an "Update credentials" button that opens the same
  Edit dialog for `aws`); the
  `provider.auth.*` events invalidate the web `providers` query through the
  runtime stream so an open Settings page updates live.
- **Connector-probe honesty.** The codex connector probe
  (`src/integrations/connectors/codex.ts`) resolves credentials through the
  provider's own reader (`probeCodexCredentials`, honoring `CODEX_AUTH_JSON`)
  instead of a bare `existsSync(~/.codex/auth.json)`, and decodes the OAuth
  access token's JWT `exp` claim locally: an expired token probes unhealthy
  with the expiry time and a `codex login` instruction. The probe makes no
  network calls; an unparseable token means "expiry unknown", not unhealthy,
  and `OPENAI_API_KEY`-shaped credentials stay presence-only (no exp to
  read). A read that races the codex CLI's non-atomic auth.json rewrite
  (flagged `transient` by the credential reader) is retried once after the
  same rewrite-settle delay the chat path uses, so a re-probe landing inside
  the rewrite window never flips an authenticated install unhealthy.

## Context

Provider auth fails mid-chat (an expired Codex OAuth token, a revoked or
quota-exhausted API key). The original failure note passed the raw provider
message through verbatim as a muted line — no provider name, no entry point.
"Please try signing in again" with no provider and no destination leaves the
user guessing (issue #205).

The two provider classes need different help, so a single uniform doc is the
wrong shape:

- **API-key providers** already return a *specific* cause in their 401/403 body
  — "incorrect API key", "you exceeded your quota", "this key has been
  disabled". A static doc can't say which happened; the API response can. The
  fix is always the same single action: paste a new key into Settings →
  Providers. So these need no doc and no step-through — surface the provider's
  verbatim message as the cause and link straight to the form.
- **OAuth/CLI providers (codex)** fail with a message that says *nothing* about
  how to recover, and there is no in-app form — re-auth is a non-obvious
  terminal flow (`codex logout` → `codex login` → sign in). This is the only
  case that needs a written step-through.

Re-auth instructions must not live in code: a step list duplicated in a React
component and a docs page will drift. Keeping the prose in hosted docs (a single
source) and deriving only the routing from the catalog's existing `auth` field
avoids that entirely.

## Consequences

- Adding a new API-key provider needs no re-auth doc — the catalog `auth: "env"`
  routes its CTA to Settings, and its own error text carries the cause.
- Adding a new OAuth/CLI provider means adding a `docs/providers/<id>.md` with a
  `## Re-authentication` section; the URL is derived by convention
  (`/providers/<id>#re-authentication`, the heading's natural slug), so no per-provider routing data is added.
- The runtime owns `reauthUrl`, so clients stay dumb. The hosted-docs base URL
  is a constant in `src/provider.ts`. The web client derives the inline doc path
  from that URL (ADR in-app-doc-references.md); the runtime contract is
  unchanged.

### Acceptance checks

- A chat turn that fails on an expired Codex token renders a note naming Codex
  with a CTA carrying `…/docs/providers/codex#re-authentication`; clicking it
  opens that section inline (ADR in-app-doc-references.md) with an Open full
  docs ↗ escape hatch.
- A chat turn that fails on a rejected API key names the provider, shows the
  provider's own message as the detail, and links to `/settings`.
- A non-auth failure renders the raw message unchanged (no `authError`).
- Text-only clients (CLI/messaging) receive the same actionable line, not the
  raw provider error.
- After a `ProviderAuthError` task failure, `/api/providers/catalog` reports
  `authStatus: "needs_reauth"` for that provider and Settings → Providers
  shows the amber state with the redacted detail and kind-routed CTA — until
  a successful provider call, a credential-carrying setup-API config write
  for that provider, or its removal clears it. A keyless model/baseUrl-only
  save, a default-model pick, or a keyless `set_provider` patch leaves the
  amber state in place.
- With an expired-`exp` access token in the codex auth file, the codex
  connector probe reports unhealthy naming the expiry time and `codex login`,
  without any network call, and the setup **Verify** fails with the same
  expiry-naming error instead of clearing the record; a valid or unparseable
  token keeps the presence-based result.

## Related

- [Connector + Provider Vocabulary, Spec Compliance, And Meta-Skills](connector-provider-spec-compliance.md)
- [Authorization vs SetupRequest](authorization-vs-setup-request.md)
- [Chat Block Protocol](chat-block-protocol.md)
- [In-App Doc References Render Inline](in-app-doc-references.md)
