# ADR: Pinned in_memory prompt-cache tier, no active warming

- **Status:** Accepted
- **See also:** [Stable System Prefix For Chat Prompt Caching](./stable-system-prefix.md), [Provider Extra Body](./provider-extra-body.md)

## Decision

Gini relies on the provider's **automatic** prompt caching and pins the
**in_memory** retention tier on its requests. It runs **no active cache
warmer or refresh** — there is no background loop, probe, config field, HTTP
endpoint, CLI command, or web control for keeping the cache warm.

1. **Hardcoded `prompt_cache_retention: "in_memory"`** on every
   OpenAI-compatible request body in `packages/runtime/src/provider.ts`
   (`callToolCallingChatCompletions`, `callStructuredChatCompletions`,
   `callOpenAIResponses` openai branch, `callChatCompletions`,
   `callVisionChatCompletions`) via the `promptCacheRetentionBody` helper. Two
   providers are excluded: the codex `/responses` builders deliberately omit the
   field because the chatgpt.com backend rejects it with HTTP 400, and the
   **azure** provider omits it because Azure's gpt-5.x deployments reject
   `in_memory` with "This model is compatible only with 24h extended prompt
   caching". Azure manages prompt caching at the resource level, so the helper
   returns no field for it (see ADR azure-provider.md).

2. **No active warming.** Provider-side prompt caching is automatic for
   prompts at or above the provider's minimum size, and the cache is refreshed
   for free every time a cached prefix is reused. A back-to-back conversation
   therefore keeps its own prefix warm with no help from the runtime. The
   only thing an active warmer could add is bridging an idle gap longer than
   the in-memory inactivity window — and the probe cost of doing that around
   the clock (the previous design) is not worth the narrow benefit, so the
   runtime does nothing here on purpose.

## Context

Prompt caching serves a matched request prefix at a fraction of the base
input rate; a miss re-prefills the entire prompt at full rate. The relevant
documented facts:

- **OpenAI** prompt caching is automatic: "Caching is enabled automatically
  for prompts that are 1024 tokens or longer"; "For requests under 1024
  tokens, `cached_tokens` will be zero." The in-memory policy keeps "cached
  prefixes generally remain active for 5 to 10 minutes of inactivity, up to a
  maximum of one hour," holds nothing at rest, and is the default for
  zero-data-retention (ZDR) orgs. The `24h` extended policy offloads
  key/value tensors to storage and is **not** the no-data-retention path.
  Source: <https://developers.openai.com/api/docs/guides/prompt-caching>.
- **Anthropic** prompt caching offers a 5-minute default and a 1-hour
  extended (`ttl: "1h"`) cache duration, both ZDR-eligible. Source:
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>.

Gini pins `prompt_cache_retention: "in_memory"` on the request body for the
OpenAI-compatible providers (`openai`, `openrouter`, `deepseek`, `local`);
`codex` and `azure` omit the field — codex because its ChatGPT backend rejects
it, azure because its gpt-5.x deployments require the `24h` tier and 400 on
`in_memory` (see the Decision above). Sending the field is not the same as the
backend caching on it: only `openai` (via that pinned tier) and `codex` (via its
own server-side prefix caching) are known to actually cache. On `openrouter`, `deepseek`, and
`local` the field is an accept-but-ignore no-op, so the request shape
guarantees no backend caching there. OpenRouter-routed Claude is a notable
case: Anthropic's native caching keys on `cache_control` markers Gini does not
emit, so the OpenAI in-memory window does not automatically apply — that would
need a future direct Anthropic Messages API provider.

### Why pin in_memory rather than leave it implicit

OpenAI documents `in_memory` as the default when the field is omitted **for
ZDR orgs**, but a non-ZDR org defaults to `24h`. Emitting `in_memory`
explicitly keeps Gini traffic on the ZDR-aligned tier regardless of org
posture, and prevents a future server-side default change from quietly
promoting Gini to the extended-retention tier. On `openrouter`, `deepseek`,
and `local` the field is an accept-but-ignore no-op; `codex` and `azure` are
the two exclusions — codex's backend 400s on it, and Azure's gpt-5.x
deployments reject `in_memory` outright (they require the `24h` tier), so Azure
is left to its resource-level caching.

### Why no active warmer

An earlier iteration shipped an operator-tuned warmer that fired a probe
against the active provider on a fixed cadence, around the clock, regardless
of whether anyone was chatting. That constant probing was a real cost with a
narrow payoff: the in-memory cache is refreshed for free by ordinary turns,
so the only gap a warmer fills is an idle stretch longer than the inactivity
window but shorter than the max retention. Paying probe cost on every session
(including abandoned ones) to win that narrow case is not worth it, so the
warmer was removed rather than reworked.

## Consequences

- **Cache behavior.** Consecutive turns within the in-memory inactivity
  window cache-hit on the shared prefix; a longer idle gap re-prefills on the
  next turn. The runtime does not attempt to prevent that re-prefill.
- **Dependency on a byte-stable prefix.** The pinned tier only pays off when
  the chat turn's prompt prefix is byte-stable across turns — automatic prefix
  caching hashes the leading bytes. That byte-stability is established in ADR
  stable-system-prefix.md.
- **Defense in depth via the extraBody denylist.** Per
  [provider-extra-body.md](provider-extra-body.md),
  `prompt_cache_retention` is in `RESERVED_EXTRA_BODY_KEYS`, so a poisoned
  `extraBody.prompt_cache_retention: "24h"` is stripped before the runtime
  spreads its own `"in_memory"` value.
- **Zero operator surface.** No config field, endpoint, CLI command, or web
  card relates to caching; the only knob is the active provider.

## Acceptance checks

- Every OpenAI-compatible builder in `packages/runtime/src/provider.ts` emits
  `prompt_cache_retention: "in_memory"` via `promptCacheRetentionBody`, except
  the two documented exclusions: codex `/responses` builders and the `azure`
  provider both omit the field.
- `prompt_cache_retention` is in `RESERVED_EXTRA_BODY_KEYS`.
- No cache warmer / refresh loop runs in `packages/runtime/src/server.ts`, and no
  `/api/settings/cache-warmer` endpoint, `gini cache-warmer` command,
  `cacheWarmerMinutes` config field, or cache-warmer web card exists.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.

## Critical files

- `packages/runtime/src/provider.ts` — the pinned `in_memory` tier and the
  `RESERVED_EXTRA_BODY_KEYS` denylist.
- `packages/runtime/src/provider.test.ts` — pins the `in_memory` value on each builder and the
  codex omission, and demonstrates that no Anthropic `cache_control` markers
  are emitted.
