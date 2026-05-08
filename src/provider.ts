import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MemoryRecord, ProviderCatalogItem, ProviderConfig, ProviderResult, RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";

const INSTRUCTIONS = [
  "You are Gini, a local-first personal agent.",
  "Reply directly and concisely.",
  "Do not claim to have performed side effects. Risky side effects are handled by tools and approvals.",
  "When the user message includes a [Context from your long-term memory ...] block, treat the facts in that block as ground truth from prior conversations with this user. Use them to answer. Do not say you don't know something if the answer is in that block."
].join("\n");

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

export async function generateTaskSummary(config: RuntimeConfig, input: string, memories: MemoryRecord[]): Promise<ProviderResult> {
  const provider = normalizeProvider(config.provider);
  if (provider.name === "echo") {
    const memoryText = memories.length > 0 ? ` Active memory: ${memories.map((memory) => memory.content).join(" | ")}` : "";
    return {
      provider,
      text: `Gini handled: ${input}${memoryText}`
    };
  }

  if (provider.name === "openrouter" || provider.name === "local") {
    return callChatCompletions(provider, input, memories);
  }
  return callOpenAIResponses(provider, input, memories);
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
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  const provider = normalizeProvider(config.provider);
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
  if (provider.name === "openrouter" || provider.name === "local" || provider.name === "openai") {
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
  const bearer = readCodexBearer(provider);
  const baseUrl = provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
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
  const streamed = await readCodexStream(response, provider);
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
  const baseUrl = provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema.` }
      ]
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

export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  if (provider.name === "openai") {
    return {
      name: "openai",
      model: provider.model || "gpt-5.4-mini",
      baseUrl: provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
      apiKeyEnv: provider.apiKeyEnv ?? "OPENAI_API_KEY"
    };
  }
  if (provider.name === "openrouter") {
    return {
      name: "openrouter",
      model: provider.model || "openrouter/auto",
      baseUrl: provider.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKeyEnv: provider.apiKeyEnv ?? "OPENROUTER_API_KEY"
    };
  }
  if (provider.name === "local") {
    return {
      name: "local",
      model: provider.model || "local/default",
      baseUrl: provider.baseUrl ?? "http://127.0.0.1:11434/v1",
      apiKeyEnv: provider.apiKeyEnv ?? "GINI_LOCAL_API_KEY"
    };
  }
  if (provider.name === "codex") {
    return {
      name: "codex",
      model: provider.model || DEFAULT_CODEX_MODEL,
      baseUrl: provider.baseUrl ?? DEFAULT_CODEX_BASE_URL,
      apiKeyEnv: provider.apiKeyEnv
    };
  }
  return {
    name: "echo",
    model: provider.model || "gini-echo-v0"
  };
}

async function callOpenAIResponses(provider: ProviderConfig, input: string, memories: MemoryRecord[]): Promise<ProviderResult> {
  const bearer = provider.name === "codex" ? readCodexBearer(provider) : readOpenAIBearer(provider);
  const headers = provider.name === "codex" ? codexHeaders(bearer) : {};

  const memoryBlock = memories.length > 0
    ? memories.map((memory) => `- (${memory.scope}) ${memory.content}`).join("\n")
    : "No active memories.";

  const isCodex = provider.name === "codex";
  const response = await fetch(`${provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: isCodex ? "text/event-stream" : "application/json",
      ...headers
    },
    body: JSON.stringify({
      model: provider.model,
      store: false,
      stream: isCodex,
      instructions: INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Active memories:\n${memoryBlock}\n\nTask:\n${input}`
            }
          ]
        }
      ]
    })
  });

  if (isCodex) {
    return readCodexStream(response, provider);
  }

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

async function callChatCompletions(provider: ProviderConfig, input: string, memories: MemoryRecord[]): Promise<ProviderResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const memoryBlock = memories.length > 0
    ? memories.map((memory) => `- (${memory.scope}) ${memory.content}`).join("\n")
    : "No active memories.";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [
        {
          role: "system",
          content: INSTRUCTIONS
        },
        { role: "user", content: `Active memories:\n${memoryBlock}\n\nTask:\n${input}` }
      ]
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

async function readCodexStream(response: Response, provider: ProviderConfig): Promise<ProviderResult> {
  const raw = await response.text();
  if (!response.ok) {
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    throw new Error(error);
  }

  const events = parseSseEvents(raw);
  const deltaTextParts: string[] = [];
  const finalTextParts: string[] = [];
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const event of events) {
    const payload = parseJsonObject(event.data);
    if (!responseId && typeof payload.response_id === "string") responseId = payload.response_id;
    if (!responseId && isRecord(payload.response) && typeof payload.response.id === "string") responseId = payload.response.id;
    if (isRecord(payload.response) && isRecord(payload.response.usage)) usage = payload.response.usage;
    if (typeof payload.delta === "string") deltaTextParts.push(payload.delta);
    if (isRecord(payload.item) && Array.isArray(payload.item.content)) {
      for (const content of payload.item.content) {
        if (isRecord(content) && typeof content.text === "string") finalTextParts.push(content.text);
      }
    }
  }

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
}

function parseSseEvents(raw: string): Array<{ event?: string; data: string }> {
  return raw
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLines = lines.filter((line) => line.startsWith("data:"));
      return {
        event: eventLine?.slice("event:".length).trim(),
        data: dataLines.map((line) => line.slice("data:".length).trim()).join("\n")
      };
    })
    .filter((event) => event.data && event.data !== "[DONE]");
}

function codexHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (Gini Agent)",
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
    throw new Error(credentials.message);
  }
  return credentials.bearer;
}

function readCodexCredentials(provider: ProviderConfig): {
  ok: boolean;
  bearer?: string;
  authPath: string;
  credentialType?: "api_key" | "access_token";
  message: string;
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
      message: `Could not read Codex credentials at ${authPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function codexAuthPath(provider: ProviderConfig): string {
  const raw = provider.apiKeyEnv && process.env[provider.apiKeyEnv]
    ? process.env[provider.apiKeyEnv]
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
