# Codex Session-Rotation Retry, UA Mirroring, and auth.json Race Handling

## Decision

Gini speaks to the Codex `/responses` backend by:

1. **Mirroring the upstream Codex CLI's request shape exactly.** The `User-Agent` and `originator` headers are byte-for-byte the same as the codex CLI's own emission — no daemon-identifying suffix. Drop fingerprintable identifiers; do not append `(Gini Agent)` or similar tags.
2. **Re-reading `~/.codex/auth.json` on every request.** `readCodexBearer` opens the file each call so a token rotation written by the codex CLI's refresh path is picked up automatically by the next attempt, with no in-process cache to invalidate.
3. **Retrying once on session-shaped failures.** `withCodexSessionRetry` wraps every Codex request path. On `CodexSessionExpiredError` (backend 401 or SSE `error` / `response.failed` matching the session-expired classifier) or `CodexAuthRaceError` (local `readCodexBearer` observed a mid-rewrite `auth.json`), the helper sleeps `CODEX_RETRY_REWRITE_DELAY_MS` (50 ms) and reruns the request once. On a second consecutive failure, a `CodexAuthRaceError` is converted to `ProviderAuthError("codex")` — a persistently unreadable or corrupt `auth.json` is a credential problem, not a mid-write race — while a second `CodexSessionExpiredError` surfaces unchanged (its backend message already matches `isAuthExpiredError` downstream); see ADR provider-reauth-guidance.md.
4. **Gating retry on caller visibility.** The two SSE readers track an `emittedToCaller` boolean flipped only when `onDelta` actually fires. Internal buffers (text accumulation, tool-call argument deltas, `response.completed` backstop) do NOT count — a session expired before any bytes reach the caller is safely retryable; once `onDelta` fires, the retry path falls through to the generic error so we don't double-deliver.
5. **Canceling the reader on every exit.** Both SSE consumption loops wrap in `try { … } finally { reader.cancel().catch(() => {}) }` so a throw from mid-stream classification cannot leave attempt 1's reader locked while withCodexSessionRetry starts attempt 2.

The retry contract applies to all four Codex call paths uniformly: `callToolCallingResponses`, `callStructuredCodex`, the `callOpenAIResponses` codex branch (text summary / single-turn responses), and `callVisionCodex`.

## Context

Codex `/responses` is gated on a ChatGPT account session token written to `~/.codex/auth.json` by the upstream codex CLI's OAuth flow. The CLI rotates that token out-of-band — a refresh-token exchange can fire while a Gini request is in flight, or between two of Gini's requests. Three distinct failure modes follow:

- **Backend session-expired**: the token Gini sent was valid when the connection opened but the backend invalidated it before the response completed. Surfaces as either an initial 401 with `{"error":{"message":"...session expired..."}}`, an SSE `error` event mid-stream, or a `response.failed` event whose `incomplete_details.reason` carries a snake_case enum like `session_expired` or `token_expired`.
- **Stale-token initial 401**: Gini read `auth.json` before the CLI's refresh landed, so attempt 1 sends an already-rotated token and gets `401 Unauthorized: access token expired` before the stream even opens.
- **Auth.json read race**: the codex CLI writes `auth.json` non-atomically (truncate + write + flush, no temp-file + rename — see `codex-rs/login/src/auth/storage.rs` `FileAuthStorage::save`). A reader observing the file between the truncate and the flush sees an empty or partial JSON document and `JSON.parse` throws.

The retry helper unifies recovery for all three: re-read `auth.json` after a small wait, then retry exactly once. The wait kills the rewrite race window; the re-read catches both backend-driven and local rotations; the cap-at-one prevents a hot loop when the CLI is offline or the backend keeps rejecting the token. Steady-state credential absence never enters the retry at all: `auth.json` missing (the post-`codex logout` state) or present without `OPENAI_API_KEY` / `tokens.access_token` makes `readCodexBearer` throw `ProviderAuthError("codex")` before any request is made.

The retry's correctness depends on two invariants:

- **No double-delivery to the caller.** Attempt 2's response replaces attempt 1's; if attempt 1 had already pushed bytes via `onDelta`, attempt 2 would re-stream them as duplicates. The `emittedToCaller` boolean is the gate — flipped exactly when `onDelta(delta)` is invoked, checked at the session-expired throw branch.
- **No socket leak across the retry.** Attempt 1's reader stays locked to its response body until cancelled. Without explicit cleanup, throwing out of the SSE loop and immediately constructing a new `fetch` for attempt 2 leaves the first socket open. Both readers wrap their consume loop in `try { … } finally { reader.cancel().catch(() => {}) }`.

## Why Mirror the Codex CLI's Headers

Earlier iterations of `codexHeaders` carried `User-Agent: codex_cli_rs/0.0.0 (Gini Agent)`. The parenthetical suffix made Gini's traffic trivially distinguishable from real interactive use of the codex CLI by the same ChatGPT account — and OpenAI's backend can fingerprint that tail and selectively 401 it while leaving the CLI alone. That selective-401 is the exact failure mode the retry path was added to recover from. Drop the suffix.

The trade-off: we lose the ability to identify Gini traffic in OpenAI's audit logs by UA. We don't owe Gini-specific attribution to that surface — Gini is authenticating with the user's own ChatGPT session token via a personal-use auth flow that has no programmatic-access contract for daemons. The `ChatGPT-Account-ID` header derived from the JWT still carries the user's account identity for any audit case OpenAI cares about.

The `originator` header (`codex_cli_rs`) is unchanged and the version placeholder is pinned to the same value the codex CLI shipped with at the time we copied this shape. If upstream drifts enough that the backend starts rejecting our pinned version, bump the constant in `codexHeaders`.

## Why a 50 ms Pre-Retry Delay

The codex CLI's non-atomic rewrite of `auth.json` typically completes in microseconds. The 50 ms wait is two-to-three orders of magnitude longer than the writer's window, so retry observes a flushed file with overwhelming probability. The cost is negligible — the user only pays 50 ms when a retry was already going to fire, never on the happy path — and the alternative (a long-running parse-retry loop inside `readCodexCredentials`) would muddle the read API and propagate async-ness through every caller.

50 ms is also short enough that the chat-task layer's existing status-flip cancellation model doesn't materially suffer: a user cancel during the delay still results in a wasted attempt-2 request (no `AbortSignal` is plumbed through the provider pipeline today), but the chat-task loop's post-await terminal-status re-check drops the result. Wiring full `AbortSignal` propagation through the provider layer is out of scope for this ADR.

## Why CodexAuthRaceError Is Separate From CodexSessionExpiredError

Both classes funnel into the same retry path, but they describe different failures:

- `CodexSessionExpiredError` — the backend rejected the token. The token Gini holds is real but invalidated upstream.
- `CodexAuthRaceError` — Gini couldn't read the token. The local file is mid-rewrite and `JSON.parse` failed.

Conflating them under one class would force readers to inspect the message to know what actually happened; keeping them distinct lets future code (logging, metrics, alternative recovery paths) treat them separately without re-parsing. The retry helper catches both with one `instanceof` check apiece — the retry trigger is shared, but the second-failure handling diverges by class (the race error converts to a typed credential failure, the expired error surfaces unchanged; see item 3 of the Decision).

## Session-Expired Classifier

`CODEX_SESSION_EXPIRED_RE` matches the bodies/reasons the backend actually emits:

```
/session[_\s-]+expired|expired[_\s-]+session|invalid[_\s-]?(?:access[_\s-]?)?token|token[_\s-]+expired|unauthorized/i
```

The `[_\s-]+` separator class accepts whitespace, underscores, and hyphens so both human-readable (`"session expired"`) and enum-coded (`"session_expired"`, `"token_expired"`) forms match. Bare `unauthorized` is included because real-world Codex 401 bodies frequently use that phrasing; it is always gated by an explicit `response.status === 401` check at the call site, so a 403/500/quota error with `unauthorized` somewhere in its message body cannot accidentally trigger a retry.

## Test Surface

Retry behavior is pinned in `src/provider.test.ts`:

- Tool-calling path: SSE error event, post-`onDelta` no-retry, buffered text without `onDelta` (retries), buffered tool-call args (retries), initial 401, no-retry on generic 500, `response.failed` event, snake_case `incomplete_details.reason`, retry cap, 50 ms wait, reader cancellation, bearer rotation across attempts, auth.json mid-rewrite race.
- Per-path coverage: `generateTaskSummary`, `generateStructured`, and `generateVisionAnalysis` each have their own retry test exercising the `callOpenAIResponses` codex branch, `callStructuredCodex`, and `callVisionCodex` respectively.
- Local credential failures (typed, no retry entry): missing `auth.json` surfaces as `ProviderAuthError` with zero network calls; wrong-shape `auth.json` (no `OPENAI_API_KEY` / `tokens.access_token`) surfaces as `ProviderAuthError` with zero network calls; persistently corrupt `auth.json` fails typed as `ProviderAuthError` after exactly one 50 ms retry.
- Header pinning: `codex_cli_rs/0.0.0` User-Agent and `codex_cli_rs` originator are asserted with a regression guard that fails if a Gini-identifying suffix re-appears.

## Out Of Scope

- **AbortSignal plumbing.** Cancellation currently rides on chat-task status flips; provider-layer signal propagation is a separate, larger change.
- **Multi-retry strategy.** A second consecutive session-expired usually means the CLI hasn't yet refreshed; looping further would burn quota without helping. The fixed cap-at-one stays.
- **Caching the parsed `auth.json`.** Every request re-reads. Caching would require an invalidation surface; the cost is one `readFileSync` per request, which is negligible compared to the model call.
- **ADR for the chat-task post-await cancellation model.** That contract lives in `src/execution/chat-task.ts` comments today; promoting it to an ADR is independent of this one.

## Consequences

- All four codex call paths get session-rotation recovery uniformly — a feature added here is automatically available to tool calling, structured output, text summary, and vision.
- The selective-401 fingerprinting failure mode is closed by the UA mirror. If OpenAI ever bumps the codex CLI's UA in a way that affects backend acceptance, update the pinned version in `codexHeaders`.
- The retry path's correctness invariants (`emittedToCaller`, `reader.cancel()`) are load-bearing — any new SSE event handling in the readers must keep them honest. The classifier regex and the `withCodexSessionRetry` helper are single points of truth; widening retry semantics requires changes only there.
- `CodexAuthRaceError` is the supported escape hatch for transient local read failures. Future code that bypasses `readCodexBearer` (e.g. a direct `readCodexCredentials` call) must either thread the same error class or accept that mid-rewrite reads will surface as permanent failures.
