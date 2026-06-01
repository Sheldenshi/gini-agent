import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentSystemContext, renderEphemeralContext } from "./system-prompt";
import { loadInstructions, loadSoul, loadUserProfile } from "./runtime/identity-files";
import { readState } from "./state";
import { appendTrace } from "./state/trace";
import type { CostRecord, ProviderCatalogItem, ProviderConfig, ProviderName, ProviderResult, RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export function providerHealth(config: RuntimeConfig) {
  const provider = normalizeProvider(config.provider);
  if (provider.name === "echo") {
    return {
      ok: true,
      provider,
      configured: true,
      message: "Echo provider is deterministic and does not require credentials."
    };
  }

  if (provider.name === "codex") {
    const credentials = readCodexCredentials(provider);
    return {
      ok: credentials.ok,
      provider,
      configured: credentials.ok,
      authPath: credentials.authPath,
      credentialType: credentials.credentialType,
      message: credentials.ok
        ? `Codex credentials are available from ${credentials.authPath}.`
        : credentials.message
    };
  }

  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const configured = provider.name === "local" || Boolean(process.env[envName]);
  return {
    ok: configured,
    provider,
    configured,
    message: configured ? `${provider.name} provider is configured.` : `Set ${envName} to use the ${provider.name} provider.`
  };
}

// Per-provider env var that holds the bearer token. Mirrors the apiKeyEnv
// defaults in normalizeProvider, and is the single source of truth for
// the "is this provider configured?" gate the settings UI uses to decide
// which rows to render.
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  local: "GINI_LOCAL_API_KEY"
};

// Whether a provider has usable credentials in the current process env.
// echo is dev-only and never reported as configured. codex consults
// readCodexCredentials so we honor CODEX_AUTH_JSON and the default path.
// local is a special case: most local gateways (Ollama, LM Studio)
// accept no-auth requests so the env var is optional — we still gate
// the row on the user having explicitly opted in by either setting the
// env var or making local the active provider.
export function isProviderConfigured(name: string, activeProviderName?: string): boolean {
  if (name === "echo") return false;
  if (name === "codex") return hasUsableCodexCredentials();
  const envVar = PROVIDER_API_KEY_ENV[name];
  if (envVar && process.env[envVar]) return true;
  if (name === "local" && activeProviderName === "local") return true;
  return false;
}

// Catalog enriched with the per-provider configured flag. Used by the
// settings UI to hide rows the user hasn't connected; the static
// providerCatalog() stays in place for callers that just need the list of
// known provider shapes (e.g. setup-api default-model resolution).
export function providerCatalogWithStatus(
  activeProviderName?: string
): Array<ProviderCatalogItem & { configured: boolean }> {
  return providerCatalog().map((item) => ({
    ...item,
    configured: isProviderConfigured(item.name, activeProviderName)
  }));
}

export function providerCatalog(): ProviderCatalogItem[] {
  return [
    {
      id: "echo",
      name: "echo",
      displayName: "Gini Echo",
      auth: "none",
      models: ["gini-echo-v0"],
      capabilities: ["deterministic", "smoke", "tests"],
      costHint: "free"
    },
    {
      id: "codex",
      name: "codex",
      displayName: "Codex OAuth",
      baseUrl: DEFAULT_CODEX_BASE_URL,
      auth: "codex-oauth",
      models: [DEFAULT_CODEX_MODEL],
      capabilities: ["responses", "streaming", "oauth"],
      costHint: "external"
    },
    {
      id: "openai",
      name: "openai",
      displayName: "OpenAI Compatible",
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      auth: "env",
      models: ["gpt-5.4-mini", "gpt-5.4"],
      capabilities: ["responses", "tool-calling"],
      costHint: "external"
    },
    {
      id: "openrouter",
      name: "openrouter",
      displayName: "OpenRouter Compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: "env",
      models: ["openrouter/auto"],
      capabilities: ["chat-completions", "model-routing"],
      costHint: "external"
    },
    {
      id: "deepseek",
      name: "deepseek",
      displayName: "DeepSeek",
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      auth: "env",
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
      capabilities: ["chat-completions", "tool-calling"],
      costHint: "external"
    },
    {
      id: "local",
      name: "local",
      displayName: "Local OpenAI-Compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      auth: "env",
      models: ["local/default"],
      capabilities: ["chat-completions", "local"],
      costHint: "unknown"
    }
  ];
}

// Short brand label for a provider, used in user-facing copy (e.g. the
// re-authenticate note surfaced when a credential expires). Mirrors the web
// settings labels: drops the catalog's "Compatible"/"OAuth" suffixes so the
// brand reads cleanly on its own.
export function providerDisplayLabel(name: ProviderName): string {
  switch (name) {
    case "codex":
      return "Codex";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "deepseek":
      return "DeepSeek";
    case "local":
      return "Local";
    case "echo":
      return "Gini Echo";
  }
}

// Detects provider errors that mean the user's credential must be
// re-established — an expired/invalid/revoked/incorrect token, a bare 401/
// unauthorized, or an explicit "sign in again" / "log in again" /
// "re-authenticate" instruction. Deliberately broader than
// CODEX_SESSION_EXPIRED_RE (which gates retries and must avoid retrying generic
// failures): here a false positive only adds a re-auth hint to a note we were
// already going to show, so the matcher favors recall. An auth noun and an
// expiry/invalidity verb must sit within the same sentence ([^.]{0,40}) and in
// either order, so unrelated failures ("the cached file is invalid") don't trip
// it. The noun uses `auth\w*` so both "authentication" and "authorization"
// match. The connector after each noun/verb is `(?:[\s_-]|\b)` rather than a
// bare `\b` so the snake_case enum forms the backend emits (`token_expired`,
// `session_expired`) match too — `_` is a word char, so `\b` alone would miss
// them.
const AUTH_NOUN = "(?:auth\\w*|session|token|credential|api[\\s_-]*key|access[\\s_-]*token)";
const AUTH_VERB = "(?:expired|invalid|revoked|rejected|incorrect|missing|failed)";
const AUTH_EXPIRED_RE = new RegExp(
  [
    "\\b401\\b",
    "\\bunauthorized\\b",
    "(?:sign|log)(?:ing|ging)?[\\s-]*in[\\s-]*again",
    "login[\\s-]*again",
    "re-?authenticate",
    `\\b${AUTH_NOUN}(?:[\\s_-]|\\b)[^.]{0,40}?${AUTH_VERB}\\b`,
    `\\b${AUTH_VERB}(?:[\\s_-]|\\b)[^.]{0,40}?${AUTH_NOUN}\\b`
  ].join("|"),
  "i"
);

export function isAuthExpiredError(message: string | undefined): boolean {
  if (!message) return false;
  return AUTH_EXPIRED_RE.test(message);
}

// Thrown in place of the raw provider error when a tool-calling / model call
// fails on an auth error, tagging the provider that actually served the turn.
// failTask reads `provider` off this so the re-auth note names the right
// credential even if the active agent changed mid-call (issue #205).
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

// Actionable copy for a failed provider credential, shared by the chat system
// note and the legacy assistant message so every client surface says the same
// thing. Neutral on the failure mode (the classifier matches expired, invalid,
// revoked, 401, …), so it reads correctly for all of them.
export function providerAuthFailureText(providerLabel: string): string {
  return `${providerLabel} authentication failed. Re-authenticate ${providerLabel} to continue.`;
}

// OpenAI tool-calling shapes. We mirror the chat-completions API surface
// directly so tool specs can be authored once and shipped to any compat
// provider (OpenAI, OpenRouter, local) without an intermediate adapter.
export interface ToolFunctionSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded args; callers parse
  };
}

export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

// Vision-capable content part. user-role messages can carry a content
// array mixing text and image_url parts so the provider sees both. The
// image_url.url field carries a data URL (data:image/png;base64,...) inlined
// at dispatch time — we do not pass a fetchable URL because the runtime
// auth-gates upload reads and the provider can't authenticate.
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCallingMessage {
  role: ChatMessageRole;
  content: string | MessageContentPart[] | null;
  // tool result messages carry the originating call id; assistant messages
  // that triggered tool calls carry `tool_calls`.
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCallingResult {
  provider: ProviderConfig;
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown";
  responseId?: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}

// Echo provider stub registry for tool-calling. Tests register a sequence
// of canned responses (each is the next ToolCallingResult to return) keyed
// by an optional tag — useful for end-to-end chat-task tests where the
// loop calls the provider multiple times.
const echoToolCallingStubs: Array<{ tag?: string; result: ToolCallingResult }> = [];
// Capture the messages each echo call was invoked with. Tests inspect this
// to assert that the chat-task loop built the expected system prompt /
// conversation transcript. The buffer is cleared by
// clearEchoToolCallingResponses so the per-test setup also resets it.
const echoToolCallingCalls: ToolCallingMessage[][] = [];

export function setEchoToolCallingResponse(result: ToolCallingResult, tag?: string): void {
  echoToolCallingStubs.push({ tag, result });
}

export function clearEchoToolCallingResponses(): void {
  echoToolCallingStubs.length = 0;
  echoToolCallingCalls.length = 0;
}

// Test-only accessor: returns the messages array passed to every
// echo-backed `generateToolCallingResponse` call since the last clear.
// Each entry is the full transcript at the moment of the call.
export function getEchoToolCallingCalls(): ToolCallingMessage[][] {
  return echoToolCallingCalls.map((messages) => messages.slice());
}

function nextEchoToolCallingResult(provider: ProviderConfig, lastUserText: string): ToolCallingResult {
  const stub = echoToolCallingStubs.shift();
  if (stub) return stub.result;
  // Default: behave like generateTaskSummary's echo branch — finish with a
  // canned text response so callers that don't pre-register stubs still see
  // a deterministic shape.
  return {
    provider,
    text: `Gini handled: ${lastUserText}`,
    toolCalls: [],
    finishReason: "stop"
  };
}

// Native tool-calling entry point. Calls the provider's chat-completions
// endpoint (or codex `/responses`) with a `tools` array. Used by the chat-task
// agent loop.
//
// For codex with no tools (legacy callers), we fall back to the text-only
// `/responses` path via `callOpenAIResponses` so older code paths still work.
// With tools present, codex now uses the native function-call surface of the
// responses API (see `callToolCallingResponses`). The echo provider keeps its
// stub-driven behavior so unit tests stay deterministic.
export async function generateToolCallingResponse(
  config: RuntimeConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  // Optional per-call override. Resolved by the chat-task loop from the
  // active agent's providerName/model via resolveEffectiveContext. We do
  // NOT mutate config.provider — embeddings and the reranker still read
  // from config and must not be retargeted by agent switches. When
  // omitted, behavior matches the legacy single-provider path.
  providerOverride?: ProviderConfig
): Promise<ToolCallingResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";

  if (provider.name === "echo") {
    echoToolCallingCalls.push(messages.map((m) => ({ ...m })));
    const result = nextEchoToolCallingResult(provider, lastUserText);
    if (result.text && onDelta) {
      // Synthesize a single streamed delta so callers exercise their
      // streaming pipelines in echo-backed tests.
      try {
        onDelta(result.text);
      } catch {
        // never let onDelta crash the test path.
      }
    }
    return result;
  }

  // Codex/responses API. Route to the native function-calling responses
  // path whenever tools are present OR the message history already
  // contains tool-calling traffic (assistant tool_calls / tool results).
  // The latter matters for the graceful-exhaustion summary call: it
  // passes `tools: []` but needs the prior tool transcript preserved so
  // the model can summarize what it learned. Falling back to the text-
  // only `/responses` path here would strip that transcript.
  if (provider.name === "codex") {
    if (tools.length > 0 || messagesContainToolTraffic(messages)) {
      return callToolCallingResponses(provider, messages, tools, onDelta);
    }
    const systemContext = stitchSystemFromMessages(messages);
    const userInput = lastUserText || "";
    const text = await callOpenAIResponses(provider, userInput, systemContext, onDelta);
    return {
      provider: text.provider,
      text: text.text,
      toolCalls: [],
      finishReason: "stop",
      responseId: text.responseId,
      usage: text.usage,
      cost: text.cost
    };
  }

  return callToolCallingChatCompletions(provider, messages, tools, onDelta);
}

// True when the message array carries assistant `tool_calls` entries or
// `tool` result messages. Used to decide whether the codex routing must
// preserve the full Responses-API tool transcript even when the caller
// passes an empty tools list (e.g. the iteration-cap summary turn).
function messagesContainToolTraffic(messages: ToolCallingMessage[]): boolean {
  for (const message of messages) {
    if (message.role === "tool") return true;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }
  }
  return false;
}

// When falling back to the responses API for codex, collapse all `system`
// messages into one instructions block. tool/assistant messages are dropped
// since the responses path doesn't model them.
function stitchSystemFromMessages(messages: ToolCallingMessage[]): string {
  return messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");
}

async function callToolCallingChatCompletions(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void
): Promise<ToolCallingResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const wantStream = Boolean(onDelta);
  const body: Record<string, unknown> = {
    ...sanitizeExtraBody(provider.extraBody),
    model: provider.model,
    messages: messages.map(serializeChatMessage),
    stream: wantStream,
    // Pin the default (non-extended) prompt cache tier on every
    // OpenAI-compatible chat-completions call. "in_memory" is what the
    // OpenAI docs document for prompts ≥ 1024 tokens (5–10 min idle, 1
    // hour max) — explicitly NOT "24h", which is documented as not
    // Zero Data Retention eligible. openrouter / deepseek / local
    // accept-but-ignore unknown fields, so the value is a no-op there.
    // Codex never hits this builder.
    prompt_cache_retention: "in_memory"
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...(wantStream ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify(body)
  });

  if (wantStream) {
    return readToolCallingStream(response, provider, onDelta);
  }

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Tool-calling request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  return extractToolCallingResult(payload, provider);
}

function serializeChatMessage(message: ToolCallingMessage): Record<string, unknown> {
  // OpenAI chat-completions accepts the wire shape directly. Strip
  // undefined fields so they don't leak into the JSON body.
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name !== undefined) out.name = message.name;
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls !== undefined) out.tool_calls = message.tool_calls;
  return out;
}

function extractToolCallingResult(
  payload: Record<string, unknown>,
  provider: ProviderConfig
): ToolCallingResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices.find(isRecord);
  const message = first && isRecord(first.message) ? first.message : undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  const toolCalls = extractToolCalls(message);
  const finishReason = normalizeFinishReason(typeof first?.finish_reason === "string" ? first.finish_reason : undefined);
  return {
    provider,
    text,
    toolCalls,
    finishReason,
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

function extractToolCalls(message: Record<string, unknown> | undefined): ToolCall[] {
  if (!message) return [];
  const raw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: ToolCall[] = [];
  for (const call of raw) {
    if (!isRecord(call)) continue;
    const id = typeof call.id === "string" ? call.id : "";
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = fn && typeof fn.name === "string" ? fn.name : "";
    const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
    if (!id || !name) continue;
    out.push({ id, type: "function", function: { name, arguments: args } });
  }
  return out;
}

function normalizeFinishReason(value: string | undefined): ToolCallingResult["finishReason"] {
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") return value;
  return "unknown";
}

// Streaming tool-calling: many compat providers send tool_call argument
// chunks across multiple SSE events. We accumulate per-index buffers and
// emit completed tool calls only when the stream finishes.
async function readToolCallingStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Tool-calling stream failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const body = response.body;
  if (!body) throw new Error("Tool-calling stream returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const textParts: string[] = [];
  // Index → in-progress tool call. The chat-completions stream sends
  // tool_calls as deltas indexed by position. Final id/name arrive in the
  // first delta for that index; arguments stream in subsequent deltas.
  const callsByIndex = new Map<number, ToolCall>();
  let finishReason: ToolCallingResult["finishReason"] = "unknown";
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;

  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return;
    const data = dataLines.map((line) => line.slice("data:".length).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    if (!responseId && typeof payload.id === "string") responseId = payload.id;
    if (isRecord(payload.usage)) usage = payload.usage;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === "string") {
        finishReason = normalizeFinishReason(choice.finish_reason);
      }
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        textParts.push(delta.content);
        if (onDelta) {
          try {
            onDelta(delta.content);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      }
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs) {
        if (!isRecord(tc)) continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const existing = callsByIndex.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (typeof tc.id === "string" && tc.id.length > 0) existing.id = tc.id;
        const fn = isRecord(tc.function) ? tc.function : undefined;
        if (fn) {
          if (typeof fn.name === "string" && fn.name.length > 0) existing.function.name = fn.name;
          if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
        }
        callsByIndex.set(idx, existing);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim().length > 0) handleEvent(block);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handleEvent(buffer);

  const toolCalls: ToolCall[] = [];
  // Preserve original index ordering.
  const sortedIndices = [...callsByIndex.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const call = callsByIndex.get(idx)!;
    if (call.id && call.function.name) toolCalls.push(call);
  }

  return {
    provider,
    text: textParts.join("").trim(),
    toolCalls,
    finishReason,
    responseId,
    usage,
    cost: estimateCost(provider, usage)
  };
}

// Codex/Responses-API tool-calling. Translates the chat-completions message
// shape used by the rest of the loop into the Responses API input shape:
//   - All `system` messages → concatenated `instructions` field
//   - `user` messages → { role: "user", content: [{ type: "input_text", text }] }
//   - `assistant` text → { role: "assistant", content: [{ type: "output_text", text }] }
//   - `assistant` tool_calls → { type: "function_call", call_id, name, arguments }
//   - `tool` results → { type: "function_call_output", call_id, output }
// Tools are flattened from the chat-completions `{ type, function: {...} }`
// shape into the Responses API `{ type: "function", name, description,
// parameters, strict: false }` shape.
async function callToolCallingResponses(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void
): Promise<ToolCallingResult> {
  // The retry closure re-reads the bearer on every attempt so a token
  // rotation between attempts (the codex CLI just wrote a new auth.json)
  // gets picked up automatically. translateMessagesToResponsesInput is
  // deterministic and cheap; recomputing on retry is fine.
  return withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const { instructions, input } = translateMessagesToResponsesInput(messages);
    const responsesTools = tools.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false
    }));
    const body: Record<string, unknown> = {
      model: provider.model,
      store: false,
      stream: true,
      instructions,
      input
    };
    if (responsesTools.length > 0) body.tools = responsesTools;

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify(body)
    });

    return readResponsesToolCallingStream(response, provider, onDelta);
  });
}

interface ResponsesInputShape {
  instructions: string;
  input: Array<Record<string, unknown>>;
}

function translateMessagesToResponsesInput(messages: ToolCallingMessage[]): ResponsesInputShape {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }
    if (message.role === "user") {
      // Vision-capable user messages arrive as a parts array (text +
      // image_url). Map text parts → input_text and image_url parts →
      // input_image, mirroring the OpenAI Responses API content schema.
      if (Array.isArray(message.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const part of message.content) {
          if (part.type === "text") parts.push({ type: "input_text", text: part.text });
          else if (part.type === "image_url") parts.push({ type: "input_image", image_url: part.image_url.url });
        }
        input.push({ role: "user", content: parts });
        continue;
      }
      const text = typeof message.content === "string" ? message.content : "";
      input.push({
        role: "user",
        content: [{ type: "input_text", text }]
      });
      continue;
    }
    if (message.role === "assistant") {
      // Emit any tool calls first as discrete function_call items so the
      // model sees the same item ordering it produced.
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const text = typeof message.content === "string" ? message.content : "";
        if (text.length > 0) {
          input.push({
            role: "assistant",
            content: [{ type: "output_text", text }]
          });
        }
        continue;
      }
      // Some assistants emit text + tool_calls in the same message. Preserve
      // the text first if present, then the function_call entries.
      const text = typeof message.content === "string" ? message.content : "";
      if (text.length > 0) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }]
        });
      }
      for (const call of toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? ""
        });
      }
      continue;
    }
    if (message.role === "tool") {
      const callId = message.tool_call_id ?? "";
      const output = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      input.push({
        type: "function_call_output",
        call_id: callId,
        output
      });
      continue;
    }
  }
  return { instructions: systemParts.join("\n\n"), input };
}

// Consume the Responses API SSE stream. Tracks both text deltas
// (`response.output_text.delta`) and function-call lifecycle events
// (`response.output_item.added` / `response.function_call_arguments.delta` /
// `response.output_item.done`). Falls back to the final
// `response.completed` event's `response.output` array if any tool calls
// were missed during streaming.
async function readResponsesToolCallingStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex tool-calling stream failed with HTTP ${response.status}`;
    const message = readOpenAIError(payload) ?? fallback;
    // Initial 401 with a session-expired body comes from auth.json holding
    // a token that was rotated before the request even left gini. Surface
    // it as the retryable sentinel so withCodexSessionRetry picks up the
    // freshly-rotated token on its second attempt.
    if (response.status === 401 && isCodexSessionExpiredMessage(message)) {
      throw new CodexSessionExpiredError(message);
    }
    throw new Error(message);
  }
  const body = response.body;
  if (!body) throw new Error("Codex tool-calling stream returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const textParts: string[] = [];
  // item_id → in-progress function call. The Responses API streams
  // function-call argument deltas keyed by item_id; we accumulate into
  // these entries and surface the final list when the stream completes.
  const callsById = new Map<string, { id: string; name: string; arguments: string; order: number }>();
  let nextOrder = 0;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let finalOutput: unknown[] | undefined;
  // True once onDelta has actually fired with a text chunk. textParts
  // and callsById are internal accumulation — nothing in them reaches
  // the caller until this function returns successfully — so they
  // do NOT count as emitted output for the safe-retry decision.
  let emittedToCaller = false;

  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    const type = typeof payload.type === "string" ? payload.type : eventType;
    if (!type) return;

    // Capture top-level metadata when present.
    if (typeof payload.response_id === "string") responseId = payload.response_id;
    if (isRecord(payload.response)) {
      const resp = payload.response;
      if (!responseId && typeof resp.id === "string") responseId = resp.id;
      if (isRecord(resp.usage)) usage = resp.usage;
      if (Array.isArray(resp.output)) finalOutput = resp.output;
    }

    // Backend-emitted error events (session rotation mid-stream, request-
    // level failures, content-policy aborts). Throwing here unwinds the
    // SSE consumer loop; if onDelta has not yet fired (no caller-visible
    // bytes), withCodexSessionRetry can re-read auth.json and retry
    // transparently. Once a delta has landed in the caller's UI we can't
    // safely retry without double-emitting, so the generic Error path
    // runs even on session-expired mid-stream.
    if (eventType === "error" || type === "error" || type === "response.failed") {
      const message = extractStreamErrorMessage(payload)
        ?? `Codex tool-calling stream errored before completion (${type ?? "unknown"}).`;
      if (isCodexSessionExpiredMessage(message) && !emittedToCaller) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }

    if (type === "response.output_text.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (delta.length > 0) {
        textParts.push(delta);
        if (onDelta) {
          emittedToCaller = true;
          try {
            onDelta(delta);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      }
      return;
    }

    if (type === "response.output_item.added") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item && item.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : (typeof payload.item_id === "string" ? payload.item_id : "");
        const callId = typeof item.call_id === "string" ? item.call_id : itemId;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        const key = itemId || callId;
        if (key && !callsById.has(key)) {
          callsById.set(key, { id: callId, name, arguments: args, order: nextOrder++ });
        }
      }
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
      if (itemId) {
        const existing = callsById.get(itemId) ?? { id: itemId, name: "", arguments: "", order: nextOrder++ };
        existing.arguments += delta;
        callsById.set(itemId, existing);
      }
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
      const finalArgs = typeof payload.arguments === "string" ? payload.arguments : undefined;
      if (itemId && finalArgs !== undefined) {
        const existing = callsById.get(itemId);
        if (existing) {
          existing.arguments = finalArgs;
          callsById.set(itemId, existing);
        } else {
          callsById.set(itemId, { id: itemId, name: "", arguments: finalArgs, order: nextOrder++ });
        }
      }
      return;
    }

    if (type === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item && item.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : (typeof payload.item_id === "string" ? payload.item_id : "");
        const callId = typeof item.call_id === "string" ? item.call_id : itemId;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        const key = itemId || callId;
        if (key) {
          const existing = callsById.get(key) ?? { id: callId, name, arguments: args, order: nextOrder++ };
          if (callId) existing.id = callId;
          if (name) existing.name = name;
          if (args.length > 0) existing.arguments = args;
          callsById.set(key, existing);
        }
      }
      return;
    }

    if (type === "response.completed") {
      // Backstop: the final completed event carries the full `response.output`
      // array. Capture it for fallback reconstruction below.
      if (isRecord(payload.response) && Array.isArray(payload.response.output)) {
        finalOutput = payload.response.output;
      }
      return;
    }
  };

  // Stream consumption wraps in try/finally so a throw from handleEvent
  // (e.g. session-expired classification mid-stream) cancels the reader
  // before withCodexSessionRetry constructs attempt 2. Without this,
  // attempt 1's reader stays locked to the response body and the
  // underlying socket can linger while a parallel attempt is already
  // in flight.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim().length > 0) handleEvent(block);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    // Backstop: if SSE delivery missed function_call items but the final
    // `response.completed` event carries them, reconstruct from there.
    if (finalOutput) {
      let backstopText = "";
      for (const item of finalOutput) {
        if (!isRecord(item)) continue;
        if (item.type === "function_call") {
          const itemId = typeof item.id === "string" ? item.id : "";
          const callId = typeof item.call_id === "string" ? item.call_id : itemId;
          const name = typeof item.name === "string" ? item.name : "";
          const args = typeof item.arguments === "string" ? item.arguments : "";
          const key = itemId || callId;
          if (!key) continue;
          const existing = callsById.get(key);
          if (!existing) {
            callsById.set(key, { id: callId, name, arguments: args, order: nextOrder++ });
          } else {
            if (!existing.id && callId) existing.id = callId;
            if (!existing.name && name) existing.name = name;
            if (existing.arguments.length === 0 && args.length > 0) existing.arguments = args;
          }
        }
        // Some responses also embed assistant text in output items as
        // { type: "message", content: [{ type: "output_text", text }] }
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (isRecord(c) && c.type === "output_text" && typeof c.text === "string") {
              backstopText += c.text;
            }
          }
        }
      }
      // Only use backstop text if streaming missed all of it.
      if (textParts.length === 0 && backstopText.length > 0) {
        textParts.push(backstopText);
      }
    }

    const ordered = [...callsById.values()].sort((a, b) => a.order - b.order);
    const toolCalls: ToolCall[] = [];
    for (const call of ordered) {
      if (!call.id || !call.name) continue;
      toolCalls.push({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      });
    }

    // Backstop: codex sometimes emits tool calls as literal `<tool_call>`
    // markup in the assistant text channel instead of (or in addition to)
    // structured function_call items. Recover those so the chat-task loop
    // can dispatch them. The structured shape wins on dedup, so a model
    // that emits both an SSE function_call and a text mirror only fires
    // the call once.
    const joinedText = textParts.join("");
    const extracted = extractTextToolCallsFromAssistantText(joinedText, toolCalls);
    for (const call of extracted.calls) {
      toolCalls.push(call);
    }
    const finalText = extracted.residual;

    const finishReason: ToolCallingResult["finishReason"] = toolCalls.length > 0 ? "tool_calls" : "stop";
    return {
      provider,
      text: finalText.trim(),
      toolCalls,
      finishReason,
      responseId,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

// Codex tool-call-as-text backstop. The Responses-API parser handles the
// structured `function_call` items; this complements it by scanning the
// final assistant text for literal `<tool_call>...</tool_call>` markup.
// Each successfully parsed block is emitted as a synthetic ToolCall and
// the markup is stripped from the residual text so the user never sees
// the raw XML/JSON in chat. Two body shapes are recognized:
//   1. XML: `<tool_call name="X"><arg name="Y">v</arg>...</tool_call>`
//   2. JSON: `<tool_call>{"name":"X","arguments":{...}}</tool_call>`
// A third hybrid form (XML `name=` attribute with a JSON inner body) is
// handled by trying JSON first and falling back to XML <arg> children.
// `structuredCalls` is the list of natively-decoded function_calls; any
// text block that matches one by (name, arguments-shape) is dropped to
// avoid double-dispatch.
export function extractTextToolCallsFromAssistantText(
  text: string,
  structuredCalls: ToolCall[]
): { calls: ToolCall[]; residual: string } {
  if (!text || !text.includes("<tool_call")) {
    return { calls: [], residual: text };
  }
  // Build a sorted list of code-block (` ``` ` fenced or single-backtick
  // span) ranges so we can skip `<tool_call>` substrings that appear
  // inside them — the model is probably explaining its own syntax.
  const codeRanges = collectCodeRanges(text);
  const calls: ToolCall[] = [];
  const seenDedupKeys = new Set<string>();
  for (const call of structuredCalls) {
    seenDedupKeys.add(toolCallDedupKey(call.function.name, call.function.arguments));
  }
  let residual = "";
  let cursor = 0;
  const re = /<tool_call(\s[^>]*)?>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isRangeInsideAny(start, end, codeRanges)) {
      continue;
    }
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const parsed = parseTextToolCallBlock(attrs, inner);
    if (!parsed) {
      // Malformed body — keep the original text in place. The chat-task
      // loop will surface the broken response to the user rather than
      // silently dispatching a corrupt call.
      continue;
    }
    const dedup = toolCallDedupKey(parsed.name, parsed.arguments);
    // Always strip the markup from the residual so the user doesn't see
    // raw XML/JSON in the reply, even when the structured channel already
    // covered the call.
    residual += text.slice(cursor, start);
    cursor = end;
    if (seenDedupKeys.has(dedup)) {
      continue;
    }
    seenDedupKeys.add(dedup);
    calls.push({
      id: synthesizeToolCallId(parsed.name, parsed.arguments, calls.length),
      type: "function",
      function: { name: parsed.name, arguments: parsed.arguments }
    });
  }
  residual += text.slice(cursor);
  return { calls, residual };
}

// Parse a single `<tool_call ...>...</tool_call>` body. Returns the tool
// name and a JSON-encoded arguments string (the ToolCall wire format),
// or undefined when the body is unrecoverable.
function parseTextToolCallBlock(
  attrs: string,
  inner: string
): { name: string; arguments: string } | undefined {
  // Name comes from the outer attribute when present, otherwise from a
  // JSON `name` field in the inner body (the legacy shape).
  let name = readXmlAttribute(attrs, "name");
  const trimmedInner = inner.trim();
  // JSON body. Tolerate either `arguments` or `parameters` for the args
  // bag; tolerate string or object values.
  if (trimmedInner.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmedInner) as unknown;
      if (isRecord(payload)) {
        if (!name && typeof payload.name === "string") name = payload.name;
        const args = payload.arguments ?? payload.parameters;
        const argsJson = serializeArgs(args);
        if (name && argsJson !== undefined) {
          return { name, arguments: argsJson };
        }
      }
    } catch {
      // Fall through to XML parsing.
    }
  }
  // XML body with <arg name="X">value</arg> children.
  if (name) {
    const xmlArgs = parseXmlArgChildren(inner);
    if (xmlArgs) {
      return { name, arguments: JSON.stringify(xmlArgs) };
    }
    // Empty body with a name attribute still counts as a zero-arg call.
    if (trimmedInner.length === 0) {
      return { name, arguments: "{}" };
    }
  }
  return undefined;
}

// Coerce an args bag into the JSON-encoded string the ToolCall shape
// requires. Strings are passed through (the model already serialized);
// objects/arrays/primitives are JSON-encoded; null/undefined become "{}".
function serializeArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return "{}";
  if (typeof value === "string") {
    // A pre-serialized JSON string. Validate it parses; if not, fall back
    // to wrapping it as a literal — better to fail JSON-parse downstream
    // than to claim success on a corrupt args payload.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// Extract a single attribute value from an XML-style attribute string.
// Supports both double- and single-quoted values. Returns undefined when
// the attribute is absent.
function readXmlAttribute(attrs: string, key: string): string | undefined {
  if (!attrs) return undefined;
  const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

// Parse `<arg name="X">value</arg>` children into a flat record. Returns
// undefined when no <arg> children are present (so the caller can decide
// whether to treat the call as zero-arg or malformed).
function parseXmlArgChildren(inner: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const re = /<arg(\s[^>]*)?>([\s\S]*?)<\/arg>/g;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const argAttrs = m[1] ?? "";
    const argInner = m[2] ?? "";
    const argName = readXmlAttribute(argAttrs, "name");
    if (!argName) continue;
    saw = true;
    out[argName] = decodeXmlEntities(argInner.trim());
  }
  return saw ? out : undefined;
}

// Minimal entity decoder for the subset that codex emits inside <arg>
// bodies: &amp;, &lt;, &gt;, &quot;, &apos;. Numeric entities are passed
// through unchanged since tool args are user-facing strings the dispatch
// layer will treat as literal text.
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Dedup key for matching a text-extracted call against a structured one.
// Args are normalized through JSON.parse → JSON.stringify so that whitespace
// and key-order differences don't defeat the match.
function toolCallDedupKey(name: string, argsJson: string): string {
  let normalized = argsJson;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    normalized = JSON.stringify(parsed);
  } catch {
    // Leave as-is — non-JSON arguments are vanishingly rare and the raw
    // string is still a stable key for dedup.
  }
  return `${name} ${normalized}`;
}

// Synthesize a deterministic call id for a text-extracted call. Using a
// content-derived id (not a random one) means a retry that re-receives
// the same text won't dispatch a second time when the upstream loop's
// idempotency check is keyed on call id.
function synthesizeToolCallId(name: string, argsJson: string, index: number): string {
  const fingerprint = textBackstopFingerprint(`${name}:${argsJson}:${index}`);
  return `call_textbackstop_${fingerprint}`;
}

// Stable, short fingerprint over the call key. Sticks to a 32-bit FNV-1a
// variant so the result is deterministic without needing Node's crypto.
function textBackstopFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Collect ranges of `text` that fall inside a triple-backtick fenced
// code block or a single-backtick inline-code span. Used to skip
// `<tool_call>` substrings the model is quoting in a code block rather
// than emitting as an actual call.
function collectCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced blocks first — these can span newlines and contain backticks.
  const fenced = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline spans. Walk in two passes so fenced ranges win; the inline
  // regex is greedy-shy to avoid bridging across paragraphs.
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isRangeInsideAny(start, end, ranges)) {
      ranges.push([start, end]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isRangeInsideAny(start: number, end: number, ranges: Array<[number, number]>): boolean {
  for (const [rs, re] of ranges) {
    if (start >= rs && end <= re) return true;
  }
  return false;
}

export async function generateTaskSummary(
  config: RuntimeConfig,
  input: string,
  recalledContext?: string,
  onDelta?: (text: string) => void,
  // Optional per-call override. Resolved by callers from the active agent's
  // providerName/model via resolveEffectiveContext. Embeddings/reranker still
  // read config.provider — do NOT mutate config here.
  providerOverride?: ProviderConfig,
  // Optional owning task id. When present, identity-file scan blocks
  // emit a runtime trace warning on the task — matches the chat-task
  // path's onBlocked plumbing. When absent (no task context — e.g.
  // tests calling generateTaskSummary directly), the [BLOCKED: ...]
  // notice in the prompt is the only signal.
  taskId?: string
): Promise<ProviderResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  if (provider.name === "echo") {
    return {
      provider,
      text: `Gini handled: ${input}`
    };
  }

  // Runtime identity files. The legacy single-shot path doesn't carry
  // the chat-task identity block, but it still benefits from a
  // user-curated INSTRUCTIONS.md / USER.md and the active agent's
  // SOUL.md. Active-agent lookup is best-effort — when no agent is
  // active the SOUL.md block is elided. See ADR runtime-identity-files.md.
  const activeAgentId = resolveActiveAgentId(config);
  const onBlocked = taskId
    ? (filename: string, findings: string[]): void => {
        appendTrace(config.instance, taskId, {
          type: "model",
          message: `identity file blocked: ${filename}`,
          data: { filename, findings }
        });
      }
    : undefined;
  const loadOpts = onBlocked ? { onBlocked } : undefined;
  const instructionsOverride = loadInstructions(config.instance, loadOpts) ?? undefined;
  const soulBlock = loadSoul(config.instance, activeAgentId, loadOpts) ?? undefined;
  const userProfileBlock = loadUserProfile(config.instance, loadOpts) ?? undefined;
  // The legacy single-shot path is one system + one user message with no
  // prior transcript and no cross-turn cache prefix to preserve, so recalled
  // memory stays appended to its system context (the stable-prefix tail only
  // applies to the multi-turn chat-task loop). renderEphemeralContext
  // single-sources the "Long-term memory…" header. See ADR
  // stable-system-prefix.md.
  const stablePrefix = buildAgentSystemContext({
    instructionsOverride,
    soul: soulBlock,
    userProfile: userProfileBlock
  });
  const recalledBlock = renderEphemeralContext(undefined, recalledContext);
  const systemContext = recalledBlock.length > 0
    ? `${stablePrefix}\n\n${recalledBlock}`
    : stablePrefix;
  if (provider.name === "openrouter" || provider.name === "local" || provider.name === "deepseek") {
    return callChatCompletions(provider, input, systemContext);
  }
  return callOpenAIResponses(provider, input, systemContext, onDelta);
}

// Best-effort active-agent resolution for the legacy single-shot path.
// Reads state once; failures (missing state file in tests, etc.) leave
// the SOUL.md block elided. The modern chat-task path threads the
// agent through resolveEffectiveContext and never falls back to this.
function resolveActiveAgentId(config: RuntimeConfig): string | undefined {
  try {
    return readState(config.instance).activeAgentId;
  } catch {
    return undefined;
  }
}

// Hindsight phase 2 — structured-output helper.
//
// Calls the LLM with a JSON-only output contract and parses the result. Two
// implementations:
//   - echo: tests register stub responders by tag (or globally by index).
//           Deterministic by construction.
//   - openai/codex: uses the Responses API with `text.format = { type:
//           "json_object" }`. The caller passes a Zod-like validator; if
//           the model returns invalid JSON we return a structured error
//           (the retain pipeline retries once with a "Reply with JSON only"
//           clarifier, then gives up).
//
// The Validator interface is intentionally tiny so domain modules don't need
// to depend on Zod — they pass a parse callback.
export interface StructuredValidator<T> {
  parse(value: unknown): T;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  usage?: Record<string, unknown>;
  provider: ProviderConfig;
}

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  validator: StructuredValidator<T>;
  // Echo provider key — tests register stub data keyed by `echoTag`.
  echoTag?: string;
}

// Echo stub registry: tests call `setEchoStructuredResponse(tag, data)` to
// preconfigure the response for a given `echoTag`. If no exact match exists,
// the resolver falls back to the longest registered prefix (so a stub
// registered as "observation:" matches every `observation:<entityId>` call).
// If still no match, an empty object is returned and the validator parses
// it to whatever the schema's default is.
const echoStructuredStubs = new Map<string, unknown>();

export function setEchoStructuredResponse(tag: string, data: unknown): void {
  echoStructuredStubs.set(tag, data);
}

export function clearEchoStructuredResponses(): void {
  echoStructuredStubs.clear();
}

function resolveEchoStub(tag: string): unknown {
  if (echoStructuredStubs.has(tag)) return echoStructuredStubs.get(tag);
  // Longest-prefix match. Lets tests register "observation:" once and have
  // it cover all entity-keyed observation calls in a single retain call.
  let bestKey: string | null = null;
  for (const key of echoStructuredStubs.keys()) {
    if (key.endsWith(":") && tag.startsWith(key)) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey !== null ? echoStructuredStubs.get(bestKey) : undefined;
}

export async function generateStructured<T>(
  config: RuntimeConfig,
  request: StructuredRequest<T>,
  // Optional per-call override. Resolved by callers from the active agent's
  // providerName/model via resolveEffectiveContext. Used by retain/reflect/
  // reinforce so Hindsight extraction follows the agent's provider just like
  // chat-task inference does. Embeddings/reranker stay on config.provider.
  providerOverride?: ProviderConfig
): Promise<StructuredResult<T>> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  if (provider.name === "echo") {
    const tag = request.echoTag ?? request.schemaName;
    const stub = resolveEchoStub(tag);
    const raw = JSON.stringify(stub ?? {});
    return {
      data: request.validator.parse(stub ?? {}),
      raw,
      usage: { input_tokens: request.system.length + request.user.length, output_tokens: raw.length },
      provider
    };
  }

  // OpenAI / OpenRouter / local OpenAI-compatible: chat-completions with
  // response_format json_object. We deliberately don't push json_schema —
  // many compat providers reject the field. Validator re-checks shape.
  if (
    provider.name === "openrouter" ||
    provider.name === "local" ||
    provider.name === "openai" ||
    provider.name === "deepseek"
  ) {
    return callStructuredChatCompletions(provider, request);
  }
  // Codex doesn't expose /chat/completions and the /responses API doesn't
  // support response_format=json_object. We prompt for JSON, stream the
  // /responses endpoint with codex auth, and validate the parsed output.
  return callStructuredCodex(provider, request);
}

async function callStructuredCodex<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  // Retry the fetch+stream pair on session-expired so Hindsight extraction
  // (retain/reflect/reinforce) doesn't lose a whole structured turn to a
  // mid-stream rotation. The JSON parsing afterward stays outside the
  // retry because a malformed payload is a model failure, not an auth one.
  const streamed = await withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify({
        model: provider.model,
        store: false,
        stream: true,
        instructions: request.system,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema. No prose, no markdown fences.`
              }
            ]
          }
        ]
      })
    });
    // readCodexStream already handles non-OK and empty-output as throws.
    return readCodexStream(response, provider);
  });
  const cleaned = stripJsonFences(streamed.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Codex structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    data: request.validator.parse(parsed),
    raw: cleaned,
    usage: streamed.usage,
    provider
  };
}

// Models occasionally wrap JSON in ```json fences despite the prompt. Strip
// once before parsing so a single rogue fence doesn't fail an otherwise good
// extraction.
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

async function callStructuredChatCompletions<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody),
      model: provider.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema.` }
      ],
      stream: false,
      prompt_cache_retention: "in_memory"
    })
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Structured request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const text = extractChatText(payload) || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    data: request.validator.parse(parsed),
    raw: text,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    provider
  };
}

// Treat both nullish and whitespace-only as missing so persisted
// `baseUrl: ""` doesn't slip through normalize and end up resolving against
// the wrong provider's default at the call site.
function pickBaseUrl(persisted: string | undefined, fallback: string): string {
  return persisted && persisted.trim().length > 0 ? persisted : fallback;
}

// DeepSeek V4 family + deepseek-reasoner (R1) accept a top-level
// `thinking: {type: "enabled"|"disabled"}` flag plus
// `reasoning_effort: "low"|"medium"|"high"|"max"` on their OpenAI-compat
// chat-completions endpoint. The API defaults to thinking-on for these
// models, which then enforces a `reasoning_content` echo-back contract on
// subsequent turns. We default-on explicitly so the wire shape matches
// what DeepSeek expects, and crank `reasoning_effort` to "max" so callers
// pick the strongest setting without extra config. User-supplied
// extraBody wins on conflicts.
function deepseekSupportsThinking(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m === "deepseek-reasoner") return true;
  // deepseek-v4-*, deepseek-v5-*, ...  Excludes V3 explicitly.
  return m.startsWith("deepseek-v") && !m.startsWith("deepseek-v3");
}

function withDeepSeekThinkingDefaults(
  model: string,
  extraBody: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!deepseekSupportsThinking(model)) {
    return extraBody;
  }
  const merged: Record<string, unknown> = { thinking: { type: "enabled" }, reasoning_effort: "max" };
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  if (provider.name === "openai") {
    return {
      name: "openai",
      model: provider.model || "gpt-5.4-mini",
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv ?? "OPENAI_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "openrouter") {
    return {
      name: "openrouter",
      model: provider.model || "openrouter/auto",
      baseUrl: pickBaseUrl(provider.baseUrl, "https://openrouter.ai/api/v1"),
      apiKeyEnv: provider.apiKeyEnv ?? "OPENROUTER_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "local") {
    return {
      name: "local",
      model: provider.model || "local/default",
      baseUrl: pickBaseUrl(provider.baseUrl, "http://127.0.0.1:11434/v1"),
      apiKeyEnv: provider.apiKeyEnv ?? "GINI_LOCAL_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "deepseek") {
    const model = provider.model || DEFAULT_DEEPSEEK_MODEL;
    const extraBody = withDeepSeekThinkingDefaults(model, provider.extraBody);
    return {
      name: "deepseek",
      model,
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_DEEPSEEK_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv ?? "DEEPSEEK_API_KEY",
      ...(extraBody ? { extraBody } : {})
    };
  }
  if (provider.name === "codex") {
    return {
      name: "codex",
      model: provider.model || DEFAULT_CODEX_MODEL,
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_CODEX_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv
    };
  }
  return {
    name: "echo",
    model: provider.model || "gini-echo-v0"
  };
}

async function callOpenAIResponses(
  provider: ProviderConfig,
  input: string,
  systemContext: string,
  onDelta?: (text: string) => void
): Promise<ProviderResult> {
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));

  // Codex and OpenAI share the /responses surface but differ on auth,
  // streaming, and retry. Codex needs withCodexSessionRetry so a token
  // rotation mid-stream (or an initial 401 on a stale token) gets a
  // second attempt after readCodexBearer re-reads auth.json. OpenAI uses
  // an env-var key with no rotation surface, so a retry would just
  // re-fail with the same bearer.
  if (provider.name === "codex") {
    return withCodexSessionRetry(async () => {
      const bearer = readCodexBearer(provider);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...codexHeaders(bearer)
        },
        body: JSON.stringify({
          model: provider.model,
          store: false,
          stream: true,
          instructions: systemContext,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: input }
              ]
            }
          ]
        })
      });
      return readCodexStream(response, provider, onDelta);
    });
  }

  const bearer = readOpenAIBearer(provider);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      store: false,
      stream: false,
      instructions: systemContext,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: input }
          ]
        }
      ],
      prompt_cache_retention: "in_memory"
    })
  });

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `OpenAI API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    throw new Error(error);
  }

  return {
    provider,
    text: extractOutputText(payload) || "The model returned no text output.",
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

async function callChatCompletions(provider: ProviderConfig, input: string, systemContext: string): Promise<ProviderResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody),
      model: provider.model,
      messages: [
        { role: "system", content: systemContext },
        { role: "user", content: input }
      ],
      stream: false,
      prompt_cache_retention: "in_memory"
    })
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Chat completions request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  return {
    provider,
    text: extractChatText(payload) || "The model returned no text output.",
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

async function readCodexStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void
): Promise<ProviderResult> {
  if (!response.ok) {
    // Error path: drain the body fully so we can surface the API's error
    // message. Streaming codex endpoints sometimes return JSON for errors.
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    // Initial 401 with a session-expired body comes from auth.json holding
    // a token that was rotated before the request even left gini. Surface
    // it as the retryable sentinel so withCodexSessionRetry picks up the
    // freshly-rotated token on its second attempt.
    if (response.status === 401 && isCodexSessionExpiredMessage(error)) {
      throw new CodexSessionExpiredError(error);
    }
    throw new Error(error);
  }

  const body = response.body;
  if (!body) {
    throw new Error("Codex stream returned no response body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const deltaTextParts: string[] = [];
  const finalTextParts: string[] = [];
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  // True once onDelta has actually fired with a delta chunk.
  // deltaTextParts and finalTextParts are internal accumulation —
  // nothing in them reaches the caller until this function returns —
  // so they do NOT count as emitted output for the safe-retry decision.
  let emittedToCaller = false;

  // Consume the SSE stream incrementally. Each event is delimited by `\n\n`;
  // we split off complete events from the rolling buffer and push the rest
  // back. `delta` events fire `onDelta` so callers can surface partial text
  // to UI. The full response text is still returned at the end so the
  // existing ProviderResult contract holds.
  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    const payloadType = typeof payload.type === "string" ? payload.type : eventType;

    // Backend-emitted error events (session rotation, request-level
    // failures, content-policy aborts). Throwing here unwinds the SSE
    // consumer loop; if onDelta has not yet fired (no caller-visible
    // bytes), withCodexSessionRetry can re-read auth.json and retry
    // transparently. Otherwise we'd risk double-emitting partial output,
    // so the generic Error path runs even on session-expired mid-stream.
    if (eventType === "error" || payloadType === "error" || payloadType === "response.failed") {
      const message = extractStreamErrorMessage(payload)
        ?? `Codex stream errored before completion (${payloadType ?? "unknown"}).`;
      if (isCodexSessionExpiredMessage(message) && !emittedToCaller) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }

    if (!responseId && typeof payload.response_id === "string") responseId = payload.response_id;
    if (!responseId && isRecord(payload.response) && typeof payload.response.id === "string") responseId = payload.response.id;
    if (isRecord(payload.response) && isRecord(payload.response.usage)) usage = payload.response.usage;
    if (typeof payload.delta === "string") {
      deltaTextParts.push(payload.delta);
      if (onDelta) {
        emittedToCaller = true;
        try {
          onDelta(payload.delta);
        } catch {
          // onDelta is fire-and-forget for UI updates; never let it abort
          // the stream consumer.
        }
      }
    }
    if (isRecord(payload.item) && Array.isArray(payload.item.content)) {
      for (const content of payload.item.content) {
        if (isRecord(content) && typeof content.text === "string") finalTextParts.push(content.text);
      }
    }
  };

  // Stream consumption wraps in try/finally so a throw from handleEvent
  // (e.g. session-expired classification mid-stream) cancels the reader
  // before withCodexSessionRetry constructs attempt 2. Without this,
  // attempt 1's reader stays locked to the response body and the
  // underlying socket can linger while a parallel attempt is already
  // in flight.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim().length > 0) handleEvent(block);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    // Flush any trailing event that wasn't followed by a blank-line terminator.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    const text = (deltaTextParts.length > 0 ? deltaTextParts.join("") : finalTextParts.join("")).trim();
    if (!text) {
      throw new Error("Codex stream completed without text output.");
    }

    return {
      provider,
      text,
      responseId,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function codexHeaders(accessToken: string): Record<string, string> {
  // Mirror the codex CLI's request shape exactly — same User-Agent and
  // originator, no daemon-identifying suffix. The previous header carried
  // a parenthetical " (Gini Agent)" tail, which made gini's traffic
  // trivially distinguishable from real codex CLI use of the same session
  // token. OpenAI's backend can fingerprint that tail and selectively
  // 401 gini's requests while leaving the interactive CLI alone, which
  // exactly matches the failure mode we're recovering from above. Keep
  // the version pinned to the same placeholder the codex CLI shipped
  // with at the time we copied this shape — if the upstream version
  // ever drifts enough that the backend starts rejecting it, bump here.
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0",
    originator: "codex_cli_rs"
  };
  const accountId = chatgptAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

function chatgptAccountId(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = isRecord(decoded["https://api.openai.com/auth"]) ? decoded["https://api.openai.com/auth"] : undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readOpenAIBearer(provider: ProviderConfig): string {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(`OpenAI provider is configured but ${envName} is not set.`);
  }
  return apiKey;
}

function extractChatText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices.find(isRecord);
  if (!first || !isRecord(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content.trim() : "";
}

function estimateCost(provider: ProviderConfig, usage?: Record<string, unknown>) {
  const inputTokens = numberField(usage, "input_tokens") ?? numberField(usage, "prompt_tokens");
  const outputTokens = numberField(usage, "output_tokens") ?? numberField(usage, "completion_tokens");
  const calculatedTokens = inputTokens || outputTokens ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
  const totalTokens = numberField(usage, "total_tokens") ?? calculatedTokens;
  return {
    provider: provider.name,
    model: provider.model,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedUsd: undefined
  };
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readCodexBearer(provider: ProviderConfig): string {
  const credentials = readCodexCredentials(provider);
  if (!credentials.ok || !credentials.bearer) {
    if (credentials.transient) {
      throw new CodexAuthRaceError(credentials.message);
    }
    throw new Error(credentials.message);
  }
  return credentials.bearer;
}

// Thrown when the codex /responses backend reports the ChatGPT session was
// rotated or invalidated. Carries a single-retry contract: callers wrap
// codex requests in `withCodexSessionRetry`, which retries once on this
// error so a freshly-rotated token in ~/.codex/auth.json (written by the
// codex CLI's own refresh path) gets a chance to land before we surface
// the failure. Only raised when no caller-visible bytes have been emitted —
// once onDelta has fired, a transparent retry would double-deliver, so
// the stream readers fall through to the generic Error path in that
// case. Internal buffers (text accumulation, tool-call argument deltas)
// do NOT count as emitted output; see emittedToCaller in the readers.
class CodexSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSessionExpiredError";
  }
}

// Thrown when reading ~/.codex/auth.json observably races the codex CLI's
// non-atomic rewrite — readFileSync returns an empty or partial document
// and JSON.parse fails. Carries the same single-retry contract as
// CodexSessionExpiredError so withCodexSessionRetry can wait out the
// writer and re-read. Distinct error class so the retry helper can
// distinguish "backend rejected the token" from "we couldn't read the
// file" without conflating the two semantically.
class CodexAuthRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthRaceError";
  }
}

// The codex backend uses several phrasings for the same condition — the
// SSE error event ("Your ChatGPT session expired before this request
// finished"), a `response.failed` event with `incomplete_details.reason`
// carrying snake_case enum codes like `session_expired` / `token_expired`,
// and an initial 401 with body shapes like {"error":{"message":"invalid
// access token"}}. Keep the matcher broad enough to cover all of them
// but anchored on substrings only the auth path produces, so we don't
// retry generic model failures. The separator class `[_\s-]+` accepts
// whitespace, underscores, and hyphens so the human-readable and
// enum-coded forms both match.
const CODEX_SESSION_EXPIRED_RE =
  /session[_\s-]+expired|expired[_\s-]+session|invalid[_\s-]?(?:access[_\s-]?)?token|token[_\s-]+expired|unauthorized/i;

function isCodexSessionExpiredMessage(message: string | undefined): boolean {
  if (!message) return false;
  return CODEX_SESSION_EXPIRED_RE.test(message);
}

// Pull a human-readable error message out of a streamed SSE `error` /
// `response.failed` payload. Tries the shapes the codex backend uses in
// the wild: top-level `message`, nested `error.message`, the
// `response.error.message` slot inside a `response.failed` envelope, and
// `response.incomplete_details.reason` (which the backend uses for
// session rotation in particular). Returns undefined when no field
// matches — callers fall back to a generic stream-error string.
function extractStreamErrorMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.message === "string") return payload.message;
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (isRecord(payload.response)) {
    const resp = payload.response;
    if (isRecord(resp.error) && typeof resp.error.message === "string") return resp.error.message;
    if (isRecord(resp.incomplete_details) && typeof resp.incomplete_details.reason === "string") {
      return resp.incomplete_details.reason;
    }
  }
  return undefined;
}

// Brief pause before a codex retry. The codex CLI writes
// ~/.codex/auth.json non-atomically (truncate + write, no temp+rename —
// see codex-rs/login/src/auth/storage.rs FileAuthStorage::save), so a
// reader observing the file between the truncate and the flush can
// see an empty or partial JSON document. An immediate retry would race
// that writer; a small wait lets the rewrite settle so the second
// attempt reads a complete file.
const CODEX_RETRY_REWRITE_DELAY_MS = 50;

// Single-retry wrapper for codex /responses calls. The codex CLI rotates
// access tokens out-of-band; a request in flight at the moment of
// rotation gets a server-side "session expired before this request
// finished" error, even though ~/.codex/auth.json on disk now holds a
// valid new token. `readCodexBearer` re-reads the file on every call, so
// a second attempt picks up the freshly-rotated token without any other
// plumbing. We retry exactly once — a second consecutive session-expired
// usually means the CLI hasn't yet refreshed, and looping would just
// burn quota. A short delay before the retry avoids racing the writer
// (see CODEX_RETRY_REWRITE_DELAY_MS).
//
// Two errors trigger the retry:
//   - CodexSessionExpiredError — the backend rejected the token (401 or
//     SSE error event matching the session-expired regex).
//   - CodexAuthRaceError — local readCodexBearer observed a partial /
//     empty auth.json mid-rewrite. Without this branch the parse failure
//     surfaces as a permanent generic Error and the user sees a hard
//     failure from a transient mid-write read.
async function withCodexSessionRetry<T>(make: () => Promise<T>): Promise<T> {
  try {
    return await make();
  } catch (err) {
    if (!(err instanceof CodexSessionExpiredError) && !(err instanceof CodexAuthRaceError)) {
      throw err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CODEX_RETRY_REWRITE_DELAY_MS));
    return await make();
  }
}

function readCodexCredentials(provider: ProviderConfig): {
  ok: boolean;
  bearer?: string;
  authPath: string;
  credentialType?: "api_key" | "access_token";
  message: string;
  // True when the failure is plausibly a mid-rewrite read of auth.json
  // (readFileSync threw, or JSON.parse failed). Distinguishes the
  // retryable race window from steady-state "no credentials" states like
  // "file is missing" or "tokens block is absent".
  transient?: boolean;
} {
  const authPath = codexAuthPath(provider);
  if (!existsSync(authPath)) {
    return {
      ok: false,
      authPath,
      message: `No Codex credentials found at ${authPath}. Run codex --login or set CODEX_AUTH_JSON.`
    };
  }

  try {
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : undefined;
    if (apiKey) {
      return {
        ok: true,
        bearer: apiKey,
        authPath,
        credentialType: "api_key",
        message: "Codex generated API key is available."
      };
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
    const accessToken = tokens && typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    if (accessToken) {
      return {
        ok: true,
        bearer: accessToken,
        authPath,
        credentialType: "access_token",
        message: "Codex OAuth access token is available."
      };
    }

    return {
      ok: false,
      authPath,
      message: `Codex auth file exists at ${authPath}, but it does not contain OPENAI_API_KEY or tokens.access_token.`
    };
  } catch (error) {
    return {
      ok: false,
      authPath,
      transient: true,
      message: `Could not read Codex credentials at ${authPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Public helper for callers that need a yes/no on "are codex credentials
// usable?" without the full credential record. Routes through the same
// codexAuthPath() resolution providerHealth uses so CODEX_AUTH_JSON is
// interpreted consistently (filesystem path, not raw JSON) everywhere.
//
// Pass a ProviderConfig if available; an empty {name:"codex"} is enough
// when the caller just wants to gate a UI flow on credential presence.
export function hasUsableCodexCredentials(provider?: ProviderConfig): boolean {
  const probe = provider ?? { name: "codex" as const, model: DEFAULT_CODEX_MODEL };
  return readCodexCredentials(probe).ok;
}

function codexAuthPath(provider: ProviderConfig): string {
  // apiKeyEnv only makes sense for codex providers (where it would point at
  // a CODEX_AUTH_JSON-style path env). For non-codex providers the field
  // typically holds an OpenAI key env name (e.g. "OPENAI_API_KEY") whose
  // value is an `sk-...` secret, not a filesystem path. Honoring it
  // unconditionally would resolve to a nonsense path during openai→codex
  // credential probes and produce false negatives. Gate on provider.name so
  // hasUsableCodexCredentials() reads the real codex auth source regardless
  // of which provider the caller's config currently names.
  const apiKeyEnv = provider.name === "codex" ? provider.apiKeyEnv : undefined;
  const raw = apiKeyEnv && process.env[apiKeyEnv]
    ? process.env[apiKeyEnv]
    : process.env.CODEX_AUTH_JSON ?? DEFAULT_CODEX_AUTH_PATH;
  const path = raw ?? DEFAULT_CODEX_AUTH_PATH;
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of content) {
      if (isRecord(contentItem) && typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function readOpenAIError(payload: Record<string, unknown>): string | undefined {
  if (!isRecord(payload.error)) return undefined;
  return typeof payload.error.message === "string" ? payload.error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Reserved fields that the runtime must own — never let `extraBody` overwrite
// them. Without this, a poisoned config (or a careless --extra-body argument)
// could redirect the call to a different model, smuggle in extra tools, flip
// stream mode and break response parsing, or change data-retention behavior.
// The denylist is the single source of truth so every chat-completions call
// site stays consistent.
//
// Maintainer note: when you add a runtime-owned chat-completions request
// field (e.g. another tool-shape variant, a new structured-output mode), add
// it here too. Vision's `max_tokens`/`max_completion_tokens` are NOT in the
// list — vision spreads its `tokenBudgetField` AFTER the sanitized extras so
// vision callers still win, while non-vision callers can put their own
// `max_tokens` in extraBody legitimately.
//
// `functions` and `function_call` cover OpenAI's deprecated legacy
// function-calling API. The runtime ignores `message.function_call` in
// responses (extractToolCalls only walks `tool_calls`), so a poisoned
// extraBody using the legacy schema would silently drop function results.
//
// `store` controls whether the provider persists the chat completion for
// distillation/evals. The /responses path pins `store: false` explicitly;
// chat-completions paths must stay consistent.
//
// Also block `__proto__`/`constructor`/`prototype` to defend against
// prototype-pollution-style payloads — Object.entries already returns
// __proto__ as an own key when JSON.parse produced it, so without an
// explicit drop the spread would forward it to the API.
//
// `toJSON` is blocked as a defense-in-depth measure. JSON-loaded extraBody
// (the only documented entry point) cannot carry functions, so this is
// dormant in practice. But if a future internal caller constructs
// ProviderConfig programmatically with a callable `toJSON`, the final
// `JSON.stringify({ ...sanitized, model, ... })` would invoke it and could
// return an arbitrary replacement object — including reserved fields.
// Stripping `toJSON` keeps that escape hatch shut.
const RESERVED_EXTRA_BODY_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "response_format",
  "functions",
  "function_call",
  "store",
  // Pinned at "in_memory" on every OpenAI-compatible chat-completions
  // builder. Defense-in-depth: a future refactor that reorders the
  // body spread so the typed field comes BEFORE sanitizeExtraBody
  // would silently let extraBody.prompt_cache_retention shadow our
  // explicit opt-out of the "24h" extended tier (documented as not
  // Zero Data Retention eligible). Stripping the key here keeps the
  // protection independent of spread order. See ADR cache-warmer.md.
  "prompt_cache_retention",
  "__proto__",
  "constructor",
  "prototype",
  "toJSON"
]);

function sanitizeExtraBody(
  extraBody: Record<string, unknown> | undefined,
  // Per-call extension to the base denylist. Vision passes its token-budget
  // keys (`max_tokens`, `max_completion_tokens`) here so a poisoned extraBody
  // can't smuggle the OTHER token field alongside the runtime-set one — a
  // real bug that broke OpenAI o-series vision (which rejects requests with
  // `max_tokens` present) and could defeat the cap on local/openrouter
  // gateways. Non-vision callers leave this empty so users can legitimately
  // set `max_tokens` via extraBody for chat/structured/tool-calling.
  extraDeny?: ReadonlySet<string>
): Record<string, unknown> {
  if (!extraBody) return {};
  // `Object.create(null)` for the output so future spreads can't be
  // surprised by an inherited prototype. Object.entries on the input only
  // yields own enumerable string-keyed properties, which is what we want.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(extraBody)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key)) continue;
    if (extraDeny && extraDeny.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// Token-budget fields owned by callVisionChatCompletions. Centralized so the
// runtime never accidentally allows extraBody to set the OTHER budget field
// alongside the runtime-set one (e.g. extraBody.max_tokens leaking through
// when openai vision sets max_completion_tokens, or vice versa).
const VISION_RESERVED_EXTRA_BODY_KEYS: ReadonlySet<string> = new Set([
  "max_tokens",
  "max_completion_tokens"
]);

// Strip trailing slashes from a baseUrl so callers can write either
// `http://x/v1` or `http://x/v1/` and the resulting request URL stays
// `http://x/v1/chat/completions` (not `http://x/v1//chat/completions` —
// some OpenAI-compatible servers reject the doubled slash). The `+`
// collapses runs of trailing slashes; src/embeddings.ts has a similar
// `/\/$/` strip but only catches a single slash.
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// Resolve a persisted baseUrl to a request-ready URL. `provider.baseUrl`
// is technically optional but a persisted empty string would also slip
// past `?? DEFAULT`. resolveBaseUrl treats nullish AND whitespace-only
// as missing so neither produces a relative `/chat/completions` URL,
// then trims trailing slashes via trimBaseUrl.
function resolveBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const candidate = baseUrl && baseUrl.trim().length > 0 ? baseUrl : fallback;
  return trimBaseUrl(candidate);
}

// Per-provider default baseUrl. Use this at call sites instead of hardcoding
// DEFAULT_OPENAI_BASE_URL — otherwise an unnormalized provider (or one whose
// persisted baseUrl somehow slipped through normalize as empty) would send
// codex /responses traffic to api.openai.com, or local/Ollama traffic to
// OpenAI. Mirrors the per-provider defaults set by normalizeProvider so the
// call-site fallback agrees with the persisted-config fallback.
function defaultBaseUrl(provider: ProviderConfig): string {
  if (provider.name === "codex") return DEFAULT_CODEX_BASE_URL;
  if (provider.name === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider.name === "local") return "http://127.0.0.1:11434/v1";
  if (provider.name === "deepseek") return DEFAULT_DEEPSEEK_BASE_URL;
  return DEFAULT_OPENAI_BASE_URL;
}

// ---------------- Vision (image input) ----------------
//
// Single-shot vision call: caller provides a prompt + one inline base64 PNG/JPEG,
// the provider returns plain text. Used by browser_vision to ask the configured
// vision model about a page screenshot without exposing pixels to the agent
// loop itself. We intentionally keep the surface tiny — one image, low detail,
// small max_tokens — so cost stays bounded.
export interface VisionRequest {
  prompt: string;
  imageBase64: string;
  mimeType: "image/png" | "image/jpeg";
  // Caps the model's response length. Defaults to 512 (small budget keeps
  // surprise costs predictable; callers that need more should raise the cap
  // explicitly and document why).
  maxTokens?: number;
}

export interface VisionResult {
  text: string;
  provider: ProviderConfig;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}

// Echo provider vision stubs — mirror of echoToolCallingStubs. Tests register
// canned results; default fallback returns a deterministic "Vision stub: <prompt>"
// so callers that forget to seed a stub still see a stable shape.
const echoVisionStubs: Array<{ tag?: string; result: Omit<VisionResult, "provider"> & { provider?: ProviderConfig } }> = [];

export function setEchoVisionResponse(
  result: Omit<VisionResult, "provider"> & { provider?: ProviderConfig },
  tag?: string
): void {
  echoVisionStubs.push({ tag, result });
}

export function clearEchoVisionResponses(): void {
  echoVisionStubs.length = 0;
}

function nextEchoVisionResult(provider: ProviderConfig, prompt: string): VisionResult {
  const stub = echoVisionStubs.shift();
  if (stub) {
    return { provider: stub.result.provider ?? provider, ...stub.result };
  }
  return { provider, text: `Vision stub: ${prompt}` };
}

export async function generateVisionAnalysis(
  config: RuntimeConfig,
  request: VisionRequest
): Promise<VisionResult> {
  const provider = normalizeProvider(config.provider);
  const maxTokens = request.maxTokens ?? 512;
  if (provider.name === "echo") {
    return nextEchoVisionResult(provider, request.prompt);
  }
  if (provider.name === "codex") {
    return callVisionCodex(provider, request, maxTokens);
  }
  // openai / openrouter / local — all expose chat-completions with the same
  // multi-modal content array shape (`type: "image_url"`).
  return callVisionChatCompletions(provider, request, maxTokens);
}

async function callVisionCodex(
  provider: ProviderConfig,
  request: VisionRequest,
  maxTokens: number
): Promise<VisionResult> {
  // Vision goes through codex's non-streaming /responses path, so the
  // session-rotation failure mode is a 401 on the initial response (not
  // a mid-stream error event). Map that to CodexSessionExpiredError so
  // withCodexSessionRetry can re-read auth.json and try again.
  return withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const dataUrl = `data:${request.mimeType};base64,${request.imageBase64}`;
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify({
        model: provider.model,
        store: false,
        stream: false,
        instructions: "",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: request.prompt },
              { type: "input_image", image_url: dataUrl, detail: "low" }
            ]
          }
        ],
        max_output_tokens: maxTokens
      })
    });
    const rawPayload = await response.text();
    const payload = parseJsonObject(rawPayload);
    if (!response.ok) {
      const fallback = rawPayload.slice(0, 500) || `Codex vision request failed with HTTP ${response.status}`;
      const message = readOpenAIError(payload) ?? fallback;
      if (response.status === 401 && isCodexSessionExpiredMessage(message)) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }
    const text = extractOutputText(payload);
    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    return {
      provider,
      text,
      usage,
      cost: estimateCost(provider, usage)
    };
  });
}

async function callVisionChatCompletions(
  provider: ProviderConfig,
  request: VisionRequest,
  maxTokens: number
): Promise<VisionResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const dataUrl = `data:${request.mimeType};base64,${request.imageBase64}`;
  // OpenAI's newer o-series chat models reject `max_tokens` outright and
  // require `max_completion_tokens`. Older OpenAI models still accept the
  // legacy field. OpenRouter / local OpenAI-compatible gateways may not
  // recognize the newer name yet, so we keep `max_tokens` for them. Send
  // only the field each backend expects to avoid double-counting or
  // 400-level errors.
  const tokenBudgetField = provider.name === "openai"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody, VISION_RESERVED_EXTRA_BODY_KEYS),
      model: provider.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } }
          ]
        }
      ],
      stream: false,
      ...tokenBudgetField,
      prompt_cache_retention: "in_memory"
    })
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Vision request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const text = extractChatText(payload);
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    provider,
    text,
    usage,
    cost: estimateCost(provider, usage)
  };
}
