# Azure OpenAI Routing on the OpenAI Provider

## Decision

The `openai` provider gains three optional `ProviderConfig` fields that let it target an Azure OpenAI resource without forking the provider into a separate `azure` family:

- `apiVersion?: string` — the Azure `api-version` query value (e.g. `2024-12-01-preview`). Its presence is the single signal that switches the provider into Azure routing.
- `deployment?: string` — the Azure deployment name (the path segment under `/openai/deployments/`). Defaults to `model` when omitted.
- `authScheme?: "bearer" | "api-key"` — the auth header style. `bearer` (default) sends `Authorization: Bearer`; `api-key` sends Azure's `api-key` header. The `api-key` scheme takes effect only in Azure mode (apiVersion set); on a non-Azure config it degrades to Bearer, since a standard OpenAI endpoint rejects an `api-key` header.

In Azure mode every OpenAI-compatible chat-completions call (tool-calling, structured JSON, vision, and the chat-completions branch of `generateTaskSummary`) routes to:

```
${baseUrl}/openai/deployments/<deployment>/chat/completions?api-version=<apiVersion>
```

instead of the flat `${baseUrl}/chat/completions`. `model` stays the real model id (so `resolveProviderModality` keeps detecting gpt-5.x multimodality); `deployment` is the Azure-specific routing key.

The fields are configurable everywhere the provider is configurable: the `gini provider set` CLI (`--api-version`, `--deployment`, `--auth-scheme`), the `POST /api/setup/provider` endpoint, and the agent's `set_provider` self-management tool. They live on the shared `ProviderConfig`, but `normalizeProvider` carries them through only for `openai` — a non-openai provider with a stray value behaves exactly as before.

## Context

Azure OpenAI does not expose the flat OpenAI-compatible surface the rest of the providers speak. Three things differ from `api.openai.com`:

1. **URL shape** — requests route per deployment (`/openai/deployments/<name>/...`), not by a `model` field in the body.
2. **Query param** — every call requires `?api-version=<v>`.
3. **Auth header** — a resource key authenticates via `api-key: <key>`, not `Authorization: Bearer`. (Azure also accepts an Entra access token via `Authorization: Bearer`, so the `bearer` scheme is valid both with and without Azure routing; the `api-key` scheme is Azure-only and is gated on `apiVersion` being set.)

The existing `openai` provider already threaded a configurable `baseUrl` through every call site, and `baseUrl` alone was nearly enough — but the deployment-in-path shape, the api-version query, and the `api-key` header had no expression. The framing of the work was explicitly "make the existing openai provider reach Azure," not "add a new provider." A separate `azure` family would have duplicated the streaming SSE reader, the function-call argument-delta accumulation, the vision content shape, and every `provider.name === "openai"` branch across the runtime, the catalog, the capabilities table, the web settings UI, and the CLI. Extending the openai provider with three optional fields is the smaller, lower-risk change and matches how `extraBody` / `baseUrl` / `apiKeyEnv` already ride on `ProviderConfig` (see `docs/adr/provider-extra-body.md`).

## Routing Helpers

Two helpers in `src/provider.ts` centralize the per-call decision so all four chat-completions builders stay consistent:

- `azureApiVersion(provider)` — returns the trimmed api-version when the provider is `openai` with a non-empty `apiVersion`, else `undefined`. This is the single definition of "Azure mode," consumed by both the URL builder and the `generateTaskSummary` routing fork.
- `chatCompletionsUrl(provider, baseUrl)` — returns the Azure deployment-scoped URL in Azure mode (percent-encoding the deployment and version), else `${baseUrl}/chat/completions`.
- `chatCompletionsAuthHeader(provider, apiKey)` — returns `{ "api-key": key }` for the `api-key` scheme *when in Azure mode*, else `{ authorization: "Bearer <key>" }`. The Azure-mode gate stops a stray `authScheme: "api-key"` on a non-Azure config from posting an `api-key` header to standard OpenAI (a guaranteed 401 mislabeled as an auth failure). Returns `{}` when no key is present, preserving the keyless-local-gateway path.
- `azureRoutingNeedsBaseUrl(name, apiVersion, baseUrl)` — true when an openai config selects Azure routing (apiVersion set) but has no usable Azure resource baseUrl (missing, or still the `api.openai.com/v1` default). The config-entry boundaries (CLI `provider set`, the setup API, and the `set_provider` tool that funnels through it) reject that combination before persisting, since the deployment URL would otherwise resolve against `api.openai.com` (which has no `/openai/deployments` path) and 404. `normalizeProvider` itself stays a pure transform and never throws, so config hydration and per-agent override resolution are unaffected.

`generateTaskSummary` routes Azure-mode openai through the chat-completions builder rather than the flat `/responses` surface, because Azure's deployment-scoped chat/completions is the stable, universally-available endpoint. Standard (non-Azure) openai still uses `/responses` unchanged.

## Auth and Secret Storage

The Azure key (or Entra token) is read from the env var named by `apiKeyEnv` (default `OPENAI_API_KEY`), the same resolution path as standard OpenAI — only the header name changes under the `api-key` scheme. The `POST /api/setup/provider` flow persists the key to `~/.gini/secrets.env` exactly as it does for standard OpenAI, so no new secret-handling surface ships here. `apiVersion`, `deployment`, and `authScheme` are non-secret transport config and flow through `providerHealth` / `/api/status` / trace records like `baseUrl`.

The web provider forms expose the routing. The Add Provider page and the Edit Provider dialog both surface a Base URL field plus an Azure section (API version, Deployment, Auth scheme) for the openai provider; the Edit dialog prefills them from the active provider's persisted config (threaded from `/status`). So configuring Azure — and swapping back to standard OpenAI by blanking the fields — is now a UI action, not CLI-only.

`setSetupProvider`'s field rule makes both the full-form and partial callers correct: a key PRESENT in the payload (even blank) is applied, with a blank value clearing the field; a key ABSENT preserves the existing value. The Edit dialog posts the full transport state, so blanking Base URL + API version clears Azure routing and swaps back to `api.openai.com`. A partial caller — the model picker's `{ provider, model }`, or the `set_provider` tool — omits the transport keys, so a model-only save preserves the persisted `baseUrl` / `apiKeyEnv` / `apiVersion` / `deployment` / `authScheme` and can't silently strip Azure routing. A provider switch (different `name`) starts clean, matching the cross-provider non-inheritance rule for agents. The CLI's `gini provider set` takes the explicit-replace stance — it rebuilds the config from the flags given, so running it without `--base-url`/`--api-version` also clears Azure routing.

## Agent Override Inheritance

`resolveEffectiveContext()` already spreads `config.provider` for a same-provider agent override, so an agent that overrides only `model` on an Azure-configured openai instance inherits `baseUrl`, `apiVersion`, `deployment`, and `authScheme` automatically. A cross-provider override (e.g. an openrouter-routed agent) takes `normalizeProvider`'s per-provider defaults and never inherits the Azure routing fields — the same invariant `provider-extra-body.md` documents for `baseUrl`/`apiKeyEnv`/`extraBody`.

## Test Surface

- `src/provider.test.ts` — fetch-mock unit tests: deployment-scoped URL construction for tool-calling (streaming and non-streaming), structured output, and vision; `api-key` vs `Bearer` header selection; deployment defaulting to the model id; `generateTaskSummary` routing to chat/completions rather than `/responses`; and a regression that non-Azure openai still hits the flat path with `Bearer`.
- `src/cli/commands/provider.test.ts` — persistence of the three flags, `--auth-scheme` value validation, and the warning surface when Azure flags are passed to a non-openai provider.
- `src/runtime/setup-api.test.ts` — the setup endpoint persists the fields for openai and drops them for openrouter.
- `src/execution/self-registry.test.ts` — the `set_provider` tool forwards the fields into the persisted config.

## Out of Scope, Linked Follow-Ups

- **Azure embeddings.** The default embedding provider is `local` (Transformers.js); the `openai` embedding path in `src/embeddings.ts` still targets the flat `${baseUrl}/embeddings` with a `Bearer` header. Azure embeddings need a separate embeddings deployment (a chat deployment can't serve `text-embedding-3-small`), so it is a distinct feature, not wired here.
- **Catalog entry.** Azure is a mode of the `openai` catalog row, not a separate entry; no dedicated `azure` tile ships.

## Consequences

- The `openai` provider is now a first-class transport for Azure OpenAI for the full chat surface (tool-calling, structured, vision, summary), verified end-to-end against a live `gpt-5.4` Global Standard deployment.
- `azureApiVersion` is the single source of truth for "is this Azure?"; any future Azure-specific behavior keys off it rather than re-deriving the condition.
- The two routing helpers replaced the duplicated header-construction block that had been copy-pasted across the four chat-completions builders, so a future transport change touches one place instead of four.
