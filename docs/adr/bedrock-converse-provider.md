# Amazon Bedrock Provider via the Converse API (Model-Agnostic, SigV4)

## Decision

Gini ships a `bedrock` provider distinct from `anthropic`. It speaks AWS's **Converse API** (`POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse[-stream]`), the model-agnostic message API that works across every Bedrock model family — Claude, Amazon Nova, Meta Llama, Mistral, DeepSeek, and more — with one request/response shape and unified tool use. Auth is **AWS SigV4** (service `bedrock`) computed from static credentials: the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars (plus `AWS_SESSION_TOKEN` for temporary sessions), else the `~/.aws/credentials` profile. No API key. (SSO/`~/.aws/config` role chains aren't auto-resolved — see Out of scope; those users export the session into the env first.)

The `modelId` is a Bedrock model id sent verbatim in the request path — typically a cross-region inference-profile id (e.g. `us.amazon.nova-pro-v1:0`, `us.anthropic.claude-opus-4-8`, `us.meta.llama3-3-70b-instruct-v1:0`). There is no Anthropic-style id remapping.

`bedrock` is modeled on `codex`: a credential-less provider whose "configured" state is whether local credentials resolve (codex reads `~/.codex/auth.json`; bedrock resolves AWS creds). Its catalog `auth` is `"aws"`, the web Add/Edit forms show no API-key field, and it is not removable from the UI (the credentials are `~/.aws`, not gini-managed).

## Context

Claude-in-Bedrock has an Anthropic-Messages-compatible endpoint, but it only serves Claude. To use Nova, Llama, Mistral, DeepSeek, etc., the right surface is the Bedrock Runtime **Converse** API, which AWS designed as "write once, run against any Bedrock model." So the model-agnostic requirement drives a Converse transport rather than reusing the Anthropic Messages path. SigV4 (vs. a Bedrock API key) needs no key minting, never expires, and requires no `iam:CreateServiceSpecificCredential` permission — it reuses the IAM access keys the operator already has.

## Wire Shape

`callBedrockConverse` mirrors `callAnthropicMessages`: it streams when an `onDelta` callback is present and parses the JSON body otherwise. Translation maps Gini's OpenAI-shaped transcript onto Converse:

- **System hoist** — `system` messages concatenate into the top-level `system: [{text}]` array.
- **Tool use** — assistant `tool_calls` become `{toolUse:{toolUseId,name,input}}` content blocks; tool defs map to `toolConfig.tools[].toolSpec = {name, description, inputSchema:{json}}` with `toolChoice:{auto:{}}`.
- **Tool results** — consecutive `tool` messages group into one user message of `{toolResult:{toolUseId, content:[{text}]}}` blocks.
- **Multimodal** — `image_url` data URLs become `{image:{format, source:{bytes}}}` (the base64 string is the blob in JSON); `format` is a bare token (png/jpeg/gif/webp). Per-model vision/doc support is gated in `resolveProviderModality` (Claude 3+, Nova Pro/Lite/Premier, Pixtral, Llama 4, Llama 3.2 vision; text-only ids stay false).
- **max_tokens** — sent as `inferenceConfig.maxTokens` (default `DEFAULT_ANTHROPIC_MAX_TOKENS`, overridable via `extraBody.max_tokens`).
- **Non-stream** — `parseConverseResponse` reads `output.message.content[]` (text + `toolUse`), maps `stopReason`, and normalizes `usage.{inputTokens,outputTokens,totalTokens}` into the snake_case keys `estimateCost` reads.
- **Streaming** — `converse-stream` returns `application/vnd.amazon.eventstream` (binary framing: `[4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]`). `readConverseStream` parses frames by length (CRCs unvalidated), reads the `:event-type` / `:message-type` string headers, and handles `messageStart`/`contentBlockStart`/`contentBlockDelta`(text + `toolUse.input` fragments)/`contentBlockStop`/`messageStop`(stopReason)/`metadata`(usage), surfacing any exception frame as a thrown error.

Dispatch arms route `bedrock` in `generateToolCallingResponse`, `generateTaskSummary`, `generateStructured` (via `callBedrockStructured`, prompt-for-JSON), and `generateVisionAnalysis`.

## Auth and Trust Boundary

`config.json` stores only `awsRegion` and the (informational) `baseUrl` — never any credentials. The access key / secret / session token come from the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars, else the `~/.aws/credentials` profile, read at call time. `signAwsRequest` (`src/aws-sigv4.ts`, `node:crypto`, no AWS SDK) computes the canonical request → `kDate→kRegion→kService→aws4_request` signing key → signature, emitting `Authorization`/`x-amz-date`/`x-amz-content-sha256` (and `x-amz-security-token` for temporary creds). The canonical URI **double-URI-encodes** the path (non-S3 SigV4 rule), so a model id's `:` (`…v1:0` → wire `%3A` → canonical `%253A`) signs correctly. `redactSecrets` masks `AKIA…`/`ASIA…` access-key ids and the computed `Signature=…` hex so neither leaks through `providerHealth` / `/api/status` / trace records. Region resolves from explicit `awsRegion`, else `AWS_REGION`/`AWS_DEFAULT_REGION`, else `us-east-1`.

Setup mirrors codex: `setSetupProvider`'s bedrock branch requires no `apiKey`, rejects up front when no AWS creds resolve (`hasUsableAwsCredentials`), and persists model + region. The web Add Provider form's bedrock panel shows an explanatory note, a free-text model id, and an optional region — no key field; `gini provider set bedrock [model] [--aws-region]` is the CLI equivalent.

## Test Surface

- `src/aws-sigv4.ts` / `src/aws-sigv4.test.ts` — the signer in isolation: golden vector, temporary-credential `x-amz-security-token`, default-`now`, region / env-credential / `~/.aws` INI resolution, and reserved-character canonical-URI encoding.
- `src/provider.test.ts` — fetch-mocked bedrock tests: SigV4-signs the Converse URL (`%3A`-encoded model id, no `x-api-key`) with the converse body shape, system hoist + `toolConfig` + `toolUse` parse, the `converse-stream` event-stream parser (text deltas, tool-use, stopReason, usage) via an event-stream encoder, an exception frame, a non-OK error, `providerHealth` configured/not + no-credentials error, the vision (image) path with region default, and structured-output JSON.
- `src/runtime/setup-api.test.ts` — bedrock configures with no apiKey when creds resolve (persists model + region), and rejects when none resolve.
- `src/cli/commands/provider.test.ts` — `gini provider set bedrock` persists model + region; default model fallback.

## Out Of Scope, Linked Follow-Ups

- Full IAM-role / `AssumeRole` sourcing, IMDS/container credentials, and `~/.aws/config` SSO. The signer uses static credentials only: the standard `AWS_*` env vars or the `~/.aws/credentials` profile.
- A live model picker (`ListFoundationModels` / `ListInferenceProfiles`); the catalog ships a cross-family starter list and the UI accepts any id.
- Bedrock Guardrails, prompt-management resources, and `additionalModelRequestFields` passthrough.

## Consequences

- Any Bedrock model — not just Claude — is reachable end-to-end (tool use, streaming, vision) signed with the operator's existing AWS credentials, no API key and no key minting. Verified live against `us.amazon.nova-lite-v1:0` (a non-Anthropic model) through a real chat turn.
- `src/aws-sigv4.ts` is a dependency-free, provider-agnostic SigV4 signer reusable by any future AWS-signed transport.
- `bedrock` and `anthropic` are independent providers; `anthropic` stays first-party-key-only (see ADR anthropic-messages-provider.md).
