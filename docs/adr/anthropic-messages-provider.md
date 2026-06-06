# Native Anthropic Messages Provider (First-Party + Amazon Bedrock)

## Decision

Gini ships a first-class `anthropic` provider that speaks the Anthropic Messages API (`POST {baseUrl}/v1/messages`) natively, rather than routing Claude through the OpenAI-compatibility shim. One provider, one wire shape, serves two targets selected entirely by configuration:

- **First-party Claude API** — `baseUrl` defaults to `https://api.anthropic.com`, `apiKeyEnv` defaults to `ANTHROPIC_API_KEY` (a Console `sk-ant-…` key).
- **Claude in Amazon Bedrock** ("Bedrock Mantle") — `baseUrl` set to `https://bedrock-mantle.{region}.api.aws/anthropic` (the user includes the `/anthropic` path prefix), `apiKeyEnv` pointing at an env var holding a bearer token minted by `aws-bedrock-token-generator`.

Both targets authenticate with the token in the `x-api-key` header plus a pinned `anthropic-version: 2023-06-01`, and share an identical request/response body shape. Only the configured `baseUrl` and `apiKeyEnv` differ between them.

## Context

Every prior provider was either OpenAI chat-completions (`openai`, `openrouter`, `local`, `deepseek`) or the Codex `/responses` surface. None spoke the Anthropic Messages API, so Claude could only be reached indirectly. Two facts made a native provider the right call:

- Bedrock Mantle exposes Claude **only** at `/anthropic/v1/messages` (the Messages API). It does not offer an OpenAI-compatible `/chat/completions` endpoint, so the existing `openai`-style path could never target it.
- Anthropic's first-party OpenAI-compatibility layer exists but is explicitly positioned for testing, not production: it drops prompt caching and ignores the tool-use `strict` parameter. Building on it would inherit those limitations and still not reach Bedrock.

A single native Messages builder reaches both targets with full fidelity, and "configurable URL + auth token" is the mechanism that makes one provider cover both — the same lever that lets an operator test against a normal Claude API key today and a Bedrock bearer tomorrow without code changes.

## Wire Shape

`callAnthropicMessages` mirrors the structure of `callToolCallingChatCompletions` / `callToolCallingResponses`: it streams when an `onDelta` callback is present and parses the JSON body otherwise. The translation layer maps Gini's OpenAI-shaped tool-calling transcript onto the Messages API:

- **System hoist** — all `system` messages are concatenated into the top-level `system` field (the Messages API does not take a system message inside the `messages` array), exactly as the Codex path hoists to `instructions`.
- **Tool use** — assistant `tool_calls` become `tool_use` content blocks (`{type, id, name, input}`); `input` is the parsed arguments object. Tool definitions map to `{name, description, input_schema}` with `tool_choice: {type:"auto"}` when any tools are present.
- **Tool results** — consecutive `tool` messages are grouped into a single user message whose content begins with `tool_result` blocks, satisfying the API's ordering rule (tool_result blocks must lead and immediately follow the assistant tool_use turn).
- **Multimodal** — `image_url` data URLs become base64 `image` source blocks and `document` parts become base64 `document` source blocks. `anthropic` is registered as `vision: true, nativeDocs: true` in `resolveProviderModality`, so document parts survive `stripDocumentPartsIfUnsupported`.
- **max_tokens** — the Messages API requires it. The runtime pins a default (`DEFAULT_ANTHROPIC_MAX_TOKENS`), overridable via `extraBody.max_tokens`, with a small per-call override used by the vision path.
- **Streaming** — the SSE reader consumes the named-event protocol (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`), accumulating `input_json_delta` fragments per content-block index and mapping `stop_reason` to the loop's finish-reason vocabulary. `usage` (input + cumulative output tokens) flows straight into `estimateCost`, which already reads `input_tokens` / `output_tokens`.

Dispatch arms were added to `generateToolCallingResponse`, `generateTaskSummary`, `generateStructured` (via `callAnthropicStructured`, a prompt-for-JSON path since the Messages API has no `response_format`), and `generateVisionAnalysis`.

## Auth and Trust Boundary

The token lives in the env var named by `apiKeyEnv` and is read at call time into the `x-api-key` header — it is never placed in `baseUrl` or `extraBody` (both of which flow through `providerHealth` / `/api/status` / trace records as non-secret transport config). This preserves the existing boundary from `provider-extra-body.md`: secrets stay in env vars, transport config stays inspectable.

Browser configuration goes through the same server-side path as every other env-keyed provider: the Settings → Add Provider form POSTs the token to `/setup/provider`, which writes it to `~/.gini/secrets.env` and into `process.env` (read on the next call — no restart). The browser never receives the token back; only the env var **name** (`apiKeyEnv`) lands in `config.json`. This honors the "browser code must not receive gateway bearer tokens" rule.

SigV4 / IAM-role auth (the AWS-recommended Bedrock path) is intentionally **not** implemented — only the bearer-in-`x-api-key` path, which is exactly what the standard Anthropic client uses against Bedrock Mantle. SigV4 would require the dedicated `AnthropicBedrockMantle` SDK client and AWS credential-chain signing; it is out of scope here.

## Operational Notes

- **Bedrock model ids** carry an `anthropic.` provider prefix (e.g. `anthropic.claude-opus-4-8`). The catalog and the Add/Edit Provider model dropdown list the clean first-party ids (Opus 4.8, Opus 4.7, Sonnet 4.6, Haiku 4.5); `callAnthropicMessages` (`resolveAnthropicModel`) auto-maps a bare id to its `anthropic.`-prefixed form at request time when the configured baseUrl is a Bedrock endpoint, so one selection targets either endpoint. An already-prefixed id (e.g. set explicitly via the CLI) is left untouched.
- **Bedrock bearer tokens expire at ≤ 12h and cannot be refreshed.** A long-lived gateway will start returning `401 authentication_error` once a token lapses; the existing `AUTH_EXPIRED_RE` / `providerReauth` note surfaces this as a re-authenticate prompt. Re-minting requires `aws-bedrock-token-generator` + AWS credentials and is a manual step.
- **`baseUrl` path-prefix convention**: the builder appends `/v1/messages` to whatever `baseUrl` resolves to, so the Bedrock `baseUrl` must include the `/anthropic` prefix. The CLI help and the Add-Provider hint document the exact value.
- **Configured badge**: the catalog "configured" status checks the canonical env var (`PROVIDER_API_KEY_ENV`) and, for the active provider, additionally honors its configured `apiKeyEnv`. So a CLI-set custom env var (e.g. a Bedrock bearer under `BEDROCK_BEARER_TOKEN`) shows the active anthropic provider as configured, matching `providerHealth` (which reads `provider.apiKeyEnv`).
- **Switching the active provider in Settings resets transport config.** `RuntimeConfig.provider` is a single slot, not a per-provider map — `setSetupProvider` preserves an omitted `baseUrl`/model only while the same provider stays active (the edit-model and re-save flows). Switching the active provider away from anthropic and back (the ProviderCard set-active radio posts only `{provider, model}`) discards the configured Bedrock `baseUrl` and model, and the client has no stored value to re-send (the catalog ships the static first-party default). Bedrock users should re-Add or Edit the anthropic provider — which threads `baseUrl` through `setSetupProvider` — rather than toggle the active-provider radio. Per-provider transport persistence is a separate follow-up, out of scope here.

## Test Surface

- `src/provider.test.ts` — fetch-mocked unit tests covering the non-stream and streaming paths, request shape and headers (`x-api-key`, `anthropic-version`), message/tool/multimodal translation, `stop_reason` mapping, error surfaces (HTTP + in-stream error events + missing body), `max_tokens` resolution, structured output (plain/fenced/invalid JSON), the vision path, and the configured/catalog gates.
- `src/runtime/setup-api.test.ts` — the anthropic env-keyed setup path (including a Bedrock `baseUrl` override) and provider removal.
- `src/cli/commands/provider.test.ts` — `gini provider set anthropic` with `--base-url` / `--api-key-env`, and default-model fallback.

## Out Of Scope, Linked Follow-Ups

- SigV4 / IAM-role auth for Bedrock (requires the dedicated SDK client).
- `anthropic-beta` header passthrough for beta-gated features (`extraBody` goes in the request body, not headers).
- Re-mint automation for expiring Bedrock bearer tokens.

## Consequences

- Claude is reachable end-to-end with full Messages-API fidelity (tool use, streaming, vision, documents) from both the first-party API and Amazon Bedrock, selected by configuration alone. Messages-API prompt caching is not yet wired — the path sends no `cache_control` markers, so the stable system prefix goes uncached (a follow-up; see ADR stable-system-prefix.md).
- The provider is the first non-OpenAI-shaped transport in `src/provider.ts`; the translation helpers (`translateMessagesToAnthropic`, `translateToolsToAnthropic`, `parseAnthropicMessage`, `readAnthropicMessagesStream`) are self-contained and reuse the existing `resolveBaseUrl` / `sanitizeExtraBody` / `estimateCost` helpers.
- `apiKeyEnv` + `baseUrl` being first-class on `ProviderConfig` (see `provider-extra-body.md`) is what makes the dual-target design require zero schema change.
