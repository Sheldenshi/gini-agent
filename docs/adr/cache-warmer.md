# ADR: Cache warmer and the in_memory prompt cache default

## Decision

Two complementary mechanisms keep OpenAI's prompt cache useful for chat
turns without exposing operators to the extended-retention tier:

1. **Cache warmer**, a single integer of state
   (`RuntimeConfig.cacheWarmerMinutes?: number`, bounded `0..1440`) and a
   gateway-resident background loop. When the value is `> 0` the loop
   sleeps for `cacheWarmerMinutes × 0.9 × 60` seconds, then fires
   `generateTaskSummary(config, " ")` against the active provider. The
   `0.9` factor lands the probe before the documented `in_memory` idle
   TTL elapses; reusing `generateTaskSummary` guarantees the probe's
   wire prefix (model + identity-file system context) matches real chat
   turns, which is what makes them cache-hit. Probes never run when
   `cacheWarmerMinutes` is `0` or `undefined`. The loop reads the value
   on every iteration, so a `POST /api/settings/cache-warmer` takes
   effect on the next tick — no pub/sub, no restart.

2. **Hardcoded `prompt_cache_retention: "in_memory"`** on every
   OpenAI-compatible request body in `src/provider.ts`
   (`callToolCallingChatCompletions`, `callStructuredChatCompletions`,
   `callOpenAIResponses` openai branch, `callChatCompletions`,
   `callVisionChatCompletions`). The four codex `/responses` builders
   deliberately omit the field because the chatgpt.com backend rejects
   it with HTTP 400.

Surfaces:

- `GET /api/settings/cache-warmer` returns `{ minutes: number }`.
- `POST /api/settings/cache-warmer` validates an integer payload in
  `[0, 1440]` and persists `cacheWarmerMinutes` to `config.json`. `0`
  stores `undefined` (clean disk state for the disabled case).
- `gini cache-warmer [set <minutes>]` (alias `gini warmer`) posts to
  the gateway so changes propagate to the in-memory config the loop
  reads. Direct `config.json` writes are deliberately avoided so the
  CLI can never desync from the running gateway.
- `web/src/app/settings/_components/CacheWarmerCard.tsx` is the single
  slider card on `/settings`. It is model-agnostic by intent — the
  warmer keeps every supported provider's cache hot, not just OpenAI.

## Context

OpenAI's prompt cache works by hashing the prefix of an incoming
request against recent prefixes. A hit serves the matched portion at
10% of the base input rate; a miss re-prefills the entire prompt at
full rate. OpenAI documents two retention tiers:

- `in_memory` (default): hot for 5–10 minutes of idle, up to one hour
  of last use.
- `24h` (extended): persists derived cache data up to 24 hours. **Not
  Zero Data Retention eligible.**

Idle eviction inside a single user session matters in practice: a chat
where the operator goes to lunch will lose its cache and pay the full
re-prefill cost on return. Empirical measurement against the live API
showed eviction between 12 minutes (still hot, 12,032 cached) and
65 minutes (`cached_tokens=0`).

A naive fix is to opt every request into the `24h` tier, but that
silently disqualifies operators from ZDR-aligned posture and changes
the data-retention contract OpenAI offers. A second naive fix is to
expose `promptCacheRetention` as a per-provider knob, which was tried
in an earlier iteration of this work and was abandoned: the surface
area (config field, CLI flag, web UI, preservation across rebuilds,
disk-source-of-truth resolution, codex 400 caveat) was disproportionate
to the value, and operators had to make a per-provider judgment call
on a setting whose safe default is "no change."

The cache warmer sidesteps both problems. It keeps the default tier
(`in_memory`) and adds an explicit operator-configured probe cadence
that prevents idle eviction within the tier the docs already cover.

## Consequences

**Operational shape.** The warmer adds one new gateway loop alongside
the existing scheduler / reprobe / telegram / discord supervisor
loops. It reads `config.cacheWarmerMinutes` on every iteration so the
HTTP and CLI surfaces take effect immediately without restart. SIGTERM
sets `cacheWarmerStopped = true` and the loop joins the existing
shutdown drain. Disabling mid-flight does not interrupt an in-flight
`Bun.sleep` — the next iteration reads `0` and switches to the 30-second
idle-poll. In practice a setWarmer(0) call may produce one extra probe
if the loop was inside an active sleep at the time; this is documented
behavior, not a bug.

**Wire defaults.** Every OpenAI-compatible chat-completions body and
the openai `/responses` summary body now carries
`prompt_cache_retention: "in_memory"` unconditionally. OpenAI
documents that the `in_memory` tier is the default when the field is
omitted, so emitting it explicitly is functionally a no-op against
OpenAI today — but it makes the intent visible to maintainers and
prevents a future server-side default change from quietly promoting
gini traffic to the `24h` tier. `openrouter`, `deepseek`, and `local`
accept-but-ignore unknown fields, so the value is harmless on those
backends. Codex `/responses` is the one explicit exclusion because the
chatgpt.com backend documents a 400 on the field.

**Defense in depth via the extraBody denylist.** Per the rule in
[provider-extra-body.md](provider-extra-body.md), every runtime-owned
chat-completions request field belongs in `RESERVED_EXTRA_BODY_KEYS`.
`prompt_cache_retention` is added there. A poisoned
`extraBody.prompt_cache_retention: "24h"` is stripped before the
runtime spreads its own `"in_memory"` value into the body, so the
protection holds even if a future refactor reorders the spread.

**Probe cost.** A probe is one call to `generateTaskSummary(config, " ")`,
which builds the same prompt prefix a real chat turn uses plus a
one-character user message. Output token count is whatever the model
chooses — the resolver does not set `max_tokens` because some
OpenAI-compatible providers reject the parameter. Empirically the
output runs in the single-digits-of-tokens range for `" "` input. Cost
scales linearly with probe frequency; the slider UI shows the operator
the chosen interval and the implied refresh cadence side-by-side so
they can tune it against their workload.

**No tests on the loop itself.** The setter validation and the probe's
dispatch are unit-tested (`src/runtime/cache-warmer.test.ts`). The loop
in `src/server.ts` is integration territory — exercised by the live
two-case test (warmer OFF for 65 min → `cached_tokens=0`; warmer ON at
4 min for 65 min → `cached_tokens=23,296`) but not pinned by a unit
test.

## Acceptance checks

- `RuntimeConfig.cacheWarmerMinutes` exists and is bounded `0..1440`
  by `setCacheWarmer`.
- Every OpenAI-compatible builder in `src/provider.ts` emits
  `prompt_cache_retention: "in_memory"`. Codex `/responses` builders
  do not.
- `prompt_cache_retention` is in `RESERVED_EXTRA_BODY_KEYS`.
- `GET` / `POST /api/settings/cache-warmer` round-trips.
- `gini cache-warmer set <minutes>` posts to the gateway and the loop
  picks up the new value on the next iteration without restart.
- The web slider card lives at
  `web/src/app/settings/_components/CacheWarmerCard.tsx` and renders
  on `/settings`.
