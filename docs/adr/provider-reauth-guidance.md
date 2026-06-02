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
| API-key (openai, deepseek, openrouter, local) | `env` | In-app **Settings → Providers** key form (`/settings`) | The provider's own 401/403 message (shown as the note's detail) — no doc |

The runtime classifies the failure, tags it with the provider that served the
turn, and stamps the chat block so every client renders the same thing:

- `ProviderAuthError` is thrown at the provider-call sites (`src/execution/chat-task.ts`
  — both the main loop call and the iteration-cap summary call), carrying the
  provider from the effective context — accurate even if the active agent
  changed while the call was in flight.
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
  terminal flow (`codex` → `/logout` → `codex` → sign in). This is the only case
  that needs a written step-through.

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

## Related

- [Connector + Provider Vocabulary, Spec Compliance, And Meta-Skills](connector-provider-spec-compliance.md)
- [Authorization vs SetupRequest](authorization-vs-setup-request.md)
- [Chat Block Protocol](chat-block-protocol.md)
- [In-App Doc References Render Inline](in-app-doc-references.md)
