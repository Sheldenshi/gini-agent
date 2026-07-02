# ADR: Connector-Backed Web Search

- **Status:** Accepted
- **Date:** 2026-06-01
- **See also:** [Connector + Provider Vocabulary, Spec Compliance, And Meta-Skills](connector-provider-spec-compliance.md), [ChatBlock Protocol](chat-block-protocol.md), [Agent Loop With Native Tool Calling](agent-loop-tool-calling.md), [Authorization vs SetupRequest](authorization-vs-setup-request.md)

## Decision

Web search is a built-in agent tool, `web_search`, backed by **connector providers** rather than a skill. The initial providers are **Brave Search** (`brave-search`, free tier) and **Exa** (`exa`, neural search + extraction). The tool selects a healthy connector at dispatch — honoring a model-supplied `provider` argument, otherwise preferring Brave then Exa — resolves that connector's API key through the standard audited secret path, calls the provider's REST API, and returns ranked results as compact text.

This is the first **connector-backed tool**: a built-in tool that consumes a connector secret directly, distinct from the two existing connector consumers (skill env-bindings and auto-registered MCP servers, see ADR connector-provider-spec-compliance.md). Adding a new search backend is a new `ProviderModule` plus a branch in the tool's backend switch — no new tool, no new toolset.

## Context

Comparable agents (Hermes, OpenClaw) expose web search as a single tool with pluggable backends selected by config. Gini already had `web_fetch` (fetch a known URL) but no discovery path, so the model guessed URLs. The connector substrate already models external credentials with health probes and audited secret resolution, so search providers fit it directly — each provider is a `ProviderModule` with a probe and an `envBinding`, and the tool reads the key the same way a skill subprocess would.

## Mechanics

- **Providers.** `packages/runtime/src/integrations/connectors/{brave-search,exa}.ts` export `ProviderModule`s (token field, probe that runs a 1-result query, env-bindings `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY`). Registered in the provider registry. Each also sets the optional `docsUrl` field (below).
- **Tool + backends.** `web_search` is defined in the tool catalog (toolset `web_search`). The dispatcher picks a configured + healthy connector, resolves its `token` via `resolveConnectorSecret` (audited), and calls the matching backend in `packages/runtime/src/tools/web-search.ts`.
- **Toolset + migration.** A `web_search` toolset ships enabled by default and is in `DEFAULT_AGENT_TOOLSETS`. Because the agent-whitelist intersection would otherwise hide the tool on instances created before it existed, `normalizeState` registers the post-`browser` default-agent snapshot so the backfill unions `web_search` into existing default-agent whitelists (see `migrateDefaultAgentToolsets` in `packages/runtime/src/state/store.ts`).
- **Degraded fallback when no connector exists.** `web_search` throws a `ToolDisplayError` (below) that steers the model to keep searching with the live-web tools it always has — `browser_navigate` or `web_fetch` against a real search engine — and answer from what it finds rather than from memory. Querying a search engine this way is searching; only guessing random content URLs is not. `request_connector` is offered as a setup upgrade for faster, cleaner results, not a hard gate. When the model does call `request_connector` for a missing provider, the chat renders the model's reason as an assistant bubble above a minimal `connector.request` card; the Connect modal captures the key, and the provider's `docsUrl` renders as a "Learn more" link.

## Model-facing vs user-facing tool errors

A tool failure can carry two audiences. `web_search` with no connector must steer the **model** verbosely (keep searching via `browser_navigate` / `web_fetch` against a search engine, with `request_connector` as a setup upgrade) while showing the **user** a calm line ("No search provider connected.").

- `ToolDisplayError` (`packages/runtime/src/execution/tool-dispatch.ts`) carries the verbose model-facing `message` plus a short `displayMessage` and a `displaySeverity` of `"info" | "error"`.
- The chat-task dispatch catch feeds the full `message` to the model as the tool result and passes `displayMessage` / `displaySeverity` to the UI. `ToolCallBlock.errorSeverity` rides the ChatBlock wire (see ADR chat-block-protocol.md) so clients render an `"info"` failure as a muted "needs setup" notice rather than a red error.

This is a general pattern: any tool may throw `ToolDisplayError` to split steering from the user-facing line. Plain `Error`s keep surfacing their message to both audiences (red).

## Async resume after setup resolution

`POST /api/setup-requests/<id>/complete` creates the connector, probes it, and — on a healthy probe — resumes the paused agent run. The resume is **detached** (`resolveSetupRequest({ awaitResume: false })`), mirroring `submitTask`'s fire-and-forget `runTask(...).catch(failTask)`. The HTTP response returns as soon as the connector is saved and verified, so the connect modal closes immediately instead of blocking for the whole resumed run; the agent then streams its continuation into the chat. The same flag applies to `browser.connect` completion.

`POST /api/setup-requests/<id>/cancel` for `connector.request` follows the same detached response shape but resumes the paused run with a cancellation tool result instead of failing the task. That lets the agent continue without the connector when possible, or reply with the specific connector/input it still needs when the original request cannot be satisfied.

## Consequences

- New search backends are additive: a `ProviderModule` + a backend branch. No tool/toolset churn.
- The connector substrate now has three consumers — skills, MCP, and built-in tools. Future built-in tools that need credentials should follow this path rather than inventing a parallel secret channel.
- `ToolDisplayError` / `errorSeverity` give every tool a way to keep model steering out of the user's view; clients must honor `errorSeverity` (default `"error"`).
- `docsUrl` is an optional `ProviderModule` field; absent it, no "Learn more" link renders.

## Acceptance checks

- `bun test packages/runtime/src/tools/web-search.test.ts`, `packages/runtime/src/integrations/connectors/{brave-search,exa}.test.ts` cover backend mapping and probes.
- `bun test packages/runtime/src/execution/tool-dispatch.test.ts` covers the no-connector `ToolDisplayError` split (verbose model message + `"No search provider connected."` info line) and the provider-specific message when an explicit backend is absent while another is connected.
- `bun test packages/runtime/src/state/store.test.ts` covers the default-agent backfill of `web_search`.
- `bun test packages/runtime/src/execution/chat-task.test.ts` covers the `connector.request` reason rendering as an assistant bubble above the setup card and cancellation resuming the agent loop with a fallback result.
- Live: asking to search the web on an instance with no search connector shows the muted "No search provider connected." line, a Gini explanation bubble, and a minimal Connect card; completing the connect closes the modal immediately and the agent continues.
- Live: cancelling the Connect card marks the card cancelled, clears the in-flight chat state, and the agent either continues with another path or explains which connector/input is still needed.
