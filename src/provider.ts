import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentSystemContext } from "./system-prompt";
import type { CostRecord, MemoryRecord, ProviderCatalogItem, ProviderConfig, ProviderResult, RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";

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

export interface ToolCallingMessage {
  role: ChatMessageRole;
  content: string | null;
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

export function setEchoToolCallingResponse(result: ToolCallingResult, tag?: string): void {
  echoToolCallingStubs.push({ tag, result });
}

export function clearEchoToolCallingResponses(): void {
  echoToolCallingStubs.length = 0;
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
  const baseUrl = provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const wantStream = Boolean(onDelta);
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(serializeChatMessage),
    stream: wantStream
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
  const bearer = readCodexBearer(provider);
  const baseUrl = provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
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
    throw new Error(readOpenAIError(payload) ?? fallback);
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

    if (type === "response.output_text.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (delta.length > 0) {
        textParts.push(delta);
        if (onDelta) {
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

  const finishReason: ToolCallingResult["finishReason"] = toolCalls.length > 0 ? "tool_calls" : "stop";
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

export async function generateTaskSummary(
  config: RuntimeConfig,
  input: string,
  memories: MemoryRecord[],
  recalledContext?: string,
  onDelta?: (text: string) => void,
  // Optional per-call override. Resolved by callers from the active agent's
  // providerName/model via resolveEffectiveContext. Embeddings/reranker still
  // read config.provider — do NOT mutate config here.
  providerOverride?: ProviderConfig
): Promise<ProviderResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  if (provider.name === "echo") {
    const memoryText = memories.length > 0 ? ` Active memory: ${memories.map((memory) => memory.content).join(" | ")}` : "";
    return {
      provider,
      text: `Gini handled: ${input}${memoryText}`
    };
  }

  const systemContext = buildAgentSystemContext(memories, recalledContext);
  if (provider.name === "openrouter" || provider.name === "local") {
    return callChatCompletions(provider, input, systemContext);
  }
  return callOpenAIResponses(provider, input, systemContext, onDelta);
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

async function callOpenAIResponses(
  provider: ProviderConfig,
  input: string,
  systemContext: string,
  onDelta?: (text: string) => void
): Promise<ProviderResult> {
  const bearer = provider.name === "codex" ? readCodexBearer(provider) : readOpenAIBearer(provider);
  const headers = provider.name === "codex" ? codexHeaders(bearer) : {};

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

  if (isCodex) {
    return readCodexStream(response, provider, onDelta);
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

async function callChatCompletions(provider: ProviderConfig, input: string, systemContext: string): Promise<ProviderResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
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
        { role: "system", content: systemContext },
        { role: "user", content: input }
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

  // Consume the SSE stream incrementally. Each event is delimited by `\n\n`;
  // we split off complete events from the rolling buffer and push the rest
  // back. `delta` events fire `onDelta` so callers can surface partial text
  // to UI. The full response text is still returned at the end so the
  // existing ProviderResult contract holds.
  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return;
    const data = dataLines.map((line) => line.slice("data:".length).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    if (!responseId && typeof payload.response_id === "string") responseId = payload.response_id;
    if (!responseId && isRecord(payload.response) && typeof payload.response.id === "string") responseId = payload.response.id;
    if (isRecord(payload.response) && isRecord(payload.response.usage)) usage = payload.response.usage;
    if (typeof payload.delta === "string") {
      deltaTextParts.push(payload.delta);
      if (onDelta) {
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
  const bearer = readCodexBearer(provider);
  const baseUrl = provider.baseUrl ?? DEFAULT_CODEX_BASE_URL;
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
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const text = extractOutputText(payload);
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    provider,
    text,
    usage,
    cost: estimateCost(provider, usage)
  };
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
  const baseUrl = provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
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
      ...tokenBudgetField
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
