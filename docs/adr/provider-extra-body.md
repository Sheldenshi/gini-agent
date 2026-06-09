# Provider extraBody Escape Hatch and Reserved-Key Denylist

## Decision

`ProviderConfig` carries an optional `extraBody?: Record<string, unknown>` that the runtime merges into the chat-completions request bodies it builds. The `local`, `openrouter`, `deepseek`, and `azure` providers route every call (tool-calling, structured, vision, and the summary) through chat-completions, so `extraBody` applies to all of them. The `openai` provider uses `/responses` for `generateTaskSummary`, so its `extraBody` applies on the tool-calling, structured, and vision calls but not the summary. The `anthropic` provider merges `extraBody` into its native Messages request body too (and reads `extraBody.max_tokens` as a budget override). A reserved-key denylist guards the merge so user-supplied extras can never override fields the runtime owns. The `bedrock` provider speaks the Converse API, which has no chat-completions body to merge into; it reads only `extraBody.max_tokens` (applied as the Converse `inferenceConfig.maxTokens` budget) and forwards no other `extraBody` key. Codex (`/responses`) and echo ignore `extraBody` entirely.

The CLI surfaces three new flags on `gini provider set`: `--base-url`, `--api-key-env`, `--extra-body`. They write directly into the persisted instance config. No HTTP/BFF surface for `extraBody` ships in this iteration; that is deferred.

`extraBody` is non-secret transport config. It flows through `providerHealth`, `/api/status`, and trace records. Bearer tokens belong in env vars referenced by `apiKeyEnv`, never in `extraBody`.

## Context

Hosting an OpenAI-compatible local model (oMLX serving Gemma in our case, but the same pattern applies to vLLM, LM Studio, llama.cpp) requires sending server-specific request fields the OpenAI spec doesn't describe. Concretely, oMLX-served Gemma needs `chat_template_kwargs` to control reasoning behavior (`enable_thinking: true`, `preserve_thinking: false`). Without those keys, thinking tokens leak into the response or reasoning is silently disabled.

The existing `local` provider already speaks chat-completions, structured JSON, vision, and tool calling against a configurable `baseUrl` — it was the only OpenAI-compatible code path that handled streaming SSE, function-calling argument deltas, and the `image_url` content shape. The single missing piece was a way to attach arbitrary provider-specific request fields without forking the call sites. `extraBody` closes that gap with one tiny abstraction instead of one per knob.

The CLI flags exist because the alternative — hand-editing `~/.gini/instances/<name>/config.json` — is hostile to scripting, autostart respawn, and remote control surfaces. `gini provider set local <model> --base-url X --api-key-env Y --extra-body '{...}'` is the same shape every other `gini provider set` invocation already uses.

## Reserved-Key Denylist

`sanitizeExtraBody()` strips a fixed set of keys before the spread so a poisoned config (or a careless `--extra-body` argument) cannot redirect the call, smuggle tools, alter response parsing, or change data-retention semantics:

- `model`, `messages`, `stream` — runtime owns these unconditionally.
- `tools`, `tool_choice` — runtime computes from the active toolset; an extraBody-supplied entry would survive the iteration-cap summary turn (where the caller passes empty tools) and let the model emit unauthorized tool calls.
- `response_format` — structured calls set this; chat-completions calls must not enable JSON mode through extraBody (it would break streaming and tool calls).
- `functions`, `function_call` — deprecated OpenAI legacy function-calling. The runtime ignores `message.function_call` in responses, so a poisoned extraBody using the legacy schema would silently drop function results.
- `store` — controls server-side retention of the completion. The `/responses` path pins `store: false` explicitly; chat-completions paths must stay consistent.
- `__proto__`, `constructor`, `prototype` — JSON-loaded objects can carry these as own enumerable keys; without an explicit drop the spread would forward them to the API.
- `toJSON` — defense-in-depth against a future internal caller constructing `ProviderConfig` programmatically with a callable `toJSON` that would replace the request body wholesale at `JSON.stringify` time.

Vision passes an additional per-call denylist (`max_tokens`, `max_completion_tokens`) so neither budget field can leak through alongside the runtime-set one — OpenAI's o-series rejects requests carrying both, and other gateways would silently take the larger of the two and defeat the cap. Non-vision callers (chat, structured, tool-calling, summary) leave these keys allowed so users can legitimately set their own budget via `extraBody`.

The Anthropic Messages builder passes its own per-call denylist (`system`) through the same mechanism: the runtime hoists every system message into the top-level `system` field, so a stray `extraBody.system` must not shadow it — nor silently become it on a turn that carries no system message. `system` stays out of the base `RESERVED_EXTRA_BODY_KEYS` because it is not a top-level field on the OpenAI chat-completions wire shape (there the system prompt is a normal message).

OpenRouter routing fields (`provider`, `models`, `route`, `transforms`) are intentionally NOT in the denylist. Selecting which underlying provider routes a request is the entire point of OpenRouter; locking that out would force users into OpenRouter's default routing.

## Reserved-Key Maintenance Rule

When you add a runtime-owned request field anywhere in `src/provider.ts`, add it to the relevant denylist — a chat-completions field to `RESERVED_EXTRA_BODY_KEYS`, or a Messages-API field (like `system`) to the anthropic per-call denylist (`ANTHROPIC_RESERVED_EXTRA_BODY_KEYS`). The denylist is the single source of truth — if a maintainer adds a new field but forgets the denylist entry, the protection silently weakens. This rule is also documented inline above each constant.

## Agent Override Inheritance

`AgentRecord` stores only `providerName` and `model`. `resolveEffectiveContext()` in `src/execution/effective-context.ts` decides whether an agent's override inherits the instance's transport config (`baseUrl`, `apiKeyEnv`, `extraBody`) by comparing `agent.providerName` to `config.provider.name`:

- **Same-provider override** (agent overrides to the same provider family as the instance): the resolver spreads `config.provider` first and overwrites only `name` + `model`. Local-only transport (e.g. an `oMLX` base URL + `chat_template_kwargs` `extraBody`) is preserved across model swaps so an operator can keep their existing endpoint when swapping models on the same agent.
- **Cross-provider override** (agent overrides to a different provider family): the resolver does NOT spread `config.provider`. Instead `normalizeProvider` supplies the per-provider defaults for `baseUrl` and `apiKeyEnv`, and `extraBody` defaults to undefined. Local-only fields like `chat_template_kwargs` therefore stay on the local instance and never leak into an OpenAI / OpenRouter call.

This is the load-bearing invariant for the openclaw migration path (`docs/adr/openclaw-migration.md`): a migrated openrouter agent on an openai instance won't accidentally inherit the openai endpoint or auth env. Tests pin both branches in `src/execution/effective-context.test.ts` ("cross-provider agent override does not inherit instance baseUrl/apiKeyEnv" + "same-provider agent override still inherits instance baseUrl/apiKeyEnv").

## Security Boundary

`extraBody` is a CLI-only surface in this iteration. The `gini provider set` command is local, authenticated by file-system access to `~/.gini/instances/<inst>/config.json`. There is no HTTP route to mutate `extraBody`. A future `/api/providers/*` extension is plausible but explicitly out of scope here.

`--api-key-env` plus `--base-url` together form a deliberate power-user feature: they let an operator point a local provider at any HTTP endpoint and bind any env var as the bearer source. A malicious local actor with write access to the instance config can use this to exfiltrate environment variables to an attacker-controlled URL on the next call. This is consistent with the CLI's existing security model (anyone who can write `~/.gini/instances/...` can already redirect the runtime). It is documented here so future hardening discussions have a starting point.

## Test Surface

Three test layers cover the change:

- `src/provider.test.ts` — fetch-mock unit tests for the merge behavior, denylist, override semantics, vision token-cap protection, baseUrl normalization, and prototype-pollution defense.
- `src/provider.integration.test.ts` — real HTTP round-trips against the bundled mock server in `src/test-utils/openai-mock-server.ts`. Each test creates its own server and env scope inside `withMockServer()`, so the file is safe under `bun test --concurrent`.
- `src/cli/commands/provider.test.ts` — CLI flag-parsing, malformed input rejection, and the warning surface for unsupported provider+flag combinations.

The mock server in `src/test-utils/openai-mock-server.ts` is bundled so anyone cloning the repo can run integration tests with no API keys, no model downloads, and no native bindings — `bun install` is the only prerequisite.

## Out Of Scope, Linked Follow-Ups

- `/api/providers/*` HTTP route to mutate `extraBody` from the web UI.
- Full `AgentRecord` transport config (currently inherits — see "Agent Override Inheritance" above).
- Runtime validation of persisted `extraBody` values (the CLI parses; future API writers must match).
- `docs/operations.md` updates for the new `local` provider flags. (`README.md` was updated in this PR with a new "OpenAI-compatible local servers" section linking back here; `docs/operations.md` still documents only the original Codex/OpenAI setup.)
- A `--` option-terminator convention for `parseSubArgs()` so users can pass dash-prefixed positional values.

## Consequences

- The `local` provider is now a first-class transport for OpenAI-compatible servers (oMLX, vLLM, LM Studio, llama.cpp). The studio deployment runs gini against oMLX-served Gemma with `chat_template_kwargs` reasoning control end-to-end.
- The denylist is the security boundary for chat-completions request bodies. Future runtime fields must extend it.
- `parseSubArgs()` (added in `src/cli/args.ts`) is now available for any other command that needs strict positionals + value-bearing flags. The provider command is the first user.
- The mock server in `src/test-utils/` establishes a convention for HTTP-level integration tests in this codebase. Future modules that speak HTTP can reuse the pattern.
