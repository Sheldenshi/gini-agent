# Native Anthropic Messages Provider (First-Party Claude)

## Decision

Gini ships a first-class `anthropic` provider that speaks the Anthropic Messages API (`POST {baseUrl}/v1/messages`) natively, rather than routing Claude through the OpenAI-compatibility shim. It targets the first-party Claude API: `baseUrl` defaults to `https://api.anthropic.com`, `apiKeyEnv` defaults to `ANTHROPIC_API_KEY` (a Console `sk-ant-…` key carried in the `x-api-key` header), with a pinned `anthropic-version: 2023-06-01`. An optional `baseUrl` override accommodates first-party-compatible proxies.

Amazon Bedrock is a **separate provider** (`bedrock`) — it speaks AWS's model-agnostic Converse API and signs with AWS credentials, not an Anthropic key. See ADR bedrock-converse-provider.md. Keeping the two apart means `anthropic` stays "just paste your Claude key," while Bedrock (Claude **and** Nova/Llama/Mistral/DeepSeek) lives under its own provider with its own auth.

## Context

Every prior provider was either OpenAI chat-completions (`openai`, `openrouter`, `local`, `deepseek`) or the Codex `/responses` surface. None spoke the Anthropic Messages API, so Claude could only be reached indirectly. Anthropic's first-party OpenAI-compatibility layer exists but is explicitly positioned for testing, not production: it drops prompt caching and ignores the tool-use `strict` parameter. A native Messages builder reaches Claude with full fidelity (tool use, streaming, vision, documents).

## Wire Shape

`callAnthropicMessages` mirrors the structure of `callToolCallingChatCompletions` / `callToolCallingResponses`: it streams when an `onDelta` callback is present and parses the JSON body otherwise. The translation layer maps Gini's OpenAI-shaped tool-calling transcript onto the Messages API:

- **System hoist** — all `system` messages are concatenated into the top-level `system` field, exactly as the Codex path hoists to `instructions`.
- **Tool use** — assistant `tool_calls` become `tool_use` content blocks (`{type, id, name, input}`); tool definitions map to `{name, description, input_schema}` with `tool_choice: {type:"auto"}` when any tools are present.
- **Tool results** — consecutive `tool` messages are grouped into a single user message whose content begins with `tool_result` blocks, satisfying the API's ordering rule.
- **Multimodal** — `image_url` data URLs become base64 `image` source blocks and `document` parts become base64 `document` source blocks. `anthropic` is registered as `vision: true, nativeDocs: true` in `resolveProviderModality`.
- **max_tokens** — the Messages API requires it. The default depends on send mode: a **streaming** turn resolves the model's real output ceiling via `resolveMaxOutputTokens` (e.g. 128K for Claude Sonnet/Opus 4.6+) so a large tool-call argument isn't truncated mid-JSON, while a **non-streaming** turn keeps the conservative `DEFAULT_ANTHROPIC_MAX_TOKENS` floor (a large non-streaming `max_tokens` trips the first-party "streaming is required for long requests" guard). A user-pinned `extraBody.max_tokens` and the vision per-call override both take precedence.
- **Streaming** — the SSE reader consumes the named-event protocol (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`), accumulating `input_json_delta` fragments per content-block index and mapping `stop_reason` to the loop's finish-reason vocabulary. `usage` flows into `estimateCost`.
- **Fine-grained tool streaming** — on a streaming turn that carries tools against a Claude 4-family model (`claudeSupportsFineGrainedToolStreaming`), the request adds the HTTP header `anthropic-beta: fine-grained-tool-streaming-2025-05-14`. Without it the Messages API buffers a `tool_use` block's entire input JSON server-side and emits nothing until the whole argument is generated; a large inline tool argument then leaves the SSE stream idle past the runtime's socket timeout, surfacing as `TimeoutError: The operation timed out.` (the idle/stall timeout + transient retry shared with the Bedrock path now recover this residual stall — see ADR bedrock-converse-provider.md). The header makes the tool input stream incrementally. It is gated to streaming + tool turns on the Claude 4 family — the beta is rejected with a 400 on models that don't support it (Claude 3.x and earlier). NOTE: this is the FIRST-PARTY mechanism (an HTTP header); the bedrock provider carries the same beta as an `anthropic_beta` entry inside `additionalModelRequestFields` instead (see ADR bedrock-converse-provider.md). The per-tool `eager_input_streaming` property was measured less effective than the header and is not used. The streaming `max_tokens` clamp, the idle/stall stream timeout (`readWithIdleTimeout` / `StreamIdleTimeoutError`), and the transient-error retry in the chat-task model loop are shared with the Bedrock path — see the corresponding bullets in ADR bedrock-converse-provider.md.

The model id is sent verbatim (first-party ids like `claude-opus-4-8`); there is no Bedrock-style id remapping on this provider. Dispatch arms route `anthropic` in `generateToolCallingResponse`, `generateTaskSummary`, `generateStructured` (via `callAnthropicStructured`, a prompt-for-JSON path since the Messages API has no `response_format`), and `generateVisionAnalysis`.

## Auth and Trust Boundary

The key lives in the env var named by `apiKeyEnv` and is read at call time into the `x-api-key` header — never placed in `baseUrl` or `extraBody` (both flow through `providerHealth` / `/api/status` / trace records as non-secret transport config). This preserves the boundary from `provider-extra-body.md`: secrets stay in env vars, transport config stays inspectable.

Browser configuration goes through the same server-side path as every other env-keyed provider: the Settings → Add Provider form POSTs the key to `/setup/provider`, which writes it to `~/.gini/secrets.env` and into `process.env` (read on the next call — no restart). The browser never receives the key back; only the env var **name** (`apiKeyEnv`) lands in `config.json`. This honors the "browser code must not receive gateway bearer tokens" rule. The Add/Edit Provider forms show just an API key (and an optional Base URL) for anthropic.

## Test Surface

- `src/provider.test.ts` — fetch-mocked unit tests covering the non-stream and streaming paths, request shape and headers (`x-api-key`, `anthropic-version`), message/tool/multimodal translation, `stop_reason` mapping, error surfaces (HTTP + in-stream error events + missing body), `max_tokens` resolution, structured output (plain/fenced/invalid JSON), the vision path, the configured/catalog gates, verbatim model id, the `/v1` trailing-path normalization, and fine-grained tool streaming gating (the `anthropic-beta: fine-grained-tool-streaming-2025-05-14` header present on a streaming Claude-4 tool turn; absent on a tool-less turn, a non-streaming turn, and a non-Claude-4 model). The Claude-family allowlist itself is unit-tested via `claudeSupportsFineGrainedToolStreaming` in `src/provider-capabilities.test.ts`.
- `src/runtime/setup-api.test.ts` — the anthropic env-keyed setup path and provider removal.
- `src/cli/commands/provider.test.ts` — `gini provider set anthropic` with `--base-url` / `--api-key-env`, and default-model fallback.

## Out Of Scope, Linked Follow-Ups

- Amazon Bedrock (any model family) — its own provider; see ADR bedrock-converse-provider.md.
- `anthropic-beta` header passthrough for beta-gated features (`extraBody` goes in the request body, not headers).
- Messages-API prompt caching — the path sends no `cache_control` markers, so the stable system prefix goes uncached (see ADR stable-system-prefix.md).

## Consequences

- Claude is reachable end-to-end with full Messages-API fidelity (tool use, streaming, vision, documents) from the first-party API with just an `ANTHROPIC_API_KEY`.
- The provider is the first non-OpenAI-shaped transport in `src/provider.ts`; the translation helpers (`translateMessagesToAnthropic`, `translateToolsToAnthropic`, `parseAnthropicMessage`, `readAnthropicMessagesStream`) are self-contained and reuse the existing `resolveBaseUrl` / `sanitizeExtraBody` / `estimateCost` helpers — and the bedrock provider's Converse transport reuses the same `estimateCost` / cost-record shape.
- `apiKeyEnv` + `baseUrl` being first-class on `ProviderConfig` (see `provider-extra-body.md`) is what keeps this provider a zero-schema-change addition.
